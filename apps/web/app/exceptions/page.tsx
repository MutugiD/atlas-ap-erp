import type { Invoice } from "@atlas/contracts";
import { approveInvoice, rejectInvoice } from "../actions";

export default async function ExceptionsPage() {
  let invoices: Invoice[] = [];
  try {
    const response = await fetch(`${process.env.API_BASE_URL ?? "http://localhost:3001"}/v1/exceptions`, {
      headers: { "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      cache: "no-store",
    });
    invoices = (await response.json()).invoices ?? [];
  } catch {
    // Ignore fetch/network errors and render an empty queue.
  }
  return (
    <>
      <h1>Exception Queue</h1>
      <section className="grid">
        {invoices.map((invoice) => (
          <div className="card" key={invoice.id}>
            <a href={`/invoices/${invoice.id}`}><strong>{invoice.invoiceNumber ?? invoice.id.slice(0, 8)}</strong></a>
            <p>{invoice.vendorName ?? "Needs review"} · {invoice.currency} {invoice.total}</p>
            <div style={{ display: "flex", gap: 8 }}>
              <form action={approveInvoice.bind(null, invoice.id)}><button>Approve</button></form>
              <form action={rejectInvoice.bind(null, invoice.id)}><button>Reject</button></form>
            </div>
          </div>
        ))}
        {invoices.length === 0 ? <div className="card">No exceptions.</div> : null}
      </section>
    </>
  );
}

