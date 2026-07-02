# Support Agent V2 Feature Backlog

This backlog translates `Support-Agent-V2-Technical-Spec.md` into implementable enterprise PRs with acceptance criteria.

## Status Legend

- `Done`: implemented and covered by tests in this repo.
- `Partial`: production seam exists; needs live integration or UI depth.
- `Next`: next implementation target.
- `Planned`: sequenced after the current enterprise foundation.

## Functional Requirements

| Spec ID | Feature | PR | Status | Acceptance Criteria |
|---|---|---:|---|---|
| FR-1 | Ingest turns and extract structured facts with provenance | PR 1 | Done | `ingest` stores facts with `sourceRole`, `convId`, timestamps; tests cover slot extraction and write. |
| FR-2 | Belief revision and supersession | PR 1 | Done | New value for a slot supersedes old value; timeline computes `replacedBy`; tests cover Pro to Enterprise and QuickBooks to NetSuite. |
| FR-3 | Retrieve `context_prompt` of active facts | PR 1 | Done | Retrieval returns active facts only, ranks by deterministic embedding when query is supplied, and budget-limits prompt. |
| FR-4 | Stateless chat mode | PR 2 | Done | Stateless route returns a reply with zero memory side effects; contract test freezes timeline length. |
| FR-5 | Episodes referencing fact IDs | PR 1 | Done | Deterministic episodes are generated after ingest and include `factIds`. |
| FR-6 | Artifacts referencing source fact IDs | PR 1 | Done | `customer_profile` artifact includes `sourceFactIds`. |
| FR-7 | Timeline with supersession provenance | PR 2 | Done | Timeline includes active and superseded facts with `supersedes` and computed `replacedBy`. |
| FR-8 | Single fact lookup | PR 2 | Done | Route returns fact provenance by `factId` under org/user scope. |
| FR-9 | Org/user isolation | PR 2/3 | Done | In-memory route tests prove cross-org/user zero rows; RLS migration exists for DB path. |
| FR-10 | Idempotent ingest | PR 1/4 | Done | Content hash prevents duplicate replay in memory and DB store. |
| FR-11 | Reply degradation | PR 4 | Partial | Template reply is default; next step adds explicit failure injection tests for store/queue outage. |
| FR-12 | Admin UI | PR 5 | Partial | Admin APIs and HTML operator surface exist for explorer, graph, DLQ replay, tenant/API-key mgmt, PII review, RBAC, and audit. Refine polish remains. |

## Non-Functional Requirements

| Spec ID | Feature | PR | Status | Acceptance Criteria |
|---|---|---:|---|---|
| NFR-1 | p95 latency targets | PR 6 | Planned | k6/autocannon smoke with p95 thresholds for template and local-LLM-off path. |
| NFR-2 | Durable async writes | PR 4 | Partial | BullMQ queue/worker/DLQ implemented; next step runs integration against live Redis. |
| NFR-3 | 99.5% availability posture | PR 6 | Planned | N>=2 deployment guidance, health probes, rolling deploy docs, alerts. |
| NFR-4 | >=50 req/s per replica | PR 6 | Planned | Load test scenario and threshold report committed. |
| NFR-5 | Cross-tenant leak test | PR 3/4 | Partial | RLS migration and local isolation tests done; next step adds live Postgres RLS test. |
| NFR-6 | Duplicate retry produces zero new facts | PR 1/4 | Done | Replay tests cover in-memory; DB store uses unique `content_hash`. |
| NFR-7 | $0 external memory/mandatory LLM | PR 1 | Done | Native engine and deterministic template path are default. |
| NFR-8 | Correlation IDs and traces | PR 4/6 | Partial | Fastify request IDs and Pino redaction implemented; OTel spans planned. |
| NFR-9 | Queue outage degradation | PR 4/6 | Planned | Add queue failure fallback/buffer test and operator alerting. |
| NFR-10 | Startup readiness gated on model/DB/Redis | PR 4/6 | Partial | Readiness reports store/Redis/model status; live DB/Redis gating tests planned. |

## Current PR Stack

1. `Done`: Native contracts, engine, extraction, redaction, embeddings seam, revision, retrieval, episodes, artifacts.
2. `Done`: Fastify API, stateless mode, 13-capability contract, health, metrics, admin shell.
3. `Done`: pgvector/RLS schema, Docker Compose Postgres+Redis, single-container Dockerfile.
4. `Done/Partial`: Postgres store, BullMQ queue/worker/DLQ, JWT/API-key auth, rate limit, helmet, Pino.
5. `Partial`: Admin/operator APIs, RBAC, graph data, DLQ replay, API-key lifecycle, PII review, audit trail.
6. `Next`: Refine UI polish plus OTel/Sentry/Grafana/load tests/license audit/CI image release gates.

## PR Description — Refine Admin And Operator Workflows

**Summary**
Build the operator UI promised by FR-12: searchable memory explorer, supersession graph, DLQ inspector/replay, tenant/API-key management, and PII review.

**Acceptance Criteria**
- Admin-only routes require `role=admin`.
- Memory explorer lists facts, episodes, artifacts, provenance, and status filters.
- Supersession graph groups by `slotKey` and highlights the active node.
- DLQ inspector lists failed jobs and supports replay through the queue seam.
- API-key issuance stores only hashes and writes audit events.
- Tests cover RBAC, graph data shape, DLQ replay, and audit writes.

## Next PR Description — Observability, Compliance, And Release Gates

**Summary**
Complete release readiness with tracing, Sentry, Grafana dashboard assets, load-test smoke, Apache-2.0 licensing, dependency audit, and CI.

**Acceptance Criteria**
- OpenTelemetry spans wrap chat, retrieve, enqueue, extract, revise, and admin actions.
- Sentry is configured with PII scrubbing and release tags.
- Grafana dashboard JSON and alert rules cover queue depth, DLQ, p95 latency, cache hit rate, and readiness failures.
- k6/autocannon smoke validates p95 and throughput thresholds.
- Apache-2.0 `LICENSE`, `NOTICE`, and dependency/model license audit script exist.
- CI workflow runs install, typecheck, tests, builds, migration checks, Docker build, and license audit.
