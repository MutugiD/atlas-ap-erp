import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import type { TenantContext } from "@atlas/contracts";
import { PostgresInvoiceRepository } from "../apps/api/src/postgres-repository";
import { Supervisor } from "@atlas/agents";

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

    const heldVendor = await repo.createVendor(ctxA, { name: "Held", currency: "USD", active: true, holdPayments: true, paymentTermsDays: 30, defaultExpenseAccount: "6100", withholdingTaxRate: 0 });

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

    const vendor = await repo.createVendor(ctxA, { name: "Widgets Co", currency: "USD", active: true, holdPayments: false, paymentTermsDays: 30, defaultExpenseAccount: "6100", withholdingTaxRate: 0 });
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

    const vendor = await repo.createVendor(ctxA, { name: "Credit Vendor", currency: "USD", active: true, holdPayments: false, paymentTermsDays: 30, defaultExpenseAccount: "6100", withholdingTaxRate: 0 });
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

  test("payment run persists withholding-tax lines for a WHT vendor", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const vendor = await repo.createVendor(ctxA, { name: "WHT", currency: "USD", active: true, holdPayments: false, paymentTermsDays: 30, defaultExpenseAccount: "6100", withholdingTaxRate: 0.1 });
    const { invoice } = await repo.createInvoice(ctxA, { vendorId: vendor.id, invoiceNumber: "WHT-L", total: 1000, currency: "USD" });
    await repo.updateInvoice(ctxA, { ...invoice, status: "queued_for_payment" });

    const run = await repo.createPaymentRun(ctxA, "2099-12-31");
    expect(run.payments[0]?.withheldTax).toBe(100);

    const whtCredit = await scalar(appPool, tenantA, "select coalesce(sum(credit),0)::float from gl_journal_lines where account = '2150'");
    expect(whtCredit).toBe(100);
    const cashCredit = await scalar(appPool, tenantA, "select coalesce(sum(credit),0)::float from gl_journal_lines where account = '1000'");
    expect(cashCredit).toBe(900);

    await appPool.end();
  });

  test("realized FX posts and persists a balanced fx_realization journal", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const { invoice } = await repo.createInvoice(ctxA, { invoiceNumber: "FX-L", total: 1000, currency: "EUR" });
    const fx = await repo.realizeFx(ctxA, { invoiceId: invoice.id, functionalCurrency: "USD", invoiceFxRate: 1.2, paymentFxRate: 1.1 });
    expect(fx.account).toBe("realized_fx_gain");
    expect(fx.journal.balanced).toBe(true);

    expect(await scalar(appPool, tenantA, "select count(*)::int from gl_journal_entries where source = 'fx_realization'")).toBe(1);
    const gain = await scalar(appPool, tenantA, "select coalesce(sum(credit),0)::float from gl_journal_lines where account = '7200'");
    expect(gain).toBe(100);

    await appPool.end();
  });

  test("issuing a debit memo persists the memo and a balanced debit_memo journal (RLS-scoped)", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    const vendor = await repo.createVendor(ctxA, { name: "Return", currency: "USD", active: true, holdPayments: false, paymentTermsDays: 30, defaultExpenseAccount: "6100", withholdingTaxRate: 0 });
    const { journal } = await repo.createDebitMemo(ctxA, { vendorId: vendor.id, amount: 250, currency: "USD", reason: "Return" });
    expect(journal.balanced).toBe(true);

    expect(await repo.listDebitMemos(ctxB)).toHaveLength(0); // RLS
    expect(await repo.listDebitMemos(ctxA)).toHaveLength(1);
    expect(await scalar(appPool, tenantA, "select count(*)::int from gl_journal_entries where source = 'debit_memo'")).toBe(1);
    expect(await scalar(appPool, tenantA, "select coalesce(sum(debit),0)::float from gl_journal_lines where account = '2100'")).toBe(250);

    await appPool.end();
  });

  test("end-to-end invoice-to-pay against Postgres: agent pipeline, posting, payment, bank reconciliation", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });
    const supervisor = new Supervisor();

    // Vendor + PO + goods receipt, then an invoice referencing them.
    const vendor = await repo.createVendor(ctxA, { name: "Acme Corp", currency: "USD", active: true, holdPayments: false, paymentTermsDays: 30, defaultExpenseAccount: "6100", withholdingTaxRate: 0 });
    const po = await repo.createPurchaseOrder(ctxA, { poNumber: "E2E-PO", vendorId: vendor.id, currency: "USD", lines: [{ description: "Acme Corp", quantity: 1, unitPrice: 1200, total: 1200 }] });
    await repo.createGoodsReceipt(ctxA, { poId: po.id, description: "Acme Corp", quantityReceived: 1 });
    const { invoice } = await repo.createInvoice(ctxA, { vendorName: "Acme Corp", vendorId: vendor.id, poId: po.id, invoiceNumber: "E2E-INV", total: 1200, currency: "USD" });

    // Three-way match before processing (raw amounts align with the PO/receipt).
    const match = await repo.matchInvoice(ctxA, invoice.id);
    expect(match.ok).toBe(true);
    expect(match.amountVariance).toBe(0);

    // The real agent supervisor drives the invoice to payable and persists events.
    const result = await supervisor.process(ctxA, invoice, repo);
    expect(result.invoice.status).toBe("queued_for_payment");
    expect((await repo.listEvents(ctxA, invoice.id)).length).toBeGreaterThan(0);

    // The posting transition persisted a balanced invoice_posting journal.
    const [postDebit, postCredit] = await debitCredit(appPool, tenantA, "invoice_posting");
    expect(postDebit).toBe(postCredit);
    expect(postDebit).toBeGreaterThan(0);

    // Payment run pays the processed invoice and persists a balanced journal.
    const processed = await repo.getInvoice(ctxA, invoice.id);
    if (!processed) throw new Error("expected the processed invoice");
    const run = await repo.createPaymentRun(ctxA, "2099-12-31");
    const payment = run.payments.find((p) => p.invoiceId === invoice.id);
    if (!payment) throw new Error("expected a payment for the invoice");
    expect(payment.amount).toBe(processed.total);
    expect(await scalar(appPool, tenantA, "select count(*)::int from payments")).toBeGreaterThan(0);
    const [payDebit, payCredit] = await debitCredit(appPool, tenantA, "payment_run");
    expect(payDebit).toBe(payCredit);

    // Bank integration: reconcile the disbursement against a bank statement line.
    const recon = await repo.reconcilePayments(ctxA, [
      { id: "aaaaaaaa-0000-4000-8000-00000000e2e1", amount: -payment.amount, currency: "USD", valueDate: "2099-12-31", reference: `ACH ${invoice.id.slice(0, 8)}` },
    ]);
    expect(recon.matched).toHaveLength(1);
    expect(recon.matched[0].paymentId).toBe(payment.id);
    expect(await scalar(appPool, tenantA, "select count(*)::int from reconciliations")).toBe(1);
    expect(await scalar(appPool, tenantA, "select count(*)::int from bank_transactions")).toBe(1);

    await appPool.end();
  });

  test("profitability inputs are tenant-scoped and compute a report on Postgres", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    await repo.createProfitabilityInput(ctxA, { period: "2026-06", account: "Acme", serviceLine: "SEO", feeRevenue: 1000, laborHours: 10, laborCostRate: 30, mediaSpend: 500, mediaMarkupRate: 0.2 });
    await repo.createProfitabilityInput(ctxA, { period: "2026-06", account: "Beta", serviceLine: "SEO", feeRevenue: 2000, laborHours: 20, laborCostRate: 40, mediaSpend: 0, mediaMarkupRate: 0 });

    expect(await repo.listProfitabilityInputs(ctxB, "2026-06")).toHaveLength(0); // RLS
    expect(await repo.listProfitabilityInputs(ctxA, "2026-06")).toHaveLength(2);

    const { report } = await repo.profitabilityReport(ctxA, { period: "2026-06", overheadPool: 300, overheadBasis: "labor" });
    expect(report.slices).toHaveLength(2);
    expect(report.total.revenue).toBe(3600); // 1600 (Acme, media marked up) + 2000 (Beta)
    expect(report.total.overhead).toBe(300);

    await appPool.end();
  });

  test("generates and persists a profitability report artifact (RLS-scoped)", async () => {
    const appPool = await freshSchema();
    const repo = new PostgresInvoiceRepository({ pool: appPool });

    await repo.createProfitabilityInput(ctxA, { period: "2026-06", account: "Acme", serviceLine: "SEO", feeRevenue: 1000, laborHours: 10, laborCostRate: 30, mediaSpend: 500, mediaMarkupRate: 0.2 });
    await repo.createProfitabilityInput(ctxA, { period: "2026-06", account: "Beta", serviceLine: "SEO", feeRevenue: 2000, laborHours: 20, laborCostRate: 40, mediaSpend: 0, mediaMarkupRate: 0 });

    const record = await repo.generateProfitabilityReport(ctxA, { period: "2026-06", overheadPool: 300, overheadBasis: "labor" });
    expect((record.summary as { total: { revenue: number } }).total.revenue).toBe(3600);

    expect(await repo.listProfitabilityReports(ctxB)).toHaveLength(0); // RLS
    expect(await repo.listProfitabilityReports(ctxA)).toHaveLength(1);
    const fetched = await repo.getProfitabilityReport(ctxA, record.id);
    expect(fetched?.id).toBe(record.id);
    expect(await scalar(appPool, tenantA, "select count(*)::int from profitability_reports")).toBe(1);

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
      credit_memo_applications, credit_memos, debit_memos, partial_payments,
      profitability_reports, profitability_inputs, agent_events, invoices, purchase_orders, vendors, tenants cascade;
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
    "0007_vendor_withholding_tax",
    "0008_debit_memos",
    "0009_profitability",
    "0010_profitability_reports",
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
