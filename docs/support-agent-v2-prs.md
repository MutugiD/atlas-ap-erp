# Support Agent V2 Iterative PR Plan

This plan breaks Support Agent V2 into reviewable enterprise PRs while preserving the end-to-end implementation path.

## PR 1 — Native Memory Contracts And Engine

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

## PR 2 — Fastify API And 13-Capability Contract

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

## PR 3 — pgvector Schema, RLS, Docker Runtime

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

## PR 4 — Production Hardening Follow-Up

**Summary**
Replaces local seams with enterprise-grade runtime integrations after the native core is green.

**Changes**
- Add real Postgres-backed `NativeStore`.
- Add BullMQ + Redis durable ingest queue, retry policy, and DLQ replay.
- Add JWT/JWKS verification and hashed API-key issuance/rotation.
- Add OpenTelemetry, Pino request logging, Sentry, and richer Prometheus metrics.
- Replace admin shell with Refine memory explorer, supersession graph, DLQ inspector, tenant management, and PII review.

**Tests**
- Queue/DLQ integration tests.
- Cross-tenant DB leak test against Postgres.
- Graceful degradation tests for Redis/Postgres/Ollama outages.
- k6/autocannon smoke for latency and throughput.

