import { describe, expect, test } from "bun:test";
import { app } from "../apps/api/src/app";
import { repository } from "../apps/api/src/repository";
import { EquityJengaConnector, normalizeJengaStatement } from "../apps/api/src/bank";

const jengaStatement = {
  data: {
    transactions: [
      { reference: "REF-CR", date: "2026-07-01", amount: 5000, type: "Credit", runningBalance: { currency: "KES", amount: 5000 } },
      { reference: "ACH 12345678", date: "2026-07-02", amount: 1200, type: "Debit", runningBalance: { currency: "KES", amount: 3800 } },
    ],
  },
};

describe("Bank connector (Equity Jenga)", () => {
  test("normalizes a Jenga statement (debits negative, credits positive)", () => {
    const txns = normalizeJengaStatement(jengaStatement);
    expect(txns).toHaveLength(2);
    expect(txns[0]).toMatchObject({ amount: 5000, currency: "KES", reference: "REF-CR", valueDate: "2026-07-01" });
    expect(txns[1].amount).toBe(-1200);
  });

  test("fetchStatement signs the request, sends a Bearer token, and returns normalized transactions", async () => {
    const captured: { url?: string; headers?: Headers } = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured.url = String(url);
      captured.headers = new Headers(init.headers);
      return new Response(JSON.stringify(jengaStatement), { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new EquityJengaConnector({ fetchImpl, token: async () => "tok-123", sign: () => "sig-abc", baseUrl: "https://jenga.test" });
    const txns = await connector.fetchStatement({ accountNumber: "1000123", countryCode: "KE", fromDate: "2026-07-01", toDate: "2026-07-31" });
    expect(txns).toHaveLength(2);
    expect(captured.url).toContain("/accounts/fullStatement");
    expect(captured.headers?.get("authorization")).toBe("Bearer tok-123");
    expect(captured.headers?.get("signature")).toBe("sig-abc");
  });

  test("disburse routes by amount and instrument (mobile / PesaLink / RTGS)", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ transactionId: "T1", status: "submitted" }), { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new EquityJengaConnector({ fetchImpl, token: async () => "t", sign: () => "s", baseUrl: "https://jenga.test", rtgsThreshold: 1_000_000 });

    expect((await connector.disburse({ paymentId: "p1", amount: 5000, currency: "KES", reference: "r1", destination: { type: "mobile", phoneNumber: "254700000000" } })).rail).toBe("mobile");
    expect((await connector.disburse({ paymentId: "p2", amount: 50_000, currency: "KES", reference: "r2", destination: { type: "bank", bankCode: "01", accountNumber: "123" } })).rail).toBe("pesalink");
    expect((await connector.disburse({ paymentId: "p3", amount: 2_000_000, currency: "KES", reference: "r3", destination: { type: "bank", bankCode: "01", accountNumber: "123" } })).rail).toBe("rtgs");
    expect(urls.some((u) => u.includes("sendtomobile"))).toBe(true);
    expect(urls.some((u) => u.includes("rtgs"))).toBe(true);
  });

  test("a pulled statement reconciles against a persisted payment", async () => {
    const ctx = { tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-ba0000000001", userId: "22222222-2222-4222-8222-222222222222", role: "ap_clerk" as const };
    const { invoice } = await repository.createInvoice(ctx, { vendorName: "Bank Vendor", invoiceNumber: "BANK-1", total: 900, currency: "KES" });
    await repository.updateInvoice(ctx, { ...invoice, status: "queued_for_payment" });
    const run = await repository.createPaymentRun(ctx, "2099-12-31");
    const payment = run.payments.find((p) => p.invoiceId === invoice.id);
    if (!payment) throw new Error("expected a payment");

    // A Jenga statement line for the disbursement (a debit referencing the invoice).
    const statement = { data: { transactions: [{ reference: `ACH ${invoice.id.slice(0, 8)}`, date: "2099-12-31", amount: payment.amount, type: "Debit", runningBalance: { currency: "KES", amount: 0 } }] } };
    const recon = await repository.reconcilePayments(ctx, normalizeJengaStatement(statement));
    expect(recon.matched).toHaveLength(1);
    expect(recon.matched[0].paymentId).toBe(payment.id);
  });

  test("statement-reconcile returns 501 when no bank connector is configured", async () => {
    const res = await app.request("/v1/bank/statement-reconcile", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-ba0000000002", "x-user-id": "22222222-2222-4222-8222-222222222222" },
      body: JSON.stringify({ accountNumber: "1000123", fromDate: "2026-07-01", toDate: "2026-07-31" }),
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe("bank_not_configured");
  });
});
