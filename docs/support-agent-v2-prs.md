# Support Agent V2 Iterative PR Plan

This plan breaks Support Agent V2 into reviewable enterprise PRs while preserving the end-to-end implementation path. Each PR is designed to be independently reviewable, test-backed, and pushable to `main` for this long-lived implementation session.

## PR 1 - Native Memory Contracts And Engine

**Summary**
Adds the shared Support Agent contracts and native memory engine skeleton: deterministic extraction, PII redaction, deterministic embedder seam, idempotency hashing, belief revision, retrieval, timeline, episodes, artifacts, and stateless-safe interfaces.

**Changes**
- Add `packages/support-contracts` with Zod contracts for chat, ingest, facts, timelines, episodes, artifacts, org context, and audit events.
- Add `packages/memory-engine` with `MemoryStore`, `Extractor`, `Embedder`, `Redactor`, and `InMemoryNativeStore`.
- Implement slot extraction for plan, CRM/tooling, contact channel, email, phone, timezone, account tier, and support preferences.
- Implement PII redaction before fact persistence.
- Implement one-active-fact-per-slot revision behavior and computed `replacedBy`.

**Tests**
- Slot extraction rules.
- PII redaction.
- Idempotency replay.
- Supersession lineage.
- Context prompt assembly.
- Episode/artifact references.

## PR 2 - Fastify API And 13-Capability Contract

**Summary**
Adds the Support Agent V2 Fastify app and proves the native engine against the V1 behavioral contract.

**Changes**
- Add `apps/support-agent` with health, readiness, metrics, chat, memory, timeline, rich timeline, fact lookup, demo, reset, and admin shell routes.
- Add JWT/API-key-shaped auth middleware with org/principal context.
- Add `with_memory` vs `stateless` chat behavior, guaranteeing stateless mode has zero memory side effects.
- Add local queue fallback seam so async BullMQ can replace it without changing routes.

**Tests**
- All 13 behavioral contract capabilities.
- Route tests for every public endpoint.
- Stateless safety guard.
- Memory-aware reply behavior.
- Cross-org route isolation.

## PR 3 - pgvector Schema, RLS, Docker Runtime

**Summary**
Adds production persistence and runtime foundations: Postgres 16 + pgvector schema/RLS migration, Redis service, Dockerfile, and long-lived docs.

**Changes**
- Add `packages/support-db` Drizzle schema and handwritten pgvector/RLS migration.
- Add facts, episodes, artifacts, audit logs, API keys, ingest jobs, orgs, and users tables.
- Enforce `support_one_active_per_slot`, `support_uniq_content`, pgvector HNSW index, and org-level RLS policies.
- Update Docker Compose with `pgvector/pgvector:pg16` and Redis.
- Add single-container Dockerfile with `APP_ROLE=web|worker`.

**Tests**
- Migration text checks for pgvector, RLS, content uniqueness, and active-slot invariant.
- `set_config('app.org_id', ..., true)` tenant scoping check.
- Typecheck and app build.

## PR 4 - Production Persistence, Queue, Auth, And Runtime Hardening

**Summary**
Replaces local-only seams with enterprise-grade runtime integrations while preserving deterministic tests.

**Changes**
- Add real Postgres-backed `NativeStore` selected by `DATABASE_URL`.
- Add BullMQ + Redis durable ingest queue, retry policy, worker role, and DLQ queue.
- Add JWT/API-key verification paths, production auth enforcement, secure headers, and per-tenant rate limiting.
- Add structured Pino logging with correlation IDs and secret redaction.
- Keep local deterministic mode as the default for fast contract tests.

**Tests**
- Queue/DLQ source checks and local queue invariants.
- Postgres store SQL/advisory-lock/RLS behavior tests.
- Auth enforcement tests for API key and JWT.
- Build and typecheck gates.

## PR 5 - Admin And Operator Workflows

**Summary**
Turns the admin shell into an operator-ready management API and UI foundation.

**Changes**
- Add admin endpoints served by the Fastify container.
- Implement memory explorer, supersession graph data, DLQ inspector/replay, tenant/API-key management, and PII redaction review.
- Add admin RBAC and audit log writes for every mutation.
- Keep the current HTML admin as the static single-container surface; Refine polish remains a follow-up.

**Tests**
- Admin route RBAC tests.
- Supersession graph smoke tests.
- DLQ replay route tests.
- Audit log assertions for admin actions.

## PR 6 - Observability, Compliance, And Release Gates

**Summary**
Completes enterprise release readiness with operational evidence and repository gates.

**Changes**
- Add typed tracing spans and a Sentry event scrubber seam without forcing external telemetry dependencies into local tests.
- Add Prometheus context-cache and readiness-failure metrics.
- Add Grafana dashboard JSON and Prometheus alert rules.
- Add k6 load smoke for 50 req/s and p95 under 400ms.
- Add Apache-2.0 `LICENSE`, `NOTICE`, and dependency license audit script.
- Add CI workflow for install, license audit, tests, typecheck, builds, CDK synth, Compose config, and Docker image build.

**Tests**
- Metrics and tracing source smoke tests.
- License audit script check.
- CI workflow gate check.
- Dashboard, alerts, and load-smoke threshold checks.

## PR 7 - Live Integration Harness And Refine Admin Polish

**Summary**
Moves remaining partial items from static/source guarantees into live integration checks and richer operator workflows.

**Planned Changes**
- Add CI service containers for Postgres pgvector and Redis.
- Add live RLS test proving org A cannot read org B through the real app role.
- Add BullMQ enqueue, retry, and DLQ replay integration test against live Redis.
- Add queue outage fallback/failure-injection tests.
- Replace the static HTML shell with Refine admin screens for explorer, graph, DLQ, PII, audit, and API keys.
- Add JWKS discovery and external IdP role mapping.

**Acceptance Criteria**
- Live Postgres and Redis suites can run locally and in CI.
- Failure-injection tests prove memory errors never block a chat reply.
- Admin UI is usable without direct API crafting.
- Auth configuration supports production IdP integration.
