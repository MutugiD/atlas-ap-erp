import {
  type AgentEvent,
  type CreateInvoiceInput,
  type CreateVendorInput,
  type Invoice,
  type TenantContext,
  type UpdateVendorInput,
  type Vendor,
} from "@atlas/contracts";
import {
  applyCreditMemos,
  buildApAging,
  buildInvoicePostingJournal,
  calculateRealizedFx,
  createPaymentRun,
  createPartialPaymentPlan,
  reconcileBankTransactions,
  type BankTransaction,
  type CreditMemo,
  type JournalEntry,
  type Payment,
} from "@atlas/accounting";
import { Pool, type PoolClient } from "pg";
import type { InvoiceRepository } from "./repository";
import { toAccountingInvoice, toVendorMaster, vendorMastersForInvoices } from "./mappers";

// Postgres-backed AP repository. Mirrors the transaction + RLS pattern used by
// PostgresNativeStore in the memory engine: every unit of work runs inside a
// transaction that first scopes app.tenant_id so row-level security applies.
export interface PostgresInvoiceRepositoryOptions {
  connectionString?: string;
  pool?: Pool;
}

export class PostgresInvoiceRepository implements InvoiceRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresInvoiceRepositoryOptions = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL });
    this.ownsPool = !options.pool;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
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

  async createInvoice(ctx: TenantContext, input: CreateInvoiceInput) {
    const id = crypto.randomUUID();
    const invoice = await this.tx(ctx.tenantId, async (client) => {
      // po_id / vendor_id have FKs; PO CRUD is not implemented yet and a vendor
      // may not exist, so only persist ids that actually resolve for this tenant.
      let poId: string | null = null;
      if (input.poId) {
        const po = await client.query("select id from purchase_orders where id = $1 and tenant_id = $2", [input.poId, ctx.tenantId]);
        poId = po.rowCount ? input.poId : null;
      }
      let vendorId: string | null = null;
      let vendorName: string | null = input.vendorName ?? null;
      if (input.vendorId) {
        const vendor = await client.query("select id, name from vendors where id = $1 and tenant_id = $2", [input.vendorId, ctx.tenantId]);
        if (vendor.rowCount) {
          vendorId = input.vendorId;
          vendorName = vendorName ?? String(vendor.rows[0].name);
        }
      }
      const result = await client.query(
        `insert into invoices (id, tenant_id, vendor_id, po_id, source_object_key, invoice_number, vendor_name, status, total, currency)
         values ($1,$2,$3,$4,$5,$6,$7,'received',$8,$9)
         returning *`,
        [id, ctx.tenantId, vendorId, poId, input.sourceObjectKey ?? null, input.invoiceNumber ?? null, vendorName, String(input.total), input.currency],
      );
      return rowToInvoice(result.rows[0]);
    });
    return { invoice, uploadUrl: `s3://local-atlas-ap/${ctx.tenantId}/${id}.pdf` };
  }

  async listInvoices(ctx: TenantContext) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from invoices where tenant_id = $1 order by created_at asc", [ctx.tenantId]);
      return result.rows.map(rowToInvoice);
    });
  }

  async getInvoice(ctx: TenantContext, id: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from invoices where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, id]);
      return result.rows[0] ? rowToInvoice(result.rows[0]) : undefined;
    });
  }

  async listExceptions(ctx: TenantContext) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from invoices where tenant_id = $1 and status = 'exception' order by created_at asc", [ctx.tenantId]);
      return result.rows.map(rowToInvoice);
    });
  }

  async listEvents(ctx: TenantContext, invoiceId: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from agent_events where tenant_id = $1 and invoice_id = $2 order by created_at asc", [ctx.tenantId, invoiceId]);
      return result.rows.map(rowToEvent);
    });
  }

  async listInvoiceNumbers(ctx: TenantContext, excludeInvoiceId: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query(
        "select invoice_number from invoices where tenant_id = $1 and id <> $2 and invoice_number is not null",
        [ctx.tenantId, excludeInvoiceId],
      );
      return result.rows.map((row) => String(row.invoice_number));
    });
  }

  async updateInvoice(ctx: TenantContext, invoice: Invoice) {
    if (invoice.tenantId !== ctx.tenantId) throw new Error("Tenant mismatch");
    return this.tx(ctx.tenantId, async (client) => {
      const prior = await client.query("select status from invoices where tenant_id = $1 and id = $2", [ctx.tenantId, invoice.id]);
      const result = await client.query(
        `update invoices set status=$3, vendor_name=$4, invoice_number=$5, total=$6, currency=$7,
           extracted=$8::jsonb, confidence=$9, updated_at=now()
         where tenant_id=$1 and id=$2 returning *`,
        [
          ctx.tenantId,
          invoice.id,
          invoice.status,
          invoice.vendorName ?? null,
          invoice.invoiceNumber ?? null,
          String(invoice.total),
          invoice.currency,
          invoice.extracted ? JSON.stringify(invoice.extracted) : null,
          invoice.confidence ?? null,
        ],
      );
      if (!result.rowCount) throw new Error("Invoice not found");
      const updated = rowToInvoice(result.rows[0]);
      // Persist the balanced posting journal exactly once, at the moment the
      // invoice actually transitions into 'posted'.
      const wasPosted = prior.rows[0]?.status === "posted";
      if (updated.status === "posted" && !wasPosted) {
        const journal = buildInvoicePostingJournal({ tenantId: ctx.tenantId, invoice: toAccountingInvoice(updated), vendor: toVendorMaster(updated) });
        await persistJournal(client, ctx.tenantId, journal);
      }
      return updated;
    });
  }

  async addEvent(ctx: TenantContext, event: Omit<AgentEvent, "id" | "createdAt">) {
    return this.tx(ctx.tenantId, async (client) => insertEvent(client, event));
  }

  async humanDecision(ctx: TenantContext, invoiceId: string, action: "approve" | "reject") {
    return this.tx(ctx.tenantId, async (client) => {
      const found = await client.query("select id from invoices where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, invoiceId]);
      if (!found.rowCount) throw new Error("Invoice not found");
      const status = action === "approve" ? "approved" : "rejected";
      const result = await client.query("update invoices set status=$3, updated_at=now() where tenant_id=$1 and id=$2 returning *", [ctx.tenantId, invoiceId, status]);
      await insertEvent(client, {
        tenantId: ctx.tenantId,
        invoiceId,
        agent: "approval_routing",
        actor: "human",
        input: { action },
        output: { status },
        tokens: 0,
        latencyMs: 0,
      });
      return rowToInvoice(result.rows[0]);
    });
  }

  async previewPosting(ctx: TenantContext, invoiceId: string): Promise<JournalEntry> {
    const invoice = await this.getInvoice(ctx, invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    // Pure preview — no persistence. The journal is persisted at posting time
    // (see updateInvoice), which is the state change that actually posts to GL.
    return buildInvoicePostingJournal({ tenantId: ctx.tenantId, invoice: toAccountingInvoice(invoice), vendor: toVendorMaster(invoice) });
  }

  async createPaymentRun(ctx: TenantContext, scheduledDate: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const invoicesResult = await client.query("select * from invoices where tenant_id = $1", [ctx.tenantId]);
      const invoices = invoicesResult.rows.map(rowToInvoice).map(toAccountingInvoice);
      const vendorRows = await client.query("select * from vendors where tenant_id = $1", [ctx.tenantId]);
      const vendorRecords = vendorRows.rows.map(rowToVendor);
      const vendors = vendorMastersForInvoices(invoices, vendorRecords);
      const run = createPaymentRun({ tenantId: ctx.tenantId, invoices, vendors, scheduledDate });

      const realVendorIds = new Set(vendorRecords.map((vendor) => vendor.id));
      await client.query("insert into payment_runs (id, tenant_id, scheduled_date, status) values ($1,$2,$3,'created')", [run.id, ctx.tenantId, scheduledDate]);
      for (const payment of run.payments) {
        // vendor_id is a uuid FK; persist it only when it resolves to a real vendor.
        const vendorId = realVendorIds.has(payment.vendorId) ? payment.vendorId : null;
        await client.query(
          "insert into payments (id, tenant_id, payment_run_id, invoice_id, vendor_id, amount, currency, status) values ($1,$2,$3,$4,$5,$6,$7,$8)",
          [payment.id, ctx.tenantId, run.id, payment.invoiceId, vendorId, String(payment.amount), payment.currency, payment.status],
        );
      }
      if (run.payments.length > 0) {
        await persistJournal(client, ctx.tenantId, run.journal);
      }
      return run;
    });
  }

  async createVendor(ctx: TenantContext, input: CreateVendorInput) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query(
        `insert into vendors (tenant_id, name, tax_id, active, hold_payments, payment_terms_days, default_expense_account, currency)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [ctx.tenantId, input.name, input.taxId ?? null, input.active, input.holdPayments, input.paymentTermsDays, input.defaultExpenseAccount, input.currency],
      );
      return rowToVendor(result.rows[0]);
    });
  }

  async listVendors(ctx: TenantContext) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from vendors where tenant_id = $1 order by created_at asc", [ctx.tenantId]);
      return result.rows.map(rowToVendor);
    });
  }

  async getVendor(ctx: TenantContext, id: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from vendors where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, id]);
      return result.rows[0] ? rowToVendor(result.rows[0]) : undefined;
    });
  }

  async updateVendor(ctx: TenantContext, id: string, patch: UpdateVendorInput) {
    return this.tx(ctx.tenantId, async (client) => {
      const existing = await client.query("select * from vendors where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, id]);
      if (!existing.rowCount) throw new Error("Vendor not found");
      const current = rowToVendor(existing.rows[0]);
      const next = { ...current, ...patch };
      const result = await client.query(
        `update vendors set name=$3, tax_id=$4, active=$5, hold_payments=$6, payment_terms_days=$7, default_expense_account=$8, currency=$9
         where tenant_id=$1 and id=$2 returning *`,
        [ctx.tenantId, id, next.name, next.taxId ?? null, next.active, next.holdPayments, next.paymentTermsDays, next.defaultExpenseAccount, next.currency],
      );
      return rowToVendor(result.rows[0]);
    });
  }

  async reconcilePayments(ctx: TenantContext, bankTransactions: BankTransaction[]) {
    return this.tx(ctx.tenantId, async (client) => {
      const paymentsResult = await client.query("select * from payments where tenant_id = $1", [ctx.tenantId]);
      const payments: Payment[] = paymentsResult.rows.map(rowToPayment);
      const result = reconcileBankTransactions({ payments, bankTransactions });
      const reconId = crypto.randomUUID();
      await client.query("insert into reconciliations (id, tenant_id, status, result) values ($1,$2,$3,$4::jsonb)", [
        reconId,
        ctx.tenantId,
        result.exceptions.some((finding) => finding.severity === "error") ? "open" : "matched",
        JSON.stringify(result),
      ]);
      for (const txn of bankTransactions) {
        await client.query(
          "insert into bank_transactions (id, tenant_id, amount, currency, value_date, reference, reconciliation_id) values ($1,$2,$3,$4,$5,$6,$7)",
          [txn.id, ctx.tenantId, String(txn.amount), txn.currency, txn.valueDate, txn.reference, reconId],
        );
      }
      return result;
    });
  }

  async applyCredits(ctx: TenantContext, invoiceId: string, creditMemos: CreditMemo[]) {
    const invoice = await this.getInvoice(ctx, invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    return applyCreditMemos({ invoice: toAccountingInvoice(invoice), creditMemos });
  }

  async planPartialPayment(ctx: TenantContext, invoiceId: string, requestedAmount: number) {
    const invoice = await this.getInvoice(ctx, invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    return createPartialPaymentPlan({ invoice: toAccountingInvoice(invoice), requestedAmount });
  }

  async aging(ctx: TenantContext, asOfDate: string) {
    const invoices = await this.listInvoices(ctx);
    return buildApAging({ invoices: invoices.map(toAccountingInvoice), asOfDate });
  }

  async realizeFx(ctx: TenantContext, input: { invoiceId: string; functionalCurrency: string; invoiceFxRate: number; paymentFxRate: number }) {
    const invoice = await this.getInvoice(ctx, input.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    return calculateRealizedFx({
      invoiceId: invoice.id,
      invoiceAmount: invoice.total,
      functionalCurrency: input.functionalCurrency,
      invoiceFxRate: input.invoiceFxRate,
      paymentFxRate: input.paymentFxRate,
    });
  }
}

async function persistJournal(client: PoolClient, tenantId: string, journal: JournalEntry) {
  await client.query("insert into gl_journal_entries (id, tenant_id, source, posting_date, currency, balanced) values ($1,$2,$3,$4,$5,$6)", [
    journal.id,
    tenantId,
    journal.source,
    journal.postingDate,
    journal.currency,
    String(journal.balanced),
  ]);
  for (const line of journal.entries) {
    await client.query(
      "insert into gl_journal_lines (id, tenant_id, journal_entry_id, invoice_id, account, debit, credit, memo) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [crypto.randomUUID(), tenantId, journal.id, line.invoiceId ?? null, line.account, String(line.debit), String(line.credit), line.memo],
    );
  }
}

async function insertEvent(client: PoolClient, event: Omit<AgentEvent, "id" | "createdAt">) {
  const id = crypto.randomUUID();
  const result = await client.query(
    `insert into agent_events (id, tenant_id, invoice_id, agent, actor, input, output, tokens, latency_ms)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) returning *`,
    [id, event.tenantId, event.invoiceId, event.agent, event.actor, JSON.stringify(event.input ?? null), JSON.stringify(event.output ?? null), String(event.tokens), String(event.latencyMs)],
  );
  return rowToEvent(result.rows[0]);
}

function rowToInvoice(row: Record<string, unknown>): Invoice {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    vendorId: row.vendor_id ? String(row.vendor_id) : undefined,
    poId: row.po_id ? String(row.po_id) : undefined,
    sourceObjectKey: row.source_object_key ? String(row.source_object_key) : undefined,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
    vendorName: row.vendor_name ? String(row.vendor_name) : undefined,
    status: String(row.status) as Invoice["status"],
    total: Number(row.total),
    currency: String(row.currency),
    extracted: row.extracted ? (typeof row.extracted === "string" ? JSON.parse(row.extracted) : (row.extracted as Invoice["extracted"])) : undefined,
    confidence: row.confidence === null || row.confidence === undefined ? undefined : Number(row.confidence),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function rowToEvent(row: Record<string, unknown>): AgentEvent {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    invoiceId: String(row.invoice_id),
    agent: row.agent as AgentEvent["agent"],
    actor: row.actor as AgentEvent["actor"],
    input: typeof row.input === "string" ? JSON.parse(row.input) : row.input,
    output: typeof row.output === "string" ? JSON.parse(row.output) : row.output,
    tokens: Number(row.tokens),
    latencyMs: Number(row.latency_ms),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToVendor(row: Record<string, unknown>): Vendor {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    taxId: row.tax_id ? String(row.tax_id) : undefined,
    active: Boolean(row.active),
    holdPayments: Boolean(row.hold_payments),
    paymentTermsDays: Number(row.payment_terms_days),
    defaultExpenseAccount: String(row.default_expense_account),
    currency: String(row.currency),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToPayment(row: Record<string, unknown>): Payment {
  return {
    id: String(row.id),
    invoiceId: String(row.invoice_id),
    vendorId: row.vendor_id ? String(row.vendor_id) : "",
    amount: Number(row.amount),
    currency: String(row.currency),
    scheduledDate: "",
    status: String(row.status) as Payment["status"],
  };
}
