import { describe, expect, test } from "bun:test";
import { assertTransition, canTransition } from "@atlas/agents";

describe("invoice lifecycle", () => {
  test("rejects invalid direct post", () => {
    expect(canTransition("received", "posted")).toBe(false);
    expect(() => assertTransition("received", "posted")).toThrow("Invalid invoice transition");
  });

  test("allows approved to posted", () => {
    expect(canTransition("approved", "posted")).toBe(true);
  });
});

