import { type AgentEvent, type CreateInvoiceInput, type Invoice, type TenantContext } from "@atlas/contracts";
import type { AgentRepository } from "@atlas/agents";
import {
  applyCreditMemos,
  buildApAging,
  buildInvoicePostingJournal,
  calculateRealizedFx,
  createPaymentRun,
  createPartialPaymentPlan,
  reconcileBankTransactions,
  type AccountingInvoice,
  type BankTransaction,
  type CreditMemo,
  type JournalEntry,
  type Payment,
  type PaymentRun,
  type VendorMaster,
} from "@atlas/accounting";

const now = () => new Date().toISOString();

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
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly invoices = new Map<string, Invoice>();
  private readonly events: AgentEvent[] = [];
  private readonly payments = new Map<string, Payment[]>();

  async createInvoice(ctx: TenantContext, input: CreateInvoiceInput) {
    const id = crypto.randomUUID();
    const invoice: Invoice = {
      id,
      tenantId: ctx.tenantId,
      sourceObjectKey: input.sourceObjectKey,
      vendorName: input.vendorName,
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
    this.invoices.set(invoice.id, invoice);
    return invoice;
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
    const vendors = invoices.map((invoice) => ({
      id: invoice.vendorId,
      name: invoice.vendorName,
      taxId: "LOCAL-TAX-ID",
      active: true,
      paymentTermsDays: 30,
      defaultExpenseAccount: "6100",
      currency: invoice.currency,
    }));
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

export const repository = new InMemoryInvoiceRepository();

function toAccountingInvoice(invoice: Invoice): AccountingInvoice {
  const subtotal = invoice.extracted?.subtotal ?? invoice.total;
  const tax = invoice.extracted?.tax ?? 0;
  const lines = invoice.extracted?.lines ?? [{ description: invoice.vendorName ?? "Invoice", quantity: 1, unitPrice: subtotal, total: subtotal }];
  return {
    id: invoice.id,
    vendorId: invoice.vendorId ?? `vendor:${invoice.vendorName ?? "unknown"}`,
    vendorName: invoice.vendorName ?? "Unknown vendor",
    invoiceNumber: invoice.invoiceNumber ?? invoice.id.slice(0, 8),
    invoiceDate: invoice.extracted?.invoiceDate ?? invoice.createdAt.slice(0, 10),
    postingDate: invoice.updatedAt.slice(0, 10),
    dueDate: invoice.updatedAt.slice(0, 10),
    currency: invoice.currency,
    subtotal,
    tax,
    total: invoice.total,
    lines,
    status: toAccountingStatus(invoice.status),
    poId: invoice.poId,
  };
}

function toVendorMaster(invoice: Pick<Invoice, "vendorId" | "vendorName" | "currency"> & { id?: string }): VendorMaster {
  return {
    id: invoice.vendorId ?? `vendor:${invoice.vendorName ?? "unknown"}`,
    name: invoice.vendorName ?? "Unknown vendor",
    taxId: "LOCAL-TAX-ID",
    active: true,
    paymentTermsDays: 30,
    defaultExpenseAccount: "6100",
    currency: invoice.currency,
  };
}

function toAccountingStatus(status: Invoice["status"]): AccountingInvoice["status"] {
  if (status === "rejected" || status === "coded") return "exception";
  if (status === "extracted" || status === "received") return "received";
  return status;
}
