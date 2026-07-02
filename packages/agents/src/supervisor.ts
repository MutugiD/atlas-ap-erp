import {
  type AgentDecision,
  type AgentEvent,
  type Invoice,
  type InvoiceStatus,
  type TenantContext,
} from "@atlas/contracts";
import { assertTransition } from "./lifecycle";
import { type AgentProvider, LocalAgentProvider, sumsToTotal } from "./local-provider";
import { BedrockAgentProvider } from "./bedrock-provider";

export interface AgentRepository {
  listInvoiceNumbers(ctx: TenantContext, excludeInvoiceId: string): Promise<string[]>;
  updateInvoice(ctx: TenantContext, invoice: Invoice): Promise<Invoice>;
  addEvent(ctx: TenantContext, event: Omit<AgentEvent, "id" | "createdAt">): Promise<AgentEvent>;
}

export interface SupervisorResult {
  invoice: Invoice;
  decisions: AgentDecision[];
}

export function createAgentProvider(): AgentProvider {
  return process.env.AGENT_PROVIDER === "bedrock" ? new BedrockAgentProvider() : new LocalAgentProvider();
}

export class Supervisor {
  constructor(
    private readonly provider: AgentProvider = createAgentProvider(),
    private readonly thresholds = { extraction: 0.75, decision: 0.8 },
  ) {}

  async process(ctx: TenantContext, invoice: Invoice, repo: AgentRepository): Promise<SupervisorResult> {
    let current = invoice;
    const decisions: AgentDecision[] = [];

    const record = async (decision: AgentDecision, input: unknown) => {
      decisions.push(decision);
      await repo.addEvent(ctx, {
        tenantId: ctx.tenantId,
        invoiceId: current.id,
        agent: decision.agent,
        actor: "agent",
        input,
        output: decision.output,
        tokens: 0,
        latencyMs: 0,
      });
    };

    const move = async (to: InvoiceStatus, patch: Partial<Invoice> = {}) => {
      assertTransition(current.status, to);
      current = await repo.updateInvoice(ctx, {
        ...current,
        ...patch,
        status: to,
        updatedAt: new Date().toISOString(),
      });
    };

    if (current.status === "received") {
      const draft = await this.provider.extract(current);
      if (draft.confidence < this.thresholds.extraction) {
        const decision = { agent: "extraction", nextStatus: "exception", confidence: draft.confidence, output: draft, humanRequired: true, reasons: ["Low extraction confidence"] } satisfies AgentDecision;
        await record(decision, current);
        await move("exception", { extracted: draft, confidence: draft.confidence });
        return { invoice: current, decisions };
      }
      await record({ agent: "extraction", nextStatus: "extracted", confidence: draft.confidence, output: draft, humanRequired: false, reasons: [] }, current);
      await move("extracted", {
        extracted: draft,
        confidence: draft.confidence,
        vendorName: draft.vendorName,
        invoiceNumber: draft.invoiceNumber,
        total: draft.total,
        currency: draft.currency,
      });
    }

    if (current.status === "extracted" && current.extracted) {
      const existingNumbers = await repo.listInvoiceNumbers(ctx, current.id);
      const result = await this.provider.validate(current, current.extracted, existingNumbers);
      if (!result.ok || result.duplicate) {
        await record({ agent: "validation", nextStatus: "exception", confidence: result.confidence, output: result, humanRequired: true, reasons: result.reasons }, current);
        await move("exception");
        return { invoice: current, decisions };
      }
      await record({ agent: "validation", nextStatus: "validated", confidence: result.confidence, output: result, humanRequired: false, reasons: [] }, current);
      await move("validated");
    }

    if (current.status === "validated" && current.extracted && current.poId) {
      const result = await this.provider.match(current, current.extracted);
      if (!result.withinTolerance) {
        await record({ agent: "matching", nextStatus: "exception", confidence: result.confidence, output: result, humanRequired: true, reasons: result.reasons }, current);
        await move("exception");
        return { invoice: current, decisions };
      }
      await record({ agent: "matching", nextStatus: "matched", confidence: result.confidence, output: result, humanRequired: false, reasons: [] }, current);
      await move("matched");
    }

    if ((current.status === "validated" || current.status === "matched") && current.extracted) {
      const proposal = await this.provider.code(current, current.extracted);
      if (!proposal.balanced || !sumsToTotal(proposal, current.total)) {
        await record({ agent: "gl_coding", nextStatus: "exception", confidence: proposal.confidence, output: proposal, humanRequired: true, reasons: ["GL proposal is not balanced"] }, current);
        await move("exception");
        return { invoice: current, decisions };
      }
      await record({ agent: "gl_coding", nextStatus: "coded", confidence: proposal.confidence, output: proposal, humanRequired: false, reasons: [] }, current);
      await move("coded");

      const route = await this.provider.route(current, proposal);
      if (route.autoApproved) {
        await record({ agent: "approval_routing", nextStatus: "approved", confidence: route.confidence, output: route, humanRequired: false, reasons: [route.reason] }, current);
        await move("approved");
      } else {
        await record({ agent: "approval_routing", nextStatus: "awaiting_approval", confidence: route.confidence, output: route, humanRequired: true, reasons: [route.reason] }, current);
        await move("awaiting_approval");
        return { invoice: current, decisions };
      }
    }

    if (current.status === "approved") {
      await record({ agent: "posting", nextStatus: "posted", confidence: 1, output: { posted: true }, humanRequired: false, reasons: [] }, current);
      await move("posted");
    }

    if (current.status === "posted") {
      await record({ agent: "posting", nextStatus: "queued_for_payment", confidence: 1, output: { queuedForPayment: true }, humanRequired: false, reasons: [] }, current);
      await move("queued_for_payment");
    }

    return { invoice: current, decisions };
  }
}

