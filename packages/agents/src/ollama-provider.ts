import {
  approvalRouteSchema,
  glCodingProposalSchema,
  invoiceDraftSchema,
  type ApprovalRoute,
  type GlCodingProposal,
  type Invoice,
  type InvoiceDraft,
  type MatchResult,
  type ValidationResult,
} from "@atlas/contracts";
import { LocalAgentProvider, sumsToTotal, type AgentProvider } from "./local-provider";

type FetchImpl = typeof fetch;
type ApiStyle = "ollama" | "openai";
type LlmTask = "extract" | "code" | "route";

export interface ModelTiers {
  complex?: string;
  standard?: string;
  simple?: string;
}

export interface OllamaAgentProviderOptions {
  baseUrl?: string;
  /** Legacy single-model fallback for any tier left unset. */
  model?: string;
  models?: ModelTiers;
  /** "ollama" -> /api/chat (default); "openai" -> /v1/chat/completions (llama.cpp). */
  apiStyle?: ApiStyle;
  /** Which tasks run on the LLM; anything else delegates to the deterministic fallback. */
  llmTasks?: LlmTask[];
  apiKey?: string;
  fetchImpl?: FetchImpl;
  fallback?: AgentProvider;
}

const DEFAULT_TIERS: Required<ModelTiers> = {
  complex: "glm-5.2:cloud",
  standard: "glm-5.1:cloud",
  simple: "gemini-3-flash-preview:latest",
};

// Routes the AP agent tasks across complexity-tiered LLMs (extract -> complex,
// GL coding -> standard, approval routing -> simple), speaking either Ollama's
// native /api/chat or an OpenAI-compatible /v1/chat/completions endpoint
// (llama.cpp). The deterministic arithmetic tasks (validate/match) stay on the
// local provider, and every LLM task degrades gracefully to the local provider
// when the model is unreachable or returns something a schema rejects.
export class OllamaAgentProvider implements AgentProvider {
  private readonly baseUrl: string;
  private readonly models: Required<ModelTiers>;
  private readonly apiStyle: ApiStyle;
  private readonly llmTasks: Set<LlmTask>;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchImpl;
  private readonly fallback: AgentProvider;

  constructor(options: OllamaAgentProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
    const legacy = options.model ?? process.env.OLLAMA_MODEL;
    this.models = {
      complex: options.models?.complex ?? process.env.OLLAMA_MODEL_COMPLEX ?? legacy ?? DEFAULT_TIERS.complex,
      standard: options.models?.standard ?? process.env.OLLAMA_MODEL_STANDARD ?? legacy ?? DEFAULT_TIERS.standard,
      simple: options.models?.simple ?? process.env.OLLAMA_MODEL_SIMPLE ?? legacy ?? DEFAULT_TIERS.simple,
    };
    this.apiStyle = options.apiStyle ?? (process.env.OLLAMA_API_STYLE as ApiStyle) ?? "ollama";
    this.llmTasks = new Set(options.llmTasks ?? parseTasks(process.env.OLLAMA_LLM_TASKS));
    this.apiKey = options.apiKey ?? process.env.OLLAMA_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallback = options.fallback ?? new LocalAgentProvider();
  }

  async extract(invoice: Invoice): Promise<InvoiceDraft> {
    if (!this.llmTasks.has("extract")) return this.fallback.extract(invoice);
    try {
      const content = await this.chat(this.models.complex, EXTRACT_SYSTEM_PROMPT, extractUserPrompt(invoice));
      const raw = extractJsonObject(content);
      // Overlay only the fields the model actually filled so nulls/empties don't
      // clobber the schema-valid defaults (small models often return e.g. lines: []).
      return invoiceDraftSchema.parse(mergeDraft(draftDefaults(invoice), raw));
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

  async code(invoice: Invoice, draft: InvoiceDraft): Promise<GlCodingProposal> {
    if (!this.llmTasks.has("code")) return this.fallback.code(invoice, draft);
    try {
      const content = await this.chat(this.models.standard, CODE_SYSTEM_PROMPT, codeUserPrompt(draft));
      const proposal = glCodingProposalSchema.parse(extractJsonObject(content));
      // The model's splits must actually reconcile to the invoice total, else the
      // GL posting would be unbalanced — reject and let the deterministic path win.
      if (!sumsToTotal(proposal, draft.total)) return this.fallback.code(invoice, draft);
      return proposal;
    } catch {
      return this.fallback.code(invoice, draft);
    }
  }

  async route(invoice: Invoice, coding: GlCodingProposal): Promise<ApprovalRoute> {
    if (!this.llmTasks.has("route")) return this.fallback.route(invoice, coding);
    try {
      const content = await this.chat(this.models.simple, ROUTE_SYSTEM_PROMPT, routeUserPrompt(invoice, coding));
      const judgment = extractJsonObject(content);
      // The LLM decides approve-vs-hold + rationale, but the concrete approver
      // UUIDs come from tenant policy (deterministic) — a model can't invent valid ones.
      const deterministic = await this.fallback.route(invoice, coding);
      const autoApproved = Boolean(judgment.autoApproved);
      return approvalRouteSchema.parse({
        autoApproved,
        approvers: autoApproved ? [] : deterministic.approvers,
        reason: typeof judgment.reason === "string" && judgment.reason ? judgment.reason : deterministic.reason,
        confidence: typeof judgment.confidence === "number" ? judgment.confidence : deterministic.confidence,
      });
    } catch {
      return this.fallback.route(invoice, coding);
    }
  }

  private async chat(model: string, system: string, user: string): Promise<string> {
    const openai = this.apiStyle === "openai";
    const url = openai ? `${this.baseUrl}/v1/chat/completions` : `${this.baseUrl}/api/chat`;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const body = openai
      ? { model, response_format: { type: "json_object" }, stream: false, messages }
      : { model, format: "json", stream: false, messages };
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
    if (openai) {
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? "";
    }
    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }
}

function parseTasks(raw: string | undefined): LlmTask[] {
  if (raw === undefined) return ["extract", "code", "route"];
  const allowed: LlmTask[] = ["extract", "code", "route"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is LlmTask => (allowed as string[]).includes(s));
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

const CODE_SYSTEM_PROMPT =
  "You propose general-ledger coding for an accounts-payable invoice. Return ONLY a JSON object with keys: " +
  "balanced (boolean), splits (array of {glAccount, costCenter, amount}), confidence (0-1). " +
  "The split amounts MUST sum exactly to the invoice total. Use expense GL accounts (e.g. 6100 supplies, " +
  "6200 services, 6300 travel) and a cost center that fits the vendor and line descriptions.";

function codeUserPrompt(draft: InvoiceDraft): string {
  return JSON.stringify({
    vendorName: draft.vendorName,
    currency: draft.currency,
    total: draft.total,
    lines: draft.lines,
  });
}

const ROUTE_SYSTEM_PROMPT =
  "You decide approval routing for an accounts-payable invoice. Return ONLY a JSON object with keys: " +
  "autoApproved (boolean), reason (string), confidence (0-1). Auto-approve small, low-risk, in-tolerance " +
  "invoices; require human approval for larger amounts or anything unusual. Do not output approver ids.";

function routeUserPrompt(invoice: Invoice, coding: GlCodingProposal): string {
  return JSON.stringify({
    currency: invoice.currency,
    total: invoice.total,
    glBalanced: coding.balanced,
    splitCount: coding.splits.length,
  });
}

// Models often wrap JSON in a ```json fence or add prose; pull out the object.
export function extractJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  const json = start >= 0 && end > start ? content.slice(start, end + 1) : content;
  return JSON.parse(json) as Record<string, unknown>;
}

// Overlay model output on the defaults, skipping null/undefined and empty lines.
function mergeDraft(defaults: InvoiceDraft, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (key === "lines" && (!Array.isArray(value) || value.length === 0)) continue;
    out[key] = value;
  }
  return out;
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
