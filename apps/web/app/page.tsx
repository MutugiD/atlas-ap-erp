import type { Invoice } from "@atlas/contracts";
import { createInvoice } from "./actions";

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
      <form className="card" action={createInvoice} style={{ marginBottom: 16 }}>
        <h3>Drop an invoice</h3>
        <p style={{ marginTop: 0, color: "#5b6577", fontSize: 13 }}>
          Enter subtotal + tax and they&apos;ll be checked on the invoice page (subtotal + tax must equal total).
        </p>
        <div className="grid">
          <label>Vendor<input name="vendorName" defaultValue="Nairobi Office Supplies" /></label>
          <label>Vendor ID (optional — link to vendor master)<input name="vendorId" placeholder="uuid from /v1/vendors" /></label>
          <label>Invoice #<input name="invoiceNumber" defaultValue="INV-100" /></label>
          <label>Currency<input name="currency" defaultValue="USD" maxLength={3} /></label>
          <label>Subtotal<input name="subtotal" type="number" step="0.01" defaultValue="1000" /></label>
          <label>Tax<input name="tax" type="number" step="0.01" defaultValue="160" /></label>
          <label>Total<input name="total" type="number" step="0.01" defaultValue="1160" /></label>
        </div>
        <button type="submit">Create invoice</button>
      </form>
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

