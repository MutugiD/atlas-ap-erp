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

  test("vendors are tenant-isolated and a payment hold excludes the invoice", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const heldVendor = await repo.createVendor(ctxA, { name: "Held", currency: "USD", active: true, holdPayments: true, paymentTermsDays: 30, defaultExpenseAccount: "6100" });

    // Vendor master is tenant-scoped: B cannot see A's vendor.
    expect(await repo.getVendor(ctxB, heldVendor.id)).toBeUndefined();
    expect(await repo.listVendors(ctxB)).toHaveLength(0);

    const { invoice } = await repo.createInvoice(ctxA, { invoiceNumber: "V-HOLD", total: 400, currency: "USD", vendorId: heldVendor.id });
    expect(invoice.vendorId).toBe(heldVendor.id);
    await repo.updateInvoice(ctxA, { ...invoice, status: "queued_for_payment" });

    const run = await repo.createPaymentRun(ctxA, "2099-12-31");
    expect(run.payments).toHaveLength(0);
    expect(run.excluded.some((e) => e.invoiceId === invoice.id && e.reason === "Vendor payment hold")).toBe(true);

    await appPool.end();
  });

  test("purchase order + goods receipt persist and drive a clean three-way match", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const vendor = await repo.createVendor(ctxA, { name: "Widgets Co", currency: "USD", active: true, holdPayments: false, paymentTermsDays: 30, defaultExpenseAccount: "6100" });
    const po = await repo.createPurchaseOrder(ctxA, { poNumber: "PO-L1", vendorId: vendor.id, currency: "USD", lines: [{ description: "Widgets", quantity: 1, unitPrice: 1000, total: 1000 }] });
    expect(po.total).toBe(1000);

    // PO + receipts are tenant-isolated.
    expect(await repo.getPurchaseOrder(ctxB, po.id)).toBeUndefined();

    await repo.createGoodsReceipt(ctxA, { poId: po.id, description: "Widgets", quantityReceived: 1 });
    expect(await repo.listGoodsReceipts(ctxA, po.id)).toHaveLength(1);
    expect(await repo.listGoodsReceipts(ctxB, po.id)).toHaveLength(0);

    const { invoice } = await repo.createInvoice(ctxA, { vendorName: "Widgets", vendorId: vendor.id, invoiceNumber: "PO-L-INV", total: 1000, currency: "USD", poId: po.id });
    expect(invoice.poId).toBe(po.id);

    const match = await repo.matchInvoice(ctxA, invoice.id);
    expect(match.ok).toBe(true);
    expect(match.amountVariance).toBe(0);

    await appPool.end();
  });

  test("a closed accounting period blocks posting until reopened", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const period = await repo.createAccountingPeriod(ctxA, { name: "FY", startsOn: "2020-01-01", endsOn: "2099-12-31" });
    expect(await repo.listAccountingPeriods(ctxB)).toHaveLength(0); // RLS
    await repo.setPeriodStatus(ctxA, period.id, "closed");

    const { invoice } = await repo.createInvoice(ctxA, { invoiceNumber: "PER-L", total: 100, currency: "USD" });
    await expect(repo.updateInvoice(ctxA, { ...invoice, status: "posted" })).rejects.toThrow(/closed/i);
    expect(await scalar(appPool, tenantA, "select count(*)::int from gl_journal_entries")).toBe(0);

    await repo.setPeriodStatus(ctxA, period.id, "open");
    const posted = await repo.updateInvoice(ctxA, { ...invoice, status: "posted" });
    expect(posted.status).toBe("posted");
    expect(await scalar(appPool, tenantA, "select count(*)::int from gl_journal_entries where source = 'invoice_posting'")).toBe(1);

    await appPool.end();
  });

  test("credit memos apply to an invoice and persist balances (RLS-scoped)", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const vendor = await repo.createVendor(ctxA, { name: "Credit Vendor", currency: "USD", active: true, holdPayments: false, paymentTermsDays: 30, defaultExpenseAccount: "6100" });
    const { invoice } = await repo.createInvoice(ctxA, { vendorId: vendor.id, invoiceNumber: "CM-L", total: 1000, currency: "USD" });
    const memoA = await repo.createCreditMemo(ctxA, { vendorId: vendor.id, amount: 300, currency: "USD" });
    const memoB = await repo.createCreditMemo(ctxA, { vendorId: vendor.id, amount: 800, currency: "USD" });

    expect(await repo.listCreditMemos(ctxB)).toHaveLength(0); // RLS

    const result = await repo.applyAvailableCredits(ctxA, invoice.id);
    expect(result.netPayable).toBe(0);
    expect(await scalar(appPool, tenantA, "select count(*)::int from credit_memo_applications")).toBe(2);

    const memos = await repo.listCreditMemos(ctxA);
    expect(memos.find((m) => m.id === memoA.id)?.status).toBe("applied");
    expect(memos.find((m) => m.id === memoB.id)?.amount).toBe(100);

    await appPool.end();
  });

  test("partial payments persist and reduce the outstanding balance (RLS-scoped)", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const { invoice } = await repo.createInvoice(ctxA, { invoiceNumber: "PP-L", total: 1000, currency: "USD" });
    await repo.updateInvoice(ctxA, { ...invoice, status: "queued_for_payment" });

    const first = await repo.executePartialPayment(ctxA, invoice.id, 400);
    expect(first.executed).toBe(true);
    expect(first.outstanding).toBe(600);

    expect(await repo.listPartialPayments(ctxB, invoice.id)).toHaveLength(0); // RLS
    expect(await repo.listPartialPayments(ctxA, invoice.id)).toHaveLength(1);
    expect(await scalar(appPool, tenantA, "select count(*)::int from partial_payments")).toBe(1);

    const second = await repo.executePartialPayment(ctxA, invoice.id, 700);
    expect(second.plan.paymentAmount).toBe(600);
    expect(second.outstanding).toBe(0);

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
      gl_journal_lines, gl_journal_entries, goods_receipts, accounting_periods,
      credit_memo_applications, credit_memos, partial_payments, agent_events,
      invoices, purchase_orders, vendors, tenants cascade;
    drop role if exists app_user;
  `);
  for (const m of [
    "0000_initial_rls",
    "0001_api_app_role",
    "0002_vendor_master",
    "0003_po_goods_receipts",
    "0004_accounting_periods",
    "0005_credit_memos",
    "0006_partial_payments",
  ]) {
    await owner.query(readFileSync(`packages/db/migrations/${m}.sql`, "utf8"));
  }
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
