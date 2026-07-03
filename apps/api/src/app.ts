import { Hono } from "hono";
import { createInvoiceSchema } from "@atlas/contracts";
import { Supervisor } from "@atlas/agents";
import { repository } from "./repository";
import { withTenant } from "./tenant";

export const app = new Hono();
const supervisor = new Supervisor();

app.get("/health", (c) => c.json({ ok: true, service: "atlas-ap-api" }));

const v1 = new Hono();
v1.use("*", withTenant);

v1.post("/invoices", async (c) => {
  const tenant = c.get("tenant");
  const input = createInvoiceSchema.parse(await c.req.json());
  const result = await repository.createInvoice(tenant, input);
  return c.json(result, 201);
});

v1.get("/invoices", async (c) => c.json({ invoices: await repository.listInvoices(c.get("tenant")) }));

v1.get("/invoices/:id", async (c) => {
  const invoice = await repository.getInvoice(c.get("tenant"), c.req.param("id"));
  return invoice ? c.json({ invoice }) : c.notFound();
});

v1.post("/invoices/:id/reprocess", async (c) => {
  const tenant = c.get("tenant");
  const invoice = await repository.getInvoice(tenant, c.req.param("id"));
  if (!invoice) return c.notFound();
  const result = await supervisor.process(tenant, invoice, repository);
  return c.json(result);
});

v1.post("/invoices/:id/posting-preview", async (c) => {
  return c.json({ journal: await repository.previewPosting(c.get("tenant"), c.req.param("id")) });
});

v1.get("/invoices/:id/events", async (c) => {
  return c.json({ events: await repository.listEvents(c.get("tenant"), c.req.param("id")) });
});

v1.get("/exceptions", async (c) => c.json({ invoices: await repository.listExceptions(c.get("tenant")) }));

v1.post("/invoices/:id/approve", async (c) => {
  return c.json({ invoice: await repository.humanDecision(c.get("tenant"), c.req.param("id"), "approve") });
});

v1.post("/invoices/:id/reject", async (c) => {
  return c.json({ invoice: await repository.humanDecision(c.get("tenant"), c.req.param("id"), "reject") });
});

v1.post("/payment-runs", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ paymentRun: await repository.createPaymentRun(c.get("tenant"), body.scheduledDate ?? new Date().toISOString().slice(0, 10)) }, 201);
});

v1.post("/reconciliations", async (c) => {
  const body = await c.req.json();
  return c.json({ reconciliation: await repository.reconcilePayments(c.get("tenant"), body.bankTransactions ?? []) });
});

v1.post("/accounting/credit-memo-applications", async (c) => {
  const body = await c.req.json();
  return c.json({ result: await repository.applyCredits(c.get("tenant"), body.invoiceId, body.creditMemos ?? []) });
});

v1.post("/accounting/partial-payment-plans", async (c) => {
  const body = await c.req.json();
  return c.json({ result: await repository.planPartialPayment(c.get("tenant"), body.invoiceId, Number(body.requestedAmount ?? 0)) });
});

v1.get("/accounting/aging", async (c) => {
  return c.json({ buckets: await repository.aging(c.get("tenant"), c.req.query("asOfDate") ?? new Date().toISOString().slice(0, 10)) });
});

v1.post("/accounting/fx-realizations", async (c) => {
  const body = await c.req.json();
  return c.json({ result: await repository.realizeFx(c.get("tenant"), body) });
});

v1.post("/webhooks/email-inbound", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json();
  const result = await repository.createInvoice(tenant, {
    sourceObjectKey: body.objectKey ?? `email/${crypto.randomUUID()}.pdf`,
    vendorName: body.vendorName,
    invoiceNumber: body.invoiceNumber,
    total: Number(body.total ?? 0),
    currency: body.currency ?? "USD",
  });
  return c.json({ accepted: true, invoice: result.invoice }, 202);
});

app.route("/v1", v1);
