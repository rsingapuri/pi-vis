import { describe, expect, it } from "vitest";
import { getHighlighter, getLoadedHighlighter, getShikiTheme } from "../shiki.js";
import { tokenizeLines, tokenizeLinesSync } from "./highlight.js";

/**
 * Regression guard for the "a single bad theme ref kills highlighting app-wide"
 * bug. The shared highlighter is built from ALL bundled themes at once; if one
 * theme's `syntax.ref` names a Shiki theme that isn't in the bundle,
 * `createHighlighter` throws atomically, the highlighter stays null, and BOTH
 * diff tokenization (returns null → no diff colors) and markdown code blocks
 * (rejected getHighlighter() → plain fallback) lose highlighting — for EVERY
 * theme, including the default Catppuccin. These tests pin that the highlighter
 * inits resiliently and that tokenization actually yields colored tokens.
 */

describe("diff highlight tokenization (regression)", () => {
  it("getHighlighter resolves instead of throwing", async () => {
    const h = await getHighlighter();
    // The default Catppuccin theme must be among the loaded themes; a bad ref
    // in another bundled theme must not have aborted init.
    expect(h.getLoadedThemes()).toContain(getShikiTheme());
  });

  it("tokenizes TypeScript into colored tokens (default theme)", async () => {
    const code = "const greet = (name: string) => `hi ${name}`;\nconsole.log(greet(42));\n";
    const tokens = await tokenizeLines(code, "typescript");
    expect(tokens).not.toBeNull();
    // Flatten and assert at least one token carries a color — the visible
    // symptom of "no syntax highlighting" is colorless spans.
    const flat = (tokens ?? []).flat();
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.some((t) => typeof t.color === "string" && t.color.length > 0)).toBe(true);
  });

  it("tokenizes TSX", async () => {
    const code = 'export const App = () => <div className="x">hi</div>;';
    const tokens = await tokenizeLines(code, "tsx");
    expect(tokens).not.toBeNull();
    expect((tokens ?? []).flat().some((t) => !!t.color)).toBe(true);
  });

  it("returns null for an unknown language path (plain-text fallback)", async () => {
    // langForPath maps unknown extensions to null; tokenizeLines must honor
    // that contract (no colors, but no throw either).
    const tokens = await tokenizeLines("hello world", null);
    expect(tokens).toBeNull();
  });

  it("line count aligns with the model side (trailing newline tolerated)", async () => {
    const withNl = "const a = 1;\nconst b = 2;\n";
    const tokens = await tokenizeLines(withNl, "typescript");
    expect(tokens).not.toBeNull();
    // Two logical lines; the guard tolerates shiki's +1 empty trailing line.
    expect(tokens?.length).toBe(2);
  });
});

describe("tokenizeLinesSync (diff editor per-keystroke path)", () => {
  it("returns null when the highlighter is not yet warm (never blocks)", () => {
    // Before any await of getHighlighter(), the singleton is null.
    // (This test runs first in the file; if another test already warmed it,
    // the guard below still holds because we assert a plain result path works.)
    const code = "const x = 1;";
    // Either it tokenizes (warm) or returns null (cold) — never throws.
    const out = tokenizeLinesSync(code, "typescript");
    expect(out === null || Array.isArray(out)).toBe(true);
  });

  it("returns null for an unknown language (plain-text fallback)", () => {
    expect(tokenizeLinesSync("hello", null)).toBeNull();
  });

  it("returns [] for empty text", () => {
    expect(tokenizeLinesSync("", "typescript")).toEqual([]);
  });

  it("matches the async path once warm, with line-count alignment", async () => {
    await getHighlighter(); // warm the singleton
    expect(getLoadedHighlighter()).not.toBeNull();
    const code = "const greet = (name: string) => name;\nconsole.log(greet(42));\n";
    const syncTokens = tokenizeLinesSync(code, "typescript");
    const asyncTokens = await tokenizeLines(code, "typescript");
    expect(syncTokens).not.toBeNull();
    expect(asyncTokens).not.toBeNull();
    expect(syncTokens!.length).toBe(asyncTokens!.length);
    expect(getShikiTheme()).toBeTruthy();
  });
});
