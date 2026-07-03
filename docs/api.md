# Atlas AP API (`/v1`) Reference

All `/v1` routes are tenant-scoped by the `withTenant` middleware. Send these headers on every request:

| Header | Meaning | Default (dev) |
|---|---|---|
| `x-tenant-id` | Tenant UUID (RLS scope) | a demo tenant UUID |
| `x-user-id` | Acting user UUID | a demo user UUID |
| `x-user-role` | `ap_clerk` \| `approver` \| `admin` | `ap_clerk` |

Bodies are JSON and validated with Zod; unknown/invalid fields are rejected. `GET /health` is the only
un-scoped route.

## Invoices

| Method | Path | Body / query | Purpose |
|---|---|---|---|
| POST | `/v1/invoices` | `{ vendorName?, vendorId?, invoiceNumber?, total, currency, poId?, sourceObjectKey? }` | Create an invoice. `vendorId`/`poId` are linked only if they resolve for the tenant. |
| GET | `/v1/invoices` | — | List invoices. |
| GET | `/v1/invoices/:id` | — | Get one invoice. |
| POST | `/v1/invoices/:id/reprocess` | — | Run the agent supervisor (extract → validate → match → code → route → post). |
| POST | `/v1/invoices/:id/posting-preview` | — | Build the (unpersisted) posting journal preview. |
| GET | `/v1/invoices/:id/events` | — | Agent/human decision events for the invoice. |
| POST | `/v1/invoices/:id/approve` | — | Human approve. |
| POST | `/v1/invoices/:id/reject` | — | Human reject. |
| POST | `/v1/invoices/:id/three-way-match` | — | Run three-way match against the invoice's persisted PO + goods receipts. |
| POST | `/v1/invoices/:id/apply-credits` | — | Apply available credit memos for the invoice's vendor; persists applications and updates memo balances. |
| POST | `/v1/invoices/:id/partial-payments` | `{ requestedAmount }` | Execute a partial payment (capped at the outstanding balance); persists a `partial_payments` record. Returns `{ plan, executed, outstanding, paymentId? }`. |
| GET | `/v1/invoices/:id/partial-payments` | — | List partial payments for the invoice. |
| GET | `/v1/exceptions` | — | Invoices in `exception` status. |
| POST | `/v1/webhooks/email-inbound` | `{ objectKey?, vendorName?, invoiceNumber?, total?, currency? }` | Ingest an invoice from an inbound email (202). |

## Vendors

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/v1/vendors` | `{ name, taxId?, active?, holdPayments?, paymentTermsDays?, defaultExpenseAccount?, currency?, withholdingTaxRate? }` | Create a vendor. `withholdingTaxRate` (0–1) withholds tax on payment runs. |
| GET | `/v1/vendors` | — | List vendors. |
| GET | `/v1/vendors/:id` | — | Get one vendor. |
| PATCH | `/v1/vendors/:id` | partial vendor | Update (e.g. `{ holdPayments: true }`). A payment hold excludes the vendor's invoices from payment runs. |

## Purchase orders & goods receipts

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/v1/purchase-orders` | `{ poNumber, vendorId?, currency, lines: [{ description, quantity, unitPrice, total }] }` | Create a PO (total derived from lines). |
| GET | `/v1/purchase-orders` | — | List POs. |
| GET | `/v1/purchase-orders/:id` | — | Get one PO. |
| POST | `/v1/goods-receipts` | `{ poId, description, quantityReceived }` | Record a goods receipt against a PO. |
| GET | `/v1/purchase-orders/:id/goods-receipts` | — | List receipts for a PO. |

## Accounting periods

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/v1/accounting-periods` | `{ name, startsOn, endsOn }` (`YYYY-MM-DD`) | Create an open period. |
| GET | `/v1/accounting-periods` | — | List periods. |
| POST | `/v1/accounting-periods/:id/close` | — | Close a period. |
| POST | `/v1/accounting-periods/:id/reopen` | — | Reopen a period. |

Posting an invoice whose posting date falls in a **closed** period returns `409 accounting_period_closed` and
writes no journal.

## Credit memos

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/v1/credit-memos` | `{ vendorId?, amount, currency }` | Create an available credit memo. |
| GET | `/v1/credit-memos` | — | List credit memos. |
| POST | `/v1/invoices/:id/apply-credits` | — | Apply available memos for the invoice's vendor (persists applications, reduces/closes memos). |

## Payments, reconciliation & accounting calculators

| Method | Path | Body / query | Purpose |
|---|---|---|---|
| POST | `/v1/payment-runs` | `{ scheduledDate? }` | Create a payment run over payable invoices (honors vendor hold). |
| POST | `/v1/reconciliations` | `{ bankTransactions: [...] }` | Reconcile persisted payments against bank transactions. |
| POST | `/v1/accounting/credit-memo-applications` | `{ invoiceId, creditMemos: [...] }` | Ad-hoc credit application calculation (non-persistent; see `/apply-credits` for the persisted flow). |
| POST | `/v1/accounting/partial-payment-plans` | `{ invoiceId, requestedAmount }` | Partial-payment plan calculation. |
| GET | `/v1/accounting/aging` | `?asOfDate=YYYY-MM-DD` | AP aging buckets. |
| POST | `/v1/accounting/fx-realizations` | `{ invoiceId, functionalCurrency, invoiceFxRate, paymentFxRate }` | Realized FX gain/loss; also returns and (with `DATABASE_URL`) persists a balanced `fx_realization` GL journal. |

Persistence is active when `DATABASE_URL` is set (Postgres, tenant-scoped RLS); otherwise the API runs on an
in-memory repository for local/dev and the fast test suite.
