/**
 * Host-side pi-theme install — the regression gate for "the host emits
 * role-identity ANSI indices, not baked RGB" (the foundation of live
 * re-theming: the renderer resolves these indices against the active palette
 * at paint time, so a scheme swap recolors every cell with no re-emit).
 *
 * The index assignment + index→token maps are unit-tested in TS
 * (src/shared/theme/pi-theme.test.ts) without pi. THIS test is the layer that
 * TS can't reach: it drives the REAL public `new pi.Theme(...)` constructor and
 * the symbol-global install (`applyPiVisTheme`), then asserts the installed
 * theme's `fg(role)` emits a STABLE INDEXED escape (`\x1b[38;5;N m`) for the
 * numeric value we passed — i.e. pi's `fgAnsi` takes its numeric branch and
 * never bakes RGB. It needs a real pi install and SKIPS (like the PI_E2E gate)
 * when pi can't be resolved, so it never fails CI on a pi-less runner.
 */
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPiVisTheme, importPi, initHostTheme } from "./bootstrap.mjs";

// ── Locate a real pi binary (skip the suite if absent) ──────────────────────
function locatePiBin() {
  const candidates = [];
  if (process.env.PIVIS_TEST_PI_BIN) candidates.push(process.env.PIVIS_TEST_PI_BIN);
  try {
    candidates.push(execSync("command -v pi", { encoding: "utf8" }).trim());
  } catch {
    /* pi not on PATH */
  }
  candidates.push("/opt/homebrew/bin/pi", "/usr/local/bin/pi");
  for (const c of candidates) {
    if (c && existsSync(c)) {
      try {
        return realpathSync(c);
      } catch {
        /* dangling symlink */
      }
    }
  }
  return null;
}

const PI_BIN = locatePiBin();

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// Current pi versions synthesize the optional thinkingMax role from
// thinkingXhigh inside Theme's constructor, so even this focused fixture must
// provide the fallback source role.
const TEST_FG_COLORS = { text: 42, error: 43, thinkingXhigh: 44 };

// Run/serialize helper: vitest's describe.skip is evaluated at collection time,
// so gate the whole suite on the resolved PI_BIN.
const suite = PI_BIN ? describe : describe.skip;

suite("applyPiVisTheme (real pi)", () => {
  let pi;
  it("imports pi", async () => {
    pi = await importPi(PI_BIN);
    expect(typeof pi.Theme).toBe("function");
  });

  it("installs a pi-vis-index Theme as the active singleton", async () => {
    pi = pi ?? (await importPi(PI_BIN));
    // Populate the global with a valid base theme first (as host.mjs does).
    initHostTheme(pi, "dark");

    const installed = applyPiVisTheme(pi, TEST_FG_COLORS, {});
    expect(installed).toBe(globalThis[THEME_KEY]);
    expect(globalThis[THEME_KEY_OLD]).toBe(installed);
  });

  it("emits a STABLE INDEXED escape (not baked RGB) for numeric role values", async () => {
    pi = pi ?? (await importPi(PI_BIN));
    initHostTheme(pi, "dark");
    // Numeric values flow through pi's fgAnsi numeric branch verbatim as
    // `\x1b[38;5;N m`, independent of color mode — the byte stream carries
    // role identity, never RGB. This is what makes the renderer's palette swap
    // recolor buffered cells live.
    applyPiVisTheme(pi, TEST_FG_COLORS, {});

    const theme = globalThis[THEME_KEY];
    expect(theme.fg("text", "X")).toContain("\x1b[38;5;42m");
    expect(theme.fg("error", "Y")).toContain("\x1b[38;5;43m");
    // And it must NOT bake truecolor for numeric inputs.
    expect(theme.fg("text", "X")).not.toContain("\x1b[38;2;");
  });
});
