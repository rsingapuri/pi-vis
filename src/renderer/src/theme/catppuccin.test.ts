import { describe, expect, it } from "vitest";
import { palettes } from "./catppuccin.js";

/**
 * Every Catppuccin flavor must expose `shadow` and `scrim` keys, because
 * `applyColorScheme()` in `stores/settings-store.ts` iterates
 * `Object.entries(palette)` and sets `--ctp-<token>` for each one — if a
 * flavor is missing a key, components that reference `var(--ctp-*)` for
 * that token would render with the bare default from theme.css.
 *
 * The values are validated as well-formed `rgb()` / `rgba()` color
 * strings so a typo can't silently leak a `undefined` token into CSS.
 */

const FLAVORS = ["latte", "frappe", "macchiato", "mocha"] as const;

const RGBA_RE = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/;

function expectRgba(value: unknown): void {
  expect(typeof value).toBe("string");
  const match = RGBA_RE.exec(value as string);
  expect(match, `expected rgb/rgba color, got: ${String(value)}`).not.toBeNull();
}

describe("catppuccin palettes", () => {
  it("exposes all four flavors", () => {
    expect(Object.keys(palettes).sort()).toEqual([...FLAVORS].sort());
  });

  for (const flavor of FLAVORS) {
    describe(flavor, () => {
      const palette = palettes[flavor];

      it("has a `shadow` color", () => {
        expectRgba(palette.shadow);
      });

      it("has a `scrim` color", () => {
        expectRgba(palette.scrim);
      });
    });
  }

  it("locks in Mocha's existing values so the baseline is preserved", () => {
    // These exact strings are what shipped before the theme-aware
    // switch. If a future change drifts away from them, the Mocha
    // visual baseline is no longer guaranteed.
    expect(palettes.mocha.shadow).toBe("rgba(0, 0, 0, 0.5)");
    expect(palettes.mocha.scrim).toBe("rgba(17, 17, 27, 0.7)");
  });

  it("uses lighter shadow and scrim on lighter flavors", () => {
    // Latte is the lightest flavor; its shadow and scrim should have
    // the lowest alphas so they don't read as a black halo on a
    // light background. We assert the alpha component directly.
    const latteShadowAlpha = Number(RGBA_RE.exec(palettes.latte.shadow!)![4]);
    const mochaShadowAlpha = Number(RGBA_RE.exec(palettes.mocha.shadow!)![4]);
    expect(latteShadowAlpha).toBeLessThan(mochaShadowAlpha);

    const latteScrimAlpha = Number(RGBA_RE.exec(palettes.latte.scrim!)![4]);
    const mochaScrimAlpha = Number(RGBA_RE.exec(palettes.mocha.scrim!)![4]);
    expect(latteScrimAlpha).toBeLessThan(mochaScrimAlpha);
  });
});
