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
| FR-11 | Reply degradation | PR 4/6 | Partial | Template reply is default; readiness and alerting exist; next step adds explicit failure injection tests for store/queue outage. |
| FR-12 | Admin UI | PR 5 | Partial | Admin APIs and HTML operator surface exist for explorer, graph, DLQ replay, tenant/API-key mgmt, PII review, RBAC, and audit. Refine polish remains. |

## Non-Functional Requirements

| Spec ID | Feature | PR | Status | Acceptance Criteria |
|---|---|---:|---|---|
| NFR-1 | p95 latency targets | PR 6 | Done | k6 smoke includes p95 threshold for the deterministic local path. |
| NFR-2 | Durable async writes | PR 4/7 | Done | BullMQ queue/worker/DLQ implemented; live Redis worker test is available in CI/service-container harness. |
| NFR-3 | 99.5% availability posture | PR 6/8 | Done | Health probes, readiness metrics, alerts, SLO model, release checklist, and rollback triggers exist. |
| NFR-4 | >=50 req/s per replica | PR 6 | Done | k6 load scenario targets 50 req/s with p95 threshold. |
| NFR-5 | Cross-tenant leak test | PR 3/4/7 | Done | RLS migration, local isolation, and live Postgres app-role RLS harness exist. |
| NFR-6 | Duplicate retry produces zero new facts | PR 1/4 | Done | Replay tests cover in-memory; DB store uses unique `content_hash`. |
| NFR-7 | $0 external memory/mandatory LLM | PR 1 | Done | Native engine and deterministic template path are default. |
| NFR-8 | Correlation IDs and traces | PR 4/6 | Partial | Fastify request IDs, Pino redaction, and tracing seam implemented; full OTel exporter remains deployment-specific. |
| NFR-9 | Queue outage degradation | PR 4/6/7 | Done | DLQ/operator alerting and degrading queue buffer exist; chat replies survive queue failures. |
| NFR-10 | Startup readiness gated on model/DB/Redis | PR 4/6 | Partial | Readiness reports store/Redis/model status and emits failure metrics; live DB/Redis gating tests planned. |

## Current PR Stack

1. `Done`: Native contracts, engine, extraction, redaction, embeddings seam, revision, retrieval, episodes, artifacts.
2. `Done`: Fastify API, stateless mode, 13-capability contract, health, metrics, admin shell.
3. `Done`: pgvector/RLS schema, Docker Compose Postgres+Redis, single-container Dockerfile.
4. `Done/Partial`: Postgres store, BullMQ queue/worker/DLQ, JWT/API-key auth, rate limit, helmet, Pino.
5. `Partial`: Admin/operator APIs, RBAC, graph data, DLQ replay, API-key lifecycle, PII review, audit trail.
6. `Done/Partial`: Observability seam, Sentry scrubber shape, Grafana dashboard, alerts, load smoke, license audit, and CI image gates.
7. `Done/Partial`: Live Postgres/Redis integration harness, degrading queue buffer, JWKS discovery seam, and richer admin shell.
8. `Done/Partial`: SLO model, release checklist, release check script, load report template, saved admin context, loading/error states, and export actions.

## PR Description - Admin And Operator Workflows

**Summary**
Build the operator workflow promised by FR-12: searchable memory explorer, supersession graph, DLQ inspector/replay, tenant/API-key management, and PII review.

**Acceptance Criteria**
- Admin-only routes require `role=admin`.
- Memory explorer lists facts, episodes, artifacts, provenance, and status filters.
- Supersession graph groups by `slotKey` and highlights the active node.
- DLQ inspector lists failed jobs and supports replay through the queue seam.
- API-key issuance stores only hashes and writes audit events.
- Tests cover RBAC, graph data shape, DLQ replay, and audit writes.

## PR Description - Observability, Compliance, And Release Gates

**Summary**
Complete release readiness with tracing seams, Sentry scrubber shape, Grafana dashboard assets, alert rules, load-test smoke, Apache-2.0 licensing, dependency audit, and CI.

**Acceptance Criteria**
- Tracing spans wrap chat, retrieve, and enqueue; extract/revise spans are reserved in the typed seam.
- Sentry event shape includes PII scrubbing and release tags.
- Grafana dashboard JSON and alert rules cover queue depth, DLQ, p95 latency, cache hit rate, and readiness failures.
- k6 smoke validates p95 and throughput thresholds.
- Apache-2.0 `LICENSE`, `NOTICE`, and dependency/model license audit script exist.
- CI workflow runs install, typecheck, tests, builds, migration checks, Docker build, and license audit.

## PR Description - Live Integration Harness And Refine Admin Polish

**Summary**
Move the remaining partial items from source-level enterprise seams to live integration checks and a richer operator UI.

**Acceptance Criteria**
- CI service containers run a live pgvector/Postgres RLS test and Redis/BullMQ enqueue/DLQ test.
- Queue outage fallback and memory degradation are covered by failure-injection tests.
- Refine admin shell renders explorer, graph, DLQ, PII, audit, and API-key workflows with route-level RBAC.
- JWKS discovery and external IdP role mapping are configurable.

## PR Description - Production Deployment SLO And Admin Productization

**Summary**
Convert the remaining deployment-specific partials into final production posture.

**Acceptance Criteria**
- Rolling deployment and multi-replica SLO math is documented for the target AWS runtime.
- Admin UI has production routing, saved filters, empty/loading/error states, and export actions.
- JWKS/IdP configuration is validated with a real issuer in a staging profile.
- Load-test output is captured as a checked-in release report for the selected instance size.

## Next PR Description - Staging Evidence And UI Framework Upgrade

**Summary**
Run the now-defined production gates against a real staging profile and, if still desired, replace the static admin shell with a full Refine application package.

**Acceptance Criteria**
- Live Postgres/Redis tests pass against staging and the k6 report is filled in with measured output.
- JWKS config is validated with the production IdP issuer metadata.
- Admin UI is promoted from static shell to package-managed Refine screens if product scope requires it.
