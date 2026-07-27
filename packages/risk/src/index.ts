import type { Invoice, InvoiceRiskFinding, InvoiceRiskAssessment, PurchaseOrder, GoodsReceiptRecord, Vendor } from "@atlas/contracts";

export const RISK_RULE_VERSION = "rules-0.1.0";

export interface RiskContext {
  invoice: Invoice;
  vendor?: Vendor;
  purchaseOrder?: PurchaseOrder;
  receipts?: GoodsReceiptRecord[];
  peerInvoices?: Invoice[];
}

function finding(code: string, severity: InvoiceRiskFinding["severity"], points: number, message: string): InvoiceRiskFinding {
  return { id: crypto.randomUUID(), code, severity, points, message };
}

export function assessInvoiceRisk(context: RiskContext): InvoiceRiskAssessment {
  const { invoice, vendor, purchaseOrder, receipts = [], peerInvoices = [] } = context;
  const findings: InvoiceRiskFinding[] = [];
  const subtotal = invoice.extracted?.subtotal ?? invoice.total;
  const tax = invoice.extracted?.tax ?? 0;
  const peers = peerInvoices.filter((item) => item.id !== invoice.id);
  const duplicate = peers.some((item) => item.vendorId === invoice.vendorId && item.invoiceNumber && item.invoiceNumber.toLowerCase() === invoice.invoiceNumber?.toLowerCase());
  if (duplicate) findings.push(finding("duplicate_invoice", "high", 45, "The vendor has another invoice with the same invoice number."));
  if (!vendor || !invoice.vendorId) findings.push(finding("vendor_not_in_master", "high", 35, "The invoice is not linked to an active vendor master record."));
  if (vendor?.holdPayments) findings.push(finding("vendor_payment_hold", "high", 35, "The vendor is currently on payment hold."));
  if (Math.abs(subtotal + tax - invoice.total) > 0.01) findings.push(finding("arithmetic_mismatch", "high", 40, "Subtotal plus tax does not equal the invoice total."));
  if (purchaseOrder && purchaseOrder.currency !== invoice.currency) findings.push(finding("currency_mismatch", "high", 30, "Invoice currency differs from the purchase order currency."));
  if (purchaseOrder && Math.abs(purchaseOrder.total - invoice.total) > 0.01) findings.push(finding("po_amount_variance", "high", 35, "Invoice total differs from the purchase order total."));
  if (purchaseOrder && receipts.reduce((sum, receipt) => sum + receipt.quantityReceived, 0) <= 0) findings.push(finding("no_goods_receipt", "high", 30, "The purchase order has no recorded goods receipt."));
  if (invoice.total > 0 && Math.abs(invoice.total % 100) < 0.001) findings.push(finding("round_amount", "warning", 8, "The invoice total is a round amount and should be confirmed against source documentation."));
  const sameVendor = peers.filter((item) => item.vendorId === invoice.vendorId);
  if (sameVendor.length >= 2) {
    const average = sameVendor.reduce((sum, item) => sum + item.total, 0) / sameVendor.length;
    if (average > 0 && invoice.total > average * 2.5) findings.push(finding("unusual_vendor_amount", "warning", 18, "The invoice is materially larger than this vendor's recent average."));
  }
  const score = Math.min(100, findings.reduce((sum, item) => sum + item.points, 0));
  const riskLevel: InvoiceRiskAssessment["riskLevel"] = score >= 60 ? "high" : score >= 20 ? "review" : "low";
  return {
    id: crypto.randomUUID(),
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    riskLevel,
    riskScore: score,
    findings,
    features: { total: invoice.total, subtotal, tax, hasVendor: Boolean(vendor), hasPurchaseOrder: Boolean(purchaseOrder), receiptQuantity: receipts.reduce((sum, receipt) => sum + receipt.quantityReceived, 0), peerInvoiceCount: peers.length },
    ruleVersion: RISK_RULE_VERSION,
    modelVersion: "rules-only",
    reviewStatus: findings.length ? "open" : "not_required",
    createdAt: new Date().toISOString(),
  };
}

export function riskAssessmentToCsv(items: InvoiceRiskAssessment[]): string {
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [
    ["Invoice ID", "Risk level", "Risk score", "Review status", "Rule version", "Reasons"],
    ...items.map((item) => [item.invoiceId, item.riskLevel, item.riskScore, item.reviewStatus, item.ruleVersion, item.findings.map((f) => `${f.code}: ${f.message}`).join(" | ")]),
  ];
  return rows.map((row) => row.map(escape).join(",")).join("\r\n") + "\r\n";
}
