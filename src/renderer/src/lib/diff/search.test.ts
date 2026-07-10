import { describe, expect, it } from "vitest";
import { buildDiffModel } from "./diff-model.js";
import type { AnyDiffModel, DiffModel, GapState } from "./diff-model.js";
import { DIFF_ROW_RENDER_MAX } from "./render-limits.js";
import { computeMatches, findOccurrences } from "./search.js";

function okModel(oldText: string, newText: string): { model: DiffModel; gapState: GapState[] } {
  const model: AnyDiffModel = buildDiffModel(oldText, newText);
  if (model.kind !== "ok") throw new Error("expected ok model");
  return { model, gapState: model.gaps.map(() => ({ top: 0, bottom: 0 })) };
}

describe("findOccurrences", () => {
  it("finds literal non-overlapping occurrences in original-text order", () => {
    expect(findOccurrences("a.b.a.b", "a.", false)).toEqual([
      [0, 2],
      [4, 6],
    ]);
    expect(findOccurrences("aaaa", "aa", false)).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("supports case-sensitive and insensitive matching", () => {
    expect(findOccurrences("FooBarfoo", "foo", false)).toEqual([
      [0, 3],
      [6, 9],
    ]);
    expect(findOccurrences("FooBarfoo", "foo", true)).toEqual([[6, 9]]);
  });

  it("keeps offsets in the original string when Unicode lowercasing changes length", () => {
    // "İ" lowercases to two UTF-16 code units (i + combining dot). Searching a
    // transformed haystack would incorrectly report x at offset 2.
    expect(findOccurrences("İx", "x", false)).toEqual([[1, 2]]);
  });

  it("returns nothing for empty query or text", () => {
    expect(findOccurrences("abc", "", false)).toEqual([]);
    expect(findOccurrences("", "a", false)).toEqual([]);
  });
});

describe("computeMatches", () => {
  it("searches context, removed, and added rows", () => {
    const { model, gapState } = okModel("foo keep\nremove foo\n", "foo keep\nadd foo\n");
    const matches = computeMatches([{ path: "a.ts", model, gapState }], "foo", false);
    expect(matches.map((match) => match.side)).toEqual(["context", "old", "new"]);
  });

  it("searches every changed row beyond the DOM browsing ceiling", () => {
    const lines = Array.from({ length: DIFF_ROW_RENDER_MAX + 25 }, (_, index) =>
      index === DIFF_ROW_RENDER_MAX + 20 ? "production-needle" : `line ${index}`,
    );
    const { model, gapState } = okModel("", `${lines.join("\n")}\n`);
    const matches = computeMatches(
      [{ path: "huge.ts", model, gapState }],
      "production-needle",
      true,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      path: "huge.ts",
      side: "new",
      rowIndex: DIFF_ROW_RENDER_MAX + 20,
    });
  });

  it("includes unchanged hunk context", () => {
    const oldLines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    oldLines[14] = "hunk-context-needle";
    const newLines = [...oldLines];
    newLines[15] = "changed line";
    const { model, gapState } = okModel(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`);
    const matches = computeMatches(
      [{ path: "f.ts", model, gapState }],
      "hunk-context-needle",
      true,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.side).toBe("context");
  });

  it("excludes hidden gap middles and includes them once explicitly revealed", () => {
    const oldLines = Array.from({ length: 80 }, (_, index) => `line ${index}`);
    oldLines[5] = "hidden-context-needle";
    const newLines = [...oldLines];
    newLines[40] = "changed line";
    const { model, gapState } = okModel(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`);

    expect(
      computeMatches([{ path: "f.ts", model, gapState }], "hidden-context-needle", true),
    ).toEqual([]);

    const revealed = model.gaps.map((gap) =>
      gap.startIdx <= 5 && gap.endIdx >= 5
        ? { top: gap.size, bottom: gap.size }
        : { top: 0, bottom: 0 },
    );
    expect(
      computeMatches([{ path: "f.ts", model, gapState: revealed }], "hidden-context-needle", true),
    ).toHaveLength(1);
  });

  it("orders files, rows, and occurrences deterministically", () => {
    const a = okModel("", "needle needle\n");
    const b = okModel("", "needle\n");
    const matches = computeMatches(
      [
        { path: "a.ts", model: a.model, gapState: a.gapState },
        { path: "b.ts", model: b.model, gapState: b.gapState },
      ],
      "needle",
      true,
    );
    expect(matches.map((match) => [match.path, match.occ])).toEqual([
      ["a.ts", 0],
      ["a.ts", 1],
      ["b.ts", 0],
    ]);
  });

  it("uses split visual order: row, old side, new side", () => {
    const { model, gapState } = okModel(
      "old needle 0\nold needle 1\n",
      "new needle 0\nnew needle 1\n",
    );
    const matches = computeMatches(
      [{ path: "f.ts", model, gapState, viewMode: "split" }],
      "needle",
      true,
    );
    expect(matches.map(({ rowIndex, side }) => ({ rowIndex, side }))).toEqual([
      { rowIndex: 0, side: "old" },
      { rowIndex: 0, side: "new" },
      { rowIndex: 1, side: "old" },
      { rowIndex: 1, side: "new" },
    ]);
  });

  it("keeps both sides aligned for large split replacements", () => {
    const oldText = `${Array.from({ length: 250 }, (_, i) => `old needle ${i}`).join("\n")}\n`;
    const newText = `${Array.from({ length: 250 }, (_, i) => `new needle ${i}`).join("\n")}\n`;
    const { model, gapState } = okModel(oldText, newText);
    const matches = computeMatches(
      [{ path: "f.ts", model, gapState, viewMode: "split" }],
      "needle",
      true,
    );
    expect(matches).toHaveLength(500);
    expect(matches.slice(0, 4).map(({ rowIndex, side }) => ({ rowIndex, side }))).toEqual([
      { rowIndex: 0, side: "old" },
      { rowIndex: 0, side: "new" },
      { rowIndex: 1, side: "old" },
      { rowIndex: 1, side: "new" },
    ]);
    expect(matches.at(-1)).toMatchObject({ rowIndex: 249, side: "new" });
  });

  it("returns no matches for an empty query", () => {
    const { model, gapState } = okModel("a\n", "b\n");
    expect(computeMatches([{ path: "f.ts", model, gapState }], "", false)).toEqual([]);
  });
});
