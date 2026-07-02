import type { AgentEvent, Invoice } from "@atlas/contracts";
import { approveInvoice, rejectInvoice, reprocessInvoice } from "../../actions";

async function loadInvoice(id: string): Promise<{ invoice?: Invoice; events: AgentEvent[] }> {
  try {
    const base = process.env.API_BASE_URL ?? "http://localhost:3001";
    const headers = { "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const [detail, events] = await Promise.all([
      fetch(`${base}/v1/invoices/${id}`, { headers, cache: "no-store" }),
      fetch(`${base}/v1/invoices/${id}/events`, { headers, cache: "no-store" }),
    ]);
    return { invoice: (await detail.json()).invoice, events: (await events.json()).events ?? [] };
  } catch {
    return { events: [] };
  }
}

export default async function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { invoice, events } = await loadInvoice(id);
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
      <form action={reprocessInvoice.bind(null, invoice.id)}>
        <button>Reprocess</button>
      </form>
      <form action={approveInvoice.bind(null, invoice.id)}>
        <button>Approve</button>
      </form>
      <form action={rejectInvoice.bind(null, invoice.id)}>
        <button>Reject</button>
      </form>
      <h2>Agent Trace</h2>
      <section className="grid">
        {events.map((event) => (
          <div className="card" key={event.id}>
            <strong>{event.agent}</strong>
            <p>{event.actor} · {event.createdAt}</p>
          </div>
        ))}
      </section>
    </>
  );
}

