import { Counter, Gauge, Histogram, Registry } from "prom-client";

export const registry = new Registry();

export const chatRequests = new Counter({
  name: "support_chat_requests_total",
  help: "Total Support Agent chat requests",
  labelNames: ["mode"],
  registers: [registry],
});

export const memoryIngest = new Counter({
  name: "memory_ingest_total",
  help: "Memory ingest results",
  labelNames: ["result"],
  registers: [registry],
});

export const supersessions = new Counter({
  name: "memory_supersession_total",
  help: "Facts superseded by belief revision",
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: "ingest_queue_depth",
  help: "Current ingest queue depth",
  registers: [registry],
});

export const dlqDepth = new Gauge({
  name: "ingest_dlq_total",
  help: "Current dead-letter queue depth",
  registers: [registry],
});

export const routeDuration = new Histogram({
  name: "support_route_duration_seconds",
  help: "Support Agent route duration",
  labelNames: ["method", "route"],
  buckets: [0.05, 0.1, 0.2, 0.4, 1, 2],
  registers: [registry],
});
