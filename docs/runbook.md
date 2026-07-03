# Runbook

## Local

```powershell
bun.cmd install
docker compose up -d postgres
bun.cmd run dev:api
bun.cmd run dev:web
bun.cmd run dev:support
```

## Create Demo Invoice

```powershell
Invoke-RestMethod -Method Post http://localhost:3001/v1/invoices `
  -Headers @{ "x-tenant-id" = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } `
  -ContentType "application/json" `
  -Body '{"vendorName":"Nairobi Office Supplies","invoiceNumber":"INV-100","total":1200,"currency":"USD","poId":"44444444-4444-4444-8444-444444444444"}'
```

## Reprocess

Call `POST /v1/invoices/:id/reprocess` to run the local or Bedrock agent provider.

## Support Agent V2 Operator Checks

Start the Support Agent with auth enabled:

```powershell
$env:REQUIRE_AUTH="true"
$env:SUPPORT_API_KEY="local-smoke-key"
bun.cmd run dev:support
```

Use these headers for admin routes:

- `x-api-key`: `local-smoke-key`
- `x-org-id`: org UUID
- `x-principal-id`: operator id
- `x-role`: `admin`

Operator endpoints:

- `GET /api/admin/memory/:userId/explorer`
- `GET /api/admin/memory/:userId/graph`
- `GET /api/admin/pii`
- `GET /api/admin/audit`
- `GET /api/admin/dlq`
- `POST /api/admin/dlq/:jobId/replay`
- `POST /api/admin/api-keys`

Prometheus metrics are exposed at `GET /metrics`. Import `ops/grafana/support-agent-dashboard.json` and apply `ops/alerts/support-agent-alerts.yml` in the Prometheus-compatible alert manager.

## CI/CD

CI (`.github/workflows/ci.yml`, job `verify`) runs on every pull request and on pushes to `main` and `v*`
tags: install (frozen lockfile), license audit, release check, tests, live Support Agent + AP integration,
typecheck, app builds, CDK synth, and the container build.

CD is the gated `publish-image` job in the same workflow. It `needs: verify`, runs only on pushes (never on
pull requests), and publishes the support-agent image to GHCR at
`ghcr.io/<owner>/atlas-support-agent` — tagged with the branch, commit SHA, `latest` on the default branch,
and the semver on `v*` tags. Authentication uses the built-in `GITHUB_TOKEN` (`packages: write`); no extra
secrets are required. Deploy by pulling the published tag onto the target host; readiness is gated on
`GET /health/ready`.

Security scanning runs as separate workflows: CodeQL (SAST) on PRs, pushes, and weekly; dependency review on
PRs; and Gitleaks secret scanning. Dependabot security updates open a PR only when a dependency has a known
vulnerability (no routine version-bump PRs). See `docs/ci-cd.md` for the complete reference.
