# Testing

Run:

```powershell
bun.cmd test
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

