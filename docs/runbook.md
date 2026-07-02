# Runbook

## Local

```powershell
bun.cmd install
docker compose up -d postgres
bun.cmd run dev:api
bun.cmd run dev:web
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

