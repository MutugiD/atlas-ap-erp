import { createSign } from "node:crypto";
import { type BankTransaction } from "@atlas/accounting";

// Bank integration seam. The API depends only on BankConnector, so a bank
// (Equity Jenga today; KCB Buni next) can be swapped in without touching the
// reconciliation flow. Live HTTP happens only when BANK_PROVIDER is configured;
// the default ManualBankConnector keeps local/dev and tests hermetic.

export interface StatementQuery {
  accountNumber: string;
  countryCode: string;
  fromDate: string;
  toDate: string;
  limit?: number;
}

export interface DisbursementRequest {
  paymentId: string;
  amount: number;
  currency: string;
  reference: string;
  // Where to send: bank account (PesaLink/RTGS) or a mobile wallet (M-Pesa).
  destination: { type: "bank"; bankCode: string; accountNumber: string } | { type: "mobile"; phoneNumber: string };
}

export interface DisbursementResult {
  bankReference: string;
  status: string;
  rail: "pesalink" | "rtgs" | "mobile";
}

export interface BankConnector {
  readonly provider: string;
  // Pull a statement and normalize it into the accounting BankTransaction shape
  // that reconcilePayments already consumes (debits are negative, credits positive).
  fetchStatement(query: StatementQuery): Promise<BankTransaction[]>;
  disburse(request: DisbursementRequest): Promise<DisbursementResult>;
}

// Default: no live bank. Reconciliation still works via the manual
// POST /v1/reconciliations path where the caller supplies bank transactions.
export class ManualBankConnector implements BankConnector {
  readonly provider = "manual";
  async fetchStatement(): Promise<BankTransaction[]> {
    throw new BankNotConfiguredError();
  }
  async disburse(): Promise<DisbursementResult> {
    throw new BankNotConfiguredError();
  }
}

export class BankNotConfiguredError extends Error {
  constructor() {
    super("No bank connector configured. Set BANK_PROVIDER (e.g. 'jenga') and its credentials.");
    this.name = "BankNotConfiguredError";
  }
}

type FetchImpl = typeof fetch;

export interface EquityJengaConnectorOptions {
  baseUrl?: string;
  // Verified Jenga auth: a Bearer access token plus a per-request RSA signature.
  token?: () => Promise<string>;
  sign?: (payload: string) => string;
  fetchImpl?: FetchImpl;
  // PesaLink caps at KES 999,999/txn; at/above this we route via RTGS (KEPSS).
  rtgsThreshold?: number;
}

export class EquityJengaConnector implements BankConnector {
  readonly provider = "jenga";
  private readonly baseUrl: string;
  private readonly token: () => Promise<string>;
  private readonly sign: (payload: string) => string;
  private readonly fetchImpl: FetchImpl;
  private readonly rtgsThreshold: number;

  constructor(options: EquityJengaConnectorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.JENGA_BASE_URL ?? "https://api.finserve.africa").replace(/\/$/, "");
    this.token = options.token ?? (async () => process.env.JENGA_ACCESS_TOKEN ?? "");
    this.sign = options.sign ?? ((payload) => rsaSignBase64(payload, process.env.JENGA_PRIVATE_KEY ?? ""));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rtgsThreshold = options.rtgsThreshold ?? 1_000_000;
  }

  async fetchStatement(query: StatementQuery): Promise<BankTransaction[]> {
    // Verified: POST /v3-apis/account-api/v3.0/accounts/fullStatement,
    // Signature over accountNumber+countryCode+toDate.
    const signature = this.sign(`${query.accountNumber}${query.countryCode}${query.toDate}`);
    const response = await this.request("/v3-apis/account-api/v3.0/accounts/fullStatement", signature, {
      accountNumber: query.accountNumber,
      countryCode: query.countryCode,
      fromDate: query.fromDate,
      toDate: query.toDate,
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return normalizeJengaStatement(response);
  }

  async disburse(request: DisbursementRequest): Promise<DisbursementResult> {
    // Route by amount/instrument. Endpoint paths are confirmed at onboarding;
    // the signature + Bearer pattern is the same as statements.
    const rail: DisbursementResult["rail"] =
      request.destination.type === "mobile" ? "mobile" : request.amount >= this.rtgsThreshold ? "rtgs" : "pesalink";
    const path =
      rail === "rtgs" ? "/v3-apis/transaction-api/v3.0/remittance/rtgs" : "/v3-apis/transaction-api/v3.0/remittance/sendtomobile";
    const signature = this.sign(`${request.reference}${request.amount}${request.currency}`);
    const response = await this.request(path, signature, {
      reference: request.reference,
      amount: String(request.amount),
      currency: request.currency,
      destination: request.destination,
    });
    const data = (response ?? {}) as { transactionId?: string; reference?: string; status?: string };
    return { bankReference: data.transactionId ?? data.reference ?? request.reference, status: data.status ?? "submitted", rail };
  }

  private async request(path: string, signature: string, body: unknown): Promise<unknown> {
    const token = await this.token();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, signature },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Jenga request failed: ${response.status}`);
    return response.json();
  }
}

export function createBankConnector(): BankConnector {
  switch (process.env.BANK_PROVIDER) {
    case "jenga":
      return new EquityJengaConnector();
    default:
      return new ManualBankConnector();
  }
}

// --- helpers -------------------------------------------------------------

export function normalizeJengaStatement(payload: unknown): BankTransaction[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const transactions = (data.transactions ?? []) as Array<Record<string, unknown>>;
  return transactions.map((txn, index) => {
    const rawAmount = Math.abs(Number(txn.amount ?? 0));
    const isDebit = String(txn.type ?? "").toLowerCase() === "debit";
    const running = (txn.runningBalance ?? {}) as Record<string, unknown>;
    return {
      id: String(txn.reference ?? txn.serial ?? `jenga-${index}`),
      amount: isDebit ? -rawAmount : rawAmount,
      currency: String(running.currency ?? txn.currency ?? "KES"),
      valueDate: String(txn.date ?? txn.postedDateTime ?? "").slice(0, 10),
      reference: String(txn.reference ?? txn.description ?? ""),
    };
  });
}

function rsaSignBase64(payload: string, privateKey: string): string {
  if (!privateKey) throw new Error("JENGA_PRIVATE_KEY is required to sign Jenga requests");
  const signer = createSign("RSA-SHA256");
  signer.update(payload);
  signer.end();
  return signer.sign(privateKey, "base64");
}
