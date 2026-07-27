import type { InvoiceRiskAssessment } from "@atlas/contracts";
import { reviewRiskFinding } from "../actions";

const base = process.env.API_BASE_URL ?? "http://localhost:3001";
const headers = { "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "x-user-id": "22222222-2222-4222-8222-222222222222" };

export default async function RiskPage() {
  let findings: InvoiceRiskAssessment[] = [];
  try { findings = (await (await fetch(`${base}/v1/risk-findings`, { headers, cache: "no-store" })).json()).findings ?? []; } catch { /* render empty state */ }
  return <>
    <div className="toolbar"><div><h1>Invoice Risk</h1><p>Auditable risk signals for AP review. A finding is not a fraud determination.</p></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="status">{findings.length} assessments</span><a className="button-link" href={`${base}/v1/risk-reports?format=csv`} target="_blank" rel="noreferrer">Export CSV</a></div></div>
    <section className="grid">
      {findings.map((item) => <div className="card" key={item.id}><a href={`/invoices/${item.invoiceId}`}><strong>{item.invoiceId.slice(0, 8)}</strong></a><p><span className={`rag rag-${item.riskLevel === "high" ? "red" : item.riskLevel === "review" ? "yellow" : "green"}`}>{item.riskLevel} · {item.riskScore}/100</span></p><ul>{item.findings.map((f) => <li key={f.id}>{f.message}</li>)}</ul>{item.reviewStatus === "open" ? <div style={{ display: "flex", gap: 8 }}><form action={reviewRiskFinding.bind(null, item.id, "confirmed_issue")}><button>Confirm issue</button></form><form action={reviewRiskFinding.bind(null, item.id, "false_positive")}><button>False positive</button></form></div> : <p>Reviewed: {item.reviewStatus}</p>}</div>)}
      {findings.length === 0 ? <div className="card">No risk assessments yet. Assess an invoice from its detail page.</div> : null}
    </section>
  </>;
}
