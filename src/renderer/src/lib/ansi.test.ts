import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi.js";

describe("parseAnsi", () => {
  it("passes plain text through as one unstyled span", () => {
    expect(parseAnsi("hello")).toEqual([{ text: "hello", style: {} }]);
  });

  it("parses the real pi headroom status (truecolor + reset)", () => {
    // Exactly what pi-headroom sends: green ✓, dim gray label
    const input = "\x1b[38;2;181;189;104m✓ \x1b[39m \x1b[38;2;102;102;102m Headroom \x1b[39m";
    const spans = parseAnsi(input);
    expect(spans).toEqual([
      { text: "✓ ", style: { color: "rgb(181,189,104)" } },
      { text: " ", style: {} },
      { text: " Headroom ", style: { color: "rgb(102,102,102)" } },
    ]);
    expect(stripAnsi(input)).toBe("✓   Headroom ");
  });

  it("handles named colors, bold, and full reset", () => {
    const spans = parseAnsi("\x1b[1;32mok\x1b[0m done");
    expect(spans).toEqual([
      { text: "ok", style: { fontWeight: "bold", color: "#a6e3a1" } },
      { text: " done", style: {} },
    ]);
  });

  it("handles 256-color codes", () => {
    const spans = parseAnsi("\x1b[38;5;196mred\x1b[39m");
    expect(spans[0]).toEqual({ text: "red", style: { color: "rgb(255,0,0)" } });
  });

  it("treats bare ESC[m as a reset", () => {
    const spans = parseAnsi("\x1b[31ma\x1b[mb");
    expect(spans).toEqual([
      { text: "a", style: { color: "#f38ba8" } },
      { text: "b", style: {} },
    ]);
  });

  it("strips non-SGR escape sequences", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Gline")).toBe("line");
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("keeps dim/italic and clears them on 22/23", () => {
    const spans = parseAnsi("\x1b[2;3mfaint\x1b[22;23mnormal");
    expect(spans[0]).toEqual({ text: "faint", style: { opacity: 0.6, fontStyle: "italic" } });
    expect(spans[1]).toEqual({ text: "normal", style: {} });
  });
});
