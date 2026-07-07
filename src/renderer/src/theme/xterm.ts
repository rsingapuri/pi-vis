import { PI_BG_ROLES, PI_ROLES, type Theme, buildPiThemeColors } from "@shared/theme";
import type { ITerminalOptions } from "@xterm/xterm";

// ─── Shared xterm.js terminal options ─────────────────────────────────────────
//
// @xterm/xterm is pinned at 6.1.0-beta.288 (exact pin) for Kitty keyboard
// protocol support, which landed in 6.1.0-beta.x (xterm.js PR #5600) behind the
// opt-in `vtExtensions.kittyKeyboard`. RE-PIN to 6.1.0 stable when released.
//
// Kitty is what makes Shift+Enter distinguishable from Enter in the in-process
// Unified TUI (and custom() panels): with it enabled, xterm encodes modified
// keys as CSI-u (Shift+Enter → `\x1b[13;2u`) and answers the host's handshake;
// without it, Shift+Enter and Enter both arrive as `\r` (indistinguishable).
// The host performs the matching handshake over the panel wire — see
// resources/pi-session-host/keyboard-protocol.mjs — so enabling this here is
// the renderer half of the fix (and alone fixes the /login pty path, where pi's
// own ProcessTerminal negotiates against the real pty).

/**
 * Base xterm.js options shared by every terminal panel (UnifiedTuiHost,
 * CustomPanelHost, LoginTerminal). The single source of truth for the Kitty
 * keyboard flag — spread (`...basePanelTerminalOptions()`) into each
 * `new Terminal(...)`. Components layer their own options (font, theme) on top.
 */
export function basePanelTerminalOptions(): ITerminalOptions {
  return {
    vtExtensions: { kittyKeyboard: true },
  };
}

/**
 * Build an xterm.js theme from a resolved Theme's semantic colors. This is the
 * single source of truth for the renderer's terminal panels (CustomPanelHost,
 * UnifiedTuiHost, LoginTerminal) — it replaces the three copies that each read
 * the raw Catppuccin palette object directly.
 *
 * The 16-color ANSI mapping is derived from the semantic roles exactly as the
 * old per-flavor copy was (cyan ← the `cyan` role, magenta ← `magenta`, etc.),
 * so the four Catppuccin themes produce an identical terminal palette.
 *
 * **`extendedAnsi` (the load-bearing part for live re-theming):** the host
 * installs a pi Theme whose per-role values are STABLE ANSI palette indices
 * (see `PI_ROLE_INDEX`), so pi emits role-identity bytes (`\x1b[38;5;N m`)
 * rather than baked RGB. xterm stores those cells by INDEX and resolves each
 * index against this palette at paint time, so when a scheme swap reassigns
 * `term.options.theme` (with a freshly built `extendedAnsi`), xterm rebuilds
 * its palette and repaints EVERY cell — including ones already in the buffer
 * — with the new colors. No re-emit, no reset. This entry's hex is the active
 * scheme's resolved color for that role (`buildPiThemeColors(theme)`), so the
 * same index resolves correctly per scheme.
 */
export function buildXtermTheme(theme: Theme): Record<string, string | string[]> {
  const c = theme.colors;

  // Role index → active-scheme hex, packed as the xterm extended palette
  // (extendedAnsi[0] === index 16). PI_ROLE_INDEX assigns a contiguous block
  // starting at 16 in PI_ROLES order, so we emit in that same order.
  const extendedAnsi: string[] = new Array(PI_ROLES.length);
  const { fgColors, bgColors } = buildPiThemeColors(theme);
  PI_ROLES.forEach((role, i) => {
    const hex = PI_BG_ROLES.has(role) ? bgColors[role] : fgColors[role];
    extendedAnsi[i] = hex ?? c.text;
  });

  return {
    background: c.bg,
    foreground: c.text,
    cursor: c.cursor,
    selectionBackground: c["surface-3"],
    black: c["surface-2"],
    red: c.danger,
    green: c.success,
    yellow: c.warning,
    blue: c.info,
    magenta: c.magenta,
    cyan: c.cyan,
    white: c["text-secondary"],
    brightBlack: c["surface-3"],
    brightRed: c.danger,
    brightGreen: c.success,
    brightYellow: c.warning,
    brightBlue: c.info,
    brightMagenta: c.magenta,
    brightCyan: c.cyan,
    brightWhite: c["text-muted"],
    // Indices 16.. — role identity → active-scheme color (see header doc).
    extendedAnsi,
  };
}
