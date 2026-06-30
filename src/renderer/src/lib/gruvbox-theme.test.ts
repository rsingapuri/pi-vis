import { BUNDLED_THEMES, ThemeSchema } from "@shared/theme";
import gruvboxJson from "@shared/theme/themes/gruvbox-material-dark.json";
import { describe, expect, it } from "vitest";
import { getHighlighter } from "./shiki.js";

describe("gruvbox theme is valid + loadable", () => {
  it("parses through ThemeSchema", () => {
    const parsed = ThemeSchema.parse(gruvboxJson);
    expect(parsed.syntax).toBeDefined();
    expect(parsed.id).toBe("gruvbox-material-dark");
  });

  it("is present in BUNDLED_THEMES and parses there too", () => {
    const ids = BUNDLED_THEMES.map((t) => t.id);
    expect(ids).toContain("gruvbox-material-dark");
  });

  it("loads into the highlighter and colorizes code", async () => {
    const h = await getHighlighter();
    expect(h.getLoadedThemes()).toContain("gruvbox-material-dark");
    const r = h.codeToTokens("const x = 1;", {
      lang: "typescript",
      theme: "gruvbox-material-dark",
    });
    const flat = r.tokens.flat();
    expect(flat.some((t) => !!t.color)).toBe(true);
  });
});
