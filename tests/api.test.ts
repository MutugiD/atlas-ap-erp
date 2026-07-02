import { describe, expect, test } from "bun:test";
import { app } from "../apps/api/src/app";

const headers = {
  "content-type": "application/json",
  "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-user-id": "22222222-2222-4222-8222-222222222222",
};

describe("Hono API", () => {
  test("creates, lists, details, reprocesses, and lists events", async () => {
    const create = await app.request("/v1/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({ total: 1200, currency: "USD", poId: "44444444-4444-4444-8444-444444444444" }),
    });
    expect(create.status).toBe(201);
    const created = await create.json();
    const id = created.invoice.id;

    const list = await app.request("/v1/invoices", { headers });
    expect((await list.json()).invoices.some((invoice: { id: string }) => invoice.id === id)).toBe(true);

    const detail = await app.request(`/v1/invoices/${id}`, { headers });
    expect((await detail.json()).invoice.id).toBe(id);

    const reprocess = await app.request(`/v1/invoices/${id}/reprocess`, { method: "POST", headers });
    expect((await reprocess.json()).invoice.status).toBe("queued_for_payment");

    const events = await app.request(`/v1/invoices/${id}/events`, { headers });
    expect((await events.json()).events.length).toBeGreaterThan(0);
  });

  test("keeps tenants isolated in repository-backed routes", async () => {
    const tenantA = headers;
    const tenantB = { ...headers, "x-tenant-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const create = await app.request("/v1/invoices", {
      method: "POST",
      headers: tenantA,
      body: JSON.stringify({ total: 50, currency: "USD" }),
    });
    const id = (await create.json()).invoice.id;
    const fromOtherTenant = await app.request(`/v1/invoices/${id}`, { headers: tenantB });
    expect(fromOtherTenant.status).toBe(404);
  });

  test("webhook accepts email inbound", async () => {
    const response = await app.request("/v1/webhooks/email-inbound", {
      method: "POST",
      headers,
      body: JSON.stringify({ vendorName: "Vendor", invoiceNumber: "EMAIL-1", total: 10 }),
    });
    expect(response.status).toBe(202);
  });
});

