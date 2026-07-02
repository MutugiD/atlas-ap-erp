import { describe, expect, test } from "bun:test";
import { LocalAgentProvider, Supervisor, sumsToTotal } from "@atlas/agents";
import { glCodingProposalSchema, type Invoice, type TenantContext } from "@atlas/contracts";
import { InMemoryInvoiceRepository } from "../apps/api/src/repository";

const ctx: TenantContext = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "22222222-2222-4222-8222-222222222222",
  role: "admin",
};

describe("agents", () => {
  test("validates GL proposal schema and balance", () => {
    const proposal = glCodingProposalSchema.parse({
      balanced: true,
      splits: [{ glAccount: "6100", costCenter: "OPS", amount: 1200 }],
      confidence: 0.91,
    });
    expect(sumsToTotal(proposal, 1200)).toBe(true);
  });

  test("routes clean PO invoice to payment queue", async () => {
    const repo = new InMemoryInvoiceRepository();
    const { invoice } = await repo.createInvoice(ctx, {
      total: 1200,
      currency: "USD",
      poId: "44444444-4444-4444-8444-444444444444",
      sourceObjectKey: "clean.pdf",
    });
    const result = await new Supervisor(new LocalAgentProvider()).process(ctx, invoice, repo);
    expect(result.invoice.status).toBe("queued_for_payment");
    expect(result.decisions.map((d) => d.agent)).toEqual([
      "extraction",
      "validation",
      "matching",
      "gl_coding",
      "approval_routing",
      "posting",
      "posting",
    ]);
  });

  test("routes non-PO invoice without matching", async () => {
    const repo = new InMemoryInvoiceRepository();
    const { invoice } = await repo.createInvoice(ctx, { total: 500, currency: "USD", sourceObjectKey: "non-po.pdf" });
    const result = await new Supervisor(new LocalAgentProvider()).process(ctx, invoice, repo);
    expect(result.invoice.status).toBe("queued_for_payment");
    expect(result.decisions.some((d) => d.agent === "matching")).toBe(false);
  });

  test("routes variance to exception", async () => {
    const repo = new InMemoryInvoiceRepository();
    const { invoice } = await repo.createInvoice(ctx, {
      total: 1200,
      currency: "USD",
      poId: "44444444-4444-4444-8444-444444444444",
      sourceObjectKey: "variance.pdf",
    });
    const result = await new Supervisor(new LocalAgentProvider()).process(ctx, invoice, repo);
    expect(result.invoice.status).toBe("exception");
  });

  test("routes low confidence extraction to exception", async () => {
    const repo = new InMemoryInvoiceRepository();
    const { invoice } = await repo.createInvoice(ctx, { total: 1200, currency: "USD", sourceObjectKey: "low-confidence.pdf" });
    const result = await new Supervisor(new LocalAgentProvider()).process(ctx, invoice, repo);
    expect(result.invoice.status).toBe("exception");
  });

  test("large invoice awaits approval", async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice: Invoice = (await repo.createInvoice(ctx, { total: 2500, currency: "USD" })).invoice;
    const result = await new Supervisor(new LocalAgentProvider()).process(ctx, invoice, repo);
    expect(result.invoice.status).toBe("awaiting_approval");
  });
});

