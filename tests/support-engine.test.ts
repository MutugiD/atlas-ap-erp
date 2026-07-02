import { describe, expect, test } from "bun:test";
import { InMemoryNativeStore, RegexRedactor, SlotExtractor, tokenBudget } from "@atlas/memory-engine";

const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Support Agent V2 native engine", () => {
  test("extracts deterministic support slots", () => {
    const facts = new SlotExtractor().extract("We upgraded to Enterprise and moved from QuickBooks to NetSuite. Contact me on Slack.");
    expect(facts.some((fact) => fact.slotKey === "plan" && fact.objectValue === "Enterprise")).toBe(true);
    expect(facts.some((fact) => fact.slotKey === "crm_tool" && fact.objectValue === "NetSuite")).toBe(true);
    expect(facts.some((fact) => fact.slotKey === "contact_channel" && fact.objectValue === "Slack")).toBe(true);
  });

  test("redacts PII before extraction/persistence", () => {
    const redacted = new RegexRedactor().redact("Email me at jane@example.com or +1 555 222 3333");
    expect(redacted.text).toContain("[REDACTED_EMAIL]");
    expect(redacted.text).toContain("[REDACTED_PHONE]");
    expect(redacted.redactions.length).toBe(2);
  });

  test("hash idempotency prevents duplicate fact replay", async () => {
    const store = new InMemoryNativeStore();
    const input = { orgId: orgA, userId: "u1", convId: "c1", sourceRole: "customer" as const, message: "I am on the Pro plan." };
    expect((await store.ingest(input)).inserted).toBe(1);
    const replay = await store.ingest(input);
    expect(replay.inserted).toBe(0);
    expect(replay.duplicate).toBe(1);
  });

  test("revision supersedes old value and keeps one active slot", async () => {
    const store = new InMemoryNativeStore();
    await store.ingest({ orgId: orgA, userId: "u2", convId: "c1", sourceRole: "customer", message: "I am on the Pro plan." });
    const second = await store.ingest({ orgId: orgA, userId: "u2", convId: "c2", sourceRole: "customer", message: "We upgraded to Enterprise plan." });
    expect(second.superseded).toBe(1);
    const timeline = await store.timeline({ orgId: orgA, userId: "u2" });
    expect(timeline.filter((fact) => fact.slotKey === "plan" && fact.status === "active")).toHaveLength(1);
    expect(timeline.find((fact) => fact.objectValue === "Pro")?.replacedBy).toBeTruthy();
  });

  test("retrieval returns active current facts only", async () => {
    const store = new InMemoryNativeStore();
    await store.ingest({ orgId: orgA, userId: "u3", convId: "c1", sourceRole: "customer", message: "I am on the Pro plan and use QuickBooks." });
    await store.ingest({ orgId: orgA, userId: "u3", convId: "c2", sourceRole: "customer", message: "We upgraded to Enterprise plan and use NetSuite." });
    const context = await store.retrieve({ orgId: orgA, userId: "u3" });
    expect(context.contextPrompt).toContain("Enterprise");
    expect(context.contextPrompt).toContain("NetSuite");
    expect(context.contextPrompt).not.toContain("QuickBooks");
  });

  test("user and org isolation returns zero foreign facts", async () => {
    const store = new InMemoryNativeStore();
    await store.ingest({ orgId: orgA, userId: "u4", convId: "c1", sourceRole: "customer", message: "I am on the Pro plan." });
    expect((await store.retrieve({ orgId: orgB, userId: "u4" })).facts).toHaveLength(0);
    expect((await store.retrieve({ orgId: orgA, userId: "other-user" })).facts).toHaveLength(0);
  });

  test("context prompt is budgeted", () => {
    expect(tokenBudget("a".repeat(2000), 50)).toHaveLength(50);
  });

  test("episodes and artifacts reference source facts", async () => {
    const store = new InMemoryNativeStore();
    await store.ingest({ orgId: orgA, userId: "u5", convId: "c1", sourceRole: "customer", message: "I am on the Pro plan and use QuickBooks." });
    const rich = await store.richTimeline({ orgId: orgA, userId: "u5" });
    expect(rich.episodes[0].factIds.length).toBeGreaterThan(0);
    expect(rich.artifacts[0].sourceFactIds.length).toBeGreaterThan(0);
  });
});

