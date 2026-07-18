// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { canCopyTreeSelection } from "./tree-copy.js";

describe("canCopyTreeSelection", () => {
  it("leaves Cmd/Ctrl+C to text inputs, contenteditables, and browser selections", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editable.append(child);
    const button = document.createElement("button");

    expect(canCopyTreeSelection(input, false)).toBe(false);
    expect(canCopyTreeSelection(child, false)).toBe(false);
    expect(canCopyTreeSelection(button, true)).toBe(false);
    expect(canCopyTreeSelection(button, false)).toBe(true);
  });
});
