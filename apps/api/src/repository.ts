import {
  type AccountingPeriodRecord,
  type AgentEvent,
  type CreateAccountingPeriodInput,
  type CreateCreditMemoInput,
  type CreateGoodsReceiptInput,
  type CreateInvoiceInput,
  type CreatePurchaseOrderInput,
  type CreateVendorInput,
  type CreditMemoRecord,
  type GoodsReceiptRecord,
  type Invoice,
  type PurchaseOrder,
  type TenantContext,
  type UpdateVendorInput,
  type Vendor,
} from "@atlas/contracts";
import type { AgentRepository } from "@atlas/agents";
import {
  applyCreditMemos,
  buildApAging,
  buildInvoicePostingJournal,
  calculateRealizedFx,
  createPaymentRun,
  createPartialPaymentPlan,
  reconcileBankTransactions,
  roundMoney,
  threeWayMatch as runThreeWayMatch,
  type BankTransaction,
  type CreditMemo,
  type JournalEntry,
  type Payment,
  type PaymentRun,
} from "@atlas/accounting";
import { toAccountingCreditMemo, toAccountingInvoice, toGoodsReceipt, toPurchaseOrderAccounting, toVendorMaster, vendorMastersForInvoices } from "./mappers";
import { ClosedPeriodError } from "./errors";
import { PostgresInvoiceRepository } from "./postgres-repository";

const now = () => new Date().toISOString();

// The AP repository: invoices, events, accounting operations, and vendor master.
export interface InvoiceRepository extends AgentRepository {
  createInvoice(ctx: TenantContext, input: CreateInvoiceInput): Promise<{ invoice: Invoice; uploadUrl: string }>;
  listInvoices(ctx: TenantContext): Promise<Invoice[]>;
  getInvoice(ctx: TenantContext, id: string): Promise<Invoice | undefined>;
  listExceptions(ctx: TenantContext): Promise<Invoice[]>;
  listEvents(ctx: TenantContext, invoiceId: string): Promise<AgentEvent[]>;
  humanDecision(ctx: TenantContext, invoiceId: string, action: "approve" | "reject"): Promise<Invoice>;
  previewPosting(ctx: TenantContext, invoiceId: string): Promise<JournalEntry>;
  createPaymentRun(ctx: TenantContext, scheduledDate: string): Promise<PaymentRun>;
  reconcilePayments(ctx: TenantContext, bankTransactions: BankTransaction[]): Promise<ReturnType<typeof reconcileBankTransactions>>;
  applyCredits(ctx: TenantContext, invoiceId: string, creditMemos: CreditMemo[]): Promise<ReturnType<typeof applyCreditMemos>>;
  planPartialPayment(ctx: TenantContext, invoiceId: string, requestedAmount: number): Promise<ReturnType<typeof createPartialPaymentPlan>>;
  aging(ctx: TenantContext, asOfDate: string): Promise<ReturnType<typeof buildApAging>>;
  realizeFx(ctx: TenantContext, input: { invoiceId: string; functionalCurrency: string; invoiceFxRate: number; paymentFxRate: number }): Promise<ReturnType<typeof calculateRealizedFx>>;
  createVendor(ctx: TenantContext, input: CreateVendorInput): Promise<Vendor>;
  listVendors(ctx: TenantContext): Promise<Vendor[]>;
  getVendor(ctx: TenantContext, id: string): Promise<Vendor | undefined>;
  updateVendor(ctx: TenantContext, id: string, patch: UpdateVendorInput): Promise<Vendor>;
  createPurchaseOrder(ctx: TenantContext, input: CreatePurchaseOrderInput): Promise<PurchaseOrder>;
  listPurchaseOrders(ctx: TenantContext): Promise<PurchaseOrder[]>;
  getPurchaseOrder(ctx: TenantContext, id: string): Promise<PurchaseOrder | undefined>;
  createGoodsReceipt(ctx: TenantContext, input: CreateGoodsReceiptInput): Promise<GoodsReceiptRecord>;
  listGoodsReceipts(ctx: TenantContext, poId: string): Promise<GoodsReceiptRecord[]>;
  matchInvoice(ctx: TenantContext, invoiceId: string): Promise<ReturnType<typeof runThreeWayMatch>>;
  createAccountingPeriod(ctx: TenantContext, input: CreateAccountingPeriodInput): Promise<AccountingPeriodRecord>;
  listAccountingPeriods(ctx: TenantContext): Promise<AccountingPeriodRecord[]>;
  setPeriodStatus(ctx: TenantContext, id: string, status: "open" | "closed"): Promise<AccountingPeriodRecord>;
  createCreditMemo(ctx: TenantContext, input: CreateCreditMemoInput): Promise<CreditMemoRecord>;
  listCreditMemos(ctx: TenantContext): Promise<CreditMemoRecord[]>;
  applyAvailableCredits(ctx: TenantContext, invoiceId: string): Promise<ReturnType<typeof applyCreditMemos>>;
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly invoices = new Map<string, Invoice>();
  private readonly events: AgentEvent[] = [];
  private readonly payments = new Map<string, Payment[]>();
  private readonly vendors = new Map<string, Vendor>();
  private readonly purchaseOrders = new Map<string, PurchaseOrder>();
  private readonly goodsReceipts: GoodsReceiptRecord[] = [];
  private readonly periods = new Map<string, AccountingPeriodRecord>();
  private readonly creditMemos = new Map<string, CreditMemoRecord>();

  async createInvoice(ctx: TenantContext, input: CreateInvoiceInput) {
    const id = crypto.randomUUID();
    // Only link a vendorId that resolves to a vendor for this tenant.
    const vendor = input.vendorId ? await this.getVendor(ctx, input.vendorId) : undefined;
    const invoice: Invoice = {
      id,
      tenantId: ctx.tenantId,
      sourceObjectKey: input.sourceObjectKey,
      vendorName: input.vendorName ?? vendor?.name,
      vendorId: vendor?.id,
      invoiceNumber: input.invoiceNumber,
      poId: input.poId,
      status: "received",
      total: input.total,
      currency: input.currency,
      createdAt: now(),
      updatedAt: now(),
    };
    this.invoices.set(id, invoice);
    return { invoice, uploadUrl: `s3://local-atlas-ap/${ctx.tenantId}/${id}.pdf` };
  }

  async createVendor(ctx: TenantContext, input: CreateVendorInput) {
    const vendor: Vendor = { id: crypto.randomUUID(), tenantId: ctx.tenantId, createdAt: now(), ...input };
    this.vendors.set(vendor.id, vendor);
    return vendor;
  }

  async listVendors(ctx: TenantContext) {
    return [...this.vendors.values()].filter((vendor) => vendor.tenantId === ctx.tenantId);
  }

  async getVendor(ctx: TenantContext, id: string) {
    const vendor = this.vendors.get(id);
    return vendor?.tenantId === ctx.tenantId ? vendor : undefined;
  }

  async updateVendor(ctx: TenantContext, id: string, patch: UpdateVendorInput) {
    const vendor = await this.getVendor(ctx, id);
    if (!vendor) throw new Error("Vendor not found");
    const updated: Vendor = { ...vendor, ...patch };
    this.vendors.set(id, updated);
    return updated;
  }

  async createPurchaseOrder(ctx: TenantContext, input: CreatePurchaseOrderInput) {
    const po: PurchaseOrder = {
      id: crypto.randomUUID(),
      tenantId: ctx.tenantId,
      poNumber: input.poNumber,
      vendorId: input.vendorId,
      currency: input.currency,
      total: roundMoney(input.lines.reduce((sum, line) => sum + line.total, 0)),
      status: "open",
      lines: input.lines,
      createdAt: now(),
    };
    this.purchaseOrders.set(po.id, po);
    return po;
  }

  async listPurchaseOrders(ctx: TenantContext) {
    return [...this.purchaseOrders.values()].filter((po) => po.tenantId === ctx.tenantId);
  }

  async getPurchaseOrder(ctx: TenantContext, id: string) {
    const po = this.purchaseOrders.get(id);
    return po?.tenantId === ctx.tenantId ? po : undefined;
  }

  async createGoodsReceipt(ctx: TenantContext, input: CreateGoodsReceiptInput) {
    const po = await this.getPurchaseOrder(ctx, input.poId);
    if (!po) throw new Error("Purchase order not found");
    const receipt: GoodsReceiptRecord = { id: crypto.randomUUID(), tenantId: ctx.tenantId, createdAt: now(), ...input };
    this.goodsReceipts.push(receipt);
    return receipt;
  }

  async listGoodsReceipts(ctx: TenantContext, poId: string) {
    return this.goodsReceipts.filter((receipt) => receipt.tenantId === ctx.tenantId && receipt.poId === poId);
  }

  async matchInvoice(ctx: TenantContext, invoiceId: string) {
    const invoice = await this.getInvoice(ctx, invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    const po = invoice.poId ? await this.getPurchaseOrder(ctx, invoice.poId) : undefined;
    const receipts = po ? await this.listGoodsReceipts(ctx, po.id) : [];
    return runThreeWayMatch({
      invoice: toAccountingInvoice(invoice),
      po: po ? toPurchaseOrderAccounting(po) : undefined,
      receipts: receipts.map(toGoodsReceipt),
    });
  }

  async listInvoices(ctx: TenantContext) {
    return [...this.invoices.values()].filter((invoice) => invoice.tenantId === ctx.tenantId);
  }

  async getInvoice(ctx: TenantContext, id: string) {
    const invoice = this.invoices.get(id);
    return invoice?.tenantId === ctx.tenantId ? invoice : undefined;
  }

  async listExceptions(ctx: TenantContext) {
    return (await this.listInvoices(ctx)).filter((invoice) => invoice.status === "exception");
  }

  async listEvents(ctx: TenantContext, invoiceId: string) {
    return this.events.filter((event) => event.tenantId === ctx.tenantId && event.invoiceId === invoiceId);
  }

  async listInvoiceNumbers(ctx: TenantContext, excludeInvoiceId: string) {
    return (await this.listInvoices(ctx))
      .filter((invoice) => invoice.id !== excludeInvoiceId && invoice.invoiceNumber)
      .map((invoice) => invoice.invoiceNumber as string);
  }

  async updateInvoice(ctx: TenantContext, invoice: Invoice) {
    if (invoice.tenantId !== ctx.tenantId) throw new Error("Tenant mismatch");
    const prior = this.invoices.get(invoice.id);
    if (invoice.status === "posted" && prior?.status !== "posted") {
      const period = this.periodForDate(ctx, toAccountingInvoice(invoice).postingDate);
      if (period?.status === "closed") throw new ClosedPeriodError(period.id);
    }
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  private periodForDate(ctx: TenantContext, date: string) {
    return [...this.periods.values()].find(
      (period) => period.tenantId === ctx.tenantId && period.startsOn <= date && date <= period.endsOn,
    );
  }

  async createAccountingPeriod(ctx: TenantContext, input: CreateAccountingPeriodInput) {
    const period: AccountingPeriodRecord = { id: crypto.randomUUID(), tenantId: ctx.tenantId, status: "open", createdAt: now(), ...input };
    this.periods.set(period.id, period);
    return period;
  }

  async listAccountingPeriods(ctx: TenantContext) {
    return [...this.periods.values()].filter((period) => period.tenantId === ctx.tenantId);
  }

  async setPeriodStatus(ctx: TenantContext, id: string, status: "open" | "closed") {
    const period = this.periods.get(id);
    if (period?.tenantId !== ctx.tenantId) throw new Error("Accounting period not found");
    const updated: AccountingPeriodRecord = { ...period, status };
    this.periods.set(id, updated);
    return updated;
  }

  async createCreditMemo(ctx: TenantContext, input: CreateCreditMemoInput) {
    const memo: CreditMemoRecord = { id: crypto.randomUUID(), tenantId: ctx.tenantId, status: "available", createdAt: now(), ...input };
    this.creditMemos.set(memo.id, memo);
    return memo;
  }

  async listCreditMemos(ctx: TenantContext) {
    return [...this.creditMemos.values()].filter((memo) => memo.tenantId === ctx.tenantId);
  }

  async applyAvailableCredits(ctx: TenantContext, invoiceId: string) {
    const invoice = await this.getInvoice(ctx, invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    const available = (await this.listCreditMemos(ctx)).filter(
      (memo) => memo.status === "available" && memo.vendorId === invoice.vendorId,
    );
    const result = applyCreditMemos({ invoice: toAccountingInvoice(invoice), creditMemos: available.map(toAccountingCreditMemo) });
    for (const memo of available) {
      const applied = result.applications.filter((a) => a.creditMemoId === memo.id).reduce((sum, a) => sum + a.amountApplied, 0);
      if (applied <= 0) continue;
      const remaining = roundMoney(memo.amount - applied);
      this.creditMemos.set(memo.id, { ...memo, amount: remaining, status: remaining <= 0 ? "applied" : "available" });
    }
    return result;
  }

  async addEvent(_ctx: TenantContext, event: Omit<AgentEvent, "id" | "createdAt">) {
    const persisted: AgentEvent = { ...event, id: crypto.randomUUID(), createdAt: now() };
    this.events.push(persisted);
    return persisted;
  }

  async humanDecision(ctx: TenantContext, invoiceId: string, action: "approve" | "reject") {
    const invoice = await this.getInvoice(ctx, invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    const status = action === "approve" ? "approved" : "rejected";
    const updated: Invoice = { ...invoice, status, updatedAt: now() };
    this.invoices.set(invoiceId, updated);
    await this.addEvent(ctx, {
      tenantId: ctx.tenantId,
      invoiceId,
      agent: "approval_routing",
      actor: "human",
      input: { action },
      output: { status },
      tokens: 0,
      latencyMs: 0,
    });
    return updated;
  }

  async previewPosting(ctx: TenantContext, invoiceId: string) {
    const invoice = await this.getInvoice(ctx, invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    return buildInvoicePostingJournal({
      tenantId: ctx.tenantId,
      invoice: toAccountingInvoice(invoice),
      vendor: toVendorMaster(invoice),
    });
  }

  async createPaymentRun(ctx: TenantContext, scheduledDate: string) {
    const invoices = (await this.listInvoices(ctx)).map(toAccountingInvoice);
    const vendors = vendorMastersForInvoices(invoices, await this.listVendors(ctx));
    const run = createPaymentRun({ tenantId: ctx.tenantId, invoices, vendors, scheduledDate });
    this.payments.set(ctx.tenantId, [...(this.payments.get(ctx.tenantId) ?? []), ...run.payments]);
    return run;
  }

  async reconcilePayments(ctx: TenantContext, bankTransactions: BankTransaction[]) {
    return reconcileBankTransactions({ payments: this.payments.get(ctx.tenantId) ?? [], bankTransactions });
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
    return buildApAging({ invoices: (await this.listInvoices(ctx)).map(toAccountingInvoice), asOfDate });
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

// Default repository: Postgres-backed when DATABASE_URL is configured, otherwise
// the in-memory implementation so local runs and the fast test suite need no DB.
// (Mirrors createDefaultStore() in the Support Agent app.)
export const repository: InvoiceRepository = process.env.DATABASE_URL
  ? new PostgresInvoiceRepository()
  : new InMemoryInvoiceRepository();
