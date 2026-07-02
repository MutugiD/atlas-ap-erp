import type { InvoiceStatus } from "@atlas/contracts";

const allowedTransitions: Record<InvoiceStatus, InvoiceStatus[]> = {
  received: ["extracted", "exception"],
  extracted: ["validated", "exception"],
  validated: ["matched", "coded", "exception"],
  matched: ["coded", "exception"],
  coded: ["awaiting_approval", "approved", "exception"],
  awaiting_approval: ["approved", "rejected", "exception"],
  approved: ["posted"],
  rejected: [],
  posted: ["queued_for_payment"],
  queued_for_payment: [],
  exception: ["validated", "rejected"],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid invoice transition: ${from} -> ${to}`);
  }
}

export function nextHappyPathStatus(status: InvoiceStatus, hasPo: boolean): InvoiceStatus {
  if (status === "validated" && !hasPo) return "coded";
  const happy: Partial<Record<InvoiceStatus, InvoiceStatus>> = {
    received: "extracted",
    extracted: "validated",
    validated: "matched",
    matched: "coded",
    coded: "awaiting_approval",
    awaiting_approval: "approved",
    approved: "posted",
    posted: "queued_for_payment",
  };
  const next = happy[status];
  if (!next) throw new Error(`No happy path transition from ${status}`);
  return next;
}

