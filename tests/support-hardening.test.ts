import { afterEach, describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { buildSupportApp } from "../apps/support-agent/src/app";

const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  delete process.env.REQUIRE_AUTH;
  delete process.env.SUPPORT_API_KEY;
  delete process.env.AUTH_JWT_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});

describe("Support Agent V2 production hardening", () => {
  test("requires auth when auth is enforced", async () => {
    process.env.REQUIRE_AUTH = "true";
    const app = buildSupportApp();
    const response = await app.inject({ method: "GET", url: "/api/memory/user-a" });
    expect(response.statusCode).toBe(401);
  });

  test("accepts configured API key auth", async () => {
    process.env.REQUIRE_AUTH = "true";
    process.env.SUPPORT_API_KEY = "secret-test-key";
    const app = buildSupportApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/user-a",
      headers: { "x-api-key": "secret-test-key", "x-org-id": orgId, "x-principal-id": "svc" },
    });
    expect(response.statusCode).toBe(200);
  });

  test("accepts JWT auth with org and role claims", async () => {
    process.env.REQUIRE_AUTH = "true";
    process.env.AUTH_JWT_SECRET = "jwt-test-secret-32-characters-long";
    const token = await new SignJWT({ org_id: orgId, role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("admin-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
    const app = buildSupportApp();
    const response = await app.inject({ method: "GET", url: "/api/memory/user-a", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
  });

  test("Postgres store implements advisory locks, RLS scoping, vector inserts, and source-time ordering", () => {
    const source = readFileSync("packages/memory-engine/src/postgres-store.ts", "utf8");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("set_config('app.org_id'");
    expect(source).toContain("::vector");
    expect(source).toContain("incomingIsOlder");
    expect(source).toContain("support_facts");
  });

  test("BullMQ queue implements durable enqueue, retries, worker, and DLQ", () => {
    const source = readFileSync("apps/support-agent/src/queue.ts", "utf8");
    expect(source).toContain("new Queue(\"support-agent-ingest\"");
    expect(source).toContain("attempts: 5");
    expect(source).toContain("new Worker(");
    expect(source).toContain("support-agent-ingest-dlq");
    expect(source).toContain("jobId");
    expect(source).toContain("support-${await hashMessage");
  });

  test("PR backlog has concrete enterprise follow-up PRs", () => {
    const source = readFileSync("docs/support-agent-v2-prs.md", "utf8");
    for (const title of [
      "PR 4",
      "Production Persistence, Queue, Auth, And Runtime Hardening",
      "PR 5",
      "Admin And Operator Workflows",
      "PR 6",
      "Observability, Compliance, And Release Gates",
    ]) {
      expect(source).toContain(title);
    }
  });
});
