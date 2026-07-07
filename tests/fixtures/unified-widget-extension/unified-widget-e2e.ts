/**
 * Fixture pi extension for the real-pi kitty keyboard e2e
 * (tests/e2e/unified-kitty-real.spec.mts).
 *
 * Registers a factory `setWidget` so the host's REAL `ensureUnifiedTui()`
 * builds a real pi-tui `TUI` + `Editor` — the exact surface Shift+Enter must
 * work on. Auto-paints on session_start (so the e2e need only open a session)
 * and also exposes a `/kitty-e2e` command to re-trigger it on demand.
 *
 * Installed into a throwaway agent dir via `PI_CODING_AGENT_DIR` so it loads as
 * a GLOBAL extension (no project-trust prompt, no pollution of the user's env).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "unified-kitty-e2e";

// A minimal pi-tui component: render() returns the lines painted below the
// editor. The editor itself is what Shift+Enter/Enter act on — the widget just
// exists to keep the unified TUI alive.
const factory = () => ({
  render: () => ["unified kitty e2e · Shift+Enter = newline · Enter = submit"],
  invalidate() {},
  dispose() {},
});

export default function (pi: ExtensionAPI) {
  const paint = (ctx: ExtensionContext) => {
    ctx.ui.setWidget(WIDGET_KEY, factory as never, { placement: "belowEditor" });
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    paint(ctx);
  });

  pi.registerCommand("kitty-e2e", {
    description: "Open the unified kitty e2e widget",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      paint(ctx);
    },
  });
}
