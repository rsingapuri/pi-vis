import { describe, expect, it } from "vitest";
import {
  BUNDLED_THEMES,
  type Theme,
  ThemeSchema,
  buildThemeRegistry,
  piThemeForTheme,
  resolveTheme,
  resolveThemeForAppearance,
} from "./index.js";

const baseColors = BUNDLED_THEMES[0]!.colors;

// `over` is loosely typed so negative cases can supply intentionally-invalid
// shapes (the whole point is to assert ThemeSchema rejects them).
function makeTheme(over: Record<string, unknown>): unknown {
  return {
    id: "test-theme",
    name: "Test",
    appearance: "dark",
    colors: baseColors,
    syntax: { ref: "catppuccin-mocha" },
    ...over,
  };
}

describe("ThemeSchema syntax: ref | inline optionality", () => {
  it("accepts the ref route", () => {
    const r = ThemeSchema.safeParse(makeTheme({ syntax: { ref: "nord" } }));
    expect(r.success).toBe(true);
  });

  it("accepts the inline route (a TextMate theme object with a name)", () => {
    const r = ThemeSchema.safeParse(
      makeTheme({
        syntax: {
          inline: {
            name: "my-syntax",
            type: "dark",
            colors: {},
            tokenColors: [{ scope: "comment", settings: { foreground: "#888888" } }],
          },
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects an inline theme with no name", () => {
    const r = ThemeSchema.safeParse(makeTheme({ syntax: { inline: { type: "dark" } } }));
    expect(r.success).toBe(false);
  });

  it("rejects an empty syntax object (neither ref nor inline)", () => {
    const r = ThemeSchema.safeParse(makeTheme({ syntax: {} }));
    expect(r.success).toBe(false);
  });

  it("rejects a non-kebab id", () => {
    const r = ThemeSchema.safeParse(makeTheme({ id: "Not Kebab" }));
    expect(r.success).toBe(false);
  });

  it("rejects a colors map missing a token", () => {
    const { accent, ...partial } = baseColors;
    const r = ThemeSchema.safeParse(makeTheme({ colors: partial as Theme["colors"] }));
    expect(r.success).toBe(false);
  });

  it("accepts the optional accent-fill/on-accent roles, present or absent", () => {
    // Absent — the shape every pre-existing user theme file has.
    expect(ThemeSchema.safeParse(makeTheme({})).success).toBe(true);
    // Present.
    const withOptional = ThemeSchema.safeParse(
      makeTheme({
        colors: { ...baseColors, "accent-fill": "#cd3c00", "on-accent": "#fff8f5" },
      }),
    );
    expect(withOptional.success).toBe(true);
  });

  it("still rejects unknown color keys (strict shape)", () => {
    const r = ThemeSchema.safeParse(
      makeTheme({ colors: { ...baseColors, "not-a-role": "#123456" } }),
    );
    expect(r.success).toBe(false);
  });
});

describe("registry resolution", () => {
  it("resolves a bundled id", () => {
    const reg = buildThemeRegistry();
    expect(resolveTheme("gruvbox-material-dark", reg).id).toBe("gruvbox-material-dark");
  });

  it("falls back to the default theme for an unknown id", () => {
    const reg = buildThemeRegistry();
    expect(resolveTheme("does-not-exist", reg).id).toBe("mocha");
  });

  it("lets a user theme override a bundled id", () => {
    const override = ThemeSchema.parse(
      makeTheme({ id: "mocha", name: "My Mocha", appearance: "light" }),
    );
    const reg = buildThemeRegistry([override]);
    expect(resolveTheme("mocha", reg).name).toBe("My Mocha");
    expect(resolveTheme("mocha", reg).appearance).toBe("light");
  });

  it("adds a brand-new user theme alongside the bundled set", () => {
    const custom = ThemeSchema.parse(makeTheme({ id: "user-neon", name: "Neon" }));
    const reg = buildThemeRegistry([custom]);
    expect(resolveTheme("user-neon", reg).name).toBe("Neon");
    // bundled themes still present
    expect(resolveTheme("mocha", reg).id).toBe("mocha");
  });

  it("falls back by expected appearance for stale split-theme ids", () => {
    const reg = buildThemeRegistry();
    expect(resolveThemeForAppearance("deleted-light-theme", "light", reg).id).toBe("latte");
    expect(resolveThemeForAppearance("deleted-dark-theme", "dark", reg).id).toBe("mocha");
  });

  it("does not accept a wrong-appearance saved id for a split-theme slot", () => {
    const reg = buildThemeRegistry();
    expect(resolveThemeForAppearance("mocha", "light", reg).id).toBe("latte");
    expect(resolveThemeForAppearance("latte", "dark", reg).id).toBe("mocha");
  });
});

describe("piThemeForTheme (pi light/dark mapping)", () => {
  it("maps appearance straight through", () => {
    const latte = BUNDLED_THEMES.find((t) => t.id === "latte")!;
    const mocha = BUNDLED_THEMES.find((t) => t.id === "mocha")!;
    expect(piThemeForTheme(latte)).toBe("light");
    expect(piThemeForTheme(mocha)).toBe("dark");
  });
});
