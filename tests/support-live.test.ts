import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { InMemoryNativeStore, PostgresNativeStore } from "@atlas/memory-engine";
import { BullMqIngestQueue } from "../apps/support-agent/src/queue";

const live = process.env.RUN_LIVE_SUPPORT_TESTS === "true";
const describeLive = live ? describe : describe.skip;
const ownerUrl = process.env.DATABASE_URL ?? "postgresql://atlas_owner:atlas_owner@localhost:5432/atlas_ap";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describeLive("Support Agent V2 live integration harness", () => {
  test("Postgres app role enforces RLS and store filters across orgs", async () => {
    const owner = new Pool({ connectionString: ownerUrl });
    await resetSupportSchema(owner);
    await owner.query(readFileSync("packages/support-db/migrations/0000_support_agent_v2.sql", "utf8"));
    await owner.query("insert into support_orgs (id, name) values ($1, $2), ($3, $4)", [orgA, "Org A", orgB, "Org B"]);
    await owner.end();

    const appPool = new Pool({ connectionString: appRoleUrl(ownerUrl) });
    const store = new PostgresNativeStore({ pool: appPool });
    await store.ingest({
      orgId: orgA,
      userId: "live-user",
      convId: "live-1",
      sourceRole: "customer",
      message: "We are on the Enterprise plan and use NetSuite.",
    });

    expect((await store.retrieve({ orgId: orgA, userId: "live-user" })).facts.length).toBeGreaterThan(0);
    expect((await store.retrieve({ orgId: orgB, userId: "live-user" })).facts).toHaveLength(0);

    expect(await countVisibleFacts(appPool, orgA)).toBeGreaterThan(0);
    expect(await countVisibleFacts(appPool, orgB)).toBe(0);
    await appPool.end();
  });

  test("Redis BullMQ worker ingests queued memory and exposes depth", async () => {
    const store = new InMemoryNativeStore();
    const queue = new BullMqIngestQueue(store, { redisUrl, startWorker: true, jobOptions: { attempts: 1, removeOnComplete: true } });
    const userId = `redis-live-${Date.now()}`;

    await queue.enqueue({
      orgId: orgA,
      userId,
      convId: "redis-live-1",
      sourceRole: "customer",
      message: "We use Salesforce and prefer email.",
    });

    await waitFor(async () => (await store.retrieve({ orgId: orgA, userId })).facts.length > 0);
    expect(await queue.depth()).toBeGreaterThanOrEqual(0);
    expect(await queue.dlqDepth()).toBeGreaterThanOrEqual(0);
    await queue.close();
  });
});

async function resetSupportSchema(pool: Pool) {
  await pool.query(`
    drop table if exists support_ingest_jobs, support_api_keys, support_audit_logs, support_artifacts, support_episodes, support_facts, support_users, support_orgs cascade;
    drop role if exists support_app_user;
  `);
}

async function countVisibleFacts(pool: Pool, orgId: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.org_id', $1, true)", [orgId]);
    const result = await client.query("select count(*)::int as count from support_facts");
    await client.query("commit");
    return result.rows[0].count as number;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function appRoleUrl(url: string) {
  const parsed = new URL(url);
  parsed.username = "support_app_user";
  parsed.password = "support_app_user";
  return parsed.toString();
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for live integration condition");
}
