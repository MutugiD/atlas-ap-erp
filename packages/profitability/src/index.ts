// Agency profitability engine. Pure, deterministic, cents-based (mirrors
// @atlas/accounting) so results tie out to the dollar against a hand-closed P&L.
//
// P&L waterfall per slice (account x service line):
//   revenue        = feeRevenue + billedMedia            (billedMedia = mediaSpend * (1 + markup))
//   costOfSales    = mediaSpend                           (pass-through media cost)
//   grossMargin    = revenue - costOfSales                (= feeRevenue + media markup)
//   laborCost      = laborHours * laborCostRate
//   deliveryMargin = grossMargin - laborCost
//   overhead       = allocated from the overhead pool by the configured basis
//   netMargin      = deliveryMargin - overhead

export type Money = number;
export type RagStatus = "green" | "yellow" | "red";
export type Trend = "up" | "down" | "flat" | "new";

export interface ProfitabilityInput {
  account: string;
  serviceLine: string;
  feeRevenue: Money;
  laborHours: number;
  laborCostRate: Money;
  mediaSpend?: Money;
  // Markup applied to pass-through media when billed to the client (e.g. 0.15 = 15%).
  mediaMarkupRate?: number;
}

export interface ProfitabilityConfig {
  overheadPool: Money;
  // How the overhead pool is spread across slices. Default: by direct labor cost.
  overheadBasis?: "labor" | "revenue";
  // Net-margin % thresholds: >= greenAtOrAbove -> green, >= yellowAtOrAbove -> yellow, else red.
  greenAtOrAbove?: number;
  yellowAtOrAbove?: number;
}

export interface Margins {
  revenue: Money;
  costOfSales: Money;
  grossMargin: Money;
  laborCost: Money;
  deliveryMargin: Money;
  overhead: Money;
  netMargin: Money;
  grossMarginPct: number;
  netMarginPct: number;
  status: RagStatus;
}

export interface SliceResult extends Margins {
  account: string;
  serviceLine: string;
}

export interface Rollup extends Margins {
  key: string;
}

export interface ProfitabilityReport {
  slices: SliceResult[];
  byAccount: Rollup[];
  byServiceLine: Rollup[];
  total: Margins;
}

const DEFAULTS = { overheadBasis: "labor" as const, greenAtOrAbove: 0.2, yellowAtOrAbove: 0.1 };

export function computeProfitability(inputs: ProfitabilityInput[], config: ProfitabilityConfig): ProfitabilityReport {
  const opts = { ...DEFAULTS, ...config };

  // Pre-compute per-slice figures above the overhead line.
  const pre = inputs.map((input) => {
    const mediaSpend = input.mediaSpend ?? 0;
    const billedMedia = roundMoney(mediaSpend * (1 + (input.mediaMarkupRate ?? 0)));
    const revenue = roundMoney(input.feeRevenue + billedMedia);
    const costOfSales = roundMoney(mediaSpend);
    const grossMargin = roundMoney(revenue - costOfSales);
    const laborCost = roundMoney(input.laborHours * input.laborCostRate);
    const deliveryMargin = roundMoney(grossMargin - laborCost);
    return { input, revenue, costOfSales, grossMargin, laborCost, deliveryMargin };
  });

  // Allocate the overhead pool across slices by the chosen basis, cent-exact.
  const weights = pre.map((p) => (opts.overheadBasis === "revenue" ? p.revenue : p.laborCost));
  const overheads = allocate(config.overheadPool, weights);

  const slices: SliceResult[] = pre.map((p, index) => {
    const overhead = overheads[index];
    return {
      account: p.input.account,
      serviceLine: p.input.serviceLine,
      ...margins(p.revenue, p.costOfSales, p.grossMargin, p.laborCost, p.deliveryMargin, overhead, opts),
    };
  });

  return {
    slices,
    byAccount: rollupBy(slices, (s) => s.account, opts),
    byServiceLine: rollupBy(slices, (s) => s.serviceLine, opts),
    total: aggregate(slices, opts),
  };
}

// --- month-over-month trend ---------------------------------------------

export interface RollupWithTrend extends Rollup {
  priorNetMargin?: Money;
  netMarginDelta?: Money;
  trend: Trend;
}

export interface ReportWithTrend {
  byAccount: RollupWithTrend[];
  byServiceLine: RollupWithTrend[];
  total: Margins;
}

export function withTrend(current: ProfitabilityReport, prior?: ProfitabilityReport): ReportWithTrend {
  return {
    byAccount: attachTrend(current.byAccount, prior?.byAccount),
    byServiceLine: attachTrend(current.byServiceLine, prior?.byServiceLine),
    total: current.total,
  };
}

function attachTrend(current: Rollup[], prior?: Rollup[]): RollupWithTrend[] {
  const priorByKey = new Map((prior ?? []).map((r) => [r.key, r]));
  return current.map((r) => {
    const previous = priorByKey.get(r.key);
    if (!previous) return { ...r, trend: "new" };
    const delta = roundMoney(r.netMargin - previous.netMargin);
    const trend: Trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    return { ...r, priorNetMargin: previous.netMargin, netMarginDelta: delta, trend };
  });
}

// --- executive summary ---------------------------------------------------

export interface StatusCounts {
  green: number;
  yellow: number;
  red: number;
}

export interface ExecutiveSummary {
  total: Margins;
  accountStatusCounts: StatusCounts;
  serviceLineStatusCounts: StatusCounts;
  bestAccount?: { key: string; netMargin: Money; netMarginPct: number };
  worstAccount?: { key: string; netMargin: Money; netMarginPct: number };
  biggestGain?: { key: string; netMarginDelta: Money };
  biggestDrop?: { key: string; netMarginDelta: Money };
}

// Roll a report (and optional trend) into an at-a-glance executive summary.
export function summarize(report: ProfitabilityReport, trend?: ReportWithTrend): ExecutiveSummary {
  const ranked = [...report.byAccount].sort((a, b) => b.netMargin - a.netMargin);
  const movers = (trend?.byAccount ?? []).filter((r) => r.netMarginDelta !== undefined);
  const byDelta = [...movers].sort((a, b) => (b.netMarginDelta ?? 0) - (a.netMarginDelta ?? 0));
  const gain = byDelta[0];
  const drop = byDelta[byDelta.length - 1];
  return {
    total: report.total,
    accountStatusCounts: countStatuses(report.byAccount),
    serviceLineStatusCounts: countStatuses(report.byServiceLine),
    bestAccount: ranked[0] ? { key: ranked[0].key, netMargin: ranked[0].netMargin, netMarginPct: ranked[0].netMarginPct } : undefined,
    worstAccount: ranked.length ? { key: ranked[ranked.length - 1].key, netMargin: ranked[ranked.length - 1].netMargin, netMarginPct: ranked[ranked.length - 1].netMarginPct } : undefined,
    biggestGain: gain && (gain.netMarginDelta ?? 0) > 0 ? { key: gain.key, netMarginDelta: gain.netMarginDelta ?? 0 } : undefined,
    biggestDrop: drop && (drop.netMarginDelta ?? 0) < 0 ? { key: drop.key, netMarginDelta: drop.netMarginDelta ?? 0 } : undefined,
  };
}

function countStatuses(rollups: Rollup[]): StatusCounts {
  return {
    green: rollups.filter((r) => r.status === "green").length,
    yellow: rollups.filter((r) => r.status === "yellow").length,
    red: rollups.filter((r) => r.status === "red").length,
  };
}

// --- helpers -------------------------------------------------------------

function margins(
  revenue: Money,
  costOfSales: Money,
  grossMargin: Money,
  laborCost: Money,
  deliveryMargin: Money,
  overhead: Money,
  opts: Required<Pick<ProfitabilityConfig, "greenAtOrAbove" | "yellowAtOrAbove">>,
): Margins {
  const netMargin = roundMoney(deliveryMargin - overhead);
  const grossMarginPct = pct(grossMargin, revenue);
  const netMarginPct = pct(netMargin, revenue);
  return {
    revenue,
    costOfSales,
    grossMargin,
    laborCost,
    deliveryMargin,
    overhead,
    netMargin,
    grossMarginPct,
    netMarginPct,
    status: ragStatus(netMarginPct, opts),
  };
}

type Thresholds = { greenAtOrAbove: number; yellowAtOrAbove: number };

function rollupBy(slices: SliceResult[], key: (s: SliceResult) => string, opts: Thresholds): Rollup[] {
  const groups = new Map<string, SliceResult[]>();
  for (const slice of slices) {
    const k = key(slice);
    groups.set(k, [...(groups.get(k) ?? []), slice]);
  }
  return [...groups.entries()].map(([k, group]) => ({ key: k, ...aggregate(group, opts) }));
}

function aggregate(slices: Margins[], opts: Thresholds): Margins {
  const sum = (pick: (m: Margins) => Money) => roundMoney(slices.reduce((acc, m) => acc + pick(m), 0));
  const revenue = sum((m) => m.revenue);
  const grossMargin = sum((m) => m.grossMargin);
  const netMargin = sum((m) => m.netMargin);
  const netMarginPct = pct(netMargin, revenue);
  return {
    revenue,
    costOfSales: sum((m) => m.costOfSales),
    grossMargin,
    laborCost: sum((m) => m.laborCost),
    deliveryMargin: sum((m) => m.deliveryMargin),
    overhead: sum((m) => m.overhead),
    netMargin,
    grossMarginPct: pct(grossMargin, revenue),
    netMarginPct,
    status: ragStatus(netMarginPct, opts),
  };
}

function ragStatus(netMarginPct: number, opts: { greenAtOrAbove: number; yellowAtOrAbove: number }): RagStatus {
  if (netMarginPct >= opts.greenAtOrAbove) return "green";
  if (netMarginPct >= opts.yellowAtOrAbove) return "yellow";
  return "red";
}

// Allocate a total across weights, cent-exact: round each share, then push the
// residual onto the largest-weight slice so the parts sum back to the total.
function allocate(total: Money, weights: number[]): Money[] {
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  if (weights.length === 0) return [];
  if (totalWeight <= 0) {
    // No basis to allocate on: spread evenly, residual on the first slice.
    const each = roundMoney(total / weights.length);
    const parts = weights.map(() => each);
    parts[0] = roundMoney(parts[0] + (total - each * weights.length));
    return parts;
  }
  const parts = weights.map((w) => roundMoney((total * w) / totalWeight));
  const residual = roundMoney(total - parts.reduce((acc, p) => acc + p, 0));
  let maxIndex = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i] > weights[maxIndex]) maxIndex = i;
  parts[maxIndex] = roundMoney(parts[maxIndex] + residual);
  return parts;
}

function pct(part: Money, whole: Money): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 10000) / 10000;
}

export function roundMoney(value: Money): Money {
  return Math.round(value * 100) / 100;
}
