import { describe, expect, test } from "bun:test";
import { AdminControlPlane } from "../apps/support-agent/src/admin";
import { buildSupportApp } from "../apps/support-agent/src/app";
import { InMemoryNativeStore } from "@atlas/memory-engine";

const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const adminHeaders = {
  "content-type": "application/json",
  "x-org-id": orgId,
  "x-principal-id": "admin-test",
  "x-role": "admin",
};
const serviceHeaders = { ...adminHeaders, "x-role": "service" };

describe("Support Agent V2 admin operator workflows", () => {
  test("requires admin role for operator endpoints", async () => {
    const app = buildSupportApp({ store: new InMemoryNativeStore() });
    const response = await app.inject({ method: "GET", url: "/api/admin/audit", headers: serviceHeaders });
    expect(response.statusCode).toBe(403);
  }, 10000);

  test("explorer, graph, pii review, api keys, audit, and DLQ replay work end to end", async () => {
    const store = new InMemoryNativeStore();
    const admin = new AdminControlPlane();
    const app = buildSupportApp({ store, admin });

    const chat = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: adminHeaders,
      payload: {
        userId: "ops-user",
        convId: "ops-1",
        message: "I am on the Pro plan and use QuickBooks. Email me at ops@example.com.",
        mode: "with_memory",
      },
    });
    expect(chat.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: adminHeaders,
      payload: {
        userId: "ops-user",
        convId: "ops-2",
        message: "We upgraded to Enterprise plan and use NetSuite. Contact us on Slack.",
        mode: "with_memory",
      },
    });

    const explorer = await app.inject({ method: "GET", url: "/api/admin/memory/ops-user/explorer", headers: adminHeaders });
    expect(explorer.json().stats.active).toBeGreaterThan(0);
    expect(explorer.json().stats.superseded).toBeGreaterThan(0);

    const graph = await app.inject({ method: "GET", url: "/api/admin/memory/ops-user/graph", headers: adminHeaders });
    expect(graph.json().lanes.some((lane: { slotKey: string }) => lane.slotKey === "plan")).toBe(true);
    expect(graph.json().edges.length).toBeGreaterThan(0);

    const pii = await app.inject({ method: "GET", url: "/api/admin/pii?userId=ops-user", headers: adminHeaders });
    expect(pii.json().redactions[0].maskedValue).toBe("[REDACTED_EMAIL]");

    const createdKey = await app.inject({
      method: "POST",
      url: "/api/admin/api-keys",
      headers: adminHeaders,
      payload: { label: "ticketing ingest", role: "service" },
    });
    const keyBody = createdKey.json();
    expect(keyBody.secret).toStartWith("sk_sa_");
    expect(keyBody.apiKey.keyHash).toHaveLength(64);

    const listedKeys = await app.inject({ method: "GET", url: "/api/admin/api-keys", headers: adminHeaders });
    expect(listedKeys.json().apiKeys).toHaveLength(1);

    const revoked = await app.inject({ method: "DELETE", url: `/api/admin/api-keys/${keyBody.apiKey.id}`, headers: adminHeaders });
    expect(revoked.json().ok).toBe(true);

    const dlqJob = admin.addDlq({
      orgId,
      userId: "ops-user",
      convId: "dlq-1",
      message: "We prefer Slack for urgent support.",
      failedReason: "simulated worker failure",
    });
    const dlq = await app.inject({ method: "GET", url: "/api/admin/dlq", headers: adminHeaders });
    expect(dlq.json().jobs).toHaveLength(1);

    const replay = await app.inject({ method: "POST", url: `/api/admin/dlq/${dlqJob.id}/replay`, headers: adminHeaders });
    expect(replay.json().result.queued).toBe(true);

    const audit = await app.inject({ method: "GET", url: "/api/admin/audit", headers: adminHeaders });
    const actions = audit.json().events.map((event: { action: string }) => event.action);
    expect(actions).toContain("memory.ingest_enqueued");
    expect(actions).toContain("api_key.created");
    expect(actions).toContain("api_key.revoked");
    expect(actions).toContain("dlq.replayed");
  });
});
