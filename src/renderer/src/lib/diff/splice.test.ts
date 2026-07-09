// Vitest suite for the splice helpers — the byte-exact save primitive.
//
// The contract (invariant 3): a save changes ONLY the replaced new-side line
// range; bytes outside it (EOL style incl. CRLF, BOM, missing final newline)
// are preserved byte-for-byte.

import { describe, expect, it } from "vitest";
import { detectEol, lineSpans, spliceNewLines } from "./splice.js";

describe("lineSpans", () => {
  it("returns [] for empty text", () => {
    expect(lineSpans("")).toEqual([]);
  });

  it("splits LF lines and records offsets", () => {
    const spans = lineSpans("a\nbc\n");
    expect(spans.map((s) => s.text)).toEqual(["a", "bc"]);
    expect(spans[0]).toMatchObject({ start: 0, contentEnd: 1, end: 2, eol: "\n" });
    expect(spans[1]).toMatchObject({ start: 2, contentEnd: 4, end: 5, eol: "\n" });
  });

  it("treats CRLF as a single EOL (strips the CR from content)", () => {
    const spans = lineSpans("a\r\nb\r\n");
    expect(spans.map((s) => s.text)).toEqual(["a", "b"]);
    expect(spans[0]).toMatchObject({ contentEnd: 1, end: 3, eol: "\r\n" });
    expect(spans[1]).toMatchObject({ contentEnd: 4, end: 6, eol: "\r\n" });
  });

  it("does NOT treat a lone CR as an EOL", () => {
    // "a\rb" is ONE line under the model's splitter.
    const spans = lineSpans("a\rb");
    expect(spans.map((s) => s.text)).toEqual(["a\rb"]);
    expect(spans[0]).toMatchObject({ eol: "" });
  });

  it("keeps a BOM as part of line 1's text (model parity)", () => {
    const spans = lineSpans("\uFEFFa\nb\n");
    expect(spans[0]!.text).toBe("\uFEFFa");
    expect(spans[0]!.start).toBe(0);
  });

  it("records no trailing span when text ends with a newline (model parity)", () => {
    expect(lineSpans("a\n").map((s) => s.text)).toEqual(["a"]);
    expect(lineSpans("a\n\n").map((s) => s.text)).toEqual(["a", ""]);
    expect(lineSpans("\n").map((s) => s.text)).toEqual([""]);
  });
});

describe("detectEol", () => {
  it("detects LF", () => {
    expect(detectEol("a\nb\nc\n")).toBe("\n");
  });
  it("detects CRLF", () => {
    expect(detectEol("a\r\nb\r\nc\r\n")).toBe("\r\n");
  });
  it("falls back to LF when there is no EOL", () => {
    expect(detectEol("abc")).toBe("\n");
  });
  it("resolves a tie to LF", () => {
    expect(detectEol("a\nb\r\n")).toBe("\n");
  });
});

describe("spliceNewLines", () => {
  it("replaces a single interior line (LF)", () => {
    expect(spliceNewLines("a\nb\nc\n", 2, 2, ["X"])).toBe("a\nX\nc\n");
  });

  it("replaces a multi-line range (LF)", () => {
    expect(spliceNewLines("a\nb\nc\nd\n", 2, 3, ["X", "Y"])).toBe("a\nX\nY\nd\n");
  });

  it("grows the file when replacement has more lines", () => {
    expect(spliceNewLines("a\nb\nc\n", 2, 2, ["X", "Y", "Z"])).toBe("a\nX\nY\nZ\nc\n");
  });

  it("shrinks the file when replacement has fewer lines", () => {
    expect(spliceNewLines("a\nb\nc\nd\n", 2, 3, ["X"])).toBe("a\nX\nd\n");
  });

  it("deletes the range when replacement is empty (interior)", () => {
    // Region "b\n" is removed; "c" becomes line 2.
    expect(spliceNewLines("a\nb\nc\n", 2, 2, [])).toBe("a\nc\n");
  });

  it("deletes a multi-line interior range", () => {
    expect(spliceNewLines("a\nb\nc\nd\n", 2, 3, [])).toBe("a\nd\n");
  });

  // ── First / last / whole file ────────────────────────────────────────

  it("replaces the first line", () => {
    expect(spliceNewLines("a\nb\nc\n", 1, 1, ["X"])).toBe("X\nb\nc\n");
  });

  it("replaces the last line that HAS a trailing newline", () => {
    expect(spliceNewLines("a\nb\nc\n", 3, 3, ["X"])).toBe("a\nb\nX\n");
  });

  it("deletes the last line WITH a trailing newline (keeps prior EOL)", () => {
    // Remove "c\n"; the file keeps the newline that ended line 2.
    expect(spliceNewLines("a\nb\nc\n", 3, 3, [])).toBe("a\nb\n");
  });

  it("replaces the whole file", () => {
    expect(spliceNewLines("a\nb\n", 1, 2, ["X", "Y"])).toBe("X\nY\n");
  });

  it("deletes the whole file down to empty", () => {
    expect(spliceNewLines("a\nb\n", 1, 2, [])).toBe("");
  });

  // ── Missing final newline ────────────────────────────────────────────

  it("replaces the last line when there is NO final newline", () => {
    expect(spliceNewLines("a\nb\nc", 3, 3, ["X"])).toBe("a\nb\nX");
  });

  it("does NOT add a trailing newline when editing the last line of a no-final-newline file", () => {
    expect(spliceNewLines("a\nb\nc", 3, 3, ["X", "Y"])).toBe("a\nb\nX\nY");
  });

  it("deletes an interior line in a no-final-newline file", () => {
    expect(spliceNewLines("a\nb\nc", 2, 2, [])).toBe("a\nc");
  });

  // ── CRLF preservation ────────────────────────────────────────────────

  it("preserves CRLF when replacing in a CRLF region", () => {
    expect(spliceNewLines("a\r\nb\r\nc\r\n", 2, 2, ["X"])).toBe("a\r\nX\r\nc\r\n");
  });

  it("preserves CRLF across a multi-line replacement", () => {
    expect(spliceNewLines("a\r\nb\r\nc\r\n", 1, 2, ["X", "Y"])).toBe("X\r\nY\r\nc\r\n");
  });

  it("deletes a CRLF line cleanly", () => {
    expect(spliceNewLines("a\r\nb\r\nc\r\n", 2, 2, [])).toBe("a\r\nc\r\n");
  });

  it("preserves the missing final newline in a CRLF file", () => {
    expect(spliceNewLines("a\r\nb\r\nc", 3, 3, ["X"])).toBe("a\r\nb\r\nX");
  });

  // ── Mixed-EOL regions ────────────────────────────────────────────────

  it("joins replacement with the region-dominant EOL on a CRLF-dominant region", () => {
    // In the [2..3] region both lines are CRLF, so the replacement joins with
    // CRLF even though the file overall is mixed (lines 1 and 4 are LF).
    const out = spliceNewLines("a\nb\r\nc\r\nd\n", 2, 3, ["X", "Y"]);
    expect(out).toBe("a\nX\r\nY\r\nd\n");
  });

  it("falls back to the file-dominant EOL when the region is evenly split", () => {
    // Region [2..3] has one CRLF + one LF line; the file is LF-dominant overall.
    const out = spliceNewLines("a\nb\r\nc\n", 2, 3, ["X", "Y"]);
    expect(out).toBe("a\nX\nY\n");
  });

  // ── BOM ──────────────────────────────────────────────────────────────

  it("preserves the BOM when editing line 1 (the buffer is seeded with it)", () => {
    // The splice primitive is BOM-neutral: it replaces line 1's content (which
    // includes the BOM) with the given buffer. BOM preservation in the real
    // flow comes from seeding the buffer from model line text (which carries
    // the BOM), so the buffer passed in still starts with the BOM.
    const out = spliceNewLines("\uFEFFa\nb\n", 1, 1, ["\uFEFFX"]);
    expect(out).toBe("\uFEFFX\nb\n");
  });

  it("preserves the BOM when editing line 2 (it is in the untouched prefix)", () => {
    const out = spliceNewLines("\uFEFFa\nb\n", 2, 2, ["X"]);
    expect(out).toBe("\uFEFFa\nX\n");
  });

  // ── Bounds ───────────────────────────────────────────────────────────

  it("throws on an out-of-bounds range", () => {
    expect(() => spliceNewLines("a\nb\n", 0, 1, ["X"])).toThrow();
    expect(() => spliceNewLines("a\nb\n", 1, 3, ["X"])).toThrow();
    expect(() => spliceNewLines("a\nb\n", 2, 1, ["X"])).toThrow();
  });
});
