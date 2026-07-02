import { describe, expect, test } from "bun:test";
import { buildSupportApp } from "../apps/support-agent/src/app";
import { setOrgSql } from "../apps/support-agent/src/auth";
import { readFileSync } from "node:fs";

const headers = {
  "content-type": "application/json",
  "x-org-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-principal-id": "api-test",
  "x-role": "admin",
};

describe("Support Agent V2 API and RLS", () => {
  test("serves health, readiness, metrics, demo, type lists, reset, and admin shell", async () => {
    const app = buildSupportApp();
    expect((await app.inject("/health/live")).json().ok).toBe(true);
    expect((await app.inject("/health/ready")).json().ok).toBe(true);

    const demo = await app.inject({ method: "POST", url: "/api/demo/run", headers, payload: { name: "demo", userId: "api-user" } });
    expect(demo.json().facts.length).toBeGreaterThan(0);

    const facts = await app.inject({ method: "GET", url: "/api/memory/api-user/fact", headers });
    expect(facts.json().items.length).toBeGreaterThan(0);

    const episodes = await app.inject({ method: "GET", url: "/api/memory/api-user/episode", headers });
    expect(episodes.json().items.length).toBeGreaterThan(0);

    const artifacts = await app.inject({ method: "GET", url: "/api/memory/api-user/artifact", headers });
    expect(artifacts.json().items.length).toBeGreaterThan(0);

    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
    const admin = await app.inject({ method: "GET", url: "/admin", headers });
    expect(admin.body).toContain("Support Agent V2 Admin");
    expect(admin.body).toContain("data-tab=\"explorer\"");
    expect(admin.body).toContain("data-load=\"dlq\"");
    expect(admin.body).toContain("exportJson");
    expect(admin.body).toContain("localStorage");

    const reset = await app.inject({ method: "DELETE", url: "/api/memory/api-user", headers });
    expect(reset.json().ok).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/memory/api-user", headers })).json().facts).toHaveLength(0);
  });

  test("RLS migration has pgvector, org policy, uniqueness, and active-slot invariant", () => {
    const migration = readFileSync("packages/support-db/migrations/0000_support_agent_v2.sql", "utf8");
    expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(migration).toContain("support_one_active_per_slot");
    expect(migration).toContain("support_uniq_content");
    expect(migration).toContain("CREATE ROLE support_app_user LOGIN");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    for (const table of ["support_users", "support_facts", "support_episodes", "support_artifacts", "support_audit_logs", "support_api_keys", "support_ingest_jobs"]) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY org_isolation ON ${table}`);
    }
    expect(setOrgSql("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toContain("set_config('app.org_id'");
  });
});
