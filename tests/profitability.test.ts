import { describe, expect, test } from "bun:test";
import { computeProfitability, summarize, withTrend, type ProfitabilityInput } from "@atlas/profitability";

const inputs: ProfitabilityInput[] = [
  { account: "Acme", serviceLine: "SEO", feeRevenue: 1000, laborHours: 10, laborCostRate: 30, mediaSpend: 500, mediaMarkupRate: 0.2 },
  { account: "Acme", serviceLine: "Ads", feeRevenue: 0, laborHours: 5, laborCostRate: 30, mediaSpend: 1000, mediaMarkupRate: 0.15 },
  { account: "Beta", serviceLine: "SEO", feeRevenue: 2000, laborHours: 20, laborCostRate: 40, mediaSpend: 0 },
];
const config = { overheadPool: 300, overheadBasis: "labor" as const, greenAtOrAbove: 0.2, yellowAtOrAbove: 0.1 };

describe("Profitability engine", () => {
  test("computes the margin waterfall and ties out to the cent", () => {
    const report = computeProfitability(inputs, config);

    // Slice: Acme / SEO — media marked up 20%, healthy net margin -> green.
    const acmeSeo = report.slices.find((s) => s.account === "Acme" && s.serviceLine === "SEO")!;
    expect(acmeSeo.revenue).toBe(1600); // 1000 fee + 500*1.2 media
    expect(acmeSeo.costOfSales).toBe(500);
    expect(acmeSeo.grossMargin).toBe(1100);
    expect(acmeSeo.laborCost).toBe(300); // 10h * 30
    expect(acmeSeo.deliveryMargin).toBe(800);
    expect(acmeSeo.overhead).toBe(72); // 300 * 300/1250
    expect(acmeSeo.netMargin).toBe(728);
    expect(acmeSeo.status).toBe("green");

    // Slice: Acme / Ads — media-heavy, labor eats delivery -> red.
    const acmeAds = report.slices.find((s) => s.serviceLine === "Ads")!;
    expect(acmeAds.revenue).toBe(1150);
    expect(acmeAds.grossMargin).toBe(150);
    expect(acmeAds.netMargin).toBe(-36); // 0 delivery - 36 overhead
    expect(acmeAds.status).toBe("red");

    // Overhead allocation (by labor) sums back to the pool exactly.
    expect(report.slices.reduce((sum, s) => sum + s.overhead, 0)).toBe(300);

    // Rollup by account.
    const acme = report.byAccount.find((r) => r.key === "Acme")!;
    expect(acme.revenue).toBe(2750);
    expect(acme.netMargin).toBe(692);
    expect(acme.netMarginPct).toBe(0.2516);
    expect(acme.status).toBe("green");

    // Rollup by service line.
    const ads = report.byServiceLine.find((r) => r.key === "Ads")!;
    expect(ads.netMargin).toBe(-36);
    expect(ads.status).toBe("red");

    // Total.
    expect(report.total.revenue).toBe(4750);
    expect(report.total.grossMargin).toBe(3250);
    expect(report.total.netMargin).toBe(1700);
    expect(report.total.netMarginPct).toBe(0.3579);
    expect(report.total.status).toBe("green");
  });

  test("attaches month-over-month trend against a prior report", () => {
    const current = computeProfitability(inputs, config);
    const prior = computeProfitability(
      [{ account: "Acme", serviceLine: "SEO", feeRevenue: 5000, laborHours: 1, laborCostRate: 10, mediaSpend: 0 }],
      config,
    );
    const trend = withTrend(current, prior);

    const acme = trend.byAccount.find((r) => r.key === "Acme")!;
    expect(acme.trend).toBe("down"); // current Acme net margin is lower than the inflated prior
    expect(acme.netMarginDelta).toBe(Math.round((acme.netMargin - acme.priorNetMargin!) * 100) / 100);

    const beta = trend.byAccount.find((r) => r.key === "Beta")!;
    expect(beta.trend).toBe("new"); // Beta not present in the prior report
  });

  test("summarizes a report into an executive summary", () => {
    const report = computeProfitability(inputs, config);
    const summary = summarize(report);
    expect(summary.total.netMargin).toBe(1700);
    expect(summary.accountStatusCounts).toEqual({ green: 2, yellow: 0, red: 0 });
    expect(summary.serviceLineStatusCounts).toEqual({ green: 1, yellow: 0, red: 1 }); // SEO green, Ads red
    expect(summary.bestAccount?.key).toBe("Beta"); // 1008 net margin
    expect(summary.worstAccount?.key).toBe("Acme"); // 692 net margin

    const prior = computeProfitability([{ account: "Acme", serviceLine: "SEO", feeRevenue: 5000, laborHours: 1, laborCostRate: 10, mediaSpend: 0 }], config);
    const withMovers = summarize(report, withTrend(report, prior));
    expect(withMovers.biggestDrop?.key).toBe("Acme"); // fell vs the inflated prior
  });
});
