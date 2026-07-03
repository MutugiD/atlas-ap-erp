import { describe, expect, test } from "bun:test";
import { app } from "../apps/api/src/app";

const headers = {
  "content-type": "application/json",
  "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-user-id": "22222222-2222-4222-8222-222222222222",
};

describe("Hono API", () => {
  test("creates, lists, details, reprocesses, and lists events", async () => {
    const create = await app.request("/v1/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({ total: 1200, currency: "USD", poId: "44444444-4444-4444-8444-444444444444" }),
    });
    expect(create.status).toBe(201);
    const created = await create.json();
    const id = created.invoice.id;

    const list = await app.request("/v1/invoices", { headers });
    expect((await list.json()).invoices.some((invoice: { id: string }) => invoice.id === id)).toBe(true);

    const detail = await app.request(`/v1/invoices/${id}`, { headers });
    expect((await detail.json()).invoice.id).toBe(id);

    const reprocess = await app.request(`/v1/invoices/${id}/reprocess`, { method: "POST", headers });
    expect((await reprocess.json()).invoice.status).toBe("queued_for_payment");

    const events = await app.request(`/v1/invoices/${id}/events`, { headers });
    expect((await events.json()).events.length).toBeGreaterThan(0);
  });

  test("keeps tenants isolated in repository-backed routes", async () => {
    const tenantA = headers;
    const tenantB = { ...headers, "x-tenant-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const create = await app.request("/v1/invoices", {
      method: "POST",
      headers: tenantA,
      body: JSON.stringify({ total: 50, currency: "USD" }),
    });
    const id = (await create.json()).invoice.id;
    const fromOtherTenant = await app.request(`/v1/invoices/${id}`, { headers: tenantB });
    expect(fromOtherTenant.status).toBe(404);
  });

  test("webhook accepts email inbound", async () => {
    const response = await app.request("/v1/webhooks/email-inbound", {
      method: "POST",
      headers,
      body: JSON.stringify({ vendorName: "Vendor", invoiceNumber: "EMAIL-1", total: 10 }),
    });
    expect(response.status).toBe(202);
  });

  test("creates posting preview, payment run, and bank reconciliation for payable invoice", async () => {
    const create = await app.request("/v1/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({ vendorName: "Nairobi Office Supplies", invoiceNumber: "PAY-1", total: 1200, currency: "USD" }),
    });
    const invoice = (await create.json()).invoice;
    const reprocess = await app.request(`/v1/invoices/${invoice.id}/reprocess`, { method: "POST", headers });
    const routed = (await reprocess.json()).invoice;
    expect(routed.status).toBe("queued_for_payment");

    const preview = await app.request(`/v1/invoices/${invoice.id}/posting-preview`, { method: "POST", headers });
    const journal = (await preview.json()).journal;
    expect(journal.balanced).toBe(true);
    expect(journal.entries.some((entry: { account: string; credit: number }) => entry.account === "2100" && entry.credit === 1200)).toBe(true);

    const paymentRunResponse = await app.request("/v1/payment-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ scheduledDate: "2026-07-20" }),
    });
    const paymentRun = (await paymentRunResponse.json()).paymentRun;
    expect(paymentRun.payments.some((payment: { invoiceId: string }) => payment.invoiceId === invoice.id)).toBe(true);
    expect(paymentRun.journal.balanced).toBe(true);

    const reconciliation = await app.request("/v1/reconciliations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        bankTransactions: [{
          id: "bank-pay-1",
          amount: -1200,
          currency: "USD",
          valueDate: "2026-07-20",
          reference: `ACH ${invoice.id.slice(0, 8)}`,
        }],
      }),
    });
    expect((await reconciliation.json()).reconciliation.matched).toHaveLength(1);
  });

  test("manages vendor master lifecycle", async () => {
    const vHeaders = { ...headers, "x-tenant-id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    const create = await app.request("/v1/vendors", {
      method: "POST",
      headers: vHeaders,
      body: JSON.stringify({ name: "Acme Supplies", taxId: "KE-123", currency: "USD" }),
    });
    expect(create.status).toBe(201);
    const vendor = (await create.json()).vendor;
    expect(vendor.active).toBe(true);
    expect(vendor.holdPayments).toBe(false);

    const list = await app.request("/v1/vendors", { headers: vHeaders });
    expect((await list.json()).vendors.some((v: { id: string }) => v.id === vendor.id)).toBe(true);

    const patched = await app.request(`/v1/vendors/${vendor.id}`, {
      method: "PATCH",
      headers: vHeaders,
      body: JSON.stringify({ holdPayments: true }),
    });
    expect((await patched.json()).vendor.holdPayments).toBe(true);
  });

  test("payment run honors vendor payment hold", async () => {
    const dHeaders = { ...headers, "x-tenant-id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
    const heldVendor = (await (await app.request("/v1/vendors", {
      method: "POST",
      headers: dHeaders,
      body: JSON.stringify({ name: "Held Vendor", currency: "USD", holdPayments: true }),
    })).json()).vendor;

    const invoice = (await (await app.request("/v1/invoices", {
      method: "POST",
      headers: dHeaders,
      body: JSON.stringify({ invoiceNumber: "HOLD-1", total: 500, currency: "USD", vendorId: heldVendor.id }),
    })).json()).invoice;
    expect(invoice.vendorId).toBe(heldVendor.id);
    await app.request(`/v1/invoices/${invoice.id}/reprocess`, { method: "POST", headers: dHeaders });

    const run = (await (await app.request("/v1/payment-runs", {
      method: "POST",
      headers: dHeaders,
      body: JSON.stringify({ scheduledDate: "2099-12-31" }),
    })).json()).paymentRun;
    expect(run.payments.some((p: { invoiceId: string }) => p.invoiceId === invoice.id)).toBe(false);
    expect(run.excluded.some((e: { invoiceId: string; reason: string }) => e.invoiceId === invoice.id && e.reason === "Vendor payment hold")).toBe(true);
  });

  test("serves accounting credit, partial payment, aging, and FX endpoints", async () => {
    const create = await app.request("/v1/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({ vendorName: "Global Components Ltd", invoiceNumber: "FX-1", total: 1000, currency: "EUR" }),
    });
    const invoice = (await create.json()).invoice;
    await app.request(`/v1/invoices/${invoice.id}/reprocess`, { method: "POST", headers });

    const credits = await app.request("/v1/accounting/credit-memo-applications", {
      method: "POST",
      headers,
      body: JSON.stringify({
        invoiceId: invoice.id,
        creditMemos: [{ id: "cm-api-1", vendorId: "vendor:Global Components Ltd", amount: 300, currency: "EUR", status: "available" }],
      }),
    });
    expect((await credits.json()).result.netPayable).toBe(700);

    const partial = await app.request("/v1/accounting/partial-payment-plans", {
      method: "POST",
      headers,
      body: JSON.stringify({ invoiceId: invoice.id, requestedAmount: 250 }),
    });
    expect((await partial.json()).result.remainingAmount).toBe(750);

    const aging = await app.request("/v1/accounting/aging?asOfDate=2026-08-20", { headers });
    expect((await aging.json()).buckets.some((bucket: { amount: number }) => bucket.amount > 0)).toBe(true);

    const fx = await app.request("/v1/accounting/fx-realizations", {
      method: "POST",
      headers,
      body: JSON.stringify({ invoiceId: invoice.id, functionalCurrency: "USD", invoiceFxRate: 1.2, paymentFxRate: 1.1 }),
    });
    expect((await fx.json()).result.account).toBe("realized_fx_gain");
  });
});
