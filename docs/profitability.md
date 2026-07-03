# Profitability Engine (`@atlas/profitability`)

A pure, deterministic, cents-based agency P&L engine (mirrors `@atlas/accounting`) so results **tie out to the
dollar** against a hand-closed P&L. No I/O and no external systems — it takes normalized inputs and returns a
report. Persistence and the period-close report artifact are separate follow-up PRs.

## Waterfall (per slice = account × service line)

```
revenue        = feeRevenue + billedMedia          (billedMedia = mediaSpend * (1 + mediaMarkupRate))
costOfSales    = mediaSpend                          (pass-through media cost)
grossMargin    = revenue - costOfSales              (= feeRevenue + the media markup)
laborCost      = laborHours * laborCostRate          (cost rate, not bill rate)
deliveryMargin = grossMargin - laborCost
overhead       = allocated from overheadPool by basis
netMargin      = deliveryMargin - overhead
```

`computeProfitability(inputs, config)` returns `{ slices, byAccount, byServiceLine, total }`, each a full margin
set plus `grossMarginPct`, `netMarginPct`, and a RAG `status`. `withTrend(current, prior)` attaches
month-over-month `netMarginDelta` and a `trend` (`up|down|flat|new`) to the account and service-line rollups.
`summarize(report, trend?)` rolls a report into an executive summary (totals, RAG status counts, best/worst
account, biggest MoM gain/drop).

## Persistence & API

- Inputs (`profitability_inputs`) are recorded per period × account × service line via
  `POST /v1/profitability/inputs`; `POST /v1/profitability/compute` runs the engine over a period (with
  optional `priorPeriod` trend).
- `POST /v1/profitability/reports` generates and **persists** a report artifact (executive summary + full
  detail) — the "monthly report package"; `GET /v1/profitability/reports[/:id]` retrieves them. Auto-generation
  at accounting-period close is a documented follow-up (`docs/roadmap.md`).

## Configuration (defaults, all overridable)

- **Overhead basis** — `labor` (default; % of direct labor cost) or `revenue`. The pool is allocated
  cent-exact: shares are rounded and the residual is pushed onto the largest-weight slice so the parts sum
  back to the pool.
- **Media markup** — pass-through media billed at `mediaSpend * (1 + mediaMarkupRate)`; the markup profit
  lands in gross margin. Omit `mediaMarkupRate` for pure cost.
- **RAG thresholds** — net-margin %: `>= greenAtOrAbove` → green (default 0.20), `>= yellowAtOrAbove` →
  yellow (default 0.10), else red.

## Tie-out

`tests/profitability.test.ts` asserts the full waterfall, overhead allocation, both rollups, RAG statuses, and
totals against hand-computed figures — the same "match to the cent" discipline the acceptance test requires.
When real closed-month numbers are provided, they drop in as additional tie-out cases.
