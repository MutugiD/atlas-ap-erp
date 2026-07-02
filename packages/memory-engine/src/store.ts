import {
  type Artifact,
  type Episode,
  type Fact,
  type IngestInput,
  type IngestResult,
  type MemoryType,
  type RichTimeline,
  type TimelineEntry,
} from "@atlas/support-contracts";
import { cosine, DeterministicEmbedder } from "./embedder";
import { SlotExtractor } from "./extractor";
import { contentHash } from "./hash";
import { RegexRedactor } from "./redactor";
import type { Embedder, Extractor, MemoryStore, Redactor } from "./types";

const now = () => new Date().toISOString();

export class InMemoryNativeStore implements MemoryStore {
  private facts: Fact[] = [];
  private episodes: Episode[] = [];
  private artifacts: Artifact[] = [];

  constructor(
    private readonly extractor: Extractor = new SlotExtractor(),
    private readonly embedder: Embedder = new DeterministicEmbedder(),
    private readonly redactor: Redactor = new RegexRedactor(),
  ) {}

  async ready() {
    return true;
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const redacted = this.redactor.redact(input.message);
    const candidates = this.extractor.extract(redacted.text);
    const inserted: Fact[] = [];
    const superseded: Fact[] = [];
    let duplicate = 0;

    for (const candidate of candidates) {
      const hash = await contentHash([input.orgId, input.userId, candidate.slotKey, candidate.objectValue]);
      const existing = this.facts.find((fact) => fact.orgId === input.orgId && fact.userId === input.userId && fact.contentHash === hash);
      if (existing) {
        duplicate++;
        continue;
      }

      const prior = this.facts.find(
        (fact) => fact.orgId === input.orgId && fact.userId === input.userId && fact.slotKey === candidate.slotKey && fact.status === "active",
      );
      if (prior && prior.objectValue !== candidate.objectValue) {
        prior.status = "superseded";
        superseded.push(prior);
      }

      const fact: Fact = {
        id: crypto.randomUUID(),
        orgId: input.orgId,
        userId: input.userId,
        slotKey: candidate.slotKey,
        subject: candidate.subject,
        predicate: candidate.predicate,
        objectValue: candidate.objectValue,
        canonicalText: candidate.canonicalText,
        embedding: await this.embedder.embed(candidate.canonicalText),
        status: "active",
        supersedes: prior?.id,
        contentHash: hash,
        sourceRole: input.sourceRole,
        convId: input.convId,
        occurredAt: input.occurredAt ?? now(),
        createdAt: now(),
      };
      this.facts.push(fact);
      inserted.push(fact);
    }

    if (inserted.length > 0) {
      this.createEpisodeAndArtifact(input.orgId, input.userId, inserted);
    }

    return { queued: true, inserted: inserted.length, superseded: superseded.length, duplicate, factIds: inserted.map((fact) => fact.id) };
  }

  async retrieve(input: { orgId: string; userId: string; query?: string }) {
    let facts = this.facts.filter((fact) => fact.orgId === input.orgId && fact.userId === input.userId && fact.status === "active");
    if (input.query) {
      const queryEmbedding = await this.embedder.embed(input.query);
      facts = [...facts].sort((a, b) => cosine(b.embedding, queryEmbedding) - cosine(a.embedding, queryEmbedding));
    } else {
      facts = [...facts].sort((a, b) => a.slotKey.localeCompare(b.slotKey));
    }
    return {
      orgId: input.orgId,
      userId: input.userId,
      facts,
      contextPrompt: tokenBudget(facts.map((fact) => fact.canonicalText).join("\n")),
    };
  }

  async getFact(input: { orgId: string; userId: string; factId: string }) {
    return this.facts.find((fact) => fact.orgId === input.orgId && fact.userId === input.userId && fact.id === input.factId) ?? null;
  }

  async timeline(input: { orgId: string; userId: string }): Promise<TimelineEntry[]> {
    const facts = this.facts
      .filter((fact) => fact.orgId === input.orgId && fact.userId === input.userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return facts.map((fact) => ({
      ...fact,
      replacedBy: facts.find((candidate) => candidate.supersedes === fact.id)?.id,
    }));
  }

  async richTimeline(input: { orgId: string; userId: string }): Promise<RichTimeline> {
    return {
      facts: await this.timeline(input),
      episodes: this.episodes.filter((episode) => episode.orgId === input.orgId && episode.userId === input.userId),
      artifacts: this.artifacts.filter((artifact) => artifact.orgId === input.orgId && artifact.userId === input.userId),
    };
  }

  async listByType(input: { orgId: string; userId: string; type: MemoryType }) {
    if (input.type === "fact") return this.timeline(input);
    if (input.type === "episode") return this.episodes.filter((episode) => episode.orgId === input.orgId && episode.userId === input.userId);
    return this.artifacts.filter((artifact) => artifact.orgId === input.orgId && artifact.userId === input.userId);
  }

  async reset(input: { orgId: string; userId: string }) {
    this.facts = this.facts.filter((fact) => fact.orgId !== input.orgId || fact.userId !== input.userId);
    this.episodes = this.episodes.filter((episode) => episode.orgId !== input.orgId || episode.userId !== input.userId);
    this.artifacts = this.artifacts.filter((artifact) => artifact.orgId !== input.orgId || artifact.userId !== input.userId);
  }

  private createEpisodeAndArtifact(orgId: string, userId: string, facts: Fact[]) {
    const factIds = facts.map((fact) => fact.id);
    this.episodes.push({
      id: crypto.randomUUID(),
      orgId,
      userId,
      summary: `Captured ${facts.length} support memor${facts.length === 1 ? "y" : "ies"}: ${facts.map((fact) => fact.canonicalText).join("; ")}`,
      factIds,
      createdAt: now(),
    });
    this.artifacts.push({
      id: crypto.randomUUID(),
      orgId,
      userId,
      kind: "customer_profile",
      content: Object.fromEntries(facts.map((fact) => [fact.slotKey, fact.objectValue])),
      sourceFactIds: factIds,
      createdAt: now(),
    });
  }
}

export function tokenBudget(text: string, maxChars = 1800) {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd();
}

export function renderTemplateReply(message: string, contextPrompt: string) {
  const memoryLine = contextPrompt ? ` I found relevant account memory: ${contextPrompt.replace(/\n/g, "; ")}.` : "";
  return `I can help with that.${memoryLine} You said: "${message}"`;
}

