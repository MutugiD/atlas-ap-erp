# Contributing

Atlas AP ERP is an open-source ERP platform. Small, focused pull requests are preferred, and every pull request
must preserve tenant isolation and existing accounting invariants.

## Development

```powershell
bun.cmd install
bun.cmd run lint
bun.cmd audit
bun.cmd test
bun.cmd run typecheck
bun.cmd run license:audit
```

For risk changes, add a focused test for each new rule, explanation, threshold, review transition, or export field.
Do not include real financial records in commits or issue reports. Use `examples/risk-sample.csv` as the public
fixture pattern.

## Pull requests

- Use one focused branch and one pull request at a time.
- Keep branch names descriptive, such as `risk-core`, `risk-ui`, or `risk-docs`.
- Describe behavior, security implications, migration impact, and validation commands.
- Do not merge directly to `main`.
- Do not claim that a risk score proves fraud.
