import Fastify from "fastify";
import {
  chatRequestSchema,
  demoScenarioSchema,
  memoryTypeSchema,
  type ChatResponse,
} from "@atlas/support-contracts";
import { InMemoryNativeStore, renderTemplateReply } from "@atlas/memory-engine";
import { authenticate } from "./auth";
import { LocalIngestQueue } from "./queue";
import { chatRequests, dlqDepth, memoryIngest, queueDepth, registry, routeDuration, supersessions } from "./metrics";

export function buildSupportApp(options: { store?: InMemoryNativeStore } = {}) {
  const app = Fastify({ logger: false });
  const store = options.store ?? new InMemoryNativeStore();
  const queue = new LocalIngestQueue(store);

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
    dependencies: { memory: "ready", redis: "local-fallback", model: "deterministic" },
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
    return await store.richTimeline({ orgId: request.org.orgId, userId });
  });

  app.delete("/api/demo/reset", async (request) => {
    const query = request.query as { userId?: string };
    await store.reset({ orgId: request.org.orgId, userId: query.userId ?? "demo-user" });
    return { ok: true };
  });

  app.delete("/api/memory/:userId", async (request) => {
    const { userId } = request.params as { userId: string };
    await store.reset({ orgId: request.org.orgId, userId });
    return { ok: true };
  });

  app.get("/admin", async (_request, reply) => {
    reply.type("text/html");
    return "<!doctype html><html><body><h1>Support Agent V2 Admin</h1><p>Memory explorer, supersession graph, DLQ replay, tenant management, and PII review shell.</p></body></html>";
  });

  return app;
}
