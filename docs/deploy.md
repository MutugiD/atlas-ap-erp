# AWS Deployment

The `infra/` CDK stack (`AtlasApStack`) provisions a production-shaped environment. It is validated on every
CI run via `bun run infra:synth`; an actual deploy requires an AWS account and credentials.

## What it creates

- **VPC** (2 AZs, 1 NAT) with public + private-with-egress subnets.
- **RDS Postgres 17** — private, encrypted at rest, automated backups, security-group scoped;
  `deletionProtection` + `SNAPSHOT` removal in prod. Credentials live in a generated Secrets Manager secret.
- **ElastiCache Redis** (`cache.t4g.micro`) in private subnets — cache/queue/rate-limit for the support agent.
- **Support-agent service on Fargate** behind an **ALB**, health-checked on `/health/ready`, image pulled from
  GHCR (`ghcr.io/<owner>/atlas-support-agent`, published by CI). `DATABASE_URL` / `REDIS_URL` are composed in
  the container from the injected DB secret (username/password) + RDS/Redis endpoints. `desiredCount` = 2 in prod.
- **Async invoice processor** — S3 `ObjectCreated` → SQS (with DLQ, maxReceiveCount 3) → Lambda, in the VPC with
  DB access. Delegates to the **GLM-first Ollama provider** by default (`AGENT_PROVIDER=ollama`); Bedrock invoke
  permissions are retained for the optional `bedrock` provider.
- **Outputs**: service URL (ALB DNS), DB endpoint, DB secret ARN, Redis endpoint, bucket name, queue URL.

Non-prod vs prod is gated on the `prod` context flag so non-prod stacks tear down cleanly:
`bun run --cwd infra deploy -c prod=true`.

## One-time prerequisites

1. **Bootstrap** the account/region: `bunx cdk bootstrap aws://<account>/<region>` (from `infra/`).
2. **OIDC deploy role** for GitHub Actions: an IAM role trusting
   `token.actions.githubusercontent.com` for this repo, with permissions to deploy the stack
   (CloudFormation + the resource services). Set repo **variables** `AWS_DEPLOY_ROLE_ARN` and `AWS_REGION`, and
   create a `aws` GitHub Environment (optionally with required reviewers).
3. **Agent provider (GLM-first).** The processor defaults to `AGENT_PROVIDER=ollama`. Set `OLLAMA_URL` to a
   **reachable** endpoint (Ollama cloud or a self-hosted Ollama/llama.cpp — `localhost` is not reachable from
   Lambda) plus `OLLAMA_API_KEY` and the `OLLAMA_MODEL_*` tiers; these pass through from the deploy environment.
   Without a reachable `OLLAMA_URL` the provider degrades to the deterministic rules. To use Bedrock instead, set
   `AGENT_PROVIDER=bedrock` and `BEDROCK_SUPERVISOR_AGENT_ID` / `BEDROCK_AGENTCORE_RUNTIME_ARN`. Optionally override
   the image with `-c supportImage=<registry/image:tag>`.

## Deploy

- **CI (recommended)**: run the **deploy** workflow (`.github/workflows/deploy.yml`) via *Run workflow*; it
  assumes the OIDC role and runs `cdk deploy`. It never runs automatically.
- **Local**: from `infra/`, `bun run deploy -c prod=true` (after `bun install` and bootstrap).

Preview changes first with `bun run --cwd infra diff`.

## Database schema

Apply the migrations in `packages/db/migrations/*` (and `packages/support-db/migrations/*` for the memory
engine) against the RDS instance as the owner, then let the app connect via the composed `DATABASE_URL`. RLS
requires the app to connect as a non-superuser (`app_user`); see `docs/ci-cd.md` / the live-test harness for the
role setup mirrored in migrations `0001`.

## Rollback

CloudFormation keeps the last good template. To roll back a failed/undesired deploy: redeploy the previous
commit (re-run the workflow from that ref) or `bunx cdk deploy` from the prior revision; CDK/CFN will converge
the stack. RDS uses `SNAPSHOT` removal in prod, so data is recoverable. Destroy a non-prod stack with
`bun run --cwd infra destroy`.

## Notes / still to verify on a real account

Exact IAM policy scoping for the deploy role, live Bedrock AgentCore IDs, ALB TLS/ACM certificate + DNS, and
autoscaling policies are environment-specific and confirmed during the first real deploy. The image is a
dev-mode container today (`bun --filter @atlas/support-agent dev`); a production start command is a follow-up.
