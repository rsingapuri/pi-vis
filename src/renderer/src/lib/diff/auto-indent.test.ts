// Vitest suite for the diff edit card's auto-indent / tab helpers.

import { describe, expect, it } from "vitest";
import { detectIndentUnit, enterInsertion, indentEdit } from "./auto-indent.js";

describe("detectIndentUnit", () => {
  it("defaults to 2 spaces when there is no indentation", () => {
    expect(detectIndentUnit("a\nb\nc")).toBe("  ");
  });
  it("detects tabs when tab-indentation dominates", () => {
    expect(detectIndentUnit("if (x) {\n\tdoThing();\n\tother();\n}")).toBe("\t");
  });
  it("detects 4-space indentation", () => {
    expect(detectIndentUnit("if (x) {\n    doThing();\n    other();\n}")).toBe("    ");
  });
  it("detects 2-space indentation", () => {
    expect(detectIndentUnit("if (x) {\n  doThing();\n  other();\n}")).toBe("  ");
  });
  it("prefers tabs when space and tab counts tie and tabs are present", () => {
    // One tab line, one 2-space line → not tab-majority (equal) → 2 spaces.
    expect(detectIndentUnit("\ta\n  b")).toBe("  ");
    // Two tab lines vs one 2-space → tab majority.
    expect(detectIndentUnit("\ta\n\tb\n  c")).toBe("\t");
  });
});

describe("enterInsertion", () => {
  const unit = "  ";
  it("copies the previous line's leading whitespace", () => {
    // caret after "  foo" on an indented line.
    const buf = "  foo";
    expect(enterInsertion(buf, 5, unit)).toBe("\n  ");
  });
  it("adds an extra indent unit after a trailing brace", () => {
    const buf = "function () {";
    expect(enterInsertion(buf, buf.length, unit)).toBe("\n  ");
  });
  it("adds an extra indent unit after `(`, `[`, and `:`", () => {
    expect(enterInsertion("arr = [", 7, unit)).toBe("\n  ");
    expect(enterInsertion("foo(", 4, unit)).toBe("\n  ");
    expect(enterInsertion("const x:", 8, unit)).toBe("\n  ");
  });
  it("does not add an extra unit after a normal line", () => {
    expect(enterInsertion("return 42", 9, unit)).toBe("\n");
  });
  it("ignores trailing whitespace when deciding on the extra unit", () => {
    // An indented line with trailing spaces before the caret: the leading ws
    // ("  ") is copied AND an extra unit is added because the trimmed end is `{`.
    const buf = "  if (x) {   ";
    expect(enterInsertion(buf, buf.length, unit)).toBe("\n    ");
  });
  it("handles a caret in the middle of a line", () => {
    // "foo|bar" at offset 3 → splits; copies the (empty) leading ws.
    expect(enterInsertion("foobar", 3, unit)).toBe("\n");
  });
  it("respects the detected unit (tabs)", () => {
    expect(enterInsertion("if (x) {", 8, "\t")).toBe("\n\t");
  });
});

describe("indentEdit", () => {
  const unit = "  ";

  it("collapsed Tab inserts the unit at the caret", () => {
    const buf = "abc";
    const p = indentEdit(buf, 2, 2, unit, "in");
    expect(p).toMatchObject({ replaceStart: 2, replaceEnd: 2, replacement: "  " });
    expect(p.selStart).toBe(4);
    expect(p.selEnd).toBe(4);
    // Applying it:
    expect(buf.slice(0, p.replaceStart) + p.replacement + buf.slice(p.replaceEnd)).toBe("ab  c");
  });

  it("collapsed Shift-Tab dedents the current line", () => {
    const buf = "  foo";
    const p = indentEdit(buf, 4, 4, unit, "out");
    expect(p.replacement).toBe("foo");
    const next = buf.slice(0, p.replaceStart) + p.replacement + buf.slice(p.replaceEnd);
    expect(next).toBe("foo");
  });

  it("multi-line Tab indents every touched line", () => {
    const buf = "a\nb\nc";
    // select from start of "b" through the end of "c"
    const p = indentEdit(buf, 2, 5, unit, "in");
    const next = buf.slice(0, p.replaceStart) + p.replacement + buf.slice(p.replaceEnd);
    expect(next).toBe("a\n  b\n  c");
    expect(p.selStart).toBe(2);
    expect(p.selEnd).toBe(2 + "  b\n  c".length);
  });

  it("multi-line Tab does not touch a line the selection ends at column 0 of", () => {
    // Selection [2,4) selects "b\n" (ends at the start of "c") → only b indents.
    const buf = "a\nb\nc";
    const p = indentEdit(buf, 2, 4, unit, "in");
    const next = buf.slice(0, p.replaceStart) + p.replacement + buf.slice(p.replaceEnd);
    expect(next).toBe("a\n  b\nc");
  });

  it("multi-line Shift-Tab dedents every touched line", () => {
    const buf = "  a\n  b\n  c";
    // selection from the start of "  b" into "  c"
    const p = indentEdit(buf, 4, 9, unit, "out");
    const next = buf.slice(0, p.replaceStart) + p.replacement + buf.slice(p.replaceEnd);
    expect(next).toBe("  a\nb\nc");
  });

  it("partially-indented line dedents only the spaces it has", () => {
    const buf = " a"; // one space, unit is two
    const p = indentEdit(buf, 2, 2, unit, "out");
    const next = buf.slice(0, p.replaceStart) + p.replacement + buf.slice(p.replaceEnd);
    expect(next).toBe("a");
  });

  it("does nothing harmful dedenting a line with no leading whitespace", () => {
    const buf = "foo";
    const p = indentEdit(buf, 3, 3, unit, "out");
    const next = buf.slice(0, p.replaceStart) + p.replacement + buf.slice(p.replaceEnd);
    expect(next).toBe("foo");
  });

  it("works with a tab unit for collapsed Tab", () => {
    const buf = "abc";
    const p = indentEdit(buf, 1, 1, "\t", "in");
    expect(p.replacement).toBe("\t");
  });
});
