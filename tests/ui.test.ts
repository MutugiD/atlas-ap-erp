import { describe, expect, test } from "bun:test";
import InboxPage from "../apps/web/app/page";
import OpsPage from "../apps/web/app/ops/page";

describe("UI smoke", () => {
  test("inbox page returns a renderable element", async () => {
    const element = await InboxPage();
    expect(element).toBeTruthy();
  });

  test("ops page returns metrics content", () => {
    const element = OpsPage();
    expect(element).toBeTruthy();
  });
});

