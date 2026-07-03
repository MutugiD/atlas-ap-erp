import { describe, expect, test } from "bun:test";
import { app } from "../apps/api/src/app";

const headers = {
  "content-type": "application/json",
  "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-c0ffee000001",
  "x-user-id": "22222222-2222-4222-8222-222222222222",
};
const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

const inputs = [
  { period: "2026-06", account: "Acme", serviceLine: "SEO", feeRevenue: 1000, laborHours: 10, laborCostRate: 30, mediaSpend: 500, mediaMarkupRate: 0.2 },
  { period: "2026-06", account: "Acme", serviceLine: "Ads", feeRevenue: 0, laborHours: 5, laborCostRate: 30, mediaSpend: 1000, mediaMarkupRate: 0.15 },
  { period: "2026-06", account: "Beta", serviceLine: "SEO", feeRevenue: 2000, laborHours: 20, laborCostRate: 40, mediaSpend: 0 },
];

describe("Profitability API", () => {
  test("persists inputs and computes a period report that ties out", async () => {
    for (const input of inputs) expect((await post("/v1/profitability/inputs", input)).status).toBe(201);

    const list = await app.request("/v1/profitability/inputs?period=2026-06", { headers });
    expect((await list.json()).inputs).toHaveLength(3);

    const { report } = await (await post("/v1/profitability/compute", { period: "2026-06", overheadPool: 300, overheadBasis: "labor", greenAtOrAbove: 0.2, yellowAtOrAbove: 0.1 })).json();
    expect(report.total.revenue).toBe(4750);
    expect(report.total.netMargin).toBe(1700);
    expect(report.total.status).toBe("green");

    const acme = report.byAccount.find((r: { key: string }) => r.key === "Acme");
    expect(acme.netMargin).toBe(692);
    expect(acme.netMarginPct).toBe(0.2516);
    expect(acme.status).toBe("green");

    const ads = report.byServiceLine.find((r: { key: string }) => r.key === "Ads");
    expect(ads.netMargin).toBe(-36);
    expect(ads.status).toBe("red");
  });

  test("computes month-over-month trend against a prior period", async () => {
    await post("/v1/profitability/inputs", { period: "2026-05", account: "Acme", serviceLine: "SEO", feeRevenue: 5000, laborHours: 1, laborCostRate: 10, mediaSpend: 0 });
    const { trend } = await (await post("/v1/profitability/compute", { period: "2026-06", priorPeriod: "2026-05", overheadPool: 300 })).json();
    expect(trend).not.toBeNull();
    const acme = trend.byAccount.find((r: { key: string }) => r.key === "Acme");
    expect(["up", "down", "flat"]).toContain(acme.trend);
    const beta = trend.byAccount.find((r: { key: string }) => r.key === "Beta");
    expect(beta.trend).toBe("new");
  });

  test("generates, persists, lists, and fetches a report artifact", async () => {
    const gen = await post("/v1/profitability/reports", { period: "2026-06", overheadPool: 300, overheadBasis: "labor", greenAtOrAbove: 0.2, yellowAtOrAbove: 0.1 });
    expect(gen.status).toBe(201);
    const record = (await gen.json()).report;
    expect(record.summary.total.netMargin).toBe(1700);
    expect(record.summary.accountStatusCounts.green).toBe(2);
    expect(record.detail.report.total.netMargin).toBe(1700);

    const list = await (await app.request("/v1/profitability/reports", { headers })).json();
    expect(list.reports.some((r: { id: string }) => r.id === record.id)).toBe(true);

    const fetched = await app.request(`/v1/profitability/reports/${record.id}`, { headers });
    expect((await fetched.json()).report.id).toBe(record.id);
  });
});
