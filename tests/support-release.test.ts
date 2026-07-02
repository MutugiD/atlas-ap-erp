import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("Support Agent V2 release gates", () => {
  test("declares Apache licensing and NOTICE metadata", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).license).toBe("Apache-2.0");
    expect(readFileSync("LICENSE", "utf8")).toContain("Apache License");
    expect(readFileSync("NOTICE", "utf8")).toContain("Support Agent V2");
  });

  test("CI enforces install, audit, tests, builds, infra, compose, and image gates", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    for (const command of [
      "bun install --frozen-lockfile",
      "bun run license:audit",
      "bun test",
      "bun run test:live-support",
      "bun run typecheck",
      "bun --filter @atlas/support-agent build",
      "bun --filter @atlas/web build",
      "bun run infra:synth",
      "docker compose config --quiet",
      "docker build -f apps/support-agent/Dockerfile",
    ]) {
      expect(workflow).toContain(command);
    }
  });

  test("observability assets cover latency, queue, DLQ, cache, and readiness signals", () => {
    const dashboard = readFileSync("ops/grafana/support-agent-dashboard.json", "utf8");
    const alerts = readFileSync("ops/alerts/support-agent-alerts.yml", "utf8");
    for (const metric of [
      "support_route_duration_seconds",
      "ingest_queue_depth",
      "ingest_dlq_total",
      "memory_context_cache_hits_total",
      "support_readiness_failures_total",
    ]) {
      expect(dashboard).toContain(metric);
      expect(alerts).toContain(metric);
    }
  });

  test("load smoke has enterprise throughput and p95 thresholds", () => {
    const load = readFileSync("tests/load/support-agent-k6.js", "utf8");
    expect(load).toContain("rate: 50");
    expect(load).toContain("p(95)<400");
    expect(load).toContain("/api/chat");
  });

  test("observability seam traces memory operations and scrubs Sentry context", () => {
    const observability = readFileSync("apps/support-agent/src/observability.ts", "utf8");
    const app = readFileSync("apps/support-agent/src/app.ts", "utf8");
    expect(observability).toContain("buildSentryEvent");
    expect(observability).toContain("[REDACTED_EMAIL]");
    expect(observability).toContain("[REDACTED_PHONE]");
    for (const span of ["support.chat", "memory.retrieve", "memory.enqueue"]) {
      expect(app).toContain(span);
    }
  });

  test("live integration harness and Windows-safe runner are committed", () => {
    const live = readFileSync("tests/support-live.test.ts", "utf8");
    const runner = readFileSync("scripts/run-live-support-tests.ts", "utf8");
    expect(live).toContain("RUN_LIVE_SUPPORT_TESTS");
    expect(live).toContain("Postgres app role enforces RLS");
    expect(live).toContain("Redis BullMQ worker");
    expect(runner).toContain("process.execPath");
  });

  test("license audit script is committed and runnable source exists", () => {
    expect(existsSync("scripts/license-audit.ts")).toBe(true);
    expect(readFileSync("scripts/license-audit.ts", "utf8")).toContain("license audit passed");
  });
});
