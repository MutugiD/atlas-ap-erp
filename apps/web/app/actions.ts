"use server";

import { revalidatePath } from "next/cache";

const apiBase = process.env.API_BASE_URL ?? "http://localhost:3001";
const headers = {
  "content-type": "application/json",
  "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-user-id": "22222222-2222-4222-8222-222222222222",
};

export async function createInvoice(formData: FormData) {
  const num = (key: string) => (formData.get(key) ? Number(formData.get(key)) : undefined);
  const body = {
    vendorName: String(formData.get("vendorName") ?? "") || undefined,
    vendorId: String(formData.get("vendorId") ?? "").trim() || undefined,
    invoiceNumber: String(formData.get("invoiceNumber") ?? "") || undefined,
    total: Number(formData.get("total") ?? 0),
    currency: String(formData.get("currency") ?? "USD") || "USD",
    subtotal: num("subtotal"),
    tax: num("tax"),
  };
  await fetch(`${apiBase}/v1/invoices`, { method: "POST", headers, body: JSON.stringify(body) });
  revalidatePath("/");
}

export async function createVendor(formData: FormData) {
  const body = {
    name: String(formData.get("name") ?? "").trim(),
    currency: String(formData.get("currency") ?? "USD") || "USD",
    taxId: String(formData.get("taxId") ?? "").trim() || undefined,
  };
  await fetch(`${apiBase}/v1/vendors`, { method: "POST", headers, body: JSON.stringify(body) });
  revalidatePath("/", "layout");
}

export async function approveInvoice(id: string) {
  await fetch(`${apiBase}/v1/invoices/${id}/approve`, { method: "POST", headers });
  revalidatePath("/", "layout");
}

export async function rejectInvoice(id: string) {
  await fetch(`${apiBase}/v1/invoices/${id}/reject`, { method: "POST", headers });
  revalidatePath("/", "layout");
}

export async function reprocessInvoice(id: string) {
  await fetch(`${apiBase}/v1/invoices/${id}/reprocess`, { method: "POST", headers });
  revalidatePath("/", "layout");
}

