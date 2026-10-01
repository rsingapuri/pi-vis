/**
 * Host-side pi-theme capability — the regression gate for "the host emits
 * role-identity ANSI indices, not baked RGB" (the foundation of live
 * re-theming: the renderer resolves these indices against the active palette
 * at paint time, so a scheme swap recolors every cell with no re-emit).
 *
 * The index assignment + index→token maps are unit-tested in TS
 * (src/shared/theme/pi-theme.test.ts) without pi. THIS test is the layer that
 * TS can't reach: it drives the REAL public `new pi.Theme(...)` constructor and
 * the capability-gated `applyPiVisTheme`, then asserts the returned local
 * theme's `fg(role)` emits a STABLE INDEXED escape (`\x1b[38;5;N m`) for the
 * numeric value we passed — i.e. pi's `fgAnsi` takes its numeric branch and
 * never bakes RGB. The test always uses the repository-pinned runtime that the
 * app ships; a missing install is a failed compatibility gate, not a skip.
 */
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPiThemeColorIndices } from "../../src/shared/theme/pi-theme.ts";
import { applyPiVisTheme, importPi, initHostTheme } from "./bootstrap.mjs";

const PINNED_PI_VERSION = "0.85.1";
const REPOSITORY_PINNED_PI_CLI = fileURLToPath(
  new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);

function resolvePinnedPiCli() {
  const override = process.env.PIVIS_TEST_PINNED_PI_CLI;
  const candidate = override?.trim() || REPOSITORY_PINNED_PI_CLI;
  if (!existsSync(candidate)) {
    throw new Error(
      `Pinned Pi CLI not found at ${candidate}; install repository dependencies or set PIVIS_TEST_PINNED_PI_CLI`,
    );
  }
  return realpathSync(candidate);
}

const PI_BIN = resolvePinnedPiCli();

// Drive the real constructor with the same complete foreground/background maps
// production serializes. Pi derives optional scrollbar/search roles from the
// required text/selectedBg values, so the old `{}` background fixture no
// longer satisfies the public Theme constructor contract.
const TEST_THEME_COLORS = buildPiThemeColorIndices();
// Pi 0.80.6 accepts an explicit thinkingMax role (and still falls back to
// thinkingXhigh for older custom themes). Give the inspected roles distinct
// indices so this host-level test proves we preserve their role identity.
const TEST_FG_COLORS = {
  ...TEST_THEME_COLORS.fg,
  text: 42,
  error: 43,
  thinkingXhigh: 44,
  thinkingMax: 45,
};
const TEST_BG_COLORS = TEST_THEME_COLORS.bg;

describe("applyPiVisTheme (repository-pinned Pi)", () => {
  let pi;
  it("imports the exact pinned Pi", async () => {
    pi = await importPi(PI_BIN);
    expect(pi.VERSION).toBe(PINNED_PI_VERSION);
    expect(typeof pi.Theme).toBe("function");
  });

  it("reports the public global-install capability honestly", async () => {
    pi = pi ?? (await importPi(PI_BIN));
    initHostTheme(pi, "dark");

    const result = applyPiVisTheme(pi, TEST_FG_COLORS, TEST_BG_COLORS);
    if (typeof pi.setThemeInstance === "function") {
      expect(result.success).toBe(true);
    } else {
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/public API/i) });
    }
    expect(result.theme).toBeInstanceOf(pi.Theme);
  });

  it("emits a STABLE INDEXED escape (not baked RGB) for numeric role values", async () => {
    pi = pi ?? (await importPi(PI_BIN));
    initHostTheme(pi, "dark");
    // Numeric values flow through pi's fgAnsi numeric branch verbatim as
    // `\x1b[38;5;N m`, independent of color mode — the byte stream carries
    // role identity, never RGB. This is what makes the renderer's palette swap
    // recolor buffered cells live.
    const { theme } = applyPiVisTheme(pi, TEST_FG_COLORS, TEST_BG_COLORS);

    expect(theme.fg("text", "X")).toContain("\x1b[38;5;42m");
    expect(theme.fg("error", "Y")).toContain("\x1b[38;5;43m");
    expect(theme.fg("thinkingMax", "Z")).toContain("\x1b[38;5;45m");
    expect(theme.fg("scrollbarThumb", "S")).toContain(`\x1b[38;5;${TEST_FG_COLORS.text}m`);
    expect(theme.fg("searchMatchText", "F")).toContain("\x1b[38;5;42m");
    expect(theme.bg("searchMatchBg", "B")).toContain(`\x1b[48;5;${TEST_BG_COLORS.selectedBg}m`);
    // And it must NOT bake truecolor for numeric inputs.
    expect(theme.fg("text", "X")).not.toContain("\x1b[38;2;");
  });
});
