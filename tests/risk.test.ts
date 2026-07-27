import { describe, expect, test } from "bun:test";
import { app } from "../apps/api/src/app";

const headers = {
  "content-type": "application/json",
  "x-tenant-id": "99999999-9999-4999-8999-999999999999",
  "x-user-id": "22222222-2222-4222-8222-222222222222",
};

describe("invoice risk controls", () => {
  test("scores arithmetic and duplicate invoice risks with explanations", async () => {
    const vendor = (await (await app.request("/v1/vendors", { method: "POST", headers, body: JSON.stringify({ name: "Risk Vendor", currency: "USD" }) })).json()).vendor;
    const first = (await (await app.request("/v1/invoices", { method: "POST", headers, body: JSON.stringify({ vendorId: vendor.id, vendorName: vendor.name, invoiceNumber: "RISK-1", total: 1160, currency: "USD", subtotal: 1000, tax: 160 }) })).json()).invoice;
    const second = (await (await app.request("/v1/invoices", { method: "POST", headers, body: JSON.stringify({ vendorId: vendor.id, vendorName: vendor.name, invoiceNumber: "RISK-1", total: 1200, currency: "USD", subtotal: 1000, tax: 160 }) })).json()).invoice;
    const response = await app.request(`/v1/invoices/${second.id}/risk-assessment`, { method: "POST", headers });
    expect(response.status).toBe(200);
    const risk = (await response.json()).risk;
    expect(risk.riskLevel).toBe("high");
    expect(risk.findings.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining(["duplicate_invoice", "arithmetic_mismatch"]));
    expect((await (await app.request(`/v1/invoices/${first.id}/risk-findings`, { headers })).json()).findings).toHaveLength(0);
  });

  test("lists, reviews, and exports tenant-scoped findings", async () => {
    const invoice = (await (await app.request("/v1/invoices", { method: "POST", headers, body: JSON.stringify({ vendorName: "Unlinked Vendor", invoiceNumber: "RISK-2", total: 100, currency: "USD" }) })).json()).invoice;
    const assessment = (await (await app.request(`/v1/invoices/${invoice.id}/risk-assessment`, { method: "POST", headers })).json()).risk;
    const reviewed = await app.request(`/v1/risk-findings/${assessment.id}/review`, { method: "POST", headers, body: JSON.stringify({ status: "false_positive" }) });
    expect((await reviewed.json()).finding.reviewStatus).toBe("false_positive");
    const report = await app.request("/v1/risk-reports", { method: "POST", headers: { ...headers, accept: "text/csv" } });
    expect(report.headers.get("content-type")).toContain("text/csv");
    expect(await report.text()).toContain("Risk level");
  });
});
