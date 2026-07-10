import { describe, expect, it } from "vitest";
import { buildDiffModelAsync } from "./diff-model-worker-client.js";

describe("buildDiffModelAsync", () => {
  it("uses the asynchronous fallback outside a browser worker environment", async () => {
    let settled = false;
    const pending = buildDiffModelAsync("old\n", "new\n").then((model) => {
      settled = true;
      return model;
    });
    expect(settled).toBe(false);
    const model = await pending;
    expect(model.kind).toBe("ok");
    if (model.kind === "ok") expect(model.changedCount).toBe(2);
  });
});
