# Spend & Margin Analytics (`@atlas/profitability`)

`@atlas/profitability` is a pure, deterministic, cents-based margin engine. It complements AP operations by
providing account and service-line margin context alongside tenant-scoped vendor and invoice spend. It has no
I/O or external-system dependency: normalized inputs produce a report that can be tied out to a closed period.

## Waterfall

Each slice represents an account × service line:

```text
revenue        = feeRevenue + billedMedia
costOfSales    = mediaSpend
grossMargin    = revenue - costOfSales
laborCost      = laborHours * laborCostRate
deliveryMargin = grossMargin - laborCost
overhead       = allocated from overheadPool by basis
netMargin      = deliveryMargin - overhead
```

`computeProfitability(inputs, config)` returns `{ slices, byAccount, byServiceLine, total }`, each with full
margin values, `grossMarginPct`, `netMarginPct`, and a RAG `status`. `withTrend(current, prior)` adds
month-over-month net-margin deltas and trends (`up`, `down`, `flat`, or `new`).

The web route `/profitability` presents this margin report together with a tenant-scoped vendor-spend view from
the AP invoice inbox. The current engine inputs remain explicit account/service-line records; source connectors
and automatic allocation are tracked in `docs/roadmap.md`.

## Persistence and API

- Inputs in `profitability_inputs` are recorded per period × account × service line through
  `POST /v1/profitability/inputs`.
- `POST /v1/profitability/compute` runs the engine for a period and optionally compares `priorPeriod`.
- `POST /v1/profitability/reports` generates and persists an executive summary plus full report detail.
- `GET /v1/profitability/reports[/:id]` retrieves persisted report artifacts.

## Configuration

- **Overhead basis:** `labor` (default) or `revenue`. Allocation is cent-exact and the residual is assigned to the
  largest-weight slice so the parts sum to the configured pool.
- **Media markup:** billed media is `mediaSpend * (1 + mediaMarkupRate)`. Omit the markup for pure cost.
- **RAG thresholds:** net margin at or above `greenAtOrAbove` is green (default `0.20`), at or above
  `yellowAtOrAbove` is yellow (default `0.10`), otherwise red.

## Tie-out

`tests/profitability.test.ts` asserts the waterfall, overhead allocation, rollups, RAG statuses, and totals
against hand-computed figures. Additional closed-period figures can be added as match-to-the-cent acceptance cases.
