# atlas-ap-erp

Atlas AP ERP is an end-to-end, multi-tenant invoice-to-pay demo for an agentic ERP module. It implements the architecture described in `docs/implementation-session.md`: Bun, Hono, Next.js, Drizzle/Postgres RLS, AWS deployment seams, deterministic local agents, and testable API/UI/domain behavior.

## What Ships

- `apps/api`: Hono API with tenant-scoped invoice, vendor master, purchase order, goods receipt, three-way match, accounting period, credit memo, event, exception, approval, reprocess, and webhook routes. Full `/v1` reference: `docs/api.md`.
- `apps/web`: Next.js App Router UI for inbox, invoice detail, exceptions, approvals, and ops metrics.
- `apps/support-agent`: Fastify Support Agent V2 API with native memory, belief revision, auth seams, queue seams, metrics, and admin shell.
- `packages/contracts`: Zod contracts shared by API, agents, DB, web, and Lambda.
- `packages/accounting`: deterministic AP accounting controls for data entry, PO matching, posting, payment runs, and bank reconciliation.
- `packages/profitability`: deterministic agency P&L engine — gross → delivery (after labor) → overhead → net margin by account and service line, with media pass-through markup, RAG status, and month-over-month trend. See `docs/profitability.md`.
- `packages/agents`: deterministic local supervisor plus Bedrock adapter seam.
- `packages/db`: Drizzle schema and a handwritten RLS migration reviewed for `ENABLE ROW LEVEL SECURITY`.
- `packages/support-contracts`, `packages/memory-engine`, `packages/support-db`: Support Agent V2 contracts, native memory engine, and pgvector/RLS schema.
- `infra`: AWS CDK stack for S3, SQS, Lambda, RDS, IAM, and Bedrock/AgentCore configuration placeholders.
- `ops`: Grafana dashboard and Prometheus alert rules for Support Agent V2.
- `tests`: unit, integration, UI, Lambda, Bedrock adapter, infrastructure, release-gate, and load-smoke checks.

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
`/profitability`: add a few inputs for a period, click **Generate report**, and the RAG scorecard (by account
and service line, with month-over-month trend) renders. The web app talks to the API at `API_BASE_URL`
(default `http://localhost:3001`).

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
- `BEDROCK_SUPERVISOR_AGENT_ID`
- `BEDROCK_AGENTCORE_RUNTIME_ARN`
- `AGENT_PROVIDER=bedrock`

The CDK stack creates the VPC, encrypted RDS Postgres (backups + security groups), ElastiCache Redis, the support-agent service on Fargate behind an ALB (health-checked on `/health/ready`), the S3 document bucket, SQS processing queue + DLQ, in-VPC Lambda processor, IAM boundaries, and stack outputs. Bedrock AgentCore/Gateway identifiers are injected as configuration because account-level Bedrock setup varies. Full deploy guide (prerequisites, OIDC role, deploy workflow, rollback): `docs/deploy.md`.

## Interview Narrative

The invoice agent provider is selectable via `AGENT_PROVIDER`:

- `local` (default) — deterministic provider, no external calls (used by tests).
- `bedrock` — AWS Bedrock agent (`BEDROCK_SUPERVISOR_AGENT_ID`).
- `ollama` — extracts invoice fields with an Ollama model (`OLLAMA_URL`, `OLLAMA_MODEL`, optional `OLLAMA_API_KEY`), delegating validation/matching/coding/routing to the deterministic rules and falling back to them if the model is unreachable.

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
