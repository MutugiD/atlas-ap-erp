import type { AgentEvent, Invoice } from "@atlas/contracts";
import { approveInvoice, rejectInvoice, reprocessInvoice } from "../../actions";

type Finding = { code: string; severity: "error" | "warning"; message: string };
type Validation = { ok: boolean; findings: Finding[] };

async function loadInvoice(id: string): Promise<{ invoice?: Invoice; events: AgentEvent[]; validation?: Validation }> {
  try {
    const base = process.env.API_BASE_URL ?? "http://localhost:3001";
    const headers = { "content-type": "application/json", "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const [detail, events, validate] = await Promise.all([
      fetch(`${base}/v1/invoices/${id}`, { headers, cache: "no-store" }),
      fetch(`${base}/v1/invoices/${id}/events`, { headers, cache: "no-store" }),
      fetch(`${base}/v1/invoices/${id}/validate`, { method: "POST", headers, cache: "no-store" }),
    ]);
    return {
      invoice: (await detail.json()).invoice,
      events: (await events.json()).events ?? [],
      validation: validate.ok ? (await validate.json()).validation : undefined,
    };
  } catch {
    return { events: [] };
  }
}

function confidenceOf(output: unknown): string {
  return output && typeof output === "object" && "confidence" in output ? ` · confidence ${(output as { confidence: number }).confidence}` : "";
}

export default async function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { invoice, events, validation } = await loadInvoice(id);
  if (!invoice) return <div className="card">Invoice not found.</div>;
  return (
    <>
      <div className="toolbar">
        <div>
          <h1>{invoice.invoiceNumber ?? invoice.id.slice(0, 8)}</h1>
          <p>{invoice.vendorName ?? "Pending extraction"} · {invoice.currency} {invoice.total}</p>
        </div>
        <span className="status">{invoice.status}</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <form action={reprocessInvoice.bind(null, invoice.id)}><button>Reprocess</button></form>
        <form action={approveInvoice.bind(null, invoice.id)}><button>Approve</button></form>
        <form action={rejectInvoice.bind(null, invoice.id)}><button>Reject</button></form>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          Validation{" "}
          {validation ? (
            <span className={`rag rag-${validation.ok ? "green" : "red"}`}>{validation.ok ? "legit" : "flagged"}</span>
          ) : (
            <span className="status">unavailable</span>
          )}
        </h2>
        {validation && validation.findings.length === 0 ? <p>No issues — vendor, arithmetic, duplicates and period all pass.</p> : null}
        {validation ? (
          <ul>
            {validation.findings.map((f) => (
              <li key={f.code}>
                <span className={`rag rag-${f.severity === "error" ? "red" : "yellow"}`}>{f.severity}</span> <strong>{f.code}</strong> — {f.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <h2 style={{ marginTop: 24 }}>Lineage (agent trace)</h2>
      <section className="grid">
        {events.length === 0 ? <div className="card">No agent events yet — reprocess to run the pipeline.</div> : null}
        {events.map((event) => (
          <div className="card" key={event.id}>
            <strong>{event.agent}</strong>
            <p>{event.actor} · {new Date(event.createdAt).toLocaleString()}{confidenceOf(event.output)}</p>
          </div>
        ))}
      </section>
    </>
  );
}

