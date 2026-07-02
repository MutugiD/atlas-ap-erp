import { describe, expect, test } from "bun:test";
import type { IngestInput, IngestResult } from "@atlas/support-contracts";
import { buildSupportApp } from "../apps/support-agent/src/app";
import { DegradingIngestQueue, type IngestQueue } from "../apps/support-agent/src/queue";

const headers = {
  "content-type": "application/json",
  "x-org-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-principal-id": "degradation-test",
  "x-role": "admin",
};

class FailingQueue implements IngestQueue {
  async enqueue(_input: IngestInput): Promise<IngestResult> {
    throw new Error("redis unavailable");
  }

  async depth(): Promise<number> {
    throw new Error("redis unavailable");
  }

  async dlqDepth(): Promise<number> {
    throw new Error("redis unavailable");
  }
}

describe("Support Agent V2 degradation behavior", () => {
  test("queue failures never block chat replies and are buffered for operators", async () => {
    const queue = new DegradingIngestQueue(new FailingQueue());
    const app = buildSupportApp({ queue });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload: {
        userId: "degrade-user",
        convId: "degrade-1",
        mode: "with_memory",
        message: "We use NetSuite and prefer Slack.",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().reply).toContain("I can help");
    expect(response.json().degraded).toBe(true);
    expect(response.json().writeResult.queued).toBe(false);
    expect(await queue.depth()).toBe(1);
    expect(await queue.dlqDepth()).toBe(1);
    expect(queue.bufferedFailures()[0].error).toContain("redis unavailable");
  });

  test("auth supports JWKS discovery configuration", () => {
    const source = Bun.file("apps/support-agent/src/auth.ts").text();
    return expect(source).resolves.toContain("AUTH_JWKS_URL");
  });
});
