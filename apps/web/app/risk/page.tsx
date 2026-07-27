import type { Invoice, InvoiceRiskAssessment, Vendor } from "@atlas/contracts";
import { reviewRiskFinding } from "../actions";

const base = process.env.API_BASE_URL ?? "http://localhost:3001";
const headers = { "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "x-user-id": "22222222-2222-4222-8222-222222222222" };
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function load<T>(path: string, key: string): Promise<T[]> {
  try {
    const response = await fetch(`${base}${path}`, { headers, cache: "no-store" });
    return response.ok ? ((await response.json())[key] ?? []) : [];
  } catch { return []; }
}

function valueOf(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function money(invoice: Invoice | undefined) {
  if (!invoice) return "—";
  return new Intl.NumberFormat("en", { style: "currency", currency: invoice.currency }).format(invoice.total);
}
function levelClass(level: InvoiceRiskAssessment["riskLevel"]) { return level === "high" ? "red" : level === "review" ? "yellow" : "green"; }
function statusLabel(status: InvoiceRiskAssessment["reviewStatus"]) { return status === "not_required" ? "No review required" : status.replaceAll("_", " "); }

export default async function RiskPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const level = valueOf(params.level) ?? "all";
  const status = valueOf(params.status) ?? "open";
  const query = (valueOf(params.q) ?? "").trim().toLowerCase();
  const [assessments, invoices, vendors] = await Promise.all([
    load<InvoiceRiskAssessment>("/v1/risk-findings", "findings"),
    load<Invoice>("/v1/invoices", "invoices"),
    load<Vendor>("/v1/vendors", "vendors"),
  ]);
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const vendorById = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const open = assessments.filter((item) => item.reviewStatus === "open");
  const high = open.filter((item) => item.riskLevel === "high");
  const exposureByCurrency = new Map<string, number>();
  open.filter((item) => item.riskLevel !== "low").forEach((item) => {
    const invoice = invoiceById.get(item.invoiceId);
    if (invoice) exposureByCurrency.set(invoice.currency, (exposureByCurrency.get(invoice.currency) ?? 0) + invoice.total);
  });
  const exposureLabel = [...exposureByCurrency.entries()].map(([currency, amount]) => new Intl.NumberFormat("en", { style: "currency", currency, notation: "compact" }).format(amount)).join(" · ") || "—";
  const filtered = assessments.filter((item) => {
    const invoice = invoiceById.get(item.invoiceId);
    const vendor = invoice?.vendorId ? vendorById.get(invoice.vendorId) : undefined;
    const matchesLevel = level === "all" || item.riskLevel === level;
    const matchesStatus = status === "all" || (status === "open" ? item.reviewStatus === "open" : item.reviewStatus !== "open");
    const haystack = `${invoice?.invoiceNumber ?? ""} ${invoice?.vendorName ?? ""} ${vendor?.name ?? ""} ${item.findings.map((finding) => finding.message).join(" ")}`.toLowerCase();
    return matchesLevel && matchesStatus && (!query || haystack.includes(query));
  });

  return <>
    <div className="toolbar workspace-toolbar">
      <div><p className="eyebrow">Accounts payable / payment controls</p><h1>Control review</h1><p>Prioritize invoices that need human review before approval or payment. Signals are explainable controls, not fraud determinations.</p></div>
      <div className="toolbar-actions"><span className="status">Rules-only · {assessments[0]?.ruleVersion ?? "rules-0.1.0"}</span><a className="button-link" href={`${base}/v1/risk-reports?format=csv`} target="_blank" rel="noreferrer">Export report</a></div>
    </div>
    <section className="metric-grid" aria-label="Control review summary">
      <div className="metric-card"><span>Open reviews</span><strong>{open.length}</strong><small>Require reviewer disposition</small></div>
      <div className="metric-card metric-danger"><span>High priority</span><strong>{high.length}</strong><small>Strongest control signals</small></div>
      <div className="metric-card"><span>Amount in review</span><strong>{exposureLabel}</strong><small>Grouped by invoice currency</small></div>
      <div className="metric-card"><span>Reviewed</span><strong>{assessments.filter((item) => item.reviewStatus !== "open").length}</strong><small>Disposition recorded</small></div>
    </section>
    <section className="control-panel"><form className="filter-bar" method="get">
      <label>Find invoice or vendor<input name="q" defaultValue={valueOf(params.q) ?? ""} placeholder="INV-100 or vendor name" /></label>
      <label>Priority<select name="level" defaultValue={level}><option value="all">All priorities</option><option value="high">High</option><option value="review">Review</option><option value="low">Low</option></select></label>
      <label>Queue<select name="status" defaultValue={status}><option value="open">Open review</option><option value="all">All assessments</option><option value="closed">Reviewed</option></select></label>
      <button type="submit">Apply filters</button>
    </form></section>
    <section className="control-panel">
      <div className="section-heading"><div><p className="eyebrow">Work queue</p><h2>Invoices requiring control review</h2></div><span className="muted">{filtered.length} shown</span></div>
      {filtered.length === 0 ? <div className="empty-state"><div className="empty-icon">✓</div><h3>{assessments.length === 0 ? "Your review queue is ready" : "No assessments match these filters"}</h3><p>{assessments.length === 0 ? "Create or reprocess an invoice in the AP inbox, then run its control assessment. The queue will show the invoice, vendor, amount, and controls that need attention." : "Try clearing the filters or return to all assessments."}</p><a className="button-link" href={assessments.length === 0 ? "/" : "/risk?status=all"}>{assessments.length === 0 ? "Open AP inbox" : "Show all assessments"}</a></div> : <div className="table-wrap"><table className="review-table"><thead><tr><th>Invoice</th><th>Vendor</th><th>Amount</th><th>Control result</th><th>Why it is here</th><th>Queue status</th><th /></tr></thead><tbody>
        {filtered.map((item) => { const invoice = invoiceById.get(item.invoiceId); const vendor = invoice?.vendorId ? vendorById.get(invoice.vendorId) : undefined; return <tr key={item.id}>
          <td><a href={`/invoices/${item.invoiceId}`}><strong>{invoice?.invoiceNumber ?? item.invoiceId.slice(0, 8)}</strong></a><small>{invoice?.status ?? "Invoice unavailable"}</small></td>
          <td>{vendor?.name ?? invoice?.vendorName ?? "Unlinked vendor"}<small>{vendor?.holdPayments ? "Payment hold" : invoice?.poId ? "PO linked" : "No PO linked"}</small></td>
          <td><strong>{money(invoice)}</strong><small>{invoice?.currency ?? ""}</small></td>
          <td><span className={`rag rag-${levelClass(item.riskLevel)}`}>{item.riskLevel} · {item.riskScore}/100</span><div className="score-track"><span style={{ width: `${item.riskScore}%` }} /></div></td>
          <td><strong>{item.findings[0]?.message ?? "No control exception"}</strong><small>{item.findings.length > 1 ? `+${item.findings.length - 1} more control${item.findings.length === 2 ? "" : "s"}` : `${item.modelVersion} assessment`}</small></td>
          <td><span className={`queue-status ${item.reviewStatus === "open" ? "queue-open" : "queue-closed"}`}>{statusLabel(item.reviewStatus)}</span>{item.reviewedAt ? <small>{new Date(item.reviewedAt).toLocaleDateString()}</small> : null}</td>
          <td>{item.reviewStatus === "open" ? <div className="row-actions"><form action={reviewRiskFinding.bind(null, item.id, "confirmed_issue")}><button type="submit">Confirm</button></form><form action={reviewRiskFinding.bind(null, item.id, "false_positive")}><button className="button-secondary" type="submit">Dismiss</button></form></div> : <a className="text-link" href={`/invoices/${item.invoiceId}`}>View detail</a>}</td>
        </tr>; })}
      </tbody></table></div>}
    </section>
  </>;
}
