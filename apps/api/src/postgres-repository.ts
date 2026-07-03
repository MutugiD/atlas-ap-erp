import {
  type AccountingPeriodRecord,
  type AgentEvent,
  type CreateAccountingPeriodInput,
  type CreateCreditMemoInput,
  type CreateGoodsReceiptInput,
  type CreateInvoiceInput,
  type CreatePurchaseOrderInput,
  type CreateDebitMemoInput,
  type CreateVendorInput,
  type CreditMemoRecord,
  type DebitMemoRecord,
  type CreateProfitabilityInput,
  type GoodsReceiptRecord,
  type Invoice,
  type PartialPaymentRecord,
  type ProfitabilityComputeInput,
  type ProfitabilityInputRecord,
  type ProfitabilityReportRecord,
  type PurchaseOrder,
  type TenantContext,
  type UpdateVendorInput,
  type Vendor,
} from "@atlas/contracts";
import { computeProfitability as computeProfitabilityReport, summarize, withTrend, type ReportWithTrend } from "@atlas/profitability";
import {
  applyCreditMemos,
  buildApAging,
  buildDebitMemoJournal,
  buildInvoicePostingJournal,
  buildRealizedFxJournal,
  calculateRealizedFx,
  createPaymentRun,
  createPartialPaymentPlan,
  reconcileBankTransactions,
  roundMoney,
  threeWayMatch as runThreeWayMatch,
  validateInvoiceDataEntry,
  type BankTransaction,
  type CreditMemo,
  type JournalEntry,
  type Payment,
} from "@atlas/accounting";
import { Pool, type PoolClient } from "pg";
import type { InvoiceRepository, PartialPaymentExecution } from "./repository";
import { ClosedPeriodError } from "./errors";
import {
  buildExtractedDraft,
  openPeriod,
  profitabilityConfigFrom,
  toAccountingCreditMemo,
  toAccountingInvoice,
  toEngineInput,
  toGoodsReceipt,
  toPurchaseOrderAccounting,
  toVendorMaster,
  vendorToMaster,
  vendorMastersForInvoices,
} from "./mappers";

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
      const extracted = buildExtractedDraft(id, input);
      const result = await client.query(
        `insert into invoices (id, tenant_id, vendor_id, po_id, source_object_key, invoice_number, vendor_name, status, total, currency, extracted)
         values ($1,$2,$3,$4,$5,$6,$7,'received',$8,$9,$10::jsonb)
         returning *`,
        [id, ctx.tenantId, vendorId, poId, input.sourceObjectKey ?? null, input.invoiceNumber ?? null, vendorName, String(input.total), input.currency, extracted ? JSON.stringify(extracted) : null],
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

  async validateDataEntry(ctx: TenantContext, invoiceId: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const invoiceResult = await client.query("select * from invoices where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, invoiceId]);
      if (!invoiceResult.rowCount) throw new Error("Invoice not found");
      const invoice = rowToInvoice(invoiceResult.rows[0]);
      const acct = toAccountingInvoice(invoice);

      let vendor;
      if (invoice.vendorId) {
        const vendorResult = await client.query("select * from vendors where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, invoice.vendorId]);
        vendor = vendorResult.rows[0] ? vendorToMaster(rowToVendor(vendorResult.rows[0])) : undefined;
      }

      const othersResult = await client.query("select * from invoices where tenant_id = $1 and id <> $2", [ctx.tenantId, invoiceId]);
      const existingInvoiceKeys = othersResult.rows.map(rowToInvoice).map((other) => { const a = toAccountingInvoice(other); return `${a.vendorId}:${a.invoiceNumber}`; });

      const periodResult = await client.query(
        "select id, starts_on, ends_on, status from accounting_periods where tenant_id = $1 and starts_on <= $2 and ends_on >= $2 limit 1",
        [ctx.tenantId, acct.postingDate],
      );
      const periodRow = periodResult.rows[0];
      const period = periodRow
        ? { id: String(periodRow.id), startsOn: toDateString(periodRow.starts_on), endsOn: toDateString(periodRow.ends_on), status: periodRow.status as "open" | "closed" }
        : openPeriod(acct.postingDate);

      return validateInvoiceDataEntry({ invoice: acct, vendor, period, existingInvoiceKeys });
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
      // invoice actually transitions into 'posted' — and never into a closed period.
      const wasPosted = prior.rows[0]?.status === "posted";
      if (updated.status === "posted" && !wasPosted) {
        const postingDate = toAccountingInvoice(updated).postingDate;
        const period = await client.query(
          "select id, status from accounting_periods where tenant_id = $1 and starts_on <= $2 and ends_on >= $2 limit 1",
          [ctx.tenantId, postingDate],
        );
        if (period.rows[0]?.status === "closed") throw new ClosedPeriodError(String(period.rows[0].id));
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
        `insert into vendors (tenant_id, name, tax_id, active, hold_payments, payment_terms_days, default_expense_account, currency, withholding_tax_rate)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [ctx.tenantId, input.name, input.taxId ?? null, input.active, input.holdPayments, input.paymentTermsDays, input.defaultExpenseAccount, input.currency, String(input.withholdingTaxRate)],
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
        `update vendors set name=$3, tax_id=$4, active=$5, hold_payments=$6, payment_terms_days=$7, default_expense_account=$8, currency=$9, withholding_tax_rate=$10
         where tenant_id=$1 and id=$2 returning *`,
        [ctx.tenantId, id, next.name, next.taxId ?? null, next.active, next.holdPayments, next.paymentTermsDays, next.defaultExpenseAccount, next.currency, String(next.withholdingTaxRate)],
      );
      return rowToVendor(result.rows[0]);
    });
  }

  async createPurchaseOrder(ctx: TenantContext, input: CreatePurchaseOrderInput) {
    return this.tx(ctx.tenantId, async (client) => {
      // vendor_id is a FK; only persist one that resolves for this tenant.
      let vendorId: string | null = null;
      if (input.vendorId) {
        const vendor = await client.query("select id from vendors where id = $1 and tenant_id = $2", [input.vendorId, ctx.tenantId]);
        vendorId = vendor.rowCount ? input.vendorId : null;
      }
      const total = roundMoney(input.lines.reduce((sum, line) => sum + line.total, 0));
      const result = await client.query(
        `insert into purchase_orders (tenant_id, po_number, vendor_id, total, currency, lines, status)
         values ($1,$2,$3,$4,$5,$6::jsonb,'open') returning *`,
        [ctx.tenantId, input.poNumber, vendorId, String(total), input.currency, JSON.stringify(input.lines)],
      );
      return rowToPurchaseOrder(result.rows[0]);
    });
  }

  async listPurchaseOrders(ctx: TenantContext) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from purchase_orders where tenant_id = $1 order by created_at asc", [ctx.tenantId]);
      return result.rows.map(rowToPurchaseOrder);
    });
  }

  async getPurchaseOrder(ctx: TenantContext, id: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from purchase_orders where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, id]);
      return result.rows[0] ? rowToPurchaseOrder(result.rows[0]) : undefined;
    });
  }

  async createGoodsReceipt(ctx: TenantContext, input: CreateGoodsReceiptInput) {
    return this.tx(ctx.tenantId, async (client) => {
      const po = await client.query("select id from purchase_orders where id = $1 and tenant_id = $2", [input.poId, ctx.tenantId]);
      if (!po.rowCount) throw new Error("Purchase order not found");
      const result = await client.query(
        "insert into goods_receipts (tenant_id, po_id, description, quantity_received) values ($1,$2,$3,$4) returning *",
        [ctx.tenantId, input.poId, input.description, String(input.quantityReceived)],
      );
      return rowToGoodsReceipt(result.rows[0]);
    });
  }

  async listGoodsReceipts(ctx: TenantContext, poId: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from goods_receipts where tenant_id = $1 and po_id = $2 order by created_at asc", [ctx.tenantId, poId]);
      return result.rows.map(rowToGoodsReceipt);
    });
  }

  async matchInvoice(ctx: TenantContext, invoiceId: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const invoiceResult = await client.query("select * from invoices where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, invoiceId]);
      if (!invoiceResult.rowCount) throw new Error("Invoice not found");
      const invoice = rowToInvoice(invoiceResult.rows[0]);
      let po: PurchaseOrder | undefined;
      let receipts: GoodsReceiptRecord[] = [];
      if (invoice.poId) {
        const poResult = await client.query("select * from purchase_orders where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, invoice.poId]);
        po = poResult.rows[0] ? rowToPurchaseOrder(poResult.rows[0]) : undefined;
        if (po) {
          const receiptResult = await client.query("select * from goods_receipts where tenant_id = $1 and po_id = $2", [ctx.tenantId, po.id]);
          receipts = receiptResult.rows.map(rowToGoodsReceipt);
        }
      }
      return runThreeWayMatch({
        invoice: toAccountingInvoice(invoice),
        po: po ? toPurchaseOrderAccounting(po) : undefined,
        receipts: receipts.map(toGoodsReceipt),
      });
    });
  }

  async createAccountingPeriod(ctx: TenantContext, input: CreateAccountingPeriodInput) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query(
        "insert into accounting_periods (tenant_id, name, starts_on, ends_on, status) values ($1,$2,$3,$4,'open') returning *",
        [ctx.tenantId, input.name, input.startsOn, input.endsOn],
      );
      return rowToAccountingPeriod(result.rows[0]);
    });
  }

  async listAccountingPeriods(ctx: TenantContext) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from accounting_periods where tenant_id = $1 order by starts_on asc", [ctx.tenantId]);
      return result.rows.map(rowToAccountingPeriod);
    });
  }

  async setPeriodStatus(ctx: TenantContext, id: string, status: "open" | "closed") {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query(
        "update accounting_periods set status = $3 where tenant_id = $1 and id = $2 returning *",
        [ctx.tenantId, id, status],
      );
      if (!result.rowCount) throw new Error("Accounting period not found");
      return rowToAccountingPeriod(result.rows[0]);
    });
  }

  async createCreditMemo(ctx: TenantContext, input: CreateCreditMemoInput) {
    return this.tx(ctx.tenantId, async (client) => {
      let vendorId: string | null = null;
      if (input.vendorId) {
        const vendor = await client.query("select id from vendors where id = $1 and tenant_id = $2", [input.vendorId, ctx.tenantId]);
        vendorId = vendor.rowCount ? input.vendorId : null;
      }
      const result = await client.query(
        "insert into credit_memos (tenant_id, vendor_id, amount, currency, status) values ($1,$2,$3,$4,'available') returning *",
        [ctx.tenantId, vendorId, String(input.amount), input.currency],
      );
      return rowToCreditMemo(result.rows[0]);
    });
  }

  async listCreditMemos(ctx: TenantContext) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from credit_memos where tenant_id = $1 order by created_at asc", [ctx.tenantId]);
      return result.rows.map(rowToCreditMemo);
    });
  }

  async applyAvailableCredits(ctx: TenantContext, invoiceId: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const invoiceResult = await client.query("select * from invoices where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, invoiceId]);
      if (!invoiceResult.rowCount) throw new Error("Invoice not found");
      const invoice = rowToInvoice(invoiceResult.rows[0]);
      const memoResult = await client.query(
        "select * from credit_memos where tenant_id = $1 and status = 'available' and vendor_id is not distinct from $2 order by created_at asc",
        [ctx.tenantId, invoice.vendorId ?? null],
      );
      const available = memoResult.rows.map(rowToCreditMemo);
      const result = applyCreditMemos({ invoice: toAccountingInvoice(invoice), creditMemos: available.map(toAccountingCreditMemo) });

      for (const application of result.applications) {
        await client.query(
          "insert into credit_memo_applications (tenant_id, credit_memo_id, invoice_id, amount_applied) values ($1,$2,$3,$4)",
          [ctx.tenantId, application.creditMemoId, invoiceId, String(application.amountApplied)],
        );
      }
      for (const memo of available) {
        const applied = result.applications.filter((a) => a.creditMemoId === memo.id).reduce((sum, a) => sum + a.amountApplied, 0);
        if (applied <= 0) continue;
        const remaining = Math.round((memo.amount - applied) * 100) / 100;
        await client.query("update credit_memos set amount = $3, status = $4 where tenant_id = $1 and id = $2", [
          ctx.tenantId,
          memo.id,
          String(remaining),
          remaining <= 0 ? "applied" : "available",
        ]);
      }
      return result;
    });
  }

  async listPartialPayments(ctx: TenantContext, invoiceId: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from partial_payments where tenant_id = $1 and invoice_id = $2 order by created_at asc", [ctx.tenantId, invoiceId]);
      return result.rows.map(rowToPartialPayment);
    });
  }

  async createDebitMemo(ctx: TenantContext, input: CreateDebitMemoInput) {
    return this.tx(ctx.tenantId, async (client) => {
      let vendorId: string | null = null;
      if (input.vendorId) {
        const vendor = await client.query("select id from vendors where id = $1 and tenant_id = $2", [input.vendorId, ctx.tenantId]);
        vendorId = vendor.rowCount ? input.vendorId : null;
      }
      const result = await client.query(
        "insert into debit_memos (tenant_id, vendor_id, amount, currency, reason, status) values ($1,$2,$3,$4,$5,'issued') returning *",
        [ctx.tenantId, vendorId, String(input.amount), input.currency, input.reason ?? null],
      );
      const debitMemo = rowToDebitMemo(result.rows[0]);
      const journal = buildDebitMemoJournal({ tenantId: ctx.tenantId, debitMemoId: debitMemo.id, amount: debitMemo.amount, currency: debitMemo.currency, postingDate: new Date().toISOString().slice(0, 10) });
      await persistJournal(client, ctx.tenantId, journal);
      return { debitMemo, journal };
    });
  }

  async listDebitMemos(ctx: TenantContext) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from debit_memos where tenant_id = $1 order by created_at asc", [ctx.tenantId]);
      return result.rows.map(rowToDebitMemo);
    });
  }

  async createProfitabilityInput(ctx: TenantContext, input: CreateProfitabilityInput) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query(
        `insert into profitability_inputs (tenant_id, period, account, service_line, fee_revenue, labor_hours, labor_cost_rate, media_spend, media_markup_rate)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [ctx.tenantId, input.period, input.account, input.serviceLine, String(input.feeRevenue), String(input.laborHours), String(input.laborCostRate), String(input.mediaSpend), String(input.mediaMarkupRate)],
      );
      return rowToProfitabilityInput(result.rows[0]);
    });
  }

  async listProfitabilityInputs(ctx: TenantContext, period: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from profitability_inputs where tenant_id = $1 and period = $2 order by account, service_line", [ctx.tenantId, period]);
      return result.rows.map(rowToProfitabilityInput);
    });
  }

  async profitabilityReport(ctx: TenantContext, params: ProfitabilityComputeInput) {
    const config = profitabilityConfigFrom(params);
    const report = computeProfitabilityReport((await this.listProfitabilityInputs(ctx, params.period)).map(toEngineInput), config);
    let trend: ReportWithTrend | null = null;
    if (params.priorPeriod) {
      const prior = computeProfitabilityReport((await this.listProfitabilityInputs(ctx, params.priorPeriod)).map(toEngineInput), config);
      trend = withTrend(report, prior);
    }
    return { report, trend };
  }

  async generateProfitabilityReport(ctx: TenantContext, params: ProfitabilityComputeInput) {
    const { report, trend } = await this.profitabilityReport(ctx, params);
    const summary = summarize(report, trend ?? undefined);
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query(
        "insert into profitability_reports (tenant_id, period, prior_period, summary, detail) values ($1,$2,$3,$4::jsonb,$5::jsonb) returning *",
        [ctx.tenantId, params.period, params.priorPeriod ?? null, JSON.stringify(summary), JSON.stringify({ report, trend })],
      );
      return rowToProfitabilityReport(result.rows[0]);
    });
  }

  async listProfitabilityReports(ctx: TenantContext) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from profitability_reports where tenant_id = $1 order by generated_at desc", [ctx.tenantId]);
      return result.rows.map(rowToProfitabilityReport);
    });
  }

  async getProfitabilityReport(ctx: TenantContext, id: string) {
    return this.tx(ctx.tenantId, async (client) => {
      const result = await client.query("select * from profitability_reports where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, id]);
      return result.rows[0] ? rowToProfitabilityReport(result.rows[0]) : undefined;
    });
  }

  async executePartialPayment(ctx: TenantContext, invoiceId: string, requestedAmount: number): Promise<PartialPaymentExecution> {
    return this.tx(ctx.tenantId, async (client) => {
      const invoiceResult = await client.query("select * from invoices where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, invoiceId]);
      if (!invoiceResult.rowCount) throw new Error("Invoice not found");
      const invoice = rowToInvoice(invoiceResult.rows[0]);
      const paidResult = await client.query("select coalesce(sum(amount),0)::float as paid from partial_payments where tenant_id = $1 and invoice_id = $2", [ctx.tenantId, invoiceId]);
      const outstanding = Math.round((invoice.total - Number(paidResult.rows[0].paid)) * 100) / 100;
      const plan = createPartialPaymentPlan({ invoice: { ...toAccountingInvoice(invoice), total: outstanding }, requestedAmount });
      if (plan.findings.some((finding) => finding.severity === "error")) {
        return { plan, executed: false, outstanding };
      }
      const inserted = await client.query(
        "insert into partial_payments (tenant_id, invoice_id, amount, currency, status) values ($1,$2,$3,$4,'paid') returning id",
        [ctx.tenantId, invoiceId, String(plan.paymentAmount), invoice.currency],
      );
      return { plan, executed: true, outstanding: Math.round((outstanding - plan.paymentAmount) * 100) / 100, paymentId: String(inserted.rows[0].id) };
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
    return this.tx(ctx.tenantId, async (client) => {
      const invoiceResult = await client.query("select * from invoices where tenant_id = $1 and id = $2 limit 1", [ctx.tenantId, input.invoiceId]);
      if (!invoiceResult.rowCount) throw new Error("Invoice not found");
      const invoice = rowToInvoice(invoiceResult.rows[0]);
      const fx = calculateRealizedFx({
        invoiceId: invoice.id,
        invoiceAmount: invoice.total,
        functionalCurrency: input.functionalCurrency,
        invoiceFxRate: input.invoiceFxRate,
        paymentFxRate: input.paymentFxRate,
      });
      const journal = buildRealizedFxJournal({ tenantId: ctx.tenantId, fx, postingDate: new Date().toISOString().slice(0, 10) });
      if (journal.entries.length > 0) await persistJournal(client, ctx.tenantId, journal);
      return { ...fx, journal };
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
    withholdingTaxRate: Number(row.withholding_tax_rate),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

// node-pg parses a `date` column into a Date at local midnight; format from its
// local parts so the calendar date is preserved regardless of timezone.
function toDateString(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value);
}

function rowToProfitabilityReport(row: Record<string, unknown>): ProfitabilityReportRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    period: String(row.period),
    priorPeriod: row.prior_period ? String(row.prior_period) : undefined,
    summary: typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary,
    detail: typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail,
    generatedAt: new Date(row.generated_at as string).toISOString(),
  };
}

function rowToProfitabilityInput(row: Record<string, unknown>): ProfitabilityInputRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    period: String(row.period),
    account: String(row.account),
    serviceLine: String(row.service_line),
    feeRevenue: Number(row.fee_revenue),
    laborHours: Number(row.labor_hours),
    laborCostRate: Number(row.labor_cost_rate),
    mediaSpend: Number(row.media_spend),
    mediaMarkupRate: Number(row.media_markup_rate),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToDebitMemo(row: Record<string, unknown>): DebitMemoRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    vendorId: row.vendor_id ? String(row.vendor_id) : undefined,
    amount: Number(row.amount),
    currency: String(row.currency),
    reason: row.reason ? String(row.reason) : undefined,
    status: String(row.status),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToPartialPayment(row: Record<string, unknown>): PartialPaymentRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    invoiceId: String(row.invoice_id),
    amount: Number(row.amount),
    currency: String(row.currency),
    status: String(row.status),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToCreditMemo(row: Record<string, unknown>): CreditMemoRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    vendorId: row.vendor_id ? String(row.vendor_id) : undefined,
    amount: Number(row.amount),
    currency: String(row.currency),
    status: String(row.status) as CreditMemoRecord["status"],
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToAccountingPeriod(row: Record<string, unknown>): AccountingPeriodRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    startsOn: toDateString(row.starts_on),
    endsOn: toDateString(row.ends_on),
    status: String(row.status) as AccountingPeriodRecord["status"],
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToPurchaseOrder(row: Record<string, unknown>): PurchaseOrder {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    poNumber: String(row.po_number),
    vendorId: row.vendor_id ? String(row.vendor_id) : undefined,
    currency: String(row.currency),
    total: Number(row.total),
    status: String(row.status) as PurchaseOrder["status"],
    lines: typeof row.lines === "string" ? JSON.parse(row.lines) : ((row.lines as PurchaseOrder["lines"]) ?? []),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function rowToGoodsReceipt(row: Record<string, unknown>): GoodsReceiptRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    poId: String(row.po_id),
    description: String(row.description),
    quantityReceived: Number(row.quantity_received),
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
