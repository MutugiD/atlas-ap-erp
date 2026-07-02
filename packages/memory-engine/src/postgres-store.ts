import { Pool, type PoolClient } from "pg";
import type {
  Artifact,
  Episode,
  Fact,
  IngestInput,
  IngestResult,
  MemoryType,
  RichTimeline,
  TimelineEntry,
} from "@atlas/support-contracts";
import { cosine, DeterministicEmbedder } from "./embedder";
import { SlotExtractor } from "./extractor";
import { contentHash } from "./hash";
import { RegexRedactor } from "./redactor";
import { tokenBudget } from "./store";
import type { Embedder, Extractor, MemoryStore, Redactor } from "./types";

export interface PostgresNativeStoreOptions {
  connectionString?: string;
  pool?: Pool;
  extractor?: Extractor;
  embedder?: Embedder;
  redactor?: Redactor;
}

export class PostgresNativeStore implements MemoryStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly extractor: Extractor;
  private readonly embedder: Embedder;
  private readonly redactor: Redactor;

  constructor(options: PostgresNativeStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL });
    this.ownsPool = !options.pool;
    this.extractor = options.extractor ?? new SlotExtractor();
    this.embedder = options.embedder ?? new DeterministicEmbedder();
    this.redactor = options.redactor ?? new RegexRedactor();
  }

  async ready() {
    try {
      await this.pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const redacted = this.redactor.redact(input.message);
    const candidates = this.extractor.extract(redacted.text);
    const client = await this.pool.connect();
    const inserted: string[] = [];
    let superseded = 0;
    let duplicate = 0;

    try {
      await client.query("begin");
      await this.scopeOrg(client, input.orgId);
      for (const candidate of candidates) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${input.orgId}:${input.userId}:${candidate.slotKey}`]);
        const hash = await contentHash([input.orgId, input.userId, candidate.slotKey, candidate.objectValue]);
        const existing = await client.query("select id from support_facts where org_id = $1 and user_id = $2 and content_hash = $3 limit 1", [
          input.orgId,
          input.userId,
          hash,
        ]);
        if (existing.rowCount) {
          duplicate++;
          continue;
        }

        const priorResult = await client.query(
          "select * from support_facts where org_id = $1 and user_id = $2 and slot_key = $3 and status = 'active' limit 1",
          [input.orgId, input.userId, candidate.slotKey],
        );
        const prior = priorResult.rows[0] ? rowToFact(priorResult.rows[0]) : undefined;
        const occurredAt = input.occurredAt ?? new Date().toISOString();
        const incomingIsOlder = prior ? Date.parse(occurredAt) < Date.parse(prior.occurredAt) : false;
        const status = incomingIsOlder ? "superseded" : "active";
        const supersedes = prior && !incomingIsOlder && prior.objectValue !== candidate.objectValue ? prior.id : undefined;

        if (supersedes) {
          await client.query("update support_facts set status = 'superseded' where id = $1 and org_id = $2", [supersedes, input.orgId]);
          superseded++;
        }

        const embedding = await this.embedder.embed(candidate.canonicalText);
        const insertedResult = await client.query(
          `insert into support_facts
            (org_id, user_id, slot_key, subject, predicate, object_value, canonical_text, embedding, status, supersedes, content_hash, source_role, conv_id, occurred_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$12,$13,$14)
           returning id`,
          [
            input.orgId,
            input.userId,
            candidate.slotKey,
            candidate.subject,
            candidate.predicate,
            candidate.objectValue,
            candidate.canonicalText,
            vectorLiteral(embedding),
            status,
            supersedes,
            hash,
            input.sourceRole,
            input.convId,
            occurredAt,
          ],
        );
        inserted.push(insertedResult.rows[0].id);
      }

      if (inserted.length > 0) {
        await this.createEpisodeAndArtifact(client, input.orgId, input.userId, inserted);
      }
      await client.query("commit");
      return { queued: true, inserted: inserted.length, superseded, duplicate, factIds: inserted };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async retrieve(input: { orgId: string; userId: string; query?: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.scopeOrg(client, input.orgId);
      const result = await client.query(
        "select * from support_facts where org_id = $1 and user_id = $2 and status = 'active' order by slot_key asc",
        [input.orgId, input.userId],
      );
      let facts = result.rows.map(rowToFact);
      if (input.query) {
        const queryEmbedding = await this.embedder.embed(input.query);
        facts = facts.sort((a, b) => cosine(b.embedding, queryEmbedding) - cosine(a.embedding, queryEmbedding));
      }
      const context = {
        orgId: input.orgId,
        userId: input.userId,
        facts,
        contextPrompt: tokenBudget(facts.map((fact) => fact.canonicalText).join("\n")),
      };
      await client.query("commit");
      return context;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getFact(input: { orgId: string; userId: string; factId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.scopeOrg(client, input.orgId);
      const result = await client.query("select * from support_facts where org_id = $1 and user_id = $2 and id = $3 limit 1", [
        input.orgId,
        input.userId,
        input.factId,
      ]);
      const fact = result.rows[0] ? rowToFact(result.rows[0]) : null;
      await client.query("commit");
      return fact;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async timeline(input: { orgId: string; userId: string }): Promise<TimelineEntry[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.scopeOrg(client, input.orgId);
      const result = await client.query("select * from support_facts where org_id = $1 and user_id = $2 order by created_at asc", [
        input.orgId,
        input.userId,
      ]);
      const facts = result.rows.map(rowToFact);
      const timeline = facts.map((fact) => ({ ...fact, replacedBy: facts.find((candidate) => candidate.supersedes === fact.id)?.id }));
      await client.query("commit");
      return timeline;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async richTimeline(input: { orgId: string; userId: string }): Promise<RichTimeline> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.scopeOrg(client, input.orgId);
      const [factsResult, episodes, artifacts] = await Promise.all([
        client.query("select * from support_facts where org_id = $1 and user_id = $2 order by created_at asc", [input.orgId, input.userId]),
        client.query("select * from support_episodes where org_id = $1 and user_id = $2 order by created_at asc", [input.orgId, input.userId]),
        client.query("select * from support_artifacts where org_id = $1 and user_id = $2 order by created_at asc", [input.orgId, input.userId]),
      ]);
      const factRows = factsResult.rows.map(rowToFact);
      const facts = factRows.map((fact) => ({ ...fact, replacedBy: factRows.find((candidate) => candidate.supersedes === fact.id)?.id }));
      await client.query("commit");
      return { facts, episodes: episodes.rows.map(rowToEpisode), artifacts: artifacts.rows.map(rowToArtifact) };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listByType(input: { orgId: string; userId: string; type: MemoryType }): Promise<Array<Fact | Episode | Artifact>> {
    if (input.type === "fact") return this.timeline(input);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.scopeOrg(client, input.orgId);
      if (input.type === "episode") {
        const result = await client.query("select * from support_episodes where org_id = $1 and user_id = $2 order by created_at asc", [
          input.orgId,
          input.userId,
        ]);
        const episodes = result.rows.map(rowToEpisode);
        await client.query("commit");
        return episodes;
      }
      const result = await client.query("select * from support_artifacts where org_id = $1 and user_id = $2 order by created_at asc", [
        input.orgId,
        input.userId,
      ]);
      const artifacts = result.rows.map(rowToArtifact);
      await client.query("commit");
      return artifacts;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async reset(input: { orgId: string; userId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.scopeOrg(client, input.orgId);
      await client.query("delete from support_artifacts where org_id = $1 and user_id = $2", [input.orgId, input.userId]);
      await client.query("delete from support_episodes where org_id = $1 and user_id = $2", [input.orgId, input.userId]);
      await client.query("delete from support_facts where org_id = $1 and user_id = $2", [input.orgId, input.userId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async scopeOrg(client: PoolClient, orgId: string) {
    await client.query("select set_config('app.org_id', $1, true)", [orgId]);
  }

  private async createEpisodeAndArtifact(client: PoolClient, orgId: string, userId: string, factIds: string[]) {
    await client.query("insert into support_episodes (org_id, user_id, summary, fact_ids) values ($1,$2,$3,$4)", [
      orgId,
      userId,
      `Captured ${factIds.length} support memor${factIds.length === 1 ? "y" : "ies"}.`,
      JSON.stringify(factIds),
    ]);
    await client.query("insert into support_artifacts (org_id, user_id, kind, content, source_fact_ids) values ($1,$2,$3,$4,$5)", [
      orgId,
      userId,
      "customer_profile",
      JSON.stringify({ generated: true, factCount: factIds.length }),
      JSON.stringify(factIds),
    ]);
  }
}

function vectorLiteral(embedding: number[]) {
  return `[${embedding.join(",")}]`;
}

function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") return value.replace(/^\[|\]$/g, "").split(",").filter(Boolean).map(Number);
  return [];
}

function rowToFact(row: Record<string, unknown>): Fact {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    slotKey: String(row.slot_key),
    subject: String(row.subject),
    predicate: String(row.predicate),
    objectValue: String(row.object_value),
    canonicalText: String(row.canonical_text),
    embedding: parseEmbedding(row.embedding),
    status: row.status as Fact["status"],
    supersedes: row.supersedes ? String(row.supersedes) : undefined,
    contentHash: String(row.content_hash),
    sourceRole: row.source_role as Fact["sourceRole"],
    convId: String(row.conv_id),
    occurredAt: new Date(row.occurred_at as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToEpisode(row: Record<string, unknown>): Episode {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    summary: String(row.summary),
    factIds: Array.isArray(row.fact_ids) ? row.fact_ids.map(String) : JSON.parse(String(row.fact_ids ?? "[]")),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    kind: String(row.kind),
    content: typeof row.content === "object" && row.content ? (row.content as Record<string, unknown>) : JSON.parse(String(row.content ?? "{}")),
    sourceFactIds: Array.isArray(row.source_fact_ids) ? row.source_fact_ids.map(String) : JSON.parse(String(row.source_fact_ids ?? "[]")),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}
