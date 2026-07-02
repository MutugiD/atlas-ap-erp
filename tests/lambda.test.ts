import { describe, expect, test } from "bun:test";
import { handler } from "../apps/api/src/lambda";

describe("lambda processor", () => {
  test("handles empty SQS batch", async () => {
    const result = await handler({ Records: [] } as never);
    expect(result.processed).toEqual([]);
  });
});

