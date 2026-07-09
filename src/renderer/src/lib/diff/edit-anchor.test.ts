// Vitest suite for edit-aware comment re-anchoring (invariant 6).

import { describe, expect, it } from "vitest";
import type { CodeComment } from "../diff-comments.js";
import { findUniqueBlock, reanchorCommentsForEdit } from "./edit-anchor.js";

function comment(
  filePath: string,
  lineNumber: number,
  lineText: string,
  opts: Partial<CodeComment> = {},
): CodeComment {
  return {
    id: `${filePath}:${lineNumber}`,
    filePath,
    lineNumber,
    originalLineNumber: opts.originalLineNumber ?? lineNumber,
    lineText,
    anchorStatus: opts.anchorStatus ?? "current",
    text: opts.text ?? "note",
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

const FILE = "src/a.ts";

describe("reanchorCommentsForEdit", () => {
  it("leaves above-range comments untouched", () => {
    const out = reanchorCommentsForEdit([comment(FILE, 3, "line3")], FILE, {
      startNewNo: 10,
      endNewNo: 12,
      replacementLines: ["x", "y", "z"],
      newLineCount: 50,
    });
    expect(out[0]).toMatchObject({ lineNumber: 3, originalLineNumber: 3, anchorStatus: "current" });
  });

  it("shifts below-range lineNumber AND originalLineNumber by delta, preserving status", () => {
    // range 10..12 (3 lines) → 5 replacement lines → delta +2
    const out = reanchorCommentsForEdit(
      [comment(FILE, 20, "l20", { originalLineNumber: 18, anchorStatus: "relocated" })],
      FILE,
      {
        startNewNo: 10,
        endNewNo: 12,
        replacementLines: ["a", "b", "c", "d", "e"],
        newLineCount: 50,
      },
    );
    expect(out[0]).toMatchObject({
      lineNumber: 22,
      originalLineNumber: 20,
      anchorStatus: "relocated",
    });
  });

  it("shifts below-range by a negative delta (file shrank)", () => {
    // range 10..12 (3 lines) → 1 replacement → delta -2
    const out = reanchorCommentsForEdit([comment(FILE, 20, "l20")], FILE, {
      startNewNo: 10,
      endNewNo: 12,
      replacementLines: ["only"],
      newLineCount: 40,
    });
    expect(out[0]!.lineNumber).toBe(18);
  });

  it("renumbers an in-range comment whose text survives uniquely, keeping status", () => {
    // range 10..12 replaced with ["foo", "bar", "baz"]; comment on "bar" (was line 11).
    const out = reanchorCommentsForEdit(
      [comment(FILE, 11, "bar", { anchorStatus: "current" })],
      FILE,
      { startNewNo: 10, endNewNo: 12, replacementLines: ["foo", "bar", "baz"], newLineCount: 50 },
    );
    expect(out[0]).toMatchObject({ lineNumber: 11, anchorStatus: "current" });
  });

  it("moves an in-range comment to the surviving line when the range shifted", () => {
    // range 10..12 (3 lines) → 5 lines; comment was on line 12 text "z", now at index 4.
    const out = reanchorCommentsForEdit([comment(FILE, 12, "z")], FILE, {
      startNewNo: 10,
      endNewNo: 12,
      replacementLines: ["a", "b", "c", "d", "z"],
      newLineCount: 50,
    });
    expect(out[0]!.lineNumber).toBe(14); // 10 + 4
  });

  it("marks an in-range comment stale when its text does not survive", () => {
    const out = reanchorCommentsForEdit([comment(FILE, 11, "gone")], FILE, {
      startNewNo: 10,
      endNewNo: 12,
      replacementLines: ["foo", "bar", "baz"],
      newLineCount: 50,
    });
    expect(out[0]).toMatchObject({ lineNumber: 11, anchorStatus: "stale" });
  });

  it("marks an in-range comment stale when its text is ambiguous (non-unique)", () => {
    const out = reanchorCommentsForEdit([comment(FILE, 11, "dup")], FILE, {
      startNewNo: 10,
      endNewNo: 12,
      replacementLines: ["dup", "dup", "x"],
      newLineCount: 50,
    });
    expect(out[0]).toMatchObject({ anchorStatus: "stale" });
  });

  it("clamps a stale comment's line to the new file length", () => {
    // original line 48 was in range 40..48 (9 lines) → replaced with 1 line;
    // new file length 5. The stale comment clamps to 5.
    const out = reanchorCommentsForEdit([comment(FILE, 48, "last")], FILE, {
      startNewNo: 40,
      endNewNo: 48,
      replacementLines: ["x"],
      newLineCount: 5,
    });
    expect(out[0]!.lineNumber).toBe(5);
    expect(out[0]!.anchorStatus).toBe("stale");
  });

  it("walks a colliding stale comment to the nearest free line", () => {
    // Two in-range comments whose text doesn't survive both clamp to line 5.
    const out = reanchorCommentsForEdit([comment(FILE, 44, "a"), comment(FILE, 46, "b")], FILE, {
      startNewNo: 40,
      endNewNo: 48,
      replacementLines: ["x"],
      newLineCount: 5,
    });
    const lines = out.map((c) => c.lineNumber).sort((a, b) => a - b);
    expect(new Set(lines).size).toBe(2); // no collision
    // Both clamp to 5 (the last line); the second walker cannot go above the
    // 5-line file, so it steps DOWN to 4.
    expect(lines).toEqual([4, 5]);
  });

  it("never collides when a below-range comment lands on a clamped stale line", () => {
    // range 40..48 (9) → 1 line, delta -8. A below comment at 56 → 48. An
    // in-range stale comment clamps to newLineCount (5). No collision.
    const out = reanchorCommentsForEdit(
      [comment(FILE, 44, "stale"), comment(FILE, 56, "below")],
      FILE,
      { startNewNo: 40, endNewNo: 48, replacementLines: ["x"], newLineCount: 48 },
    );
    const lns = out.map((c) => c.lineNumber);
    expect(new Set(lns).size).toBe(2);
  });

  it("passes comments on other files through unchanged without causing line collisions", () => {
    const other = comment("src/other.ts", 5, "x");
    const moved = comment(FILE, 11, "bar");
    const out = reanchorCommentsForEdit([other, moved], FILE, {
      startNewNo: 10,
      endNewNo: 12,
      replacementLines: ["foo", "bar", "baz"],
      newLineCount: 50,
    });
    const otherOut = out.find((c) => c.filePath === "src/other.ts");
    expect(otherOut).toBe(other); // referentially unchanged
    expect(out.find((c) => c.filePath === FILE)?.lineNumber).toBe(11);

    const outWithSameLineOnOtherFile = reanchorCommentsForEdit(
      [comment("src/other.ts", 10, "x"), comment(FILE, 10, "gone")],
      FILE,
      { startNewNo: 10, endNewNo: 10, replacementLines: ["new"], newLineCount: 20 },
    );
    expect(outWithSameLineOnOtherFile.find((c) => c.filePath === FILE)?.lineNumber).toBe(10);
  });
});

describe("findUniqueBlock", () => {
  it("finds a unique contiguous block", () => {
    const r = findUniqueBlock("a\nb\nc\nd\n", ["b", "c"]);
    expect(r).toEqual({ startLine: 2, endLine: 3 });
  });

  it("returns null when the block is absent", () => {
    expect(findUniqueBlock("a\nb\nc\n", ["x", "y"])).toBeNull();
  });

  it("returns null when the block appears more than once (ambiguous)", () => {
    expect(findUniqueBlock("a\nb\na\nb\n", ["a", "b"])).toBeNull();
  });

  it("splits fresh CRLF text with the model splitter so it re-anchors", () => {
    expect(findUniqueBlock("a\r\nb\r\nc\r\n", ["b", "c"])).toEqual({ startLine: 2, endLine: 3 });
  });

  it("returns null for an empty block", () => {
    expect(findUniqueBlock("a\nb\n", [])).toBeNull();
  });
});
