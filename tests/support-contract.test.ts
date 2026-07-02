import { describe, expect, test } from "bun:test";
import { buildSupportApp } from "../apps/support-agent/src/app";
import { InMemoryNativeStore } from "@atlas/memory-engine";

const headers = {
  "content-type": "application/json",
  "x-org-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-principal-id": "contract-test",
  "x-role": "admin",
};

describe("Support Agent V2 13-capability contract", () => {
  test("passes native memory acceptance suite", async () => {
    const app = buildSupportApp({ store: new InMemoryNativeStore() });

    const write = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload: { userId: "contract-user", convId: "c1", message: "I am on the Pro plan and use QuickBooks. Email me at user@example.com.", mode: "with_memory" },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json().writeResult.inserted).toBeGreaterThan(0);

    const retrieval = await app.inject({ method: "GET", url: "/api/memory/contract-user", headers });
    expect(retrieval.json().contextPrompt).toContain("Pro");

    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload: { userId: "contract-user", convId: "c2", message: "We upgraded to Enterprise plan and prefer Slack.", mode: "with_memory" },
    });
    const timeline = await app.inject({ method: "GET", url: "/api/memory/contract-user/timeline", headers });
    const timelineBody = timeline.json();
    expect(timelineBody.timeline.some((fact: { supersedes?: string }) => fact.supersedes)).toBe(true);
    expect(timelineBody.timeline.some((fact: { replacedBy?: string }) => fact.replacedBy)).toBe(true);

    const factId = timelineBody.timeline[0].id;
    const lookup = await app.inject({ method: "GET", url: `/api/memory/contract-user/facts/${factId}`, headers });
    expect(lookup.json().fact.convId).toBeTruthy();
    expect(lookup.json().fact.sourceRole).toBe("customer");

    const revised = await app.inject({ method: "GET", url: "/api/memory/contract-user", headers });
    expect(revised.json().contextPrompt).toContain("Enterprise");
    expect(revised.json().contextPrompt).not.toContain("Customer plan is Pro");

    const foreign = await app.inject({ method: "GET", url: "/api/memory/contract-user", headers: { ...headers, "x-org-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    expect(foreign.json().facts).toHaveLength(0);

    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload: { userId: "contract-user", convId: "c3", message: "We moved from QuickBooks to NetSuite.", mode: "with_memory" },
    });
    const finalTimeline = await app.inject({ method: "GET", url: "/api/memory/contract-user/timeline", headers });
    expect(finalTimeline.json().timeline.filter((fact: { slotKey: string }) => fact.slotKey === "crm_tool").length).toBeGreaterThanOrEqual(2);

    const beforeStateless = finalTimeline.json().timeline.length;
    const stateless = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload: { userId: "contract-user", convId: "c4", message: "This should not be remembered. I am on Starter plan.", mode: "stateless" },
    });
    expect(stateless.json().writeResult.inserted).toBe(0);
    const afterStateless = await app.inject({ method: "GET", url: "/api/memory/contract-user/timeline", headers });
    expect(afterStateless.json().timeline).toHaveLength(beforeStateless);

    const memoryAware = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload: { userId: "contract-user", convId: "c5", message: "What do you remember?", mode: "with_memory" },
    });
    expect(memoryAware.json().reply).toContain("Enterprise");

    const rich = await app.inject({ method: "GET", url: "/api/memory/contract-user/rich-timeline", headers });
    expect(rich.json().episodes.length).toBeGreaterThan(0);
    expect(rich.json().artifacts.length).toBeGreaterThan(0);
    expect(rich.json().artifacts[0].sourceFactIds.length).toBeGreaterThan(0);
  });
});

