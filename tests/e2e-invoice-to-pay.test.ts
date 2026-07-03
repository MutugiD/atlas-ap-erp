import { describe, expect, test } from "bun:test";
import { app } from "../apps/api/src/app";

// A real end-to-end walk of the invoice-to-pay lifecycle through the HTTP API:
// vendor + PO + goods receipt -> invoice -> three-way match -> agent pipeline ->
// posting -> payment run -> bank reconciliation. Runs against the in-memory
// repository (no DB required); the same scenario is exercised against Postgres
// in tests/api-live.test.ts.

const headers = {
  "content-type": "application/json",
  "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-e2e000000001",
  "x-user-id": "22222222-2222-4222-8222-222222222222",
};
const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
const get = (path: string) => app.request(path, { headers });

describe("End-to-end invoice-to-pay flow", () => {
  test("ingest -> three-way match -> agent processing -> posting -> payment run -> bank reconciliation", async () => {
    // 1. Vendor master.
    const vendor = (await (await post("/v1/vendors", { name: "Acme Corp", currency: "USD" })).json()).vendor;

    // 2. Purchase order + goods receipt (for three-way matching).
    const po = (await (await post("/v1/purchase-orders", {
      poNumber: "E2E-PO",
      vendorId: vendor.id,
      currency: "USD",
      lines: [{ description: "Acme Corp", quantity: 1, unitPrice: 1200, total: 1200 }],
    })).json()).purchaseOrder;
    expect((await post("/v1/goods-receipts", { poId: po.id, description: "Acme Corp", quantityReceived: 1 })).status).toBe(201);

    // 3. Invoice referencing the vendor and PO.
    const created = await post("/v1/invoices", { vendorName: "Acme Corp", vendorId: vendor.id, poId: po.id, invoiceNumber: "E2E-INV", total: 1200, currency: "USD" });
    expect(created.status).toBe(201);
    const invoiceId = (await created.json()).invoice.id;

    // 4. Three-way match: invoice matches the PO amount and the received quantity.
    const match = (await (await post(`/v1/invoices/${invoiceId}/three-way-match`, {})).json()).match;
    expect(match.ok).toBe(true);
    expect(match.amountVariance).toBe(0);

    // 5. Agent pipeline drives the invoice through to payable, recording events.
    const reprocess = await post(`/v1/invoices/${invoiceId}/reprocess`, {});
    expect(reprocess.status).toBe(200);
    expect((await reprocess.json()).invoice.status).toBe("queued_for_payment");
    expect((await (await get(`/v1/invoices/${invoiceId}/events`)).json()).events.length).toBeGreaterThan(0);

    // 6. Posting preview is a balanced journal.
    const journal = (await (await post(`/v1/invoices/${invoiceId}/posting-preview`, {})).json()).journal;
    expect(journal.balanced).toBe(true);

    // 7. Payment run pays the (processed) invoice with a balanced disbursement journal.
    const invoice = (await (await get(`/v1/invoices/${invoiceId}`)).json()).invoice;
    const run = (await (await post("/v1/payment-runs", { scheduledDate: "2099-12-31" })).json()).paymentRun;
    const payment = run.payments.find((p: { invoiceId: string }) => p.invoiceId === invoiceId);
    expect(payment).toBeDefined();
    expect(payment.amount).toBe(invoice.total);
    expect(run.journal.balanced).toBe(true);

    // 8. Bank integration: reconcile the disbursement against a bank statement line.
    const recon = (await (await post("/v1/reconciliations", {
      bankTransactions: [{ id: "bank-e2e-1", amount: -payment.amount, currency: "USD", valueDate: "2099-12-31", reference: `ACH ${invoiceId.slice(0, 8)}` }],
    })).json()).reconciliation;
    expect(recon.matched).toHaveLength(1);
    expect(recon.matched[0].paymentId).toBe(payment.id);
    expect(recon.exceptions.filter((e: { severity: string }) => e.severity === "error")).toHaveLength(0);
  });
});
