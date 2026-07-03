# Architecture

Atlas AP is a shared-schema multi-tenant AP module.

## Runtime Flow

1. Invoice metadata or inbound email creates an `invoice`.
2. S3 upload/event can enqueue the invoice for Lambda processing.
3. Supervisor executes only required sub-agents for the invoice context.
4. Hard invariants are deterministic: lifecycle transitions, GL balance, tolerance checks, RLS.
5. Agent and human decisions are stored as `agent_events`.

## Agent Branching

- PO invoice: extract -> validate -> match -> code -> route -> post.
- Non-PO invoice: extract -> validate -> code -> route.
- Low extraction confidence: exception.
- Duplicate or invalid totals: exception.
- PO variance outside tolerance: exception.
- Amount over auto-approval limit: awaiting approval.

## Accounting Cycle

After an invoice reaches payable status, the accounting layer can produce a posting preview, create a payment run, and reconcile payments against bank transactions.

- Data-entry controls validate vendor master status, duplicate invoice keys, invoice arithmetic, tax variance, and accounting period status.
- Three-way matching validates PO amount tolerance and receipt quantity coverage.
- Posting creates a balanced journal with expense/tax debits and AP credit.
- Payment runs clear AP and credit cash only for payable, due, non-held invoices.
- Bank reconciliation matches cash disbursements to bank debits and reports unmatched exceptions.

### Persistence

The API repository is swappable behind the `InvoiceRepository` interface: in-memory by default, and
Postgres-backed (`PostgresInvoiceRepository`) when `DATABASE_URL` is set. The Postgres path runs every unit
of work inside a transaction that first sets `app.tenant_id`, so row-level security applies, and persists
invoices, agent events, GL journal entries/lines (posting and payment-run journals), payment runs, payments,
bank transactions, reconciliations, the vendor master, purchase orders, and goods receipts. Invoices link to
a vendor via `vendorId`, and payment runs honor the real vendor master (e.g. a payment hold excludes the
invoice). Purchase orders carry lines and drive a three-way match endpoint against persisted goods receipts.
Accounting periods can be opened/closed, and posting into a closed period is rejected (409) with no journal
written. Credit-memo/partial-payment execution remains pending.

## Deployment

The CDK stack provides the cloud path. Bedrock AgentCore/Gateway values are environment-injected because production agent setup depends on account and region availability.

Container delivery is automated: on pushes to `main` and `v*` tags, CI builds and publishes the
support-agent image to GHCR (`ghcr.io/<owner>/atlas-support-agent`), gated behind the full `verify` job.

## CI/CD and Security Posture

Quality and security are enforced in the pipeline rather than by convention. Every pull request must pass:

- **Build gate** (`verify`): frozen-lockfile install, ESLint, `bun audit`, license audit, release check,
  the full test suite, live Postgres/Redis integration (RLS isolation, queue, AP persistence), typecheck,
  app/infra builds, and the container build.
- **SAST**: CodeQL (`security-and-quality`) analyses the JS/TS on every PR and weekly.
- **Supply chain**: dependency-review blocks PRs that add high-severity-vulnerable packages; `bun audit`
  fails the build on any known vulnerability in the resolved tree; Dependabot security updates open a PR only
  when a dependency has a known vulnerability.
- **Secrets**: Gitleaks plus GitHub-native secret scanning with push protection.

See `docs/ci-cd.md` for the full pipeline reference.
