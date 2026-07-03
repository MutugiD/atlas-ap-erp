import {
  type ApprovalRoute,
  type GlCodingProposal,
  type Invoice,
  type InvoiceDraft,
  type MatchResult,
  type ValidationResult,
} from "@atlas/contracts";

export interface AgentProvider {
  extract(invoice: Invoice): Promise<InvoiceDraft>;
  validate(invoice: Invoice, draft: InvoiceDraft, existingNumbers: string[]): Promise<ValidationResult>;
  match(invoice: Invoice, draft: InvoiceDraft): Promise<MatchResult>;
  code(invoice: Invoice, draft: InvoiceDraft): Promise<GlCodingProposal>;
  route(invoice: Invoice, coding: GlCodingProposal): Promise<ApprovalRoute>;
}

export class LocalAgentProvider implements AgentProvider {
  async extract(invoice: Invoice): Promise<InvoiceDraft> {
    const total = invoice.total || 1200;
    const lowConfidence = invoice.sourceObjectKey?.includes("low-confidence") ?? false;
    const variance = invoice.sourceObjectKey?.includes("variance") ?? false;
    const subtotal = variance ? total - 40 : total - total * 0.16;
    const tax = variance ? 40 : total * 0.16;
    return {
      vendorName: invoice.vendorName ?? "Nairobi Office Supplies",
      invoiceNumber: invoice.invoiceNumber ?? `INV-${invoice.id.slice(0, 8)}`,
      invoiceDate: "2026-07-03",
      poNumber: invoice.poId ? `PO-${invoice.poId.slice(0, 8)}` : undefined,
      currency: invoice.currency,
      subtotal,
      tax,
      total,
      lines: [{ description: "Office supplies", quantity: 1, unitPrice: subtotal, total: subtotal }],
      fieldConfidence: { vendorName: lowConfidence ? 0.65 : 0.97, total: 0.98 },
      confidence: lowConfidence ? 0.67 : 0.96,
    };
  }

  async validate(_invoice: Invoice, draft: InvoiceDraft, existingNumbers: string[]): Promise<ValidationResult> {
    const expected = Number((draft.subtotal + draft.tax).toFixed(2));
    const actual = Number(draft.total.toFixed(2));
    const duplicate = existingNumbers.includes(draft.invoiceNumber);
    const reasons = [
      ...(Math.abs(expected - actual) > 0.01 ? [`Totals do not add up: ${expected} != ${actual}`] : []),
      ...(duplicate ? [`Duplicate invoice number ${draft.invoiceNumber}`] : []),
    ];
    return { ok: reasons.length === 0, duplicate, reasons, confidence: reasons.length === 0 ? 0.95 : 0.88 };
  }

  async match(invoice: Invoice, draft: InvoiceDraft): Promise<MatchResult> {
    if (!invoice.poId) {
      return { matched: false, variance: draft.total, withinTolerance: false, reasons: ["No PO supplied"], confidence: 0.9 };
    }
    const variance = invoice.sourceObjectKey?.includes("variance") ? 250 : 0;
    return {
      matched: variance === 0,
      variance,
      withinTolerance: variance <= 25,
      reasons: variance > 25 ? ["Invoice variance exceeds tolerance"] : [],
      confidence: variance > 25 ? 0.82 : 0.94,
    };
  }

  async code(_invoice: Invoice, draft: InvoiceDraft): Promise<GlCodingProposal> {
    return {
      balanced: true,
      splits: [{ glAccount: "6100", costCenter: "OPS", amount: draft.total }],
      confidence: 0.91,
    };
  }

  async route(invoice: Invoice, _coding: GlCodingProposal): Promise<ApprovalRoute> {
    if (invoice.total <= 1500) {
      return { autoApproved: true, approvers: [], reason: "Under tenant auto-approval limit", confidence: 0.93 };
    }
    return {
      autoApproved: false,
      approvers: ["11111111-1111-4111-8111-111111111111"],
      reason: "Amount requires approver",
      confidence: 0.9,
    };
  }
}

export function sumsToTotal(proposal: GlCodingProposal, total: number): boolean {
  const sum = proposal.splits.reduce((acc, split) => acc + split.amount, 0);
  return Math.abs(sum - total) < 0.01;
}
