import type { ProfitabilityReportRecord } from "@atlas/contracts";
import type { ExecutiveSummary, ProfitabilityReport, ReportWithTrend, Rollup } from "@atlas/profitability";
import { addProfitabilityInput, generateProfitabilityReport } from "./actions";

const apiBase = process.env.API_BASE_URL ?? "http://localhost:3001";
const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function loadReports(): Promise<ProfitabilityReportRecord[]> {
  try {
    const response = await fetch(`${apiBase}/v1/profitability/reports`, { headers: { "x-tenant-id": tenant }, cache: "no-store" });
    return (await response.json()).reports ?? [];
  } catch {
    return [];
  }
}

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
const arrow = (t?: string) => (t === "up" ? "▲" : t === "down" ? "▼" : t === "new" ? "＋" : "▬");

type TrendRollup = Rollup & { trend?: string; netMarginDelta?: number };

function RollupTable({ title, rows, trend }: { title: string; rows: Rollup[]; trend?: TrendRollup[] }) {
  const trendByKey = new Map((trend ?? []).map((r) => [r.key, r]));
  return (
    <div className="card">
      <h3>{title}</h3>
      <table className="ptable">
        <thead>
          <tr><th>Name</th><th>Revenue</th><th>Gross</th><th>Net</th><th>Net %</th><th>Status</th><th>MoM</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const t = trendByKey.get(r.key);
            return (
              <tr key={r.key}>
                <td>{r.key}</td>
                <td>{money(r.revenue)}</td>
                <td>{money(r.grossMargin)}</td>
                <td>{money(r.netMargin)}</td>
                <td>{percent(r.netMarginPct)}</td>
                <td><span className={`rag rag-${r.status}`}>{r.status}</span></td>
                <td>{t ? `${arrow(t.trend)} ${t.netMarginDelta !== undefined ? money(t.netMarginDelta) : ""}`.trim() : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function ProfitabilityPage() {
  const reports = await loadReports();
  const latest = reports[0];
  const summary = latest?.summary as ExecutiveSummary | undefined;
  const detail = latest?.detail as { report: ProfitabilityReport; trend: ReportWithTrend | null } | undefined;

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Profitability</h1>
          <p>Agency P&amp;L by account and service line, with RAG status and month-over-month trend.</p>
        </div>
        <span className="status">{reports.length} reports</span>
      </div>

      <section className="grid">
        <form className="card" action={addProfitabilityInput}>
          <h3>Add input</h3>
          <label>Period<input name="period" defaultValue="2026-06" /></label>
          <label>Account<input name="account" defaultValue="Acme" /></label>
          <label>Service line<input name="serviceLine" defaultValue="SEO" /></label>
          <label>Fee revenue<input name="feeRevenue" type="number" step="0.01" defaultValue="1000" /></label>
          <label>Labor hours<input name="laborHours" type="number" step="0.01" defaultValue="10" /></label>
          <label>Labor cost rate<input name="laborCostRate" type="number" step="0.01" defaultValue="30" /></label>
          <label>Media spend<input name="mediaSpend" type="number" step="0.01" defaultValue="500" /></label>
          <label>Media markup<input name="mediaMarkupRate" type="number" step="0.01" defaultValue="0.2" /></label>
          <button type="submit">Add input</button>
        </form>

        <form className="card" action={generateProfitabilityReport}>
          <h3>Generate report</h3>
          <label>Period<input name="period" defaultValue="2026-06" /></label>
          <label>Prior period (optional)<input name="priorPeriod" placeholder="2026-05" /></label>
          <label>Overhead pool<input name="overheadPool" type="number" step="0.01" defaultValue="300" /></label>
          <label>Overhead basis
            <select name="overheadBasis" defaultValue="labor"><option value="labor">labor</option><option value="revenue">revenue</option></select>
          </label>
          <button type="submit">Generate report</button>
        </form>
      </section>

      {summary && detail ? (
        <>
          <h2 style={{ marginTop: 28 }}>
            Latest report — {latest.period}
            {latest.priorPeriod ? ` (vs ${latest.priorPeriod})` : ""}
          </h2>
          <section className="grid">
            <div className="card"><div className="metric">{money(summary.total.revenue)}</div><span>Revenue</span></div>
            <div className="card"><div className="metric">{money(summary.total.grossMargin)}</div><span>Gross margin</span></div>
            <div className="card"><div className="metric">{money(summary.total.netMargin)}</div><span>Net margin ({percent(summary.total.netMarginPct)})</span></div>
            <div className="card">
              <div className="metric"><span className={`rag rag-${summary.total.status}`}>{summary.total.status}</span></div>
              <span>
                Accounts: {summary.accountStatusCounts.green}🟢 {summary.accountStatusCounts.yellow}🟡 {summary.accountStatusCounts.red}🔴
              </span>
            </div>
          </section>
          <section className="grid" style={{ marginTop: 14 }}>
            <RollupTable title="By account" rows={detail.report.byAccount} trend={detail.trend?.byAccount} />
            <RollupTable title="By service line" rows={detail.report.byServiceLine} trend={detail.trend?.byServiceLine} />
          </section>
        </>
      ) : (
        <div className="card" style={{ marginTop: 20 }}>No reports yet. Add a few inputs for a period, then Generate report.</div>
      )}
    </>
  );
}
