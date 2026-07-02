import { describe, expect, test } from "bun:test";
import { BedrockAgentProvider } from "@atlas/agents";

describe("Bedrock adapter", () => {
  test("requires supervisor id before live invoke", async () => {
    const provider = new BedrockAgentProvider({
      agentId: "",
      client: { send: async () => ({}) } as never,
    });
    await expect(provider.extract({
      id: "99999999-9999-4999-8999-999999999999",
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "received",
      total: 10,
      currency: "USD",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })).rejects.toThrow("BEDROCK_SUPERVISOR_AGENT_ID");
  });
});

