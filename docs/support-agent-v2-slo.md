# Support Agent V2 SLO Model

## Availability Target

Support Agent V2 targets 99.5% monthly availability for the API tier. The design assumes at least two web replicas and at least one worker replica behind a managed load balancer.

Monthly error budget at 99.5%:

- 30-day month: 216 minutes.
- 31-day month: 223.2 minutes.

## Latency Target

The deterministic local-memory path targets p95 under 400ms at 50 requests per second per web replica. The k6 smoke in `tests/load/support-agent-k6.js` encodes that release gate.

## Deployment Shape

- Web role: `APP_ROLE=web`, horizontally scaled, serves Fastify API/admin/metrics.
- Worker role: `APP_ROLE=worker`, consumes BullMQ ingest jobs.
- Database: RDS Postgres with pgvector, app role RLS enforced through transaction-scoped `app.org_id`.
- Queue: Redis-compatible managed cache for BullMQ.
- Observability: Prometheus scrape of `/metrics`, dashboard in `ops/grafana/support-agent-dashboard.json`, alerts in `ops/alerts/support-agent-alerts.yml`.

## Rolling Deployment

1. Apply migrations with the owner role.
2. Run `bun run license:audit`, `bun test`, `bun run typecheck`, `bun --filter @atlas/support-agent build`, and `bun run test:live-support` in staging.
3. Deploy workers first with max unavailable 0 and verify queue depth is stable.
4. Deploy web replicas with at least one healthy old replica serving traffic.
5. Watch p95 latency, readiness failures, DLQ depth, and queue depth for 30 minutes.

## Rollback

Rollback is image-first. Revert the web role image, then the worker role image. Database migration rollback must be handled with a forward-fix migration unless the release explicitly declares a reversible schema change.
