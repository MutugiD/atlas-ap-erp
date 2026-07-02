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
