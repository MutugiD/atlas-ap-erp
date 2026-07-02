# atlas-ap-erp

Atlas AP ERP is an end-to-end, multi-tenant invoice-to-pay demo for an agentic ERP module. It implements the architecture described in `docs/implementation-session.md`: Bun, Hono, Next.js, Drizzle/Postgres RLS, AWS deployment seams, deterministic local agents, and testable API/UI/domain behavior.

## What Ships

- `apps/api`: Hono API with tenant-scoped invoice, event, exception, approval, reprocess, and webhook routes.
- `apps/web`: Next.js App Router UI for inbox, invoice detail, exceptions, approvals, and ops metrics.
- `apps/support-agent`: Fastify Support Agent V2 API with native memory, belief revision, auth seams, queue seams, metrics, and admin shell.
- `packages/contracts`: Zod contracts shared by API, agents, DB, web, and Lambda.
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
bun.cmd test
bun.cmd run license:audit
```

Optional local Postgres:

```powershell
docker compose up -d postgres
```

The API tests run against an in-memory repository so CI and local verification do not require live AWS or Postgres. RLS is still represented in Drizzle and covered by SQL/policy tests.

## Run

```powershell
bun.cmd run dev:api
bun.cmd run dev:web
bun.cmd run dev:support
```

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

The CDK stack creates the document bucket, processing queue, DLQ, Lambda processor, RDS instance, and IAM boundaries. Bedrock AgentCore/Gateway identifiers are injected as configuration because account-level Bedrock setup varies.

## Interview Narrative

Atlas AP uses a Supervisor agent to route invoices through extraction, validation, 3-way matching, GL coding, and approval routing. Clean PO-backed invoices can post without human touch; low-confidence, duplicate, or variance cases move to an exception queue. Every agent and human decision is recorded in `agent_events`, and tenant isolation is enforced through Postgres RLS with `SET LOCAL app.tenant_id`.

Support Agent V2 adds a native belief-revision memory engine: deterministic fact extraction, PII redaction, local embeddings seam, idempotent writes, supersession lineage, context retrieval, stateless mode, Postgres/pgvector persistence seam, BullMQ durable ingest seam, JWT/API-key auth, per-tenant rate limiting, and a 13-capability contract suite.

## Support Agent V2 Release Gates

- CI runs install, license audit, tests, TypeScript checks, Support Agent build, Next.js build, CDK synth, Docker Compose config, and Support Agent image build.
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
