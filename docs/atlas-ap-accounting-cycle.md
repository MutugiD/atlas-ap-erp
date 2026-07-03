# Atlas AP Accounting Cycle

This document captures the real-world AP/accounting controls added after the initial invoice-to-pay implementation.

## Problem

The original Atlas AP implementation could route an invoice through extraction, validation, matching, GL coding, approval, posting, and payment queue states. That proved the agent workflow, but it did not prove accounting outcomes:

- Invoice line arithmetic could drift from subtotal/tax/total.
- Vendor master controls were implicit.
- PO matching did not have an accounting-focused test harness.
- GL posting was represented by agent decisions, not double-entry journal output.
- Payment runs and bank reconciliation were not modeled.
- RLS schema did not include accounting-cycle tables.

## Solution

Added `packages/accounting`, a deterministic AP accounting engine with cents-based money arithmetic.

Implemented controls:

- Vendor master validation: missing vendor, inactive vendor, missing tax ID, currency mismatch, payment hold.
- Invoice data-entry validation: line extensions, subtotal, tax, total, duplicates, closed/out-of-period posting.
- Three-way match: PO vendor/currency, PO amount tolerance, goods receipt quantity checks.
- Posting journal: expense/tax debit and AP credit, with balance check.
- Payment run: excludes held vendors, not-due invoices, and non-payable statuses.
- Bank reconciliation: matches payments to bank debits and reports unmatched payments/transactions.
- Trial balance helper for account-level debit/credit net checks.

## API Surface Added

- `POST /v1/invoices/:id/posting-preview`
- `POST /v1/payment-runs`
- `POST /v1/reconciliations`

## Persistence Shape Added

The Drizzle schema and RLS migration now include:

- `gl_journal_entries`
- `gl_journal_lines`
- `payment_runs`
- `payments`
- `bank_transactions`
- `reconciliations`

Each table is tenant-scoped and covered by the existing `app.tenant_id` RLS policy pattern.

## Bug Found And Fixed

The real-world posting test found that `LocalAgentProvider.extract` was emitting invoice lines at gross total while also emitting tax separately. That made accounting journals unbalanced because expense debit plus tax debit exceeded AP credit.

Fix:

- Extracted line total now equals net subtotal.
- Tax remains separate.
- Posting preview now balances for generated invoices.

## Tests

Primary test file:

- `tests/accounting-cycle.test.ts`

Coverage:

- Clean PO-backed invoice through agent routing, posting, payment run, and bank reconciliation.
- Inactive vendor, duplicate invoice, closed period, line mismatch, subtotal mismatch, total mismatch, and tax variance.
- PO amount variance and receipt shortfall.
- Payment-run exclusions for holds, future due dates, and exception status.
- Bank reconciliation exceptions for unmatched payments and bank transactions.

API coverage:

- `tests/api.test.ts` covers posting preview, payment run, and reconciliation routes.

RLS coverage:

- `tests/rls.test.ts` checks accounting-cycle tables are present in the RLS migration.

## Pending

- Persist journal/payment/reconciliation records through a real Postgres repository, not only the in-memory API repository.
- Add vendor master and purchase order CRUD APIs.
- Add accounting-period close/reopen workflow.
- Add partial payments, credit memos, debit memos, withholding tax, and multi-currency realized FX.
- Add bank statement import format parsers.
- Run live Postgres RLS tests for the new accounting tables once Docker/staging Postgres is available.
