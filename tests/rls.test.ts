import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setTenantSql } from "../apps/api/src/tenant";

describe("RLS", () => {
  test("migration enables RLS and tenant policies", () => {
    const migration = readFileSync("packages/db/migrations/0000_initial_rls.sql", "utf8");
    for (const table of ["vendors", "purchase_orders", "invoices", "agent_events"]) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
    }
    expect(migration).toContain("current_setting('app.tenant_id', true)::uuid");
  });

  test("tenant middleware SQL uses transaction-local setting", () => {
    expect(setTenantSql("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toContain("set_config('app.tenant_id'");
    expect(setTenantSql("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toContain("true");
  });
});

