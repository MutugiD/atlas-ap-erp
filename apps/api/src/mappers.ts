import { type Invoice, type Vendor } from "@atlas/contracts";
import { type AccountingInvoice, type VendorMaster } from "@atlas/accounting";

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
