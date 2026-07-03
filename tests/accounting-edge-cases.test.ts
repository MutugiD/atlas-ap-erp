import { describe, expect, test } from "bun:test";
import {
  applyCreditMemos,
  buildApAging,
  calculateRealizedFx,
  createPartialPaymentPlan,
  type AccountingInvoice,
} from "@atlas/accounting";

const baseInvoice: AccountingInvoice = {
  id: "inv-edge-001",
  vendorId: "vendor-1",
  vendorName: "Global Components Ltd",
  invoiceNumber: "GC-100",
  invoiceDate: "2026-05-01",
  postingDate: "2026-05-01",
  dueDate: "2026-05-31",
  currency: "EUR",
  subtotal: 1000,
  tax: 0,
  total: 1000,
  status: "queued_for_payment",
  lines: [{ description: "Components", quantity: 10, unitPrice: 100, total: 1000 }],
};

describe("real-world AP accounting edge cases", () => {
  test("applies available credit memos and leaves residual credit", () => {
    const result = applyCreditMemos({
      invoice: baseInvoice,
      creditMemos: [
        { id: "cm-1", vendorId: "vendor-1", amount: 250, currency: "EUR", status: "available" },
        { id: "cm-2", vendorId: "vendor-1", amount: 900, currency: "EUR", status: "available" },
      ],
    });
    expect(result.netPayable).toBe(0);
    expect(result.applications).toEqual([
      { creditMemoId: "cm-1", invoiceId: "inv-edge-001", amountApplied: 250 },
      { creditMemoId: "cm-2", invoiceId: "inv-edge-001", amountApplied: 750 },
    ]);
    expect(result.remainingCredits).toEqual([{ id: "cm-2", vendorId: "vendor-1", amount: 150, currency: "EUR", status: "available" }]);
  });

  test("rejects credit memos from another vendor or currency", () => {
    const result = applyCreditMemos({
      invoice: baseInvoice,
      creditMemos: [
        { id: "cm-vendor", vendorId: "vendor-2", amount: 100, currency: "EUR", status: "available" },
        { id: "cm-currency", vendorId: "vendor-1", amount: 100, currency: "USD", status: "available" },
      ],
    });
    expect(result.netPayable).toBe(1000);
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["credit_vendor_mismatch", "credit_currency_mismatch"]));
  });

  test("creates partial payment plan with remaining balance", () => {
    const plan = createPartialPaymentPlan({ invoice: baseInvoice, requestedAmount: 400, minimumPayment: 25 });
    expect(plan.paymentAmount).toBe(400);
    expect(plan.remainingAmount).toBe(600);
    expect(plan.findings).toHaveLength(0);
  });

  test("blocks partial payment for non-payable invoice", () => {
    const plan = createPartialPaymentPlan({ invoice: { ...baseInvoice, status: "exception" }, requestedAmount: 400 });
    expect(plan.paymentAmount).toBe(0);
    expect(plan.findings[0].code).toBe("invoice_not_payable");
  });

  test("builds AP aging buckets by due date", () => {
    const aging = buildApAging({
      asOfDate: "2026-07-15",
      invoices: [
        { ...baseInvoice, id: "current", dueDate: "2026-07-20", total: 100 },
        { ...baseInvoice, id: "bucket-1", dueDate: "2026-07-01", total: 200 },
        { ...baseInvoice, id: "bucket-31", dueDate: "2026-06-01", total: 300 },
        { ...baseInvoice, id: "bucket-61", dueDate: "2026-05-01", total: 400 },
        { ...baseInvoice, id: "bucket-90", dueDate: "2026-03-01", total: 500 },
        { ...baseInvoice, id: "paid", status: "paid", dueDate: "2026-03-01", total: 999 },
      ],
    });
    expect(aging.map((bucket) => [bucket.label, bucket.amount])).toEqual([
      ["current", 100],
      ["1-30", 200],
      ["31-60", 300],
      ["61-90", 400],
      ["90+", 500],
    ]);
  });

  test("calculates realized FX gain and loss on foreign-currency payment", () => {
    const gain = calculateRealizedFx({
      invoiceId: baseInvoice.id,
      invoiceAmount: 1000,
      functionalCurrency: "USD",
      invoiceFxRate: 1.2,
      paymentFxRate: 1.1,
    });
    expect(gain.realizedGainLoss).toBe(100);
    expect(gain.account).toBe("realized_fx_gain");

    const loss = calculateRealizedFx({
      invoiceId: baseInvoice.id,
      invoiceAmount: 1000,
      functionalCurrency: "USD",
      invoiceFxRate: 1.1,
      paymentFxRate: 1.2,
    });
    expect(loss.realizedGainLoss).toBe(-100);
    expect(loss.account).toBe("realized_fx_loss");
  });
});
