import {
  invoiceDraftSchema,
  type ApprovalRoute,
  type GlCodingProposal,
  type Invoice,
  type InvoiceDraft,
  type MatchResult,
  type ValidationResult,
} from "@atlas/contracts";
import { LocalAgentProvider, type AgentProvider } from "./local-provider";

type FetchImpl = typeof fetch;

export interface OllamaAgentProviderOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  fetchImpl?: FetchImpl;
  fallback?: AgentProvider;
}

// Uses an Ollama model for the LLM-suited extraction step (structured JSON), and
// delegates the deterministic validate/match/code/route business rules to the
// local provider. Extraction degrades gracefully to the local provider if the
// model is unreachable or returns something the draft schema rejects.
export class OllamaAgentProvider implements AgentProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchImpl;
  private readonly fallback: AgentProvider;

  constructor(options: OllamaAgentProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = options.model ?? process.env.OLLAMA_MODEL ?? "llama3.1";
    this.apiKey = options.apiKey ?? process.env.OLLAMA_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallback = options.fallback ?? new LocalAgentProvider();
  }

  async extract(invoice: Invoice): Promise<InvoiceDraft> {
    try {
      const content = await this.chat(EXTRACT_SYSTEM_PROMPT, extractUserPrompt(invoice));
      const raw = JSON.parse(content) as Record<string, unknown>;
      return invoiceDraftSchema.parse({ ...draftDefaults(invoice), ...raw });
    } catch {
      // Any transport/parse/validation failure falls back to deterministic extraction.
      return this.fallback.extract(invoice);
    }
  }

  validate(invoice: Invoice, draft: InvoiceDraft, existingNumbers: string[]): Promise<ValidationResult> {
    return this.fallback.validate(invoice, draft, existingNumbers);
  }

  match(invoice: Invoice, draft: InvoiceDraft): Promise<MatchResult> {
    return this.fallback.match(invoice, draft);
  }

  code(invoice: Invoice, draft: InvoiceDraft): Promise<GlCodingProposal> {
    return this.fallback.code(invoice, draft);
  }

  route(invoice: Invoice, coding: GlCodingProposal): Promise<ApprovalRoute> {
    return this.fallback.route(invoice, coding);
  }

  private async chat(system: string, user: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        format: "json",
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }
}

const EXTRACT_SYSTEM_PROMPT =
  "You extract accounts-payable invoice fields. Return ONLY a JSON object with keys: " +
  "vendorName, invoiceNumber, invoiceDate (YYYY-MM-DD), poNumber (optional), currency (3-letter), " +
  "subtotal, tax, total (numbers), lines (array of {description, quantity, unitPrice, total}), " +
  "and confidence (0-1). subtotal + tax must equal total.";

function extractUserPrompt(invoice: Invoice): string {
  return JSON.stringify({
    hint: "Normalize this invoice into the required draft. Use the provided values where present.",
    invoiceId: invoice.id,
    sourceObjectKey: invoice.sourceObjectKey,
    vendorName: invoice.vendorName,
    invoiceNumber: invoice.invoiceNumber,
    currency: invoice.currency,
    total: invoice.total,
  });
}

// Defaults so a model that omits a field still yields a schema-valid draft.
function draftDefaults(invoice: Invoice): InvoiceDraft {
  const total = invoice.total || 0;
  const tax = Number((total * 0.16).toFixed(2));
  const subtotal = Number((total - tax).toFixed(2));
  return {
    vendorName: invoice.vendorName ?? "Unknown vendor",
    invoiceNumber: invoice.invoiceNumber ?? `INV-${invoice.id.slice(0, 8)}`,
    invoiceDate: invoice.createdAt.slice(0, 10),
    poNumber: invoice.poId ? `PO-${invoice.poId.slice(0, 8)}` : undefined,
    currency: invoice.currency,
    subtotal,
    tax,
    total,
    lines: [{ description: "Invoice line", quantity: 1, unitPrice: subtotal, total: subtotal }],
    fieldConfidence: {},
    confidence: 0.9,
  };
}
