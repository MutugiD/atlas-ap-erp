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
import { BullMqIngestQueue, DegradingIngestQueue, LocalIngestQueue, type IngestQueue } from "./queue";
import {
  chatRequests,
  contextCacheHits,
  dlqDepth,
  memoryIngest,
  queueDepth,
  readinessFailures,
  registry,
  routeDuration,
  supersessions,
} from "./metrics";
import { observability } from "./observability";

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

  app.get("/health/ready", async () => {
    const memoryReady = await store.ready();
    if (!memoryReady) readinessFailures.inc({ dependency: "memory" });
    return {
      ok: memoryReady,
      dependencies: {
        memory: memoryReady ? "ready" : "unavailable",
        redis: process.env.REDIS_URL ? "configured" : "local-fallback",
        model: "deterministic",
      },
    };
  });

  app.get("/metrics", async (_request, reply) => {
    queueDepth.set(await queue.depth());
    dlqDepth.set(await queue.dlqDepth());
    reply.type(registry.contentType);
    return registry.metrics();
  });

  app.post("/api/chat", async (request) =>
    observability.withSpan("support.chat", { mode: (request.body as { mode?: string }).mode ?? "unknown" }, async () => {
      const body = chatRequestSchema.parse(request.body);
      chatRequests.inc({ mode: body.mode });
      let contextPrompt = "";
      let retrievedFacts = 0;
      let writeResult = { queued: false, inserted: 0, superseded: 0, duplicate: 0 };
      let degraded = false;

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
        const context = await observability.withSpan("memory.retrieve", { orgId: request.org.orgId, userId: body.userId }, () =>
          store.retrieve({ orgId: request.org.orgId, userId: body.userId, query: body.message }),
        );
        contextPrompt = context.contextPrompt;
        retrievedFacts = context.facts.length;
        if (retrievedFacts > 0) contextCacheHits.inc();
        writeResult = await observability.withSpan("memory.enqueue", { orgId: request.org.orgId, userId: body.userId }, () =>
          queue.enqueue({
            orgId: request.org.orgId,
            userId: body.userId,
            convId: body.convId,
            sourceRole: "customer",
            message: body.message,
            occurredAt: body.occurredAt,
          }),
        );
        degraded = !writeResult.queued;
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
        degraded,
      };
      return response;
    }));

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
    ? new DegradingIngestQueue(new BullMqIngestQueue(store, { redisUrl: process.env.REDIS_URL, startWorker: process.env.APP_ROLE !== "web" }))
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
      header { background: #172033; color: white; padding: 18px 28px; }
      main { max-width: 1180px; margin: 0 auto; padding: 22px; }
      .toolbar { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; margin: 16px 0; }
      input, select, button { border: 1px solid #c9d3df; border-radius: 6px; padding: 9px 10px; font: inherit; }
      button { background: #0f6b5f; color: white; border-color: #0f6b5f; cursor: pointer; }
      nav { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 18px; }
      nav button { background: white; color: #172033; border-color: #c9d3df; }
      nav button.active { background: #172033; color: white; }
      section { display: none; background: white; border: 1px solid #dfe4ec; border-radius: 8px; padding: 16px; margin: 14px 0; }
      section.active { display: block; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { border-bottom: 1px solid #e6ebf1; padding: 8px; text-align: left; vertical-align: top; }
      pre { background: #0f1724; color: #d8e2ef; border-radius: 8px; padding: 12px; overflow: auto; max-height: 360px; }
      code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <header><h1>Support Agent V2 Admin</h1></header>
    <main>
      <div class="toolbar">
        <input id="apiKey" placeholder="API key" />
        <input id="orgId" value="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />
        <input id="principalId" value="operator" />
        <input id="userId" value="demo-user" />
      </div>
      <div class="toolbar">
        <button id="saveContext">Save Context</button>
        <button id="loadContext">Load Saved</button>
        <button id="exportJson">Export JSON</button>
        <button id="exportCsv">Export CSV</button>
      </div>
      <p id="status" class="status">Ready</p>
      <nav>
        <button data-tab="explorer" class="active">Explorer</button>
        <button data-tab="graph">Graph</button>
        <button data-tab="dlq">DLQ</button>
        <button data-tab="pii">PII</button>
        <button data-tab="audit">Audit</button>
        <button data-tab="keys">API Keys</button>
      </nav>
      <section id="explorer" class="active"><button data-load="explorer">Refresh</button><div id="explorerOut"></div></section>
      <section id="graph"><button data-load="graph">Refresh</button><pre id="graphOut">{}</pre></section>
      <section id="dlq"><button data-load="dlq">Refresh</button><div id="dlqOut"></div></section>
      <section id="pii"><button data-load="pii">Refresh</button><div id="piiOut"></div></section>
      <section id="audit"><button data-load="audit">Refresh</button><div id="auditOut"></div></section>
      <section id="keys">
        <div class="toolbar"><input id="keyLabel" placeholder="service key label" /><select id="keyRole"><option>service</option><option>agent</option><option>admin</option></select><button id="createKey">Create</button></div>
        <pre id="keySecret"></pre><div id="keysOut"></div>
      </section>
    </main>
    <script>
      const headers = () => ({
        "content-type": "application/json",
        "x-api-key": document.getElementById("apiKey").value,
        "x-org-id": document.getElementById("orgId").value,
        "x-principal-id": document.getElementById("principalId").value,
        "x-role": "admin"
      });
      const userId = () => encodeURIComponent(document.getElementById("userId").value);
      let activeTab = "explorer";
      let lastData = {};
      const setStatus = (message, kind = "") => {
        const status = document.getElementById("status");
        status.textContent = message;
        status.className = "status " + kind;
      };
      const renderTable = (rows) => {
        if (!rows?.length) return "<p>No records.</p>";
        const keys = Object.keys(rows[0]);
        return "<table><thead><tr>" + keys.map((key) => "<th>" + key + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map((row) => "<tr>" + keys.map((key) => "<td>" + JSON.stringify(row[key] ?? "") + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
      };
      const load = async (name) => {
        const routes = {
          explorer: "/api/admin/memory/" + userId() + "/explorer",
          graph: "/api/admin/memory/" + userId() + "/graph",
          dlq: "/api/admin/dlq",
          pii: "/api/admin/pii?userId=" + userId(),
          audit: "/api/admin/audit",
          keys: "/api/admin/api-keys"
        };
        try {
        setStatus("Loading " + name + "...");
        const data = await fetch(routes[name], { headers: headers() }).then((res) => {
          if (!res.ok) throw new Error("Request failed with " + res.status);
          return res.json();
        });
        activeTab = name;
        lastData[name] = data;
        if (name === "explorer") document.getElementById("explorerOut").innerHTML = renderTable(data.facts ?? []);
        if (name === "graph") document.getElementById("graphOut").textContent = JSON.stringify(data, null, 2);
        if (name === "dlq") document.getElementById("dlqOut").innerHTML = renderTable(data.jobs ?? []);
        if (name === "pii") document.getElementById("piiOut").innerHTML = renderTable(data.redactions ?? []);
        if (name === "audit") document.getElementById("auditOut").innerHTML = renderTable(data.events ?? []);
        if (name === "keys") document.getElementById("keysOut").innerHTML = renderTable(data.apiKeys ?? []);
        setStatus("Loaded " + name + ".");
        } catch (error) {
          setStatus(error.message, "error");
        }
      };
      document.querySelectorAll("nav button").forEach((button) => button.addEventListener("click", () => {
        document.querySelectorAll("nav button, section").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        document.getElementById(button.dataset.tab).classList.add("active");
        activeTab = button.dataset.tab;
      }));
      document.querySelectorAll("[data-load]").forEach((button) => button.addEventListener("click", () => load(button.dataset.load)));
      document.getElementById("createKey").addEventListener("click", async () => {
        const data = await fetch("/api/admin/api-keys", { method: "POST", headers: headers(), body: JSON.stringify({ label: document.getElementById("keyLabel").value, role: document.getElementById("keyRole").value }) }).then((res) => res.json());
        document.getElementById("keySecret").textContent = JSON.stringify(data, null, 2);
        await load("keys");
      });
      document.getElementById("saveContext").addEventListener("click", () => {
        localStorage.setItem("supportAdminContext", JSON.stringify({
          apiKey: document.getElementById("apiKey").value,
          orgId: document.getElementById("orgId").value,
          principalId: document.getElementById("principalId").value,
          userId: document.getElementById("userId").value
        }));
        setStatus("Saved operator context.");
      });
      document.getElementById("loadContext").addEventListener("click", () => {
        const saved = JSON.parse(localStorage.getItem("supportAdminContext") || "{}");
        for (const key of ["apiKey", "orgId", "principalId", "userId"]) if (saved[key]) document.getElementById(key).value = saved[key];
        setStatus("Loaded saved operator context.");
      });
      const download = (name, text, type) => {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        URL.revokeObjectURL(url);
      };
      document.getElementById("exportJson").addEventListener("click", () => download("support-" + activeTab + ".json", JSON.stringify(lastData[activeTab] ?? {}, null, 2), "application/json"));
      document.getElementById("exportCsv").addEventListener("click", () => {
        const data = lastData[activeTab] ?? {};
        const rows = data.facts ?? data.jobs ?? data.redactions ?? data.events ?? data.apiKeys ?? [];
        if (!rows.length) return setStatus("No rows to export.", "error");
        const keys = Object.keys(rows[0]);
        const csv = [keys.join(","), ...rows.map((row) => keys.map((key) => JSON.stringify(row[key] ?? "")).join(","))].join("\\n");
        download("support-" + activeTab + ".csv", csv, "text/csv");
      });
    </script>
  </body>
</html>`;
}
