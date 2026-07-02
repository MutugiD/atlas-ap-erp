import { BedrockAgentRuntimeClient, InvokeAgentCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import {
  approvalRouteSchema,
  glCodingProposalSchema,
  invoiceDraftSchema,
  matchResultSchema,
  validationResultSchema,
  type ApprovalRoute,
  type GlCodingProposal,
  type Invoice,
  type InvoiceDraft,
  type MatchResult,
  type ValidationResult,
} from "@atlas/contracts";
import type { AgentProvider } from "./local-provider";

type BedrockTask = "extract" | "validate" | "match" | "code" | "route";

export class BedrockAgentProvider implements AgentProvider {
  private readonly client: BedrockAgentRuntimeClient;
  private readonly agentId: string;
  private readonly aliasId: string;

  constructor(options?: { client?: BedrockAgentRuntimeClient; agentId?: string; aliasId?: string }) {
    this.client = options?.client ?? new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    this.agentId = options?.agentId ?? process.env.BEDROCK_SUPERVISOR_AGENT_ID ?? "";
    this.aliasId = options?.aliasId ?? process.env.BEDROCK_SUPERVISOR_AGENT_ALIAS_ID ?? "TSTALIASID";
  }

  async extract(invoice: Invoice): Promise<InvoiceDraft> {
    return invoiceDraftSchema.parse(await this.invoke("extract", { invoice }));
  }

  async validate(invoice: Invoice, draft: InvoiceDraft, existingNumbers: string[]): Promise<ValidationResult> {
    return validationResultSchema.parse(await this.invoke("validate", { invoice, draft, existingNumbers }));
  }

  async match(invoice: Invoice, draft: InvoiceDraft): Promise<MatchResult> {
    return matchResultSchema.parse(await this.invoke("match", { invoice, draft }));
  }

  async code(invoice: Invoice, draft: InvoiceDraft): Promise<GlCodingProposal> {
    return glCodingProposalSchema.parse(await this.invoke("code", { invoice, draft }));
  }

  async route(invoice: Invoice, coding: GlCodingProposal): Promise<ApprovalRoute> {
    return approvalRouteSchema.parse(await this.invoke("route", { invoice, coding }));
  }

  private async invoke(task: BedrockTask, payload: unknown): Promise<unknown> {
    if (!this.agentId) {
      throw new Error("BEDROCK_SUPERVISOR_AGENT_ID is required when AGENT_PROVIDER=bedrock");
    }
    const response = await this.client.send(
      new InvokeAgentCommand({
        agentId: this.agentId,
        agentAliasId: this.aliasId,
        sessionId: crypto.randomUUID(),
        inputText: JSON.stringify({ task, payload }),
      }),
    );
    const chunks: string[] = [];
    if (response.completion) {
      for await (const event of response.completion) {
        const bytes = event.chunk?.bytes;
        if (bytes) chunks.push(new TextDecoder().decode(bytes));
      }
    }
    return JSON.parse(chunks.join(""));
  }
}

