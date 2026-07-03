import { describe, expect, test } from "bun:test";
import { OllamaAgentProvider } from "@atlas/agents";
import type { Invoice } from "@atlas/contracts";

const invoice: Invoice = {
  id: "99999999-9999-4999-8999-999999999999",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "received",
  vendorName: "Nairobi Office Supplies",
  invoiceNumber: "INV-OLLAMA",
  total: 1160,
  currency: "USD",
  createdAt: new Date("2026-07-03T00:00:00Z").toISOString(),
  updatedAt: new Date("2026-07-03T00:00:00Z").toISOString(),
};

function fetchReturning(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ message: { content } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("Ollama agent provider", () => {
  test("extracts an invoice draft from the model's JSON response", async () => {
    const modelJson = JSON.stringify({
      vendorName: "Nairobi Office Supplies",
      invoiceNumber: "INV-OLLAMA",
      invoiceDate: "2026-07-03",
      currency: "USD",
      subtotal: 1000,
      tax: 160,
      total: 1160,
      lines: [{ description: "Office supplies", quantity: 1, unitPrice: 1000, total: 1000 }],
      confidence: 0.92,
    });
    const provider = new OllamaAgentProvider({ fetchImpl: fetchReturning(modelJson) });
    const draft = await provider.extract(invoice);
    expect(draft.vendorName).toBe("Nairobi Office Supplies");
    expect(draft.subtotal + draft.tax).toBe(draft.total);
    expect(draft.confidence).toBe(0.92);
  });

  test("extracts from a fenced JSON response, ignoring null/empty fields", async () => {
    const fenced = "```json\n{\n \"vendorName\": \"Fenced Co\",\n \"invoiceNumber\": \"INV-9\",\n \"invoiceDate\": null,\n \"currency\": \"USD\",\n \"subtotal\": 1160,\n \"tax\": 0,\n \"total\": 1160,\n \"lines\": [],\n \"confidence\": 0.42\n}\n```";
    const provider = new OllamaAgentProvider({ fetchImpl: fetchReturning(fenced) });
    const draft = await provider.extract(invoice);
    expect(draft.vendorName).toBe("Fenced Co"); // model value used despite the ```json fence
    expect(draft.confidence).toBe(0.42); // model value used, not the deterministic fallback
    expect(draft.lines.length).toBeGreaterThan(0); // default kept because the model returned []
    expect(typeof draft.invoiceDate).toBe("string"); // default kept because the model returned null
  });

  test("falls back to deterministic extraction when the model errors", async () => {
    const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const provider = new OllamaAgentProvider({ fetchImpl: failing });
    const draft = await provider.extract(invoice);
    // Still a valid draft (from the local fallback), not a thrown error.
    expect(draft.total).toBe(1160);
    expect(draft.lines.length).toBeGreaterThan(0);
  });

  test("sends the Authorization header when an API key is configured", async () => {
    const captured: { auth: string | null } = { auth: null };
    const capturing = (async (_url: string, init: RequestInit) => {
      captured.auth = new Headers(init.headers).get("authorization");
      return new Response(JSON.stringify({ message: { content: "{}" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OllamaAgentProvider({ fetchImpl: capturing, apiKey: "secret-key" });
    await provider.extract(invoice);
    expect(captured.auth).toBe("Bearer secret-key");
  });
});
