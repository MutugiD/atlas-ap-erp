# VPS Deployment

This guide describes a small self-hosted installation for finance teams. It assumes Ubuntu 24.04, Docker,
Docker Compose, a DNS name, and an administrator who can manage secrets and backups.

## Services

- Atlas API on an internal application port.
- Atlas web application behind Nginx.
- PostgreSQL for persistent tenant-scoped data.
- Redis when the support-agent or durable queue profile is enabled.

Keep PostgreSQL and Redis private. Expose only Nginx on ports 80 and 443.

## Installation outline

```bash
git clone https://github.com/MutugiD/atlas-ap-erp.git
cd atlas-ap-erp
cp .env.example .env.local
docker compose up -d postgres redis
```

Set a strong database password, a production `DATABASE_URL`, trusted API/web origins, and verified authentication
configuration before exposing the application. Apply migrations as the database owner, then run the API with the
non-superuser application role so Postgres RLS is enforced.

## Nginx and TLS

Proxy `/` to the web service and `/v1/` to the API service. Terminate TLS with an ACME certificate, redirect HTTP
to HTTPS, and configure a renewal timer. Do not forward database credentials or model API keys to browser clients.

## Backups and upgrades

- Take encrypted daily PostgreSQL backups and test restores monthly.
- Keep uploaded invoice objects in encrypted storage with a retention policy.
- Pin release tags rather than deploying arbitrary branch heads.
- Run migrations before starting a new application version.
- Keep the previous image available for rollback.
- Verify `/health` and the web route after every upgrade.

## Risk service profile

The core risk rules run inside the Atlas API and require no separate ML service. Add a Python anomaly service only
when a reviewed model and its data-retention policy are ready. It must accept normalized Atlas records, return a
versioned risk response, and fail back to deterministic rules when unavailable.
