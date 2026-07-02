import type { Invoice } from "@atlas/contracts";

async function loadInvoices(): Promise<Invoice[]> {
  try {
    const response = await fetch(`${process.env.API_BASE_URL ?? "http://localhost:3001"}/v1/invoices`, {
      headers: { "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      cache: "no-store",
    });
    const data = await response.json();
    return data.invoices ?? [];
  } catch {
    return [];
  }
}

export default async function InboxPage() {
  const invoices = await loadInvoices();
  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Invoice Inbox</h1>
          <p>Tenant-scoped AP work queue.</p>
        </div>
        <span className="status">{invoices.length} invoices</span>
      </div>
      <section className="grid">
        {invoices.map((invoice) => (
          <a className="card" href={`/invoices/${invoice.id}`} key={invoice.id}>
            <strong>{invoice.invoiceNumber ?? invoice.id.slice(0, 8)}</strong>
            <p>{invoice.vendorName ?? "Pending extraction"}</p>
            <span className="status">{invoice.status}</span>
          </a>
        ))}
        {invoices.length === 0 ? <div className="card">No invoices yet. Create one through the API.</div> : null}
      </section>
    </>
  );
}

