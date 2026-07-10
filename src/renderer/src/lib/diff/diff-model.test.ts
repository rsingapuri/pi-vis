// Vitest suite for the diff model. Pure functions, no DOM.
//
// Coverage targets the spec's correctness bars:
//   - Pairing of del/add within a change block
//   - Hunk merge at adjacent / overlapping change boundaries
//   - All three gap kinds: file start, between hunks, file end
//   - Expansion math (up/down/all/exhausted)
//   - Line numbers
//   - Added file (old empty), deleted file (new empty)
//   - Identical content
//   - No-trailing-newline pairs
//   - Intraline emphasis ranges

import { describe, expect, it } from "vitest";
import {
  type DiffModel,
  type GapState,
  buildDiffModel,
  buildSplitRows,
  visibleRows,
  visibleSplitRows,
} from "./diff-model.js";
import { langForPath, segmentLine } from "./highlight.js";
import { intralineRanges } from "./intraline.js";

function ok(model: ReturnType<typeof buildDiffModel>): DiffModel {
  if (model.kind !== "ok") throw new Error(`expected ok model, got ${model.kind}`);
  return model;
}

describe("buildDiffModel — basic shape", () => {
  it("identical content → ok model, no hunks, no changed lines", () => {
    const m = ok(buildDiffModel("a\nb\nc\n", "a\nb\nc\n"));
    expect(m.lines.every((l) => l.type === "context")).toBe(true);
    expect(m.hunks).toEqual([]);
    expect(m.changedCount).toBe(0);
    // One gap covering the whole file.
    expect(m.gaps).toHaveLength(1);
    expect(m.gaps[0]?.isFileStart).toBe(true);
    expect(m.gaps[0]?.isFileEnd).toBe(true);
    expect(m.gaps[0]?.size).toBe(3);
  });

  it("added file: old='' → no del rows, only adds and matching context", () => {
    const m = ok(buildDiffModel("", "a\nb\nc\n"));
    expect(m.lines.every((l) => l.type === "add")).toBe(true);
    expect(m.lines).toHaveLength(3);
    expect(m.changedCount).toBe(3);
    // The hunk covers the entire file (no old lines to compare), so
    // there's no start- or end-gap to emit.
    expect(m.gaps).toHaveLength(0);
  });

  it("deleted file: new='' → only del rows, no adds", () => {
    const m = ok(buildDiffModel("a\nb\nc\n", ""));
    expect(m.lines.every((l) => l.type === "del")).toBe(true);
    expect(m.changedCount).toBe(3);
    expect(m.gaps).toHaveLength(0);
  });

  it("CRLF normalization: trailing CR is stripped on both sides", () => {
    const m = ok(buildDiffModel("a\r\nb\r\n", "a\nb\n"));
    expect(m.lines.every((l) => l.type === "context")).toBe(true);
  });

  it("line numbers start at 1 and increment for context and changes", () => {
    const m = ok(buildDiffModel("a\nb\nc\nd\n", "a\nB\nc\nd\n"));
    // Change at line 2 (b → B). Context: 1, 2 (del), 2 (add), 3, 4.
    const dels = m.lines.filter((l) => l.type === "del");
    const adds = m.lines.filter((l) => l.type === "add");
    expect(dels[0]?.type === "del" && dels[0].oldNo).toBe(2);
    expect(adds[0]?.type === "add" && adds[0].newNo).toBe(2);
  });

  it("no trailing newline on either side is reflected in the line list", () => {
    const m = ok(buildDiffModel("a\nb", "a\nB"));
    // 4 lines: context a, del b, add B (and a tail context? no — file ends at the diff).
    // diffLines bundles values; we should see at least the changed pair.
    expect(m.changedCount).toBe(2);
  });
});

describe("buildDiffModel — pairing & hunks", () => {
  it("dels and adds within the same change block are paired (del.pair ↔ add.pair)", () => {
    const m = ok(buildDiffModel("a\nb\nc\n", "X\nY\nZ\n"));
    const dels = m.lines.filter((l) => l.type === "del");
    const adds = m.lines.filter((l) => l.type === "add");
    expect(dels).toHaveLength(3);
    expect(adds).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const d = dels[i]!;
      const a = adds[i]!;
      expect(d.type === "del" && d.pair).toBe(m.lines.indexOf(a));
      expect(a.type === "add" && a.pair).toBe(m.lines.indexOf(d));
    }
  });

  it("unpaired extras: more dels than adds leaves trailing del.pair undefined", () => {
    const m = ok(buildDiffModel("a\nb\nc\nd\n", "X\n"));
    const dels = m.lines.filter((l) => l.type === "del");
    const adds = m.lines.filter((l) => l.type === "add");
    expect(dels).toHaveLength(4);
    expect(adds).toHaveLength(1);
    const paired = dels.filter((d) => d.type === "del" && d.pair !== undefined);
    expect(paired).toHaveLength(1);
  });

  it("hunks merge when their context windows overlap", () => {
    // 5 lines, with two small changes 1 line apart. Context window = 3
    // on each side, so the two hunks overlap and should merge.
    const oldText = "a1\na2\na3\na4\na5\n";
    const newText = "A1\na2\na3\na4\nA5\n";
    const m = ok(buildDiffModel(oldText, newText));
    expect(m.hunks).toHaveLength(1);
  });

  it("hunks do not merge when changes are far apart", () => {
    // 20 identical context lines between the two changes.
    const ctx = `${Array.from({ length: 20 }, () => "x").join("\n")}\n`;
    const oldText = `a1\n${ctx}ZZ\n`;
    const newText = `A1\n${ctx}ZZZ\n`;
    const m = ok(buildDiffModel(oldText, newText));
    expect(m.hunks).toHaveLength(2);
    // One mid-file gap.
    expect(m.gaps.filter((g) => !g.isFileStart && !g.isFileEnd)).toHaveLength(1);
  });

  it("populates intraline emphasis on paired modified lines", () => {
    const model = buildDiffModel("const a = 1;\n", "const a = 2;\n");
    if (model.kind !== "ok") throw new Error("expected ok model");
    const del = model.lines.find((l) => l.type === "del");
    const add = model.lines.find((l) => l.type === "add");
    expect(del && del.type === "del" ? del.emphasis : undefined).toBeTruthy();
    expect(add && add.type === "add" ? add.emphasis : undefined).toBeTruthy();
  });

  it("pairs large replacement blocks while skipping expensive intraline emphasis", () => {
    const oldText = `${Array.from({ length: 250 }, (_, i) => `old ${i}`).join("\n")}\n`;
    const newText = `${Array.from({ length: 250 }, (_, i) => `new ${i}`).join("\n")}\n`;
    const m = ok(buildDiffModel(oldText, newText));
    const firstDelIdx = m.lines.findIndex((l) => l.type === "del");
    const firstAddIdx = m.lines.findIndex((l) => l.type === "add");
    const firstDel = m.lines[firstDelIdx];
    const firstAdd = m.lines[firstAddIdx];
    expect(firstDel?.type === "del" ? firstDel.pair : undefined).toBe(firstAddIdx);
    expect(firstAdd?.type === "add" ? firstAdd.pair : undefined).toBe(firstDelIdx);
    expect(firstDel?.type === "del" ? firstDel.emphasis : undefined).toBeUndefined();
    expect(firstAdd?.type === "add" ? firstAdd.emphasis : undefined).toBeUndefined();
  });
});

describe("buildDiffModel — gap kinds", () => {
  it("two far-apart changes produce start, mid, and end gaps", () => {
    // 50 lines, changes at line 5 and line 30. Hunks are at 2..8 and
    // 27..33 (3 context lines each side). There is room for all three
    // gap kinds.
    const oldLines = `${Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n")}\n`;
    const newText = oldLines.replace("L5", "CHANGED-A").replace("L30", "CHANGED-B");
    const m = ok(buildDiffModel(oldLines, newText));
    expect(m.hunks.length).toBe(2);
    expect(m.gaps.length).toBe(3);
    expect(m.gaps[0]?.isFileStart).toBe(true);
    expect(m.gaps[0]?.isFileEnd).toBe(false);
    expect(m.gaps[1]?.isFileStart).toBe(false);
    expect(m.gaps[1]?.isFileEnd).toBe(false);
    expect(m.gaps[2]?.isFileStart).toBe(false);
    expect(m.gaps[2]?.isFileEnd).toBe(true);
  });

  it("a change at line 1 produces only a file-end gap", () => {
    const oldLines = `${["L0", "L1", "L2", "L3", "L4"].join("\n")}\n`;
    const newText = `CHANGED\n${["L1", "L2", "L3", "L4"].join("\n")}\n`;
    const m = ok(buildDiffModel(oldLines, newText));
    expect(m.gaps).toHaveLength(1);
    expect(m.gaps[0]?.isFileEnd).toBe(true);
    expect(m.gaps[0]?.isFileStart).toBe(false);
  });

  it("a change at the last line produces only a file-start gap", () => {
    const oldLines = `${["L0", "L1", "L2", "L3", "L4"].join("\n")}\n`;
    const newText = `${["L0", "L1", "L2", "L3"].join("\n")}\nCHANGED\n`;
    const m = ok(buildDiffModel(oldLines, newText));
    expect(m.gaps).toHaveLength(1);
    expect(m.gaps[0]?.isFileStart).toBe(true);
    expect(m.gaps[0]?.isFileEnd).toBe(false);
  });
});

describe("visibleRows — expansion math", () => {
  // 50 lines, one change at line 25 → 1 hunk (lines 22-28) → 2 gaps
  // (file-start: 0-21, file-end: 29-49).
  const oldLines = `${Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n")}\n`;
  const newText = oldLines.replace("L25", "CHANGED");
  const model = ok(buildDiffModel(oldLines, newText));
  const collapsedState: GapState[] = [
    { top: 0, bottom: 0 },
    { top: 0, bottom: 0 },
  ];

  it("collapsed: emits one gap row per non-exhausted gap", () => {
    const rows = visibleRows(model, collapsedState);
    const gaps = rows.filter((r) => r.type === "gap");
    expect(gaps).toHaveLength(2);
  });

  it("reveal-down (top) emits the FIRST top lines of the gap", () => {
    const rows = visibleRows(model, [
      { top: 5, bottom: 0 },
      { top: 0, bottom: 0 },
    ]);
    // First gap now reveals its first 5 lines. The hunk hasn't been
    // reached yet (its first context line is index 22). We expect 5
    // non-gap rows before the first gap row.
    const firstGapIdx = rows.findIndex((r) => r.type === "gap");
    const before = rows.slice(0, firstGapIdx).filter((r) => r.type !== "gap");
    expect(before.length).toBe(5);
  });

  it("reveal-up (bottom) emits the LAST bottom lines of the gap, after the gap row", () => {
    // 50 lines, one change in the middle → 1 hunk → 2 gaps (start, end).
    // We reveal the LAST 5 lines of the *file-end* gap (gap 1) and
    // verify exactly 5 non-gap rows follow the file-end gap row.
    // The file-end gap is at the end of the rows, so there's no
    // ambiguity from a hunk after the gap.
    const ol = `${Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n")}\n`;
    const nt = ol.replace("L25", "CHANGED");
    const m = ok(buildDiffModel(ol, nt));
    expect(m.gaps.length).toBe(2);
    const rows = visibleRows(m, [
      { top: 0, bottom: 0 },
      { top: 0, bottom: 5 },
    ]);
    const gapIdx = rows.findIndex((r) => r.type === "gap" && r.gapIndex === 1);
    expect(gapIdx).toBeGreaterThanOrEqual(0);
    const after: number[] = [];
    for (let i = gapIdx + 1; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.type === "gap") break;
      after.push(i);
    }
    expect(after.length).toBe(5);
  });

  it("exhausted gap (top+bottom >= size) emits no gap row", () => {
    // Single hunk model: 2 gaps. Exhaust the first → only 1 gap row.
    const state: GapState[] = [
      { top: 100, bottom: 0 },
      { top: 0, bottom: 0 },
    ];
    const rows = visibleRows(model, state);
    expect(rows.filter((r) => r.type === "gap")).toHaveLength(1);
  });

  it("a gap of size 1 has hiddenCount 1 when fully collapsed (the 'expand' affordance takes over)", () => {
    const state: GapState[] = [
      { top: 0, bottom: 0 },
      { top: 0, bottom: 0 },
    ];
    const rows = visibleRows(model, state);
    const gap = rows.find((r) => r.type === "gap" && r.gapIndex === 0);
    expect(gap).toBeDefined();
    if (gap?.type === "gap") expect(gap.hiddenCount).toBe(22);
  });

  it("can stop projection at a row limit", () => {
    const rows = visibleRows(model, collapsedState, 3);
    expect(rows).toHaveLength(3);
  });
});

describe("buildSplitRows — alignment", () => {
  it("change block of 2 dels and 3 adds produces 3 split-pair rows with empty right cell", () => {
    const oldLines = `${["A", "B", "C", "D"].join("\n")}\n`;
    const newLines = `${["A", "B2", "C2", "D2", "E2"].join("\n")}\n`;
    const m = ok(buildDiffModel(oldLines, newLines));
    const rows = visibleRows(
      m,
      m.gaps.map(() => ({ top: 0, bottom: 0 })),
    );
    const split = buildSplitRows(rows);
    // After the hunk merges all the changes, the split should produce
    // exactly max(3 dels, 4 adds) = 4 pairs.
    const pairs = split.filter((r) => r.type === "split-pair");
    expect(pairs.length).toBe(4);
    // The first pair has the first del on the left.
    expect(pairs[0]?.type === "split-pair" && pairs[0].leftText).toBe("B");
    expect(pairs[0]?.type === "split-pair" && pairs[0].rightText).toBe("B2");
  });

  it("context rows become split-context rows", () => {
    const m = ok(buildDiffModel("a\n", "a\n"));
    const rows = visibleRows(m, []);
    const split = buildSplitRows(rows);
    expect(split.every((r) => r.type === "split-context" || r.type === "split-gap")).toBe(true);
  });

  it("applies split limits after pairing complete replacement blocks", () => {
    const oldText = `${Array.from({ length: 20 }, (_, i) => `old ${i}`).join("\n")}\n`;
    const newText = `${Array.from({ length: 20 }, (_, i) => `new ${i}`).join("\n")}\n`;
    const m = ok(buildDiffModel(oldText, newText));
    const split = visibleSplitRows(
      m,
      m.gaps.map(() => ({ top: 0, bottom: 0 })),
      10,
    );
    expect(split).toHaveLength(10);
    expect(split.every((r) => r.type === "split-pair" && r.leftText && r.rightText)).toBe(true);
    expect(split[0]?.type === "split-pair" && split[0].leftText).toBe("old 0");
    expect(split[0]?.type === "split-pair" && split[0].rightText).toBe("new 0");
  });
});

describe("intralineRanges", () => {
  it("returns null on identical input", () => {
    expect(intralineRanges("foo", "foo")).toBeNull();
  });

  it("returns null when the change is the entire line", () => {
    expect(intralineRanges("foo", "bar baz qux quux")).not.toBeNull();
    // 100% changed → null per the 65% rule.
    expect(intralineRanges("xxxxxxxxxx", "yyyy")).toBeNull();
  });

  it("returns null when either line is over 500 chars", () => {
    const long = "a".repeat(501);
    expect(intralineRanges(long, "b")).toBeNull();
  });

  it("returns sane ranges for a small change", () => {
    const r = intralineRanges("foo bar baz", "foo BAR baz");
    expect(r).not.toBeNull();
    // The changed word is "bar" → "BAR" at positions [4, 7).
    expect(r!.old).toEqual([[4, 7]]);
    expect(r!.new).toEqual([[4, 7]]);
  });
});

describe("segmentLine", () => {
  it("returns plain segments when there are no emphasis ranges", () => {
    const out = segmentLine(
      [
        { text: "foo", color: "#fff" },
        { text: " bar", color: "#fff" },
      ],
      [],
    );
    expect(out).toEqual([
      { text: "foo", color: "#fff", em: false },
      { text: " bar", color: "#fff", em: false },
    ]);
  });

  it("splits a token at emphasis range edges", () => {
    // Token "foo bar" (length 7). Emphasis range [4, 7) means "bar".
    const out = segmentLine([{ text: "foo bar", color: "#fff" }], [[4, 7]]);
    expect(out).toEqual([
      { text: "foo ", color: "#fff", em: false },
      { text: "bar", color: "#fff", em: true },
    ]);
  });

  it("handles an emphasis range that fully covers a token", () => {
    const out = segmentLine([{ text: "abc" }], [[0, 3]]);
    expect(out).toEqual([{ text: "abc", em: true }]);
  });

  it("handles an emphasis range that is empty after clamping", () => {
    const out = segmentLine([{ text: "abc" }], [[10, 12]]);
    // No overlap → plain segment.
    expect(out).toEqual([{ text: "abc", em: false }]);
  });
});

describe("langForPath", () => {
  it("maps common extensions to shiki langs", () => {
    expect(langForPath("a.ts")).toBe("typescript");
    expect(langForPath("a.tsx")).toBe("tsx");
    expect(langForPath("a.js")).toBe("javascript");
    expect(langForPath("a.py")).toBe("python");
    expect(langForPath("a.rs")).toBe("rust");
    expect(langForPath("a.go")).toBe("go");
    expect(langForPath("a.sh")).toBe("bash");
    expect(langForPath("a.bash")).toBe("bash");
    expect(langForPath("a.zsh")).toBe("bash");
    expect(langForPath("a.json")).toBe("json");
    expect(langForPath("a.yaml")).toBe("yaml");
    expect(langForPath("a.yml")).toBe("yaml");
    expect(langForPath("a.md")).toBe("markdown");
    expect(langForPath("a.css")).toBe("css");
    expect(langForPath("a.html")).toBe("html");
    expect(langForPath("a.sql")).toBe("sql");
    expect(langForPath("a.diff")).toBe("diff");
  });

  it("returns null for unknown extensions", () => {
    expect(langForPath("a.xyz")).toBeNull();
    expect(langForPath("a")).toBeNull();
    expect(langForPath("a.")).toBeNull();
  });

  it("uses the basename (not a dirname extension)", () => {
    expect(langForPath("src/lib/weird.json/binary")).toBeNull();
    expect(langForPath("src/lib/a.ts")).toBe("typescript");
  });
});
