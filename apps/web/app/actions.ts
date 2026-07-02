"use server";

const apiBase = process.env.API_BASE_URL ?? "http://localhost:3001";
const headers = {
  "content-type": "application/json",
  "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-user-id": "22222222-2222-4222-8222-222222222222",
};

export async function approveInvoice(id: string) {
  await fetch(`${apiBase}/v1/invoices/${id}/approve`, { method: "POST", headers });
}

export async function rejectInvoice(id: string) {
  await fetch(`${apiBase}/v1/invoices/${id}/reject`, { method: "POST", headers });
}

export async function reprocessInvoice(id: string) {
  await fetch(`${apiBase}/v1/invoices/${id}/reprocess`, { method: "POST", headers });
}

