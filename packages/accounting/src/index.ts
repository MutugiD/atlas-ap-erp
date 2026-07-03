export type Money = number;

export interface VendorMaster {
  id: string;
  name: string;
  taxId?: string;
  active: boolean;
  paymentTermsDays: number;
  defaultExpenseAccount: string;
  currency: string;
  holdPayments?: boolean;
  withholdingTaxRate?: number;
}

export interface AccountingLine {
  description: string;
  quantity: number;
  unitPrice: Money;
  total: Money;
  glAccount?: string;
  costCenter?: string;
}

export interface AccountingInvoice {
  id: string;
  vendorId: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  postingDate: string;
  dueDate?: string;
  currency: string;
  subtotal: Money;
  tax: Money;
  total: Money;
  lines: AccountingLine[];
  status: "received" | "validated" | "matched" | "approved" | "posted" | "queued_for_payment" | "paid" | "exception" | "awaiting_approval";
  poId?: string;
}

export interface PurchaseOrderAccounting {
  id: string;
  poNumber: string;
  vendorId: string;
  currency: string;
  lines: AccountingLine[];
}

export interface GoodsReceipt {
  poId: string;
  description: string;
  quantityReceived: number;
}

export interface AccountingPeriod {
  id: string;
  startsOn: string;
  endsOn: string;
  status: "open" | "closed";
}

export interface ControlFinding {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface ControlResult {
  ok: boolean;
  findings: ControlFinding[];
}

export interface LedgerEntry {
  account: string;
  debit: Money;
  credit: Money;
  memo: string;
  invoiceId?: string;
  paymentId?: string;
}

export interface JournalEntry {
  id: string;
  tenantId: string;
  source: "invoice_posting" | "payment_run";
  postingDate: string;
  currency: string;
  entries: LedgerEntry[];
  balanced: boolean;
}

export interface Payment {
  id: string;
  invoiceId: string;
  vendorId: string;
  amount: Money;
  currency: string;
  scheduledDate: string;
  status: "scheduled" | "paid" | "reconciled";
  withheldTax?: Money;
}

export interface PaymentRun {
  id: string;
  tenantId: string;
  scheduledDate: string;
  payments: Payment[];
  journal: JournalEntry;
  excluded: Array<{ invoiceId: string; reason: string }>;
}

export interface BankTransaction {
  id: string;
  amount: Money;
  currency: string;
  valueDate: string;
  reference: string;
}

export interface ReconciliationResult {
  matched: Array<{ paymentId: string; bankTransactionId: string; amount: Money }>;
  unmatchedPayments: Payment[];
  unmatchedBankTransactions: BankTransaction[];
  exceptions: ControlFinding[];
}

export interface CreditMemo {
  id: string;
  vendorId: string;
  amount: Money;
  currency: string;
  status: "available" | "applied" | "void";
}

export interface CreditApplication {
  creditMemoId: string;
  invoiceId: string;
  amountApplied: Money;
}

export interface CreditMemoApplicationResult {
  invoiceId: string;
  grossPayable: Money;
  netPayable: Money;
  applications: CreditApplication[];
  remainingCredits: CreditMemo[];
  findings: ControlFinding[];
}

export interface PartialPaymentPlan {
  invoiceId: string;
  requestedAmount: Money;
  paymentAmount: Money;
  remainingAmount: Money;
  findings: ControlFinding[];
}

export interface AgingBucket {
  label: "current" | "1-30" | "31-60" | "61-90" | "90+";
  invoiceIds: string[];
  amount: Money;
}

export interface RealizedFxResult {
  invoiceId: string;
  functionalCurrency: string;
  invoiceFunctionalAmount: Money;
  paymentFunctionalAmount: Money;
  realizedGainLoss: Money;
  account: "realized_fx_gain" | "realized_fx_loss" | "none";
}

export function validateInvoiceDataEntry(input: {
  invoice: AccountingInvoice;
  vendor?: VendorMaster;
  period: AccountingPeriod;
  existingInvoiceKeys?: string[];
  expectedTaxRate?: number;
}): ControlResult {
  const findings: ControlFinding[] = [];
  const { invoice, vendor, period } = input;

  if (!vendor) {
    findings.push(error("vendor_missing", "Vendor is not in the vendor master."));
  } else {
    if (!vendor.active) findings.push(error("vendor_inactive", `Vendor ${vendor.name} is inactive.`));
    if (!vendor.taxId) findings.push(warning("vendor_tax_id_missing", `Vendor ${vendor.name} is missing a tax id.`));
    if (vendor.currency !== invoice.currency) findings.push(error("currency_mismatch", `Vendor currency ${vendor.currency} does not match invoice currency ${invoice.currency}.`));
  }

  if (!dateInPeriod(invoice.postingDate, period)) {
    findings.push(error("posting_period_mismatch", `Posting date ${invoice.postingDate} is outside period ${period.id}.`));
  }
  if (period.status === "closed") findings.push(error("posting_period_closed", `Accounting period ${period.id} is closed.`));

  for (const [index, line] of invoice.lines.entries()) {
    if (!moneyEquals(line.quantity * line.unitPrice, line.total)) {
      findings.push(error("line_extension_mismatch", `Line ${index + 1} quantity times unit price does not equal line total.`));
    }
  }

  const lineSubtotal = invoice.lines.reduce((sum, line) => sum + line.total, 0);
  if (!moneyEquals(lineSubtotal, invoice.subtotal)) {
    findings.push(error("subtotal_mismatch", "Invoice subtotal does not equal the sum of line totals."));
  }

  if (!moneyEquals(invoice.subtotal + invoice.tax, invoice.total)) {
    findings.push(error("invoice_total_mismatch", "Invoice subtotal plus tax does not equal total."));
  }

  if (input.expectedTaxRate !== undefined && !moneyEquals(invoice.subtotal * input.expectedTaxRate, invoice.tax, 1)) {
    findings.push(warning("tax_rate_variance", "Invoice tax does not match the expected tax rate."));
  }

  const key = `${invoice.vendorId}:${invoice.invoiceNumber}`.toLowerCase();
  if (input.existingInvoiceKeys?.map((item) => item.toLowerCase()).includes(key)) {
    findings.push(error("duplicate_invoice", `Duplicate invoice key ${key}.`));
  }

  return { ok: findings.every((finding) => finding.severity !== "error"), findings };
}

export function threeWayMatch(input: {
  invoice: AccountingInvoice;
  po?: PurchaseOrderAccounting;
  receipts?: GoodsReceipt[];
  amountTolerance?: Money;
  percentTolerance?: number;
}): ControlResult & { amountVariance: Money; receiptVariance: Money } {
  const findings: ControlFinding[] = [];
  const amountTolerance = input.amountTolerance ?? 5;
  const percentTolerance = input.percentTolerance ?? 0.02;

  if (!input.po) {
    return {
      ok: false,
      findings: [error("po_missing", "PO invoice does not have a purchase order.")],
      amountVariance: input.invoice.total,
      receiptVariance: input.invoice.lines.reduce((sum, line) => sum + line.quantity, 0),
    };
  }

  if (input.po.vendorId !== input.invoice.vendorId) findings.push(error("po_vendor_mismatch", "Invoice vendor does not match PO vendor."));
  if (input.po.currency !== input.invoice.currency) findings.push(error("po_currency_mismatch", "Invoice currency does not match PO currency."));

  const poTotal = input.po.lines.reduce((sum, line) => sum + line.total, 0);
  const amountVariance = roundMoney(input.invoice.subtotal - poTotal);
  const allowed = Math.max(amountTolerance, Math.abs(poTotal * percentTolerance));
  if (Math.abs(toCents(amountVariance)) > toCents(allowed)) {
    findings.push(error("po_amount_variance", `Invoice subtotal variance ${amountVariance} exceeds tolerance ${roundMoney(allowed)}.`));
  }

  const receivedByDescription = new Map<string, number>();
  for (const receipt of input.receipts ?? []) {
    receivedByDescription.set(receipt.description, (receivedByDescription.get(receipt.description) ?? 0) + receipt.quantityReceived);
  }

  let receiptVariance = 0;
  for (const line of input.invoice.lines) {
    const received = receivedByDescription.get(line.description) ?? 0;
    if (received < line.quantity) {
      receiptVariance += line.quantity - received;
      findings.push(error("receipt_quantity_short", `Received quantity for ${line.description} is below invoiced quantity.`));
    }
  }

  return { ok: findings.every((finding) => finding.severity !== "error"), findings, amountVariance, receiptVariance };
}

export function buildInvoicePostingJournal(input: {
  tenantId: string;
  invoice: AccountingInvoice;
  vendor: VendorMaster;
  apAccount?: string;
  taxRecoverableAccount?: string;
}): JournalEntry {
  const expenseLines = input.invoice.lines.map((line): LedgerEntry => ({
    account: line.glAccount ?? input.vendor.defaultExpenseAccount,
    debit: roundMoney(line.total),
    credit: 0,
    memo: `${input.invoice.invoiceNumber} ${line.description}`,
    invoiceId: input.invoice.id,
  }));
  const taxLine: LedgerEntry[] = input.invoice.tax > 0 ? [{
    account: input.taxRecoverableAccount ?? "1410",
    debit: roundMoney(input.invoice.tax),
    credit: 0,
    memo: `${input.invoice.invoiceNumber} recoverable tax`,
    invoiceId: input.invoice.id,
  }] : [];
  const apLine: LedgerEntry = {
    account: input.apAccount ?? "2100",
    debit: 0,
    credit: roundMoney(input.invoice.total),
    memo: `${input.invoice.invoiceNumber} AP liability`,
    invoiceId: input.invoice.id,
  };
  const entries = [...expenseLines, ...taxLine, apLine];
  return {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    source: "invoice_posting",
    postingDate: input.invoice.postingDate,
    currency: input.invoice.currency,
    entries,
    balanced: journalBalances(entries),
  };
}

export function createPaymentRun(input: {
  tenantId: string;
  invoices: AccountingInvoice[];
  vendors: VendorMaster[];
  scheduledDate: string;
  apAccount?: string;
  cashAccount?: string;
  withholdingTaxAccount?: string;
}): PaymentRun {
  const vendorsById = new Map(input.vendors.map((vendor) => [vendor.id, vendor]));
  const payments: Payment[] = [];
  const excluded: PaymentRun["excluded"] = [];

  for (const invoice of input.invoices) {
    const vendor = vendorsById.get(invoice.vendorId);
    if (!vendor) {
      excluded.push({ invoiceId: invoice.id, reason: "Vendor missing" });
      continue;
    }
    if (vendor.holdPayments) {
      excluded.push({ invoiceId: invoice.id, reason: "Vendor payment hold" });
      continue;
    }
    if (invoice.status !== "queued_for_payment") {
      excluded.push({ invoiceId: invoice.id, reason: `Invoice status ${invoice.status} is not payable` });
      continue;
    }
    if (invoice.dueDate && invoice.dueDate > input.scheduledDate) {
      excluded.push({ invoiceId: invoice.id, reason: "Invoice is not due yet" });
      continue;
    }
    const amount = roundMoney(invoice.total);
    payments.push({
      id: crypto.randomUUID(),
      invoiceId: invoice.id,
      vendorId: invoice.vendorId,
      amount,
      currency: invoice.currency,
      scheduledDate: input.scheduledDate,
      status: "scheduled",
      withheldTax: roundMoney(amount * (vendor.withholdingTaxRate ?? 0)),
    });
  }

  const entries = payments.flatMap((payment): LedgerEntry[] => {
    const withheld = payment.withheldTax ?? 0;
    const lines: LedgerEntry[] = [
      {
        account: input.apAccount ?? "2100",
        debit: payment.amount,
        credit: 0,
        memo: `Clear AP for ${payment.invoiceId}`,
        invoiceId: payment.invoiceId,
        paymentId: payment.id,
      },
      {
        account: input.cashAccount ?? "1000",
        debit: 0,
        credit: roundMoney(payment.amount - withheld),
        memo: `Cash disbursement for ${payment.invoiceId}`,
        invoiceId: payment.invoiceId,
        paymentId: payment.id,
      },
    ];
    if (withheld > 0) {
      lines.push({
        account: input.withholdingTaxAccount ?? "2150",
        debit: 0,
        credit: withheld,
        memo: `Withholding tax for ${payment.invoiceId}`,
        invoiceId: payment.invoiceId,
        paymentId: payment.id,
      });
    }
    return lines;
  });

  return {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    scheduledDate: input.scheduledDate,
    payments,
    excluded,
    journal: {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      source: "payment_run",
      postingDate: input.scheduledDate,
      currency: payments[0]?.currency ?? "USD",
      entries,
      balanced: journalBalances(entries),
    },
  };
}

export function reconcileBankTransactions(input: {
  payments: Payment[];
  bankTransactions: BankTransaction[];
  tolerance?: Money;
}): ReconciliationResult {
  const tolerance = input.tolerance ?? 0.01;
  const unmatchedBank = [...input.bankTransactions];
  const matched: ReconciliationResult["matched"] = [];
  const unmatchedPayments: Payment[] = [];
  const exceptions: ControlFinding[] = [];

  for (const payment of input.payments) {
    const index = unmatchedBank.findIndex((txn) =>
      txn.currency === payment.currency &&
      Math.abs(toCents(txn.amount) + toCents(payment.amount)) <= toCents(tolerance) &&
      txn.reference.toLowerCase().includes(payment.invoiceId.toLowerCase().slice(0, 8)),
    );
    if (index >= 0) {
      const [txn] = unmatchedBank.splice(index, 1);
      matched.push({ paymentId: payment.id, bankTransactionId: txn.id, amount: payment.amount });
    } else {
      unmatchedPayments.push(payment);
      exceptions.push(error("payment_not_found_in_bank", `Payment ${payment.id} was not found in bank transactions.`));
    }
  }

  for (const txn of unmatchedBank) {
    exceptions.push(warning("unmatched_bank_transaction", `Bank transaction ${txn.id} did not match a payment.`));
  }

  return { matched, unmatchedPayments, unmatchedBankTransactions: unmatchedBank, exceptions };
}

export function applyCreditMemos(input: {
  invoice: AccountingInvoice;
  creditMemos: CreditMemo[];
}): CreditMemoApplicationResult {
  let remainingPayable = input.invoice.total;
  const applications: CreditApplication[] = [];
  const remainingCredits: CreditMemo[] = [];
  const findings: ControlFinding[] = [];

  for (const memo of input.creditMemos) {
    if (memo.status !== "available") {
      remainingCredits.push(memo);
      continue;
    }
    if (memo.vendorId !== input.invoice.vendorId) {
      findings.push(error("credit_vendor_mismatch", `Credit memo ${memo.id} belongs to a different vendor.`));
      remainingCredits.push(memo);
      continue;
    }
    if (memo.currency !== input.invoice.currency) {
      findings.push(error("credit_currency_mismatch", `Credit memo ${memo.id} currency does not match invoice currency.`));
      remainingCredits.push(memo);
      continue;
    }
    const amountApplied = Math.min(remainingPayable, memo.amount);
    if (amountApplied > 0) {
      applications.push({ creditMemoId: memo.id, invoiceId: input.invoice.id, amountApplied: roundMoney(amountApplied) });
      remainingPayable = roundMoney(remainingPayable - amountApplied);
    }
    if (memo.amount > amountApplied) {
      remainingCredits.push({ ...memo, amount: roundMoney(memo.amount - amountApplied) });
    }
  }

  return {
    invoiceId: input.invoice.id,
    grossPayable: input.invoice.total,
    netPayable: roundMoney(remainingPayable),
    applications,
    remainingCredits,
    findings,
  };
}

export function createPartialPaymentPlan(input: {
  invoice: AccountingInvoice;
  requestedAmount: Money;
  minimumPayment?: Money;
}): PartialPaymentPlan {
  const findings: ControlFinding[] = [];
  const minimumPayment = input.minimumPayment ?? 1;
  if (input.invoice.status !== "queued_for_payment") {
    findings.push(error("invoice_not_payable", `Invoice status ${input.invoice.status} is not payable.`));
  }
  if (input.requestedAmount < minimumPayment) {
    findings.push(error("partial_payment_below_minimum", `Requested amount is below minimum payment ${minimumPayment}.`));
  }
  const paymentAmount = Math.min(Math.max(input.requestedAmount, 0), input.invoice.total);
  return {
    invoiceId: input.invoice.id,
    requestedAmount: input.requestedAmount,
    paymentAmount: findings.some((finding) => finding.severity === "error") ? 0 : roundMoney(paymentAmount),
    remainingAmount: findings.some((finding) => finding.severity === "error") ? input.invoice.total : roundMoney(input.invoice.total - paymentAmount),
    findings,
  };
}

export function buildApAging(input: {
  invoices: AccountingInvoice[];
  asOfDate: string;
}): AgingBucket[] {
  const buckets: AgingBucket[] = [
    { label: "current", invoiceIds: [], amount: 0 },
    { label: "1-30", invoiceIds: [], amount: 0 },
    { label: "31-60", invoiceIds: [], amount: 0 },
    { label: "61-90", invoiceIds: [], amount: 0 },
    { label: "90+", invoiceIds: [], amount: 0 },
  ];
  for (const invoice of input.invoices) {
    if (!["posted", "queued_for_payment", "awaiting_approval"].includes(invoice.status)) continue;
    const daysPastDue = daysBetween(invoice.dueDate ?? invoice.invoiceDate, input.asOfDate);
    const bucket =
      daysPastDue <= 0 ? buckets[0] :
      daysPastDue <= 30 ? buckets[1] :
      daysPastDue <= 60 ? buckets[2] :
      daysPastDue <= 90 ? buckets[3] :
      buckets[4];
    bucket.invoiceIds.push(invoice.id);
    bucket.amount = roundMoney(bucket.amount + invoice.total);
  }
  return buckets;
}

export function calculateRealizedFx(input: {
  invoiceId: string;
  invoiceAmount: Money;
  functionalCurrency: string;
  invoiceFxRate: number;
  paymentFxRate: number;
}): RealizedFxResult {
  const invoiceFunctionalAmount = roundMoney(input.invoiceAmount * input.invoiceFxRate);
  const paymentFunctionalAmount = roundMoney(input.invoiceAmount * input.paymentFxRate);
  const realizedGainLoss = roundMoney(invoiceFunctionalAmount - paymentFunctionalAmount);
  return {
    invoiceId: input.invoiceId,
    functionalCurrency: input.functionalCurrency,
    invoiceFunctionalAmount,
    paymentFunctionalAmount,
    realizedGainLoss,
    account: realizedGainLoss > 0 ? "realized_fx_gain" : realizedGainLoss < 0 ? "realized_fx_loss" : "none",
  };
}

export function journalBalances(entries: LedgerEntry[], tolerance: Money = 0.01) {
  const debits = entries.reduce((sum, entry) => sum + toCents(entry.debit), 0);
  const credits = entries.reduce((sum, entry) => sum + toCents(entry.credit), 0);
  return Math.abs(debits - credits) <= toCents(tolerance);
}

export function trialBalance(entries: LedgerEntry[]) {
  const balances = new Map<string, { debit: Money; credit: Money; net: Money }>();
  for (const entry of entries) {
    const current = balances.get(entry.account) ?? { debit: 0, credit: 0, net: 0 };
    current.debit = roundMoney(current.debit + entry.debit);
    current.credit = roundMoney(current.credit + entry.credit);
    current.net = roundMoney(current.debit - current.credit);
    balances.set(entry.account, current);
  }
  return balances;
}

export function roundMoney(value: Money) {
  return toCents(value) / 100;
}

function toCents(value: Money) {
  return Math.round(value * 100);
}

function moneyEquals(left: Money, right: Money, toleranceCents = 0) {
  return Math.abs(toCents(left) - toCents(right)) <= toleranceCents;
}

function dateInPeriod(date: string, period: AccountingPeriod) {
  return date >= period.startsOn && date <= period.endsOn;
}

function daysBetween(from: string, to: string) {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);
}

function error(code: string, message: string): ControlFinding {
  return { code, severity: "error", message };
}

function warning(code: string, message: string): ControlFinding {
  return { code, severity: "warning", message };
}
