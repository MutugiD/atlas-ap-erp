# Atlas AP Claude Code Routing

Use focused sub-agents for bounded work. Chain schema -> RLS audit -> endpoints -> tests for dependent backend changes. Fan out only when files do not overlap.

## Scope: these are dev-time helpers, not the product's agents

The sub-agents under `.claude/agents/` are **Claude Code development helpers** — they assist with writing schema,
endpoints, and tests. They run on whatever model the coding session uses (`model: inherit`); Claude Code cannot
route them to GLM/Ollama, so they carry no hardcoded model tier.

The **product's runtime task delegation** (the AP invoice Supervisor: extract → validate → match → code → route)
runs on **GLM via the tiered Ollama provider** (`AGENT_PROVIDER=ollama`), documented in
[docs/agent-routing.md](../docs/agent-routing.md). That is the GLM delegation path — it is independent of these
dev-time sub-agents.
