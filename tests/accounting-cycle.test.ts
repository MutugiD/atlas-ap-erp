import { describe, expect, test } from "bun:test";
import {
  buildInvoicePostingJournal,
  createPaymentRun,
  journalBalances,
  reconcileBankTransactions,
  threeWayMatch,
  trialBalance,
  validateInvoiceDataEntry,
  type AccountingInvoice,
  type AccountingPeriod,
  type PurchaseOrderAccounting,
  type VendorMaster,
} from "@atlas/accounting";
import { LocalAgentProvider, Supervisor } from "@atlas/agents";
import type { TenantContext } from "@atlas/contracts";
import { InMemoryInvoiceRepository } from "../apps/api/src/repository";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ctx: TenantContext = {
  tenantId,
  userId: "22222222-2222-4222-8222-222222222222",
  role: "admin",
};

const openPeriod: AccountingPeriod = {
  id: "2026-07",
  startsOn: "2026-07-01",
  endsOn: "2026-07-31",
  status: "open",
};

const vendor: VendorMaster = {
  id: "vendor-office",
  name: "Nairobi Office Supplies",
  taxId: "KE-PIN-001",
  active: true,
  paymentTermsDays: 30,
  defaultExpenseAccount: "6100",
  currency: "USD",
};

function accountingInvoice(overrides: Partial<AccountingInvoice> = {}): AccountingInvoice {
  return {
    id: "inv-clean-001",
    vendorId: vendor.id,
    vendorName: vendor.name,
    invoiceNumber: "INV-2026-1001",
    invoiceDate: "2026-07-03",
    postingDate: "2026-07-03",
    dueDate: "2026-07-20",
    currency: "USD",
    subtotal: 1000,
    tax: 160,
    total: 1160,
    status: "queued_for_payment",
    poId: "po-office-001",
    lines: [
      { description: "Printer paper", quantity: 100, unitPrice: 4, total: 400, glAccount: "6100", costCenter: "OPS" },
      { description: "Toner", quantity: 20, unitPrice: 30, total: 600, glAccount: "6110", costCenter: "OPS" },
    ],
    ...overrides,
  };
}

function purchaseOrder(overrides: Partial<PurchaseOrderAccounting> = {}): PurchaseOrderAccounting {
  return {
    id: "po-office-001",
    poNumber: "PO-2026-1001",
    vendorId: vendor.id,
    currency: "USD",
    lines: [
      { description: "Printer paper", quantity: 100, unitPrice: 4, total: 400 },
      { description: "Toner", quantity: 20, unitPrice: 30, total: 600 },
    ],
    ...overrides,
  };
}

describe("real-world AP accounting cycles", () => {
  test("clean PO-backed invoice flows through agents, posting, payment run, and bank reconciliation", async () => {
    const repo = new InMemoryInvoiceRepository();
    const { invoice } = await repo.createInvoice(ctx, {
      total: 1160,
      currency: "USD",
      poId: "44444444-4444-4444-8444-444444444444",
      sourceObjectKey: "clean-accounting-cycle.pdf",
    });

    const routed = await new Supervisor(new LocalAgentProvider()).process(ctx, invoice, repo);
    expect(routed.invoice.status).toBe("queued_for_payment");

    const apInvoice = accountingInvoice({ id: routed.invoice.id, invoiceNumber: routed.invoice.invoiceNumber ?? "INV-2026-1001" });
    const controls = validateInvoiceDataEntry({ invoice: apInvoice, vendor, period: openPeriod, expectedTaxRate: 0.16 });
    expect(controls.ok).toBe(true);
    expect(controls.findings.filter((finding) => finding.severity === "error")).toHaveLength(0);

    const match = threeWayMatch({
      invoice: apInvoice,
      po: purchaseOrder(),
      receipts: [
        { poId: "po-office-001", description: "Printer paper", quantityReceived: 100 },
        { poId: "po-office-001", description: "Toner", quantityReceived: 20 },
      ],
    });
    expect(match.ok).toBe(true);
    expect(match.amountVariance).toBe(0);
    expect(match.receiptVariance).toBe(0);

    const posting = buildInvoicePostingJournal({ tenantId, invoice: apInvoice, vendor });
    expect(posting.balanced).toBe(true);
    expect(posting.entries).toContainEqual(expect.objectContaining({ account: "2100", credit: 1160 }));

    const paymentRun = createPaymentRun({ tenantId, invoices: [apInvoice], vendors: [vendor], scheduledDate: "2026-07-20" });
    expect(paymentRun.payments).toHaveLength(1);
    expect(paymentRun.excluded).toHaveLength(0);
    expect(paymentRun.journal.balanced).toBe(true);

    const reconciliation = reconcileBankTransactions({
      payments: paymentRun.payments,
      bankTransactions: [{
        id: "bank-001",
        amount: -1160,
        currency: "USD",
        valueDate: "2026-07-20",
        reference: `ACH ${apInvoice.id.slice(0, 8)} Nairobi Office Supplies`,
      }],
    });
    expect(reconciliation.matched).toHaveLength(1);
    expect(reconciliation.exceptions.filter((finding) => finding.severity === "error")).toHaveLength(0);

    const balances = trialBalance([...posting.entries, ...paymentRun.journal.entries]);
    expect(balances.get("2100")?.net).toBe(0);
    expect(journalBalances([...posting.entries, ...paymentRun.journal.entries])).toBe(true);
  });

  test("data-entry controls catch inactive vendor, duplicate, closed period, bad line extension, and tax variance", () => {
    const invoice = accountingInvoice({
      invoiceNumber: "INV-DUP-1",
      postingDate: "2026-06-30",
      subtotal: 999,
      tax: 10,
      total: 1015,
      lines: [{ description: "Consulting", quantity: 3, unitPrice: 300, total: 950 }],
    });
    const result = validateInvoiceDataEntry({
      invoice,
      vendor: { ...vendor, active: false, taxId: undefined },
      period: { ...openPeriod, status: "closed" },
      existingInvoiceKeys: [`${vendor.id}:INV-DUP-1`],
      expectedTaxRate: 0.16,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "vendor_inactive",
      "vendor_tax_id_missing",
      "posting_period_mismatch",
      "posting_period_closed",
      "line_extension_mismatch",
      "subtotal_mismatch",
      "invoice_total_mismatch",
      "tax_rate_variance",
      "duplicate_invoice",
    ]));
  });

  test("three-way match blocks quantity short receipt and amount variance outside tolerance", () => {
    const invoice = accountingInvoice({ subtotal: 1225, tax: 196, total: 1421 });
    const result = threeWayMatch({
      invoice,
      po: purchaseOrder(),
      receipts: [
        { poId: "po-office-001", description: "Printer paper", quantityReceived: 100 },
        { poId: "po-office-001", description: "Toner", quantityReceived: 10 },
      ],
      amountTolerance: 5,
      percentTolerance: 0.01,
    });
    expect(result.ok).toBe(false);
    expect(result.amountVariance).toBe(225);
    expect(result.receiptVariance).toBe(10);
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["po_amount_variance", "receipt_quantity_short"]));
  });

  test("payment run excludes holds, not-due invoices, and non-payable statuses", () => {
    const payable = accountingInvoice({ id: "payable", status: "queued_for_payment", dueDate: "2026-07-20" });
    const future = accountingInvoice({ id: "future", status: "queued_for_payment", dueDate: "2026-08-20" });
    const exception = accountingInvoice({ id: "exception", status: "exception" });
    const heldVendorInvoice = accountingInvoice({ id: "held", vendorId: "held-vendor", status: "queued_for_payment" });
    const run = createPaymentRun({
      tenantId,
      invoices: [payable, future, exception, heldVendorInvoice],
      vendors: [vendor, { ...vendor, id: "held-vendor", holdPayments: true }],
      scheduledDate: "2026-07-20",
    });
    expect(run.payments.map((payment) => payment.invoiceId)).toEqual(["payable"]);
    expect(run.excluded.map((item) => item.reason)).toEqual(expect.arrayContaining([
      "Invoice is not due yet",
      "Invoice status exception is not payable",
      "Vendor payment hold",
    ]));
  });

  test("bank reconciliation flags unmatched payments and stray bank transactions", () => {
    const run = createPaymentRun({ tenantId, invoices: [accountingInvoice({ id: "missing-bank" })], vendors: [vendor], scheduledDate: "2026-07-20" });
    const reconciliation = reconcileBankTransactions({
      payments: run.payments,
      bankTransactions: [{ id: "bank-fee", amount: -25, currency: "USD", valueDate: "2026-07-20", reference: "WIRE FEE" }],
    });
    expect(reconciliation.matched).toHaveLength(0);
    expect(reconciliation.unmatchedPayments).toHaveLength(1);
    expect(reconciliation.unmatchedBankTransactions).toHaveLength(1);
    expect(reconciliation.exceptions.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "payment_not_found_in_bank",
      "unmatched_bank_transaction",
    ]));
  });
});
