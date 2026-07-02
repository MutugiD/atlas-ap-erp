# Support Agent V2 Release Checklist

## Preflight

- `bun.cmd install`
- `bun.cmd run license:audit`
- `bun.cmd test`
- `bun.cmd run typecheck`
- `bun.cmd --filter @atlas/support-agent build`
- `bun.cmd --filter @atlas/web build`
- `bun.cmd run infra:synth`
- `docker compose config --quiet`
- `bun.cmd run test:live-support` with Postgres and Redis available

## Secrets

- `SUPPORT_API_KEY` for emergency/service access.
- `AUTH_JWKS_URL`, `AUTH_JWT_AUDIENCE`, and `AUTH_JWT_ISSUER` for production identity.
- `DATABASE_URL` for the RLS-enforced app role.
- `REDIS_URL` for BullMQ.
- `RELEASE_VERSION` for Sentry/trace release metadata.

## Release Gates

- No non-skipped fast tests fail.
- Live Postgres RLS test passes with the app role.
- Live Redis worker ingest test passes.
- k6 smoke has p95 under 400ms at 50 req/s per replica.
- Dashboard and alert assets are deployed before traffic shift.

## Rollback Triggers

- Readiness failure alert fires for more than 1 minute.
- DLQ remains non-empty for more than 2 minutes.
- p95 latency remains above 400ms for 10 minutes.
- Cross-tenant isolation test fails in staging.
