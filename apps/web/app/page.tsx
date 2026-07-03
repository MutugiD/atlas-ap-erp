import type { Invoice, Vendor } from "@atlas/contracts";
import { createInvoice, createVendor } from "./actions";

const base = process.env.API_BASE_URL ?? "http://localhost:3001";
const headers = { "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

async function loadList<T>(path: string, key: string): Promise<T[]> {
  try {
    const response = await fetch(`${base}${path}`, { headers, cache: "no-store" });
    return (await response.json())[key] ?? [];
  } catch {
    return [];
  }
}

export default async function InboxPage() {
  const [invoices, vendors] = await Promise.all([
    loadList<Invoice>("/v1/invoices", "invoices"),
    loadList<Vendor>("/v1/vendors", "vendors"),
  ]);
  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Invoice Inbox</h1>
          <p>Tenant-scoped AP work queue.</p>
        </div>
        <span className="status">{invoices.length} invoices</span>
      </div>
      <section className="grid" style={{ marginBottom: 16 }}>
        <form className="card" action={createVendor}>
          <h3>Add vendor</h3>
          <label>Name<input name="name" defaultValue="Nairobi Office Supplies" /></label>
          <label>Currency<input name="currency" defaultValue="USD" maxLength={3} /></label>
          <label>Tax ID<input name="taxId" defaultValue="KE-123" /></label>
          <button type="submit">Add vendor</button>
        </form>

        <form className="card" action={createInvoice}>
          <h3>Drop an invoice</h3>
          <p style={{ marginTop: 0, color: "#5b6577", fontSize: 13 }}>
            Link a vendor to clear &quot;vendor_missing&quot;; subtotal + tax must equal total.
          </p>
          <label>Vendor (from master)
            <select name="vendorId" defaultValue="">
              <option value="">— none (flags vendor_missing) —</option>
              {vendors.map((v) => (
                <option value={v.id} key={v.id}>{v.name} ({v.currency})</option>
              ))}
            </select>
          </label>
          <label>Vendor name (display)<input name="vendorName" defaultValue="Nairobi Office Supplies" /></label>
          <div className="grid">
            <label>Invoice #<input name="invoiceNumber" defaultValue="INV-100" /></label>
            <label>Currency<input name="currency" defaultValue="USD" maxLength={3} /></label>
            <label>Subtotal<input name="subtotal" type="number" step="0.01" defaultValue="1000" /></label>
            <label>Tax<input name="tax" type="number" step="0.01" defaultValue="160" /></label>
            <label>Total<input name="total" type="number" step="0.01" defaultValue="1160" /></label>
          </div>
          <button type="submit">Create invoice</button>
        </form>
      </section>
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

