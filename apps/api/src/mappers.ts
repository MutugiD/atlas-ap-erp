import {
  type CreateInvoiceInput,
  type CreditMemoRecord,
  type GoodsReceiptRecord,
  type Invoice,
  type InvoiceDraft,
  type ProfitabilityComputeInput,
  type ProfitabilityInputRecord,
  type PurchaseOrder,
  type Vendor,
} from "@atlas/contracts";
import { type AccountingInvoice, type AccountingPeriod, type CreditMemo, type GoodsReceipt, type PurchaseOrderAccounting, type VendorMaster } from "@atlas/accounting";
import { type ProfitabilityConfig, type ProfitabilityInput } from "@atlas/profitability";

// Shared mapping from the persisted Invoice shape to the accounting-engine
// inputs, used by both the in-memory and Postgres repositories.

export function toAccountingInvoice(invoice: Invoice): AccountingInvoice {
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

export function toVendorMaster(invoice: Pick<Invoice, "vendorId" | "vendorName" | "currency"> & { id?: string }): VendorMaster {
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

// When a create request supplies subtotal + tax, build an extracted draft so the
// invoice carries a real breakdown the data-entry controls can validate (line
// extensions, subtotal = sum(lines), subtotal + tax = total).
export function buildExtractedDraft(id: string, input: CreateInvoiceInput): InvoiceDraft | undefined {
  if (input.subtotal === undefined || input.tax === undefined) return undefined;
  const subtotal = input.subtotal;
  return {
    vendorName: input.vendorName ?? "Unknown vendor",
    invoiceNumber: input.invoiceNumber ?? id.slice(0, 8),
    invoiceDate: new Date().toISOString().slice(0, 10),
    currency: input.currency,
    subtotal,
    tax: input.tax,
    total: input.total,
    lines: [{ description: input.vendorName ?? "Invoice", quantity: 1, unitPrice: subtotal, total: subtotal }],
    fieldConfidence: {},
    confidence: 1,
  };
}

// A synthetic open period for validation when no managed accounting period
// covers the posting date, so periods being unmanaged doesn't false-flag.
export function openPeriod(date: string): AccountingPeriod {
  return { id: "unmanaged", startsOn: date, endsOn: date, status: "open" };
}

export function toAccountingStatus(status: Invoice["status"]): AccountingInvoice["status"] {
  if (status === "rejected" || status === "coded") return "exception";
  if (status === "extracted" || status === "received") return "received";
  return status;
}

// A persisted vendor record maps directly onto the accounting engine's VendorMaster.
export function vendorToMaster(vendor: Vendor): VendorMaster {
  return {
    id: vendor.id,
    name: vendor.name,
    taxId: vendor.taxId,
    active: vendor.active,
    paymentTermsDays: vendor.paymentTermsDays,
    defaultExpenseAccount: vendor.defaultExpenseAccount,
    currency: vendor.currency,
    holdPayments: vendor.holdPayments,
    withholdingTaxRate: vendor.withholdingTaxRate,
  };
}

export function toPurchaseOrderAccounting(po: PurchaseOrder): PurchaseOrderAccounting {
  return { id: po.id, poNumber: po.poNumber, vendorId: po.vendorId ?? "", currency: po.currency, lines: po.lines };
}

export function toGoodsReceipt(receipt: GoodsReceiptRecord): GoodsReceipt {
  return { poId: receipt.poId, description: receipt.description, quantityReceived: receipt.quantityReceived };
}

export function toAccountingCreditMemo(memo: CreditMemoRecord): CreditMemo {
  return { id: memo.id, vendorId: memo.vendorId ?? "", amount: memo.amount, currency: memo.currency, status: memo.status };
}

export function profitabilityConfigFrom(params: ProfitabilityComputeInput): ProfitabilityConfig {
  const config: ProfitabilityConfig = { overheadPool: params.overheadPool };
  if (params.overheadBasis) config.overheadBasis = params.overheadBasis;
  if (params.greenAtOrAbove !== undefined) config.greenAtOrAbove = params.greenAtOrAbove;
  if (params.yellowAtOrAbove !== undefined) config.yellowAtOrAbove = params.yellowAtOrAbove;
  return config;
}

export function toEngineInput(record: ProfitabilityInputRecord): ProfitabilityInput {
  return {
    account: record.account,
    serviceLine: record.serviceLine,
    feeRevenue: record.feeRevenue,
    laborHours: record.laborHours,
    laborCostRate: record.laborCostRate,
    mediaSpend: record.mediaSpend,
    mediaMarkupRate: record.mediaMarkupRate,
  };
}

// Build the VendorMaster list a payment run needs: use the real vendor master
// where the invoice's vendorId resolves to a persisted vendor, otherwise fall
// back to a synthetic stub (invoices not yet linked to a vendor record).
export function vendorMastersForInvoices(invoices: AccountingInvoice[], vendors: Vendor[]): VendorMaster[] {
  const byId = new Map(vendors.map((vendor) => [vendor.id, vendorToMaster(vendor)]));
  const result = new Map<string, VendorMaster>();
  for (const invoice of invoices) {
    if (result.has(invoice.vendorId)) continue;
    result.set(
      invoice.vendorId,
      byId.get(invoice.vendorId) ?? toVendorMaster({ vendorId: invoice.vendorId, vendorName: invoice.vendorName, currency: invoice.currency }),
    );
  }
  return [...result.values()];
}
