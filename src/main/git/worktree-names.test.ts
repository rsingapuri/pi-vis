import { describe, expect, it } from "vitest";
import { generateWorktreeName } from "./worktree-names.js";

describe("generateWorktreeName", () => {
  it("returns a hyphen-joined adjective-noun pair", () => {
    const name = generateWorktreeName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(name.length).toBeGreaterThan(3);
  });

  it("returns a unique name on successive calls", () => {
    const names = new Set<string>();
    for (let i = 0; i < 10; i++) {
      names.add(generateWorktreeName());
    }
    // With ~100 * ~150 = 15k combinations, 10 calls should all be unique.
    expect(names.size).toBe(10);
  });
});
