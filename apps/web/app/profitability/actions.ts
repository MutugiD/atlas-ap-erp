"use server";

import { revalidatePath } from "next/cache";

const apiBase = process.env.API_BASE_URL ?? "http://localhost:3001";
const headers = {
  "content-type": "application/json",
  "x-tenant-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-user-id": "22222222-2222-4222-8222-222222222222",
};

export async function addProfitabilityInput(formData: FormData) {
  const body = {
    period: String(formData.get("period") ?? ""),
    account: String(formData.get("account") ?? ""),
    serviceLine: String(formData.get("serviceLine") ?? ""),
    feeRevenue: Number(formData.get("feeRevenue") ?? 0),
    laborHours: Number(formData.get("laborHours") ?? 0),
    laborCostRate: Number(formData.get("laborCostRate") ?? 0),
    mediaSpend: Number(formData.get("mediaSpend") ?? 0),
    mediaMarkupRate: Number(formData.get("mediaMarkupRate") ?? 0),
  };
  await fetch(`${apiBase}/v1/profitability/inputs`, { method: "POST", headers, body: JSON.stringify(body) });
  revalidatePath("/profitability");
}

export async function generateProfitabilityReport(formData: FormData) {
  const prior = String(formData.get("priorPeriod") ?? "").trim();
  const body = {
    period: String(formData.get("period") ?? ""),
    priorPeriod: prior || undefined,
    overheadPool: Number(formData.get("overheadPool") ?? 0),
    overheadBasis: String(formData.get("overheadBasis") ?? "labor"),
  };
  await fetch(`${apiBase}/v1/profitability/reports`, { method: "POST", headers, body: JSON.stringify(body) });
  revalidatePath("/profitability");
}
