import { Hono } from "hono";
import { createAccountingPeriodSchema, createCreditMemoSchema, createDebitMemoSchema, createGoodsReceiptSchema, createInvoiceSchema, createProfitabilityInputSchema, createPurchaseOrderSchema, createVendorSchema, executePartialPaymentSchema, profitabilityComputeSchema, updateVendorSchema } from "@atlas/contracts";
import { Supervisor } from "@atlas/agents";
import { repository } from "./repository";
import { ClosedPeriodError } from "./errors";
import { BankNotConfiguredError, createBankConnector } from "./bank";
import { withTenant } from "./tenant";

const bankConnector = createBankConnector();

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

// Data-entry controls: is this a legit invoice? (vendor in master, arithmetic /
// line extensions, subtotal+tax=total, duplicate key, open period).
v1.post("/invoices/:id/validate", async (c) => {
  return c.json({ validation: await repository.validateDataEntry(c.get("tenant"), c.req.param("id")) });
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

// Pull a bank statement via the configured connector (e.g. Equity Jenga) and
// reconcile it against persisted payments in one call.
v1.post("/bank/statement-reconcile", async (c) => {
  const body = await c.req.json();
  try {
    const transactions = await bankConnector.fetchStatement({
      accountNumber: body.accountNumber,
      countryCode: body.countryCode ?? "KE",
      fromDate: body.fromDate,
      toDate: body.toDate,
      limit: body.limit,
    });
    const reconciliation = await repository.reconcilePayments(c.get("tenant"), transactions);
    return c.json({ provider: bankConnector.provider, transactions: transactions.length, reconciliation });
  } catch (error) {
    if (error instanceof BankNotConfiguredError) return c.json({ error: "bank_not_configured", message: error.message }, 501);
    throw error;
  }
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

v1.post("/vendors", async (c) => {
  const input = createVendorSchema.parse(await c.req.json());
  return c.json({ vendor: await repository.createVendor(c.get("tenant"), input) }, 201);
});

v1.get("/vendors", async (c) => c.json({ vendors: await repository.listVendors(c.get("tenant")) }));

v1.get("/vendors/:id", async (c) => {
  const vendor = await repository.getVendor(c.get("tenant"), c.req.param("id"));
  return vendor ? c.json({ vendor }) : c.notFound();
});

v1.patch("/vendors/:id", async (c) => {
  const patch = updateVendorSchema.parse(await c.req.json());
  return c.json({ vendor: await repository.updateVendor(c.get("tenant"), c.req.param("id"), patch) });
});

v1.post("/purchase-orders", async (c) => {
  const input = createPurchaseOrderSchema.parse(await c.req.json());
  return c.json({ purchaseOrder: await repository.createPurchaseOrder(c.get("tenant"), input) }, 201);
});

v1.get("/purchase-orders", async (c) => c.json({ purchaseOrders: await repository.listPurchaseOrders(c.get("tenant")) }));

v1.get("/purchase-orders/:id", async (c) => {
  const purchaseOrder = await repository.getPurchaseOrder(c.get("tenant"), c.req.param("id"));
  return purchaseOrder ? c.json({ purchaseOrder }) : c.notFound();
});

v1.post("/goods-receipts", async (c) => {
  const input = createGoodsReceiptSchema.parse(await c.req.json());
  return c.json({ goodsReceipt: await repository.createGoodsReceipt(c.get("tenant"), input) }, 201);
});

v1.get("/purchase-orders/:id/goods-receipts", async (c) => {
  return c.json({ goodsReceipts: await repository.listGoodsReceipts(c.get("tenant"), c.req.param("id")) });
});

v1.post("/invoices/:id/three-way-match", async (c) => {
  return c.json({ match: await repository.matchInvoice(c.get("tenant"), c.req.param("id")) });
});

v1.post("/accounting-periods", async (c) => {
  const input = createAccountingPeriodSchema.parse(await c.req.json());
  return c.json({ period: await repository.createAccountingPeriod(c.get("tenant"), input) }, 201);
});

v1.get("/accounting-periods", async (c) => c.json({ periods: await repository.listAccountingPeriods(c.get("tenant")) }));

v1.post("/accounting-periods/:id/close", async (c) => {
  return c.json({ period: await repository.setPeriodStatus(c.get("tenant"), c.req.param("id"), "closed") });
});

v1.post("/accounting-periods/:id/reopen", async (c) => {
  return c.json({ period: await repository.setPeriodStatus(c.get("tenant"), c.req.param("id"), "open") });
});

v1.post("/credit-memos", async (c) => {
  const input = createCreditMemoSchema.parse(await c.req.json());
  return c.json({ creditMemo: await repository.createCreditMemo(c.get("tenant"), input) }, 201);
});

v1.get("/credit-memos", async (c) => c.json({ creditMemos: await repository.listCreditMemos(c.get("tenant")) }));

v1.post("/debit-memos", async (c) => {
  const input = createDebitMemoSchema.parse(await c.req.json());
  return c.json(await repository.createDebitMemo(c.get("tenant"), input), 201);
});

v1.get("/debit-memos", async (c) => c.json({ debitMemos: await repository.listDebitMemos(c.get("tenant")) }));

v1.post("/profitability/inputs", async (c) => {
  const input = createProfitabilityInputSchema.parse(await c.req.json());
  return c.json({ input: await repository.createProfitabilityInput(c.get("tenant"), input) }, 201);
});

v1.get("/profitability/inputs", async (c) => {
  const period = c.req.query("period");
  if (!period) return c.json({ error: "period query param is required" }, 400);
  return c.json({ inputs: await repository.listProfitabilityInputs(c.get("tenant"), period) });
});

v1.post("/profitability/compute", async (c) => {
  const params = profitabilityComputeSchema.parse(await c.req.json());
  return c.json(await repository.profitabilityReport(c.get("tenant"), params));
});

// Generate + persist a report artifact (executive summary + detail) for a period.
v1.post("/profitability/reports", async (c) => {
  const params = profitabilityComputeSchema.parse(await c.req.json());
  return c.json({ report: await repository.generateProfitabilityReport(c.get("tenant"), params) }, 201);
});

v1.get("/profitability/reports", async (c) => c.json({ reports: await repository.listProfitabilityReports(c.get("tenant")) }));

v1.get("/profitability/reports/:id", async (c) => {
  const report = await repository.getProfitabilityReport(c.get("tenant"), c.req.param("id"));
  return report ? c.json({ report }) : c.notFound();
});

v1.post("/invoices/:id/apply-credits", async (c) => {
  return c.json({ result: await repository.applyAvailableCredits(c.get("tenant"), c.req.param("id")) });
});

v1.post("/invoices/:id/partial-payments", async (c) => {
  const input = executePartialPaymentSchema.parse(await c.req.json());
  return c.json({ result: await repository.executePartialPayment(c.get("tenant"), c.req.param("id"), input.requestedAmount) });
});

v1.get("/invoices/:id/partial-payments", async (c) => {
  return c.json({ partialPayments: await repository.listPartialPayments(c.get("tenant"), c.req.param("id")) });
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

// A post into a closed accounting period is a conflict, not a server error.
app.onError((err, c) => {
  if (err instanceof ClosedPeriodError) {
    return c.json({ error: "accounting_period_closed", message: err.message, periodId: err.periodId }, 409);
  }
  throw err;
});

app.route("/v1", v1);
