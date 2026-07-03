# Roadmap / Future Work

Notes captured for later. Everything here is deliberately deferred; the shipped state is described in the
other docs and the merged PRs.

## Near-term direction (requested)
- **UI** — an operator/reporting front-end (invoice inbox, exceptions, approvals, and the profitability
  report artifact / RAG scorecard). A Next.js `apps/web` shell already exists to build on.
- **AWS deployment** — the CDK stack (`infra/`) defines the shape (S3, SQS, DLQ, Lambda, RDS, IAM). Still
  needed: deploy to staging, confirm RDS Postgres (+pgvector for the support agent), Redis-compatible service,
  worker/web scaling, secrets rotation, rollback procedure, and (if using live Bedrock) AgentCore IDs. The
  CI/CD already publishes the support-agent image to GHCR.

## Profitability module follow-ups
- **Auto-generate at book close** — wire `generateProfitabilityReport` into the accounting-period close
  workflow (#19) so the artifact is produced automatically when a period is closed.
- **Read-only source connectors** — populate `profitability_inputs` from QuickBooks Online (revenue by
  customer/class via the Reports API) and ClickUp (time entries → labor hours), plus a media-spend source
  (Meta/Google Ads API or a structured sheet). Same injectable-fetch/hermetic-test seam as the bank connector.
  Read-only on the sources (never writes back).
- **"Chat about this report"** — NL Q&A over a persisted report artifact via the Ollama agent seam (#26)
  (e.g. "why was labor on Client X high this month?").
- **Weekly time-completeness control** — a lightweight check that flags who hasn't entered time in ClickUp,
  surfaced as `ControlFinding`s (reuse the AP data-entry findings pattern).
- **Tie-out cases** — drop real closed-month figures into `tests/profitability.test.ts` as additional
  match-to-the-cent acceptance cases.

## Bank integration follow-ups
- **Outbound payments** — wire payment runs → `BankConnector.disburse`, and add **vendor payment
  instruments** (bank account/code, mobile number, preferred rail) so a run actually sends via
  PesaLink/RTGS/M-Pesa.
- **KCB Buni connector + IPN** — second bank; add the real-time credit-notification webhook
  (`POST /v1/webhooks/bank-ipn`) alongside the pull-based statement reconcile.
- **File-based rails** — bank-statement parsers (MT940 / BAI2 / CAMT.053 / OFX) for banks without a JSON
  statement API, and outbound payment-file generation (NACHA / ISO 20022 pain.001) + remittance advice.
- **Onboarding-confirmed details** — exact Jenga token endpoint / send-money paths and KCB Buni OAuth token
  endpoint (see `docs/bank-integration.md`).

## Other AP items (lower priority)
- Real Bedrock agent wiring (live `AGENT_PROVIDER=bedrock`) with configured AgentCore IDs.
- Debit/credit-memo *application against invoices* beyond the current issue/apply flows, if needed.
