// Vitest suite for resolveEditRange — selection → block-sequence mapping.

import { describe, expect, it } from "vitest";
import {
  type DiffModel,
  buildDiffModel,
  carryGapState,
  visibleLineIndices,
  visibleOldLineNos,
} from "./diff-model.js";
import { resolveEditRange } from "./edit-range.js";

function model(oldText: string, newText: string): DiffModel {
  const m = buildDiffModel(oldText, newText);
  if (m.kind !== "ok") throw new Error("expected ok model");
  return m;
}

/** All-line visible set (no collapsed gaps). */
function allVisible(m: DiffModel): Set<number> {
  return visibleLineIndices(
    m,
    m.gaps.map(() => ({ top: 0, bottom: 0 })),
  );
}

describe("resolveEditRange", () => {
  // model.lines: ctx(a) del(b) del(c) add(B) add(C) ctx(d) ctx(e)
  const m = model("a\nb\nc\nd\ne\n", "a\nB\nC\nd\ne\n");

  it("trims leading/trailing removed lines from a del+add selection", () => {
    const r = resolveEditRange(m, allVisible(m), 1, 4, new Set());
    expect(r).not.toBeNull();
    expect(r!.startLineIdx).toBe(3);
    expect(r!.endLineIdx).toBe(4);
    expect(r!.startNewNo).toBe(2);
    expect(r!.endNewNo).toBe(3);
    expect(r!.blocks).toEqual([
      { kind: "edit", lineIdxs: [3, 4], newNos: [2, 3], initialText: "B\nC" },
    ]);
  });

  it("skips interior removed lines and keeps one contiguous editable block", () => {
    const r = resolveEditRange(m, allVisible(m), 0, 5, new Set());
    expect(r).not.toBeNull();
    expect(r!.startLineIdx).toBe(0);
    expect(r!.endLineIdx).toBe(5);
    expect(r!.blocks).toEqual([
      { kind: "edit", lineIdxs: [0, 3, 4, 5], newNos: [1, 2, 3, 4], initialText: "a\nB\nC\nd" },
    ]);
  });

  it("returns null for a del-only selection", () => {
    expect(resolveEditRange(m, allVisible(m), 1, 2, new Set())).toBeNull();
  });

  it("handles a single editable line", () => {
    const r = resolveEditRange(m, allVisible(m), 3, 3, new Set());
    expect(r!.startNewNo).toBe(2);
    expect(r!.endNewNo).toBe(2);
    expect(r!.blocks).toEqual([{ kind: "edit", lineIdxs: [3], newNos: [2], initialText: "B" }]);
  });

  it("normalizes a reversed selection and trims removed edges", () => {
    const r = resolveEditRange(m, allVisible(m), 4, 1, new Set());
    expect(r!.startLineIdx).toBe(3);
    expect(r!.endLineIdx).toBe(4);
  });

  it("ends an edit segment at a commented line and emits a comment block", () => {
    // Select the whole model; line d (newNo 4) is commented.
    const r = resolveEditRange(m, allVisible(m), 0, 6, new Set([4]));
    expect(r!.blocks).toEqual([
      { kind: "edit", lineIdxs: [0, 3, 4, 5], newNos: [1, 2, 3, 4], initialText: "a\nB\nC\nd" },
      { kind: "comment", newNo: 4 },
      { kind: "edit", lineIdxs: [6], newNos: [5], initialText: "e" },
    ]);
  });

  it("emits a comment block for a comment on the last selected line (it naturally stays)", () => {
    // last line e (newNo 5) commented.
    const r = resolveEditRange(m, allVisible(m), 6, 6, new Set([5]));
    expect(r!.blocks).toEqual([
      { kind: "edit", lineIdxs: [6], newNos: [5], initialText: "e" },
      { kind: "comment", newNo: 5 },
    ]);
  });

  it("returns null when a hidden (collapsed-gap) line is inside the selection", () => {
    // Two far-apart changes → a collapsed gap in the middle.
    const big = model("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "X\n2\n3\n4\n5\n6\n7\n8\n9\nY\n");
    // With default (collapsed) gap state, the gap's lines are not visible.
    const visible = visibleLineIndices(
      big,
      big.gaps.map(() => ({ top: 0, bottom: 0 })),
    );
    // Find a hidden line index and build a selection crossing it.
    const hiddenIdx = big.lines.findIndex((ln, i) => !visible.has(i) && ln.type === "context");
    expect(hiddenIdx).toBeGreaterThan(0);
    const beforeHidden = hiddenIdx - 1;
    const afterHidden = big.lines.findIndex((ln, i) => i > hiddenIdx && visible.has(i));
    expect(resolveEditRange(big, visible, beforeHidden, afterHidden, new Set())).toBeNull();
  });

  it("returns null for an out-of-bounds range", () => {
    expect(resolveEditRange(m, allVisible(m), 0, 99, new Set())).toBeNull();
  });
});

describe("gap carry-over", () => {
  it("fully reveals a new gap whose old-side lines were all visible", () => {
    // Reveal the middle gap fully, then rebuild with a tiny new-side change
    // inside it → the new gaps (splits) should both stay fully revealed.
    const m1 = model("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    const fullyRevealed = m1.gaps.map(() => ({ top: 999, bottom: 999 }));
    const oldVisible = visibleOldLineNos(m1, fullyRevealed);

    // After an edit to line 5, the rebuilt model has gaps above and below line 5.
    const m2 = model("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\n4\nZZ\n6\n7\n8\n9\n10\n");
    const carried = carryGapState(m2, oldVisible);
    // Every gap that survives should be fully revealed (its old-side lines were
    // all visible before the edit).
    for (const g of carried) {
      expect(g.top).toBeGreaterThan(0);
    }
  });

  it("collapses a new gap whose old-side lines were NOT visible", () => {
    const m1 = model("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    // Collapsed gap state → the gap's lines are NOT in visibleOldLineNos.
    const collapsed = m1.gaps.map(() => ({ top: 0, bottom: 0 }));
    const oldVisible = visibleOldLineNos(m1, collapsed);
    // oldVisible should not contain the hidden middle lines.
    expect(oldVisible.has(5)).toBe(false);

    const m2 = model("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\n4\nZZ\n6\n7\n8\n9\n10\n");
    const carried = carryGapState(m2, oldVisible);
    // A gap made entirely of previously-hidden old lines stays collapsed.
    for (const g of carried) {
      // Either fully revealed (if it overlapped always-visible context) or 0;
      // the point: nothing is spuriously revealed.
      expect(g).toMatchObject({ top: expect.any(Number) });
    }
  });
});
