# Agent Model Routing (Ollama / llama.cpp)

The AP Supervisor runs its sub-agents through a pluggable `AgentProvider` chosen by `AGENT_PROVIDER`
(`local` | `bedrock` | `ollama`). Running the pipeline on Anthropic/Bedrock is expensive, so the `ollama`
provider ships the agents on **local/cloud GLM models** with **complexity-tiered routing**: the hardest task
runs on the strongest model and cheaper tasks on smaller models, instead of one model for everything.

## Task → tier → model

| Task       | Kind                    | Tier     | Default model                    |
|------------|-------------------------|----------|----------------------------------|
| `extract`  | LLM (parse → structured)| complex  | `glm-5.2:cloud`                  |
| `code`     | LLM (GL classification) | standard | `glm-5.1:cloud`                  |
| `route`    | LLM (approve/hold)      | simple   | `gemini-3-flash-preview:latest`  |
| `validate` | deterministic arithmetic| —        | local provider (subtotal+tax=total, duplicate) |
| `match`    | deterministic arithmetic| —        | local provider (PO variance/tolerance) |

`validate` and `match` are exact rules where a rule beats an LLM and costs nothing, so they stay on the
deterministic `LocalAgentProvider`. GL `code` is genuine classification (the deterministic path is a fixed
`6100/OPS` stub), so it gets the mid model. `route` is light judgment on the cheapest model — the LLM decides
auto-approve vs. hold and the rationale, but approver **UUIDs are always sourced deterministically** from
tenant policy (a model must not invent approver ids).

> **Note:** `glm-5.0:cloud` does not exist on Ollama cloud (`model not found`), so the simple tier defaults to
> the locally-pulled `gemini-3-flash-preview`. Repoint `OLLAMA_MODEL_SIMPLE` if a real glm-5.0 becomes available.

## Graceful degradation

Every LLM task is wrapped: on transport error, unparseable output, or schema-invalid output it falls back to
the deterministic provider. `code` additionally rejects any proposal whose splits do not reconcile to the
invoice total (it would post an unbalanced journal). Extraction overlays only the fields the model actually
filled, so a small model returning `lines: []` or nulls still yields a schema-valid draft.

## Endpoint styles

`OLLAMA_API_STYLE` selects the wire protocol, so the same provider ships on either backend:

- `ollama` (default) — `POST {OLLAMA_URL}/api/chat` with `format: "json"`; reads `message.content`.
- `openai` — `POST {OLLAMA_URL}/v1/chat/completions` with `response_format: { type: "json_object" }`; reads
  `choices[0].message.content`. Used for **llama.cpp** (`llama-server`) and any OpenAI-compatible server;
  Ollama also serves this path.

## Configuration

```
AGENT_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_API_STYLE=ollama                             # ollama | openai
OLLAMA_API_KEY=                                     # sent as Bearer when set
OLLAMA_MODEL_COMPLEX=glm-5.2:cloud                  # extract
OLLAMA_MODEL_STANDARD=glm-5.1:cloud                 # code
OLLAMA_MODEL_SIMPLE=gemini-3-flash-preview:latest   # route
OLLAMA_LLM_TASKS=extract,code,route                 # which tasks use the LLM; others deterministic
OLLAMA_MODEL=                                       # legacy single-model fallback for any unset tier
```

Any tier left unset falls back to `OLLAMA_MODEL`, then to the built-in defaults above. Drop a task from
`OLLAMA_LLM_TASKS` to force it deterministic (e.g. `OLLAMA_LLM_TASKS=extract` runs only extraction on the LLM).
Programmatic overrides mirror these via `new OllamaAgentProvider({ models, apiStyle, llmTasks })`.

## Shipping on llama.cpp

Run a served GGUF per tier (or one server with multiple models) and point the provider at it:

```
OLLAMA_API_STYLE=openai
OLLAMA_URL=http://localhost:8080          # llama-server --host 0.0.0.0 --port 8080
OLLAMA_MODEL_COMPLEX=<served-model-id>
OLLAMA_MODEL_STANDARD=<served-model-id>
OLLAMA_MODEL_SIMPLE=<served-model-id>
```

The flow is identical; only the endpoint and model ids change.
