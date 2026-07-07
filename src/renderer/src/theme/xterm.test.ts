/**
 * Unit tests for the shared xterm.js terminal options (the Kitty keyboard
 * protocol flag is the renderer half of the Shift+Enter fix — I11).
 *
 * `basePanelTerminalOptions()` is the single source of truth for the
 * `vtExtensions.kittyKeyboard` flag; every terminal panel (UnifiedTuiHost,
 * CustomPanelHost, LoginTerminal) spreads it into `new Terminal(...)`. This
 * test pins the flag AND verifies the three component sites actually use the
 * helper (so a future `new Terminal({})` without the spread can't silently
 * regress kitty support).
 */
import { describe, expect, it } from "vitest";
import { basePanelTerminalOptions } from "./xterm";

describe("basePanelTerminalOptions", () => {
  it("enables the Kitty keyboard protocol flag (the renderer half of the fix)", () => {
    const opts = basePanelTerminalOptions();
    expect(opts.vtExtensions?.kittyKeyboard).toBe(true);
  });

  it("returns a fresh object each call (callers layer their own options on top)", () => {
    const a = basePanelTerminalOptions();
    const b = basePanelTerminalOptions();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("all three terminal panel sites use basePanelTerminalOptions", () => {
  // These are source-level guards: the helper is the single source of truth for
  // the kitty flag, so each panel MUST spread it into `new Terminal(...)`. A
  // future edit that drops the spread would silently regress kitty support
  // (Shift+Enter indistinguishable from Enter) with no other symptom.
  const panels = [
    "src/renderer/src/components/ext-ui/UnifiedTuiHost.tsx",
    "src/renderer/src/components/ext-ui/CustomPanelHost.tsx",
    "src/renderer/src/components/auth/LoginTerminal.tsx",
  ];

  it.each(panels)("%s imports and spreads basePanelTerminalOptions", (file) => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(process.cwd(), file), "utf8");
    expect(src, `${file} must import basePanelTerminalOptions`).toContain(
      "basePanelTerminalOptions",
    );
    expect(src, `${file} must spread the helper into new Terminal`).toContain(
      "...basePanelTerminalOptions()",
    );
  });
});
