# Architecture

Atlas AP is a shared-schema multi-tenant AP module.

## Runtime Flow

1. Invoice metadata or inbound email creates an `invoice`.
2. S3 upload/event can enqueue the invoice for Lambda processing.
3. Supervisor executes only required sub-agents for the invoice context.
4. Hard invariants are deterministic: lifecycle transitions, GL balance, tolerance checks, RLS.
5. Agent and human decisions are stored as `agent_events`.

## Agent Branching

- PO invoice: extract -> validate -> match -> code -> route -> post.
- Non-PO invoice: extract -> validate -> code -> route.
- Low extraction confidence: exception.
- Duplicate or invalid totals: exception.
- PO variance outside tolerance: exception.
- Amount over auto-approval limit: awaiting approval.

## Deployment

The CDK stack provides the cloud path. Bedrock AgentCore/Gateway values are environment-injected because production agent setup depends on account and region availability.

