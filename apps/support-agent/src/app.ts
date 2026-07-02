import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  apiKeyCreateSchema,
  chatRequestSchema,
  demoScenarioSchema,
  memoryTypeSchema,
  type ChatResponse,
} from "@atlas/support-contracts";
import { InMemoryNativeStore, PostgresNativeStore, RegexRedactor, renderTemplateReply, type MemoryStore } from "@atlas/memory-engine";
import { AdminControlPlane, buildSupersessionGraph } from "./admin";
import { authenticate } from "./auth";
import { BullMqIngestQueue, LocalIngestQueue, type IngestQueue } from "./queue";
import { chatRequests, dlqDepth, memoryIngest, queueDepth, registry, routeDuration, supersessions } from "./metrics";

export function buildSupportApp(options: { store?: MemoryStore; queue?: IngestQueue; admin?: AdminControlPlane } = {}) {
  const app = Fastify({
    logger:
      process.env.SUPPORT_AGENT_LOG === "true"
        ? {
            level: process.env.LOG_LEVEL ?? "info",
            redact: ["req.headers.authorization", "req.headers.x-api-key", "request.headers.authorization", "request.headers.x-api-key"],
          }
        : false,
    genReqId: (request) => String(request.headers["x-correlation-id"] ?? crypto.randomUUID()),
  });
  const store = options.store ?? createDefaultStore();
  const queue = options.queue ?? createDefaultQueue(store);
  const admin = options.admin ?? new AdminControlPlane();
  const redactor = new RegexRedactor();

  void app.register(helmet);
  void app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_PER_TENANT ?? 120),
    timeWindow: "1 minute",
    keyGenerator: (request) => `${request.headers["x-org-id"] ?? "anonymous"}:${request.ip}`,
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (error) {
      done(error as Error);
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/health") || request.url === "/metrics") return;
    await authenticate(request, reply);
  });

  app.addHook("onRequest", async (request, reply) => {
    const end = routeDuration.startTimer();
    reply.raw.on("finish", () => end({ method: request.method, route: request.routeOptions.url ?? request.url }));
  });

  app.get("/health/live", async () => ({ ok: true, service: "support-agent-v2" }));

  app.get("/health/ready", async () => ({
    ok: await store.ready(),
    dependencies: {
      memory: (await store.ready()) ? "ready" : "unavailable",
      redis: process.env.REDIS_URL ? "configured" : "local-fallback",
      model: "deterministic",
    },
  }));

  app.get("/metrics", async (_request, reply) => {
    queueDepth.set(await queue.depth());
    dlqDepth.set(await queue.dlqDepth());
    reply.type(registry.contentType);
    return registry.metrics();
  });

  app.post("/api/chat", async (request) => {
    const body = chatRequestSchema.parse(request.body);
    chatRequests.inc({ mode: body.mode });
    let contextPrompt = "";
    let retrievedFacts = 0;
    let writeResult = { queued: false, inserted: 0, superseded: 0, duplicate: 0 };

    if (body.mode === "with_memory") {
      const pii = redactor.redact(body.message);
      for (const redaction of pii.redactions) {
        admin.recordPii({
          orgId: request.org.orgId,
          userId: body.userId,
          convId: body.convId,
          kind: redaction.kind,
          maskedValue: redaction.kind === "email" ? "[REDACTED_EMAIL]" : "[REDACTED_PHONE]",
          sourceRole: "customer",
        });
      }
      const context = await store.retrieve({ orgId: request.org.orgId, userId: body.userId, query: body.message });
      contextPrompt = context.contextPrompt;
      retrievedFacts = context.facts.length;
      writeResult = await queue.enqueue({
        orgId: request.org.orgId,
        userId: body.userId,
        convId: body.convId,
        sourceRole: "customer",
        message: body.message,
        occurredAt: body.occurredAt,
      });
      memoryIngest.inc({ result: writeResult.inserted > 0 ? "inserted" : "duplicate_or_empty" });
      if (writeResult.superseded > 0) supersessions.inc(writeResult.superseded);
      await admin.audit(request.org, "memory.ingest_enqueued", "user_memory", body.userId, {
        inserted: writeResult.inserted,
        superseded: writeResult.superseded,
        duplicate: writeResult.duplicate,
      });
    }

    const response: ChatResponse = {
      reply: renderTemplateReply(body.message, contextPrompt),
      mode: body.mode,
      contextPrompt,
      retrievedFacts,
      writeResult,
      degraded: false,
    };
    return response;
  });

  app.get("/api/memory/:userId", async (request) => {
    const { userId } = request.params as { userId: string };
    const context = await store.retrieve({ orgId: request.org.orgId, userId });
    return { facts: context.facts, contextPrompt: context.contextPrompt };
  });

  app.get("/api/memory/:userId/timeline", async (request) => {
    const { userId } = request.params as { userId: string };
    return { timeline: await store.timeline({ orgId: request.org.orgId, userId }) };
  });

  app.get("/api/memory/:userId/rich-timeline", async (request) => {
    const { userId } = request.params as { userId: string };
    return await store.richTimeline({ orgId: request.org.orgId, userId });
  });

  app.get("/api/memory/:userId/:type", async (request) => {
    const { userId, type } = request.params as { userId: string; type: string };
    return { items: await store.listByType({ orgId: request.org.orgId, userId, type: memoryTypeSchema.parse(type) }) };
  });

  app.get("/api/memory/:userId/facts/:factId", async (request) => {
    const { userId, factId } = request.params as { userId: string; factId: string };
    const fact = await store.getFact({ orgId: request.org.orgId, userId, factId });
    return fact ? { fact } : null;
  });

  app.post("/api/demo/run", async (request) => {
    const scenario = demoScenarioSchema.parse(request.body);
    const userId = scenario.userId ?? "demo-user";
    const messages = scenario.messages ?? [
      "I am on the Pro plan and use QuickBooks. Email me at demo@example.com.",
      "We upgraded to Enterprise and moved from QuickBooks to NetSuite. Contact me on Slack.",
    ];
    for (const [index, message] of messages.entries()) {
      await store.ingest({
        orgId: request.org.orgId,
        userId,
        convId: `${scenario.name}-${index}`,
        sourceRole: "customer",
        message,
      });
    }
    await admin.audit(request.org, "demo.run", "user_memory", userId, { scenario: scenario.name, messages: messages.length });
    return await store.richTimeline({ orgId: request.org.orgId, userId });
  });

  app.delete("/api/demo/reset", async (request) => {
    const query = request.query as { userId?: string };
    await store.reset({ orgId: request.org.orgId, userId: query.userId ?? "demo-user" });
    await admin.audit(request.org, "demo.reset", "user_memory", query.userId ?? "demo-user");
    return { ok: true };
  });

  app.delete("/api/memory/:userId", async (request) => {
    const { userId } = request.params as { userId: string };
    await store.reset({ orgId: request.org.orgId, userId });
    await admin.audit(request.org, "memory.erased", "user_memory", userId);
    return { ok: true };
  });

  app.get("/api/admin/memory/:userId/explorer", async (request) => {
    requireAdmin(request.org);
    const { userId } = request.params as { userId: string };
    const rich = await store.richTimeline({ orgId: request.org.orgId, userId });
    return {
      ...rich,
      stats: {
        facts: rich.facts.length,
        active: rich.facts.filter((fact) => fact.status === "active").length,
        superseded: rich.facts.filter((fact) => fact.status === "superseded").length,
        episodes: rich.episodes.length,
        artifacts: rich.artifacts.length,
      },
    };
  });

  app.get("/api/admin/memory/:userId/graph", async (request) => {
    requireAdmin(request.org);
    const { userId } = request.params as { userId: string };
    const rich = await store.richTimeline({ orgId: request.org.orgId, userId });
    return buildSupersessionGraph(rich.facts);
  });

  app.get("/api/admin/pii", async (request) => {
    requireAdmin(request.org);
    const query = request.query as { userId?: string };
    return { redactions: admin.listPii(request.org, query.userId) };
  });

  app.get("/api/admin/audit", async (request) => {
    requireAdmin(request.org);
    return { events: admin.listAudit(request.org) };
  });

  app.get("/api/admin/dlq", async (request) => {
    requireAdmin(request.org);
    return { jobs: admin.listDlq(request.org) };
  });

  app.post("/api/admin/dlq/:jobId/replay", async (request) => {
    requireAdmin(request.org);
    const { jobId } = request.params as { jobId: string };
    const result = await admin.replayDlq(request.org, jobId, queue);
    return result ?? { error: "not_found" };
  });

  app.post("/api/admin/api-keys", async (request) => {
    requireAdmin(request.org);
    return await admin.createApiKey(request.org, apiKeyCreateSchema.parse(request.body));
  });

  app.get("/api/admin/api-keys", async (request) => {
    requireAdmin(request.org);
    return { apiKeys: admin.listApiKeys(request.org) };
  });

  app.delete("/api/admin/api-keys/:id", async (request) => {
    requireAdmin(request.org);
    const { id } = request.params as { id: string };
    return { ok: await admin.revokeApiKey(request.org, id) };
  });

  app.get("/admin", async (request, reply) => {
    requireAdmin(request.org);
    reply.type("text/html");
    return adminHtml();
  });

  return app;
}

export function createDefaultStore(): MemoryStore {
  return process.env.DATABASE_URL ? new PostgresNativeStore({ connectionString: process.env.DATABASE_URL }) : new InMemoryNativeStore();
}

export function createDefaultQueue(store: MemoryStore): IngestQueue {
  return process.env.REDIS_URL
    ? new BullMqIngestQueue(store, { redisUrl: process.env.REDIS_URL, startWorker: process.env.APP_ROLE !== "web" })
    : new LocalIngestQueue(store);
}

function requireAdmin(org: { role: string }) {
  if (org.role !== "admin") {
    const error = new Error("Admin role required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}

function adminHtml() {
  return `<!doctype html>
<html>
  <head>
    <title>Support Agent V2 Admin</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #f7f8fb; color: #172033; }
      main { max-width: 1120px; margin: 0 auto; padding: 28px; }
      section { background: white; border: 1px solid #dfe4ec; border-radius: 8px; padding: 16px; margin: 14px 0; }
      code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Support Agent V2 Admin</h1>
      <section><h2>Memory Explorer</h2><p>Use <code>/api/admin/memory/:userId/explorer</code> for facts, episodes, artifacts, provenance, and status counts.</p></section>
      <section><h2>Supersession Graph</h2><p>Use <code>/api/admin/memory/:userId/graph</code> for slot lanes, active nodes, and supersession edges.</p></section>
      <section><h2>Operations</h2><p>Use <code>/api/admin/dlq</code>, <code>/api/admin/audit</code>, and <code>/api/admin/pii</code> for queue, audit, and redaction review.</p></section>
      <section><h2>Tenant/API Keys</h2><p>Use <code>/api/admin/api-keys</code> to issue, list, and revoke service credentials. Secrets are returned once.</p></section>
    </main>
  </body>
</html>`;
}
