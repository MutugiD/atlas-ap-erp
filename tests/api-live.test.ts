import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import type { TenantContext } from "@atlas/contracts";
import { PostgresInvoiceRepository } from "../apps/api/src/postgres-repository";

const live = process.env.RUN_LIVE_API_TESTS === "true";
const describeLive = live ? describe : describe.skip;
const ownerUrl = process.env.DATABASE_URL ?? "postgresql://atlas_owner:atlas_owner@localhost:5432/atlas_ap";
const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const user = "22222222-2222-4222-8222-222222222222";
const ctxA: TenantContext = { tenantId: tenantA, userId: user, role: "ap_clerk" };
const ctxB: TenantContext = { tenantId: tenantB, userId: user, role: "ap_clerk" };

describeLive("Atlas AP live Postgres persistence", () => {
  test("app-role RLS isolates invoices across tenants", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    await repo.createInvoice(ctxA, { vendorName: "Acme", invoiceNumber: "INV-A1", total: 1000, currency: "USD" });
    expect((await repo.listInvoices(ctxA)).length).toBe(1);

    // Tenant B must see none of A's rows — through the repository and raw SQL.
    expect(await repo.listInvoices(ctxB)).toHaveLength(0);
    expect(await countInvoices(appPool, tenantB)).toBe(0);
    expect(await countInvoices(appPool, tenantA)).toBe(1);

    await appPool.end();
  });

  test("payment run persists payments and a balanced GL journal", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const { invoice } = await repo.createInvoice(ctxA, { vendorName: "Acme", invoiceNumber: "INV-A2", total: 500, currency: "USD" });
    // Move the invoice to a payable state so the run picks it up. The invoice's
    // due date maps from updated_at (today), so schedule on/after that.
    await repo.updateInvoice(ctxA, { ...invoice, status: "queued_for_payment" });

    const run = await repo.createPaymentRun(ctxA, "2099-12-31");
    expect(run.payments.length).toBe(1);

    expect(await scalar(appPool, tenantA, "select count(*)::int from payments")).toBe(1);
    expect(await scalar(appPool, tenantA, "select count(*)::int from payment_runs")).toBe(1);
    // The persisted payment-run journal balances.
    const [debit, credit] = await debitCredit(appPool, tenantA, "payment_run");
    expect(debit).toBe(credit);
    expect(debit).toBeGreaterThan(0);

    await appPool.end();
  });

  test("posting transition persists a balanced invoice_posting journal", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const { invoice } = await repo.createInvoice(ctxA, { vendorName: "Acme", invoiceNumber: "INV-A3", total: 800, currency: "USD" });
    await repo.updateInvoice(ctxA, { ...invoice, status: "posted" });

    expect(await scalar(appPool, tenantA, "select count(*)::int from gl_journal_entries where source = 'invoice_posting'")).toBe(1);
    const [debit, credit] = await debitCredit(appPool, tenantA, "invoice_posting");
    expect(debit).toBe(credit);
    expect(debit).toBe(800);

    await appPool.end();
  });
});

// --- helpers -------------------------------------------------------------

async function freshSchema(): Promise<Pool> {
  const owner = new Pool({ connectionString: ownerUrl });
  await owner.query(`
    drop table if exists reconciliations, bank_transactions, payments, payment_runs,
      gl_journal_lines, gl_journal_entries, agent_events, invoices, purchase_orders,
      vendors, tenants cascade;
    drop role if exists app_user;
  `);
  await owner.query(readFileSync("packages/db/migrations/0000_initial_rls.sql", "utf8"));
  await owner.query(readFileSync("packages/db/migrations/0001_api_app_role.sql", "utf8"));
  await owner.query("insert into tenants (id, name) values ($1, $2), ($3, $4)", [tenantA, "Tenant A", tenantB, "Tenant B"]);
  await owner.end();
  return new Pool({ connectionString: appRoleUrl(ownerUrl) });
}

function appRoleUrl(url: string) {
  const parsed = new URL(url);
  parsed.username = "app_user";
  parsed.password = "app_user";
  return parsed.toString();
}

async function withTenant<T>(pool: Pool, tenantId: string, fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function countInvoices(pool: Pool, tenantId: string) {
  return scalar(pool, tenantId, "select count(*)::int from invoices");
}

async function scalar(pool: Pool, tenantId: string, sql: string): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query(sql);
    return Number(Object.values(result.rows[0])[0]);
  });
}

async function debitCredit(pool: Pool, tenantId: string, source: string): Promise<[number, number]> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query(
      `select coalesce(sum(l.debit),0)::float as debit, coalesce(sum(l.credit),0)::float as credit
       from gl_journal_lines l join gl_journal_entries e on e.id = l.journal_entry_id
       where e.source = $1`,
      [source],
    );
    return [Number(result.rows[0].debit), Number(result.rows[0].credit)];
  });
}
