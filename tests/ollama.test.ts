import { describe, expect, test } from "bun:test";
import { OllamaAgentProvider } from "@atlas/agents";
import type { GlCodingProposal, Invoice, InvoiceDraft } from "@atlas/contracts";

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

const draft: InvoiceDraft = {
  vendorName: "Nairobi Office Supplies",
  invoiceNumber: "INV-OLLAMA",
  invoiceDate: "2026-07-03",
  currency: "USD",
  subtotal: 1000,
  tax: 160,
  total: 1160,
  lines: [{ description: "Office supplies", quantity: 1, unitPrice: 1000, total: 1000 }],
  fieldConfidence: {},
  confidence: 0.9,
};

function fetchReturning(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ message: { content } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

// Records the request URL + parsed model per call and replies with `content`
// shaped for the given API style.
function capturingFetch(content: string, style: "ollama" | "openai" = "ollama") {
  const calls: Array<{ url: string; model: string }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    calls.push({ url: String(url), model: body.model });
    const payload =
      style === "openai" ? { choices: [{ message: { content } }] } : { message: { content } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("Ollama agent provider — extraction", () => {
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
    const result = await provider.extract(invoice);
    expect(result.vendorName).toBe("Nairobi Office Supplies");
    expect(result.subtotal + result.tax).toBe(result.total);
    expect(result.confidence).toBe(0.92);
  });

  test("extracts from a fenced JSON response, ignoring null/empty fields", async () => {
    const fenced = "```json\n{\n \"vendorName\": \"Fenced Co\",\n \"invoiceNumber\": \"INV-9\",\n \"invoiceDate\": null,\n \"currency\": \"USD\",\n \"subtotal\": 1160,\n \"tax\": 0,\n \"total\": 1160,\n \"lines\": [],\n \"confidence\": 0.42\n}\n```";
    const provider = new OllamaAgentProvider({ fetchImpl: fetchReturning(fenced) });
    const result = await provider.extract(invoice);
    expect(result.vendorName).toBe("Fenced Co"); // model value used despite the ```json fence
    expect(result.confidence).toBe(0.42); // model value used, not the deterministic fallback
    expect(result.lines.length).toBeGreaterThan(0); // default kept because the model returned []
    expect(typeof result.invoiceDate).toBe("string"); // default kept because the model returned null
  });

  test("falls back to deterministic extraction when the model errors", async () => {
    const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const provider = new OllamaAgentProvider({ fetchImpl: failing });
    const result = await provider.extract(invoice);
    // Still a valid draft (from the local fallback), not a thrown error.
    expect(result.total).toBe(1160);
    expect(result.lines.length).toBeGreaterThan(0);
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

describe("Ollama agent provider — tiered model routing", () => {
  test("extract hits /api/chat on the complex tier model", async () => {
    const modelJson = JSON.stringify({ ...draft, confidence: 0.9 });
    const { impl, calls } = capturingFetch(modelJson);
    const provider = new OllamaAgentProvider({
      fetchImpl: impl,
      models: { complex: "glm-5.2:cloud", standard: "glm-5.1:cloud", simple: "gemini-3-flash-preview:latest" },
    });
    await provider.extract(invoice);
    expect(calls[0].url).toContain("/api/chat");
    expect(calls[0].model).toBe("glm-5.2:cloud");
  });

  test("code runs on the standard tier and uses a balanced proposal", async () => {
    const proposal = JSON.stringify({
      balanced: true,
      splits: [{ glAccount: "6200", costCenter: "MKT", amount: 1160 }],
      confidence: 0.88,
    });
    const { impl, calls } = capturingFetch(proposal);
    const provider = new OllamaAgentProvider({ fetchImpl: impl, models: { standard: "glm-5.1:cloud" } });
    const result = await provider.code(invoice, draft);
    expect(calls[0].model).toBe("glm-5.1:cloud");
    expect(result.splits[0].glAccount).toBe("6200"); // model proposal used
  });

  test("code falls back to deterministic when splits do not reconcile to the total", async () => {
    const unbalanced = JSON.stringify({
      balanced: true,
      splits: [{ glAccount: "6200", costCenter: "MKT", amount: 5 }], // != 1160
      confidence: 0.9,
    });
    const provider = new OllamaAgentProvider({ fetchImpl: fetchReturning(unbalanced) });
    const result = await provider.code(invoice, draft);
    expect(result.splits[0].glAccount).toBe("6100"); // deterministic 6100/OPS split
    expect(result.splits[0].amount).toBe(1160);
  });

  test("code falls back to deterministic on unparseable output", async () => {
    const provider = new OllamaAgentProvider({ fetchImpl: fetchReturning("not json at all") });
    const result = await provider.code(invoice, draft);
    expect(result.splits[0].glAccount).toBe("6100");
  });

  test("route runs on the simple tier and grafts deterministic approver UUIDs", async () => {
    const coding: GlCodingProposal = { balanced: true, splits: [{ glAccount: "6100", costCenter: "OPS", amount: 5000 }], confidence: 0.9 };
    const bigInvoice: Invoice = { ...invoice, total: 5000 }; // over the $1500 auto-approve limit
    const judgment = JSON.stringify({ autoApproved: false, reason: "Large spend needs a human", confidence: 0.8 });
    const { impl, calls } = capturingFetch(judgment);
    const provider = new OllamaAgentProvider({ fetchImpl: impl, models: { simple: "gemini-3-flash-preview:latest" } });
    const result = await provider.route(bigInvoice, coding);
    expect(calls[0].model).toBe("gemini-3-flash-preview:latest");
    expect(result.autoApproved).toBe(false);
    expect(result.reason).toBe("Large spend needs a human"); // LLM rationale kept
    expect(result.approvers.length).toBeGreaterThan(0); // deterministic, schema-valid UUID grafted in
    expect(result.approvers[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("route auto-approval yields no approvers", async () => {
    const coding: GlCodingProposal = { balanced: true, splits: [{ glAccount: "6100", costCenter: "OPS", amount: 1160 }], confidence: 0.9 };
    const judgment = JSON.stringify({ autoApproved: true, reason: "Small and in tolerance", confidence: 0.95 });
    const provider = new OllamaAgentProvider({ fetchImpl: fetchReturning(judgment) });
    const result = await provider.route(invoice, coding);
    expect(result.autoApproved).toBe(true);
    expect(result.approvers).toEqual([]);
  });
});

describe("Ollama agent provider — endpoint styles and gating", () => {
  test("openai apiStyle hits /v1/chat/completions and parses choices[]", async () => {
    const modelJson = JSON.stringify({ ...draft, confidence: 0.77 });
    const { impl, calls } = capturingFetch(modelJson, "openai");
    const provider = new OllamaAgentProvider({ fetchImpl: impl, apiStyle: "openai", models: { complex: "local-gguf" } });
    const result = await provider.extract(invoice);
    expect(calls[0].url).toContain("/v1/chat/completions");
    expect(calls[0].model).toBe("local-gguf");
    expect(result.confidence).toBe(0.77);
  });

  test("validate and match never call the LLM (deterministic)", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response(JSON.stringify({ message: { content: "{}" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OllamaAgentProvider({ fetchImpl: spy });
    await provider.validate(invoice, draft, []);
    await provider.match(invoice, draft);
    expect(called).toBe(false);
  });

  test("a task excluded from llmTasks runs deterministically", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response(JSON.stringify({ message: { content: "{}" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OllamaAgentProvider({ fetchImpl: spy, llmTasks: ["extract", "route"] });
    const result = await provider.code(invoice, draft);
    expect(called).toBe(false); // code excluded -> no LLM call
    expect(result.splits[0].glAccount).toBe("6100");
  });
});
