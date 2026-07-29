# atlas-ap-erp

Atlas AP ERP is an open-source, multi-tenant invoice-to-pay ERP platform for controlled AP operations. It combines deterministic accounting controls, agentic invoice processing, bank reconciliation, Spend & Margin Analytics, and optional invoice risk controls. The platform is built with Bun, Hono, Next.js, Drizzle/Postgres RLS, and AWS deployment seams.

## What Ships

- `apps/api`: Hono API with tenant-scoped invoice, vendor master, purchase order, goods receipt, three-way match, accounting period, credit memo, event, exception, approval, reprocess, and webhook routes. Full `/v1` reference: `docs/api.md`.
- `apps/web`: Next.js App Router UI for the invoice inbox, exceptions, approvals, Control Review, Spend & Margin Analytics, invoice detail, and operations metrics.
- `apps/support-agent`: Fastify Support Agent V2 API with native memory, belief revision, auth seams, queue seams, metrics, and admin shell.
- `packages/contracts`: Zod contracts shared by API, agents, DB, web, and Lambda.
- `packages/accounting`: deterministic AP accounting controls for data entry, PO matching, posting, payment runs, and bank reconciliation.
- `packages/risk`: tenant-scoped, explainable invoice risk assessment with deterministic rules, review workflow, rule/model metadata, and CSV reporting. Findings are review signals, never automatic fraud determinations.
- `packages/profitability`: deterministic spend and margin engine — gross → delivery (after labor) → overhead → net margin by account and service line, with AP/vendor spend context, media pass-through markup, RAG status, and month-over-month trend. See `docs/profitability.md`.
- `packages/agents`: deterministic local supervisor plus Bedrock adapter seam.
- `packages/db`: Drizzle schema and a handwritten RLS migration reviewed for `ENABLE ROW LEVEL SECURITY`.
- `packages/support-contracts`, `packages/memory-engine`, `packages/support-db`: Support Agent V2 contracts, native memory engine, and pgvector/RLS schema.
- `infra`: AWS CDK stack for S3, SQS, Lambda, RDS, IAM, and Bedrock/AgentCore configuration placeholders.
- `ops`: Grafana dashboard and Prometheus alert rules for Support Agent V2.
- `tests`: unit, integration, UI, Lambda, Bedrock adapter, infrastructure, release-gate, and load-smoke checks.

## Product capabilities

Atlas AP ERP covers the controlled invoice-to-pay lifecycle:

`receive → extract → validate → three-way match → control review → GL coding → approval → posting → payment → reconciliation`

- **AP operations:** vendor master, purchase orders, goods receipts, invoice validation, exceptions, approvals, posting, payment runs, and bank reconciliation.
- **Control Review:** duplicate, arithmetic, vendor, PO, receipt, currency, amount, and payment-hold signals with human review and audit metadata.
- **Spend & Margin Analytics:** tenant-scoped AP/vendor spend context alongside account and service-line margin reporting, RAG status, and month-over-month trends.
- **Agentic processing:** deterministic local execution by default, with Ollama and Bedrock adapter seams for configured deployments.

Accounting controls remain authoritative. Optional risk analytics can increase review requirements, but cannot bypass matching, approval, posting, payment, or reconciliation controls.

## Local Setup

PowerShell on this machine blocks npm's `bun.ps1` shim, so use `bun.cmd` if `bun` is rejected.

```powershell
npm install -g bun
bun.cmd install
bun.cmd run lint
bun.cmd run audit
bun.cmd test
bun.cmd run license:audit
bun.cmd run release:check
```

Optional local Postgres:

```powershell
docker compose up -d postgres
```

The API defaults to an in-memory repository so CI and local verification do not require live AWS or Postgres. When `DATABASE_URL` is set, the API uses the Postgres-backed repository (`PostgresInvoiceRepository`), which persists invoices, agent events, GL journals, payment runs, payments, bank transactions, and reconciliations under tenant-scoped RLS. The live path is exercised by `bun run test:live-api` (gated on a running Postgres):

```powershell
docker compose up -d postgres
$env:DATABASE_URL="postgresql://atlas_owner:atlas_owner@localhost:5432/atlas_ap"
bun.cmd run test:live-api
```

## Run

```powershell
bun.cmd run dev:api
bun.cmd run dev:web
bun.cmd run dev:support
```

For local UI testing **no database is required** — with `DATABASE_URL` unset the API uses the in-memory
repository. Start `dev:api` (http://localhost:3001) and `dev:web` (http://localhost:3000), then open
`/profitability`: open Spend & Margin Analytics to review AP/vendor spend context alongside the RAG scorecard by account
and service line, with month-over-month trend. The web app talks to the API at `API_BASE_URL`
(default `http://localhost:3001`).

For invoice control review, open `/risk`, assess an invoice from its detail page, inspect the triggered controls,
record a human disposition, and export the tenant-scoped CSV report. Risk findings are review signals and do not
determine fraud or bypass accounting controls. See `docs/fraud-risk.md`.

Default tenant headers for API calls:

- `x-tenant-id`: tenant UUID
- `x-user-id`: user UUID
- `x-user-role`: `ap_clerk`, `approver`, or `admin`

## AWS Deploy Shape

Set these before deploying CDK:

- `AWS_REGION`
- `AWS_PROFILE`
- `DATABASE_URL`
- `S3_INVOICE_BUCKET`
- `AGENT_PROVIDER=ollama` (GLM-first default; needs a reachable `OLLAMA_URL`)
- `OLLAMA_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODEL_{COMPLEX,STANDARD,SIMPLE}`
- `BEDROCK_SUPERVISOR_AGENT_ID`, `BEDROCK_AGENTCORE_RUNTIME_ARN` (only if `AGENT_PROVIDER=bedrock`)

The CDK stack creates the VPC, encrypted RDS Postgres (backups + security groups), ElastiCache Redis, the support-agent service on Fargate behind an ALB (health-checked on `/health/ready`), the S3 document bucket, SQS processing queue + DLQ, in-VPC Lambda processor, IAM boundaries, and stack outputs. Bedrock AgentCore/Gateway identifiers are injected as configuration because account-level Bedrock setup varies. Full deploy guide (prerequisites, OIDC role, deploy workflow, rollback): `docs/deploy.md`.

## Interview Narrative

The invoice agent provider is selectable via `AGENT_PROVIDER`:

- `local` (default in code/tests) — deterministic provider, no external calls.
- `ollama` — **GLM-first tiered delegation** and the intended runtime provider: `extract` → complex
  (`glm-5.2:cloud`), GL `code` → standard (`glm-5.1:cloud`), `route` → simple (`gemini-3-flash`); `validate`/`match`
  stay deterministic. Speaks Ollama `/api/chat` or an OpenAI-compatible endpoint (llama.cpp) via `OLLAMA_API_STYLE`,
  and degrades to the deterministic rules if a model is unreachable. See `docs/agent-routing.md`.
- `bedrock` — optional AWS Bedrock agent seam (`BEDROCK_SUPERVISOR_AGENT_ID`).

Atlas AP uses a Supervisor agent to route invoices through extraction, validation, 3-way matching, GL coding, and approval routing. Clean PO-backed invoices can post without human touch; low-confidence, duplicate, or variance cases move to an exception queue. Every agent and human decision is recorded in `agent_events`, and tenant isolation is enforced through Postgres RLS with `SET LOCAL app.tenant_id`.

The accounting-cycle layer adds vendor master checks, invoice arithmetic validation, PO/receipt tolerance checks, balanced AP posting journals, payment runs, and bank reconciliation tests. See `docs/atlas-ap-accounting-cycle.md`.

Bank integration is behind a `BankConnector` seam (Equity Jenga implemented; KCB Buni next) selected via `BANK_PROVIDER`; the default keeps everything hermetic. See `docs/bank-integration.md` for the verified provider facts (Jenga statements/auth, KCB Buni IPN, PesaLink/RTGS/M-Pesa rails).

Support Agent V2 adds a native belief-revision memory engine: deterministic fact extraction, PII redaction, local embeddings seam, idempotent writes, supersession lineage, context retrieval, stateless mode, Postgres/pgvector persistence seam, BullMQ durable ingest seam, JWT/API-key auth, per-tenant rate limiting, and a 13-capability contract suite.

## CI/CD and Security

Every pull request and every push to `main`/`v*` runs a full gate: frozen-lockfile install, ESLint,
`bun audit`, license audit, release check, the test suite, live Postgres/Redis integration, typecheck,
app/infra builds, and the container build. Security scanning runs in parallel: CodeQL (SAST), dependency
review, Gitleaks secret scanning, and Dependabot security updates. On pushes to `main`/`v*` a gated `publish-image`
job pushes the support-agent image to GHCR. Full reference: `docs/ci-cd.md`.

## Support Agent V2 Release Gates

- CI runs install, lint, dependency audit, license audit, release check, tests, live integration, TypeScript checks, Support Agent build, Next.js build, CDK synth, Docker Compose config, and Support Agent image build; CodeQL, dependency review, and Gitleaks run as separate security workflows.
- `docs/support-agent-v2-slo.md` and `docs/support-agent-v2-release-checklist.md` define rollout, rollback, SLO, and release evidence gates.
- `ops/grafana/support-agent-dashboard.json` covers request rate, p95 latency, ingest results, context reuse, queue depth, DLQ depth, and readiness failures.
- `ops/alerts/support-agent-alerts.yml` covers high latency, DLQ backlog, queue backlog, readiness failure, and low memory-context reuse.
- `tests/load/support-agent-k6.js` is the k6 smoke target for 50 req/s and p95 under 400ms.

Live Support Agent integration:

```powershell
docker compose up -d postgres redis
$env:DATABASE_URL="postgresql://atlas_owner:atlas_owner@localhost:5432/atlas_ap"
$env:REDIS_URL="redis://localhost:6379"
bun.cmd run test:live-support
```
