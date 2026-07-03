# CI/CD and Security

The pipeline is defined entirely in `.github/workflows/` and runs on every pull request and on pushes to
`main` (plus `v*` tags for releases). Every check below must pass before a change merges.

## Workflows

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| CI (`verify`) | `.github/workflows/ci.yml` | PR, push to `main`/`v*` | Build/test gate (details below). |
| CD (`publish-image`) | `.github/workflows/ci.yml` | push to `main`/`v*` only, `needs: verify` | Build and push the container image to GHCR. |
| CodeQL | `.github/workflows/codeql.yml` | PR, push to `main`, weekly cron | Static application security testing (SAST) for JS/TS with the `security-and-quality` query pack. |
| Dependency review | `.github/workflows/dependency-review.yml` | PR | Fails a PR that introduces a dependency with a known **high**-severity advisory. |
| Gitleaks | `.github/workflows/gitleaks.yml` | PR, push to `main` | Secret scanning over the diff/history (config: `.gitleaks.toml`). |

Automated dependency and GitHub Actions updates are proposed weekly by Dependabot (`.github/dependabot.yml`).
GitHub-native secret scanning and push protection are also enabled on the repository.

## The `verify` job (in order)

1. `bun install --frozen-lockfile` — lockfile must be committed and current.
2. `bun run lint` — ESLint flat config (`eslint.config.js`); zero errors required.
3. `bun run audit` — `bun audit`; fails on any known vulnerability in the resolved tree.
4. `bun run license:audit` — dependency license compliance.
5. `bun run release:check` — Support Agent V2 release-gate assertions.
6. `bun test` — full unit/integration/contract suite.
7. `bun run test:live-support` and `bun run test:live-api` — live Postgres/Redis integration against
   `pgvector/pgvector:pg16` + `redis:7` service containers (RLS isolation, queue, AP persistence).
8. `bun run typecheck` — `tsc --noEmit`.
9. Builds: `@atlas/support-agent`, `@atlas/web`; `infra:synth`; `docker compose config`; support-agent image build.

## CD / image publish

`publish-image` runs only after `verify` succeeds and only on pushes (never on pull requests). It publishes
`ghcr.io/<owner>/atlas-support-agent` tagged with the branch, commit SHA, `latest` on the default branch, and
the semver on `v*` tags, authenticating with the built-in `GITHUB_TOKEN` (`packages: write`). Deploy by
pulling the tag onto the target host; readiness is gated on `GET /health/ready`.

## Local pre-flight

Run the same gate before pushing:

```powershell
bun.cmd install
bun.cmd run lint
bun.cmd run audit
bun.cmd run license:audit
bun.cmd run release:check
bun.cmd test
bun.cmd run typecheck
bun.cmd run infra:synth
```
