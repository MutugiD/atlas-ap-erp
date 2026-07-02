# Testing

Run:

```powershell
bun.cmd test
bun.cmd run typecheck
bun.cmd run license:audit
bun.cmd --filter @atlas/support-agent build
bun.cmd --filter @atlas/web build
bun.cmd run infra:synth
docker compose config --quiet
```

Live Support Agent integration:

```powershell
docker compose up -d postgres redis
$env:DATABASE_URL="postgresql://atlas_owner:atlas_owner@localhost:5432/atlas_ap"
$env:REDIS_URL="redis://localhost:6379"
bun.cmd run test:live-support
```

The test suite covers:

- Lifecycle reducer safety.
- GL balancing.
- Agent schema parsing.
- Supervisor routing.
- Hono route behavior.
- Tenant isolation behavior in repository and RLS SQL.
- UI page render smoke tests.
- Lambda handler message handling.
- Bedrock adapter command contract.
- Infrastructure source checks.
- Support Agent V2 admin/operator workflows.
- Support Agent V2 observability, compliance, CI, license, and load-smoke release gates.
- Optional live Postgres RLS and Redis/BullMQ integration when services are available.

Load smoke:

```powershell
k6 run tests/load/support-agent-k6.js
```

Set `SUPPORT_AGENT_URL` and `SUPPORT_API_KEY` when targeting a deployed or auth-enforced runtime.
