import type { Invoice } from "@atlas/contracts";

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
          <a className="card" href={`/invoices/${invoice.id}`} key={invoice.id}>
            <strong>{invoice.invoiceNumber ?? invoice.id.slice(0, 8)}</strong>
            <p>{invoice.vendorName ?? "Needs review"}</p>
          </a>
        ))}
        {invoices.length === 0 ? <div className="card">No exceptions.</div> : null}
      </section>
    </>
  );
}

