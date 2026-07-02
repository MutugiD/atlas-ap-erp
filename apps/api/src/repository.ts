import { type AgentEvent, type CreateInvoiceInput, type Invoice, type TenantContext } from "@atlas/contracts";
import type { AgentRepository } from "@atlas/agents";

const now = () => new Date().toISOString();

export interface InvoiceRepository extends AgentRepository {
  createInvoice(ctx: TenantContext, input: CreateInvoiceInput): Promise<{ invoice: Invoice; uploadUrl: string }>;
  listInvoices(ctx: TenantContext): Promise<Invoice[]>;
  getInvoice(ctx: TenantContext, id: string): Promise<Invoice | undefined>;
  listExceptions(ctx: TenantContext): Promise<Invoice[]>;
  listEvents(ctx: TenantContext, invoiceId: string): Promise<AgentEvent[]>;
  humanDecision(ctx: TenantContext, invoiceId: string, action: "approve" | "reject"): Promise<Invoice>;
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly invoices = new Map<string, Invoice>();
  private readonly events: AgentEvent[] = [];

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
}

export const repository = new InMemoryInvoiceRepository();

