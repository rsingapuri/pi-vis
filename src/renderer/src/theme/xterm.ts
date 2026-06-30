import type { Theme } from "@shared/theme";

/**
 * Build an xterm.js theme from a resolved Theme's semantic colors. This is the
 * single source of truth for the renderer's terminal panels (CustomPanelHost,
 * UnifiedTuiHost, LoginTerminal) — it replaces the three copies that each read
 * the raw Catppuccin palette object directly.
 *
 * The 16-color ANSI mapping is derived from the semantic roles exactly as the
 * old per-flavor copy was (cyan ← the `cyan` role, magenta ← `magenta`, etc.),
 * so the four Catppuccin themes produce an identical terminal palette.
 */
export function buildXtermTheme(theme: Theme): Record<string, string> {
  const c = theme.colors;
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
  };
}
