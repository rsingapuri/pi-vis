/**
 * CustomPanelHost — embedded xterm.js overlay for extension custom() panels.
 *
 * Renders when a session has an open panel (ctx.ui.custom() was called).
 * Mirrors the LoginTerminal xterm.js pattern but is inline (replaces the
 * composer area) rather than a full-screen modal.
 *
 * Lifecycle:
 * 1. Mount: create xterm.js Terminal, load FitAddon, flush buffered ANSI
 * 2. Stream: listen for session.panelEvent (panel_data) → term.write()
 * 3. Input: term.onData → session.panelInput IPC
 * 4. Close: session.panelEvent (panel_close) → unmount; or Escape key
 *
 * Sizing: a STABLE, deterministic box (CSS min-height + max-height: 50vh) that
 * an extension's overlay floats and self-scrolls inside — deliberately NOT
 * content-hugged (unlike the sibling UnifiedTuiHost). See `applyFit` below.
 */

import type { SessionId } from "@shared/ids.js";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { getTheme } from "../../theme/registry.js";
import { buildXtermTheme } from "../../theme/xterm.js";
import "@xterm/xterm/css/xterm.css";
import "./CustomPanelHost.css";

// ─── Props ───────────────────────────────────────────────────────────────

interface CustomPanelHostProps {
  sessionId: SessionId;
}

// ─── xterm theme builder ──────────────────────────────────────────────────

function resolveMonoFont(): string {
  const fromVar = getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim();
  return fromVar || "ui-monospace, Menlo, monospace";
}

// ─── Component ────────────────────────────────────────────────────────────

export function CustomPanelHost({ sessionId }: CustomPanelHostProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const panelRef = useRef<{ id: number; overlay: boolean; buffer: string[] } | null>(null);
  const { panel } = useSessionsStore((s) => s.sessions.get(sessionId)) ?? {};
  // Claim ESC while a custom panel is open so a background streaming session
  // isn't aborted (the panel routes ESC to the extension via onData).
  useEscapeClaim(!!panel);
  // Keep panelRef in sync with the latest panel so the lifecycle effect (which
  // depends on panelId only) can read the current panel + its buffer without
  // taking panel/panel.buffer as reactive deps (which would rebuild xterm on
  // every streamed chunk).
  panelRef.current = panel ?? null;
  const panelId = panel?.id;

  // One lifecycle effect: build terminal, stream data, handle input, cleanup.
  //
  // Deps: [sessionId, panelId]. We rebuild the xterm ONLY when the panel
  // identity changes — NOT on every buffer append (which would tear down and
  // recreate the terminal per streamed chunk). Live `panel_data` arrives via
  // the session.panelEvent subscription, so the effect doesn't need to read
  // panel.buffer reactively. We capture `panel` via a ref so the lint rule
  // doesn't demand the whole panel object (and its buffer) as a dep.

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild terminal on panel identity change only, not buffer appends (see comment above)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const currentPanel = panelRef.current;
    if (!currentPanel) return;

    let disposed = false;
    let unsubPanel: (() => void) | null = null;

    const fontFamily = resolveMonoFont();
    const { colorScheme, fonts } = useSettingsStore.getState().settings;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      // Honor the user's configured code-font size (matches the rest of the
      // app); the TUI's cols/rows derive from this, so it must not be hardcoded.
      fontSize: fonts?.code?.sizePx ?? 14,
      fontFamily,
      theme: buildXtermTheme(getTheme(colorScheme ?? "mocha")),
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    // ── Render to DOM ──
    term.open(container);

    // ── Focus ──
    // xterm.js does NOT steal focus on open; without an explicit focus the
    // terminal renders but keyboard input goes nowhere until the user clicks
    // it. Focus on mount so keystrokes work immediately, and refocus on any
    // click within the container (so clicking back into the panel after
    // interacting with another control restores input).
    term.focus();
    const refocus = () => term.focus();
    container.addEventListener("mousedown", refocus);

    // ── Write buffered ANSI from the panel's pre-existing buffer ──
    // panel.buffer is a snapshot at mount; live updates arrive via the
    // session.panelEvent subscription below. Capturing it here (rather than
    // depending on panel.buffer in the effect deps) keeps the terminal from
    // being torn down and rebuilt on every streamed chunk.
    const initialBuffer = currentPanel.buffer;
    for (const chunk of initialBuffer) {
      term.write(chunk);
    }

    // ── Listen for new panel data ──
    unsubPanel = window.pivis.on("session.panelEvent", ({ sessionId: eventSid, event }) => {
      if (eventSid !== sessionId) return;
      if (event.type === "panel_data" && event.panelId === currentPanel.id) {
        term.write(event.data);
      }
      if (event.type === "panel_close" && event.panelId === currentPanel.id) {
        // Panel closed by extension — unfold state triggers unmount
      }
    });

    // ── User keystrokes → panel input IPC ──
    const onDataDispose = term.onData((data) => {
      void window.pivis
        .invoke("session.panelInput", {
          sessionId,
          panelId: currentPanel.id,
          data,
        })
        .catch(() => {});
    });

    // ── Resize observer ──
    // FitAddon recomputes cols/rows from the container; we apply them to the
    // xterm AND forward them to the host so the TUI's overlay layout (sized off
    // the Terminal's columns/rows) matches the actual panel. The reported rows
    // are exactly `term.rows` — the SAME grid the host renders into — so there
    // is no grid-vs-host mismatch (that mismatch was the black bar / clipped
    // frame this changeset had introduced).
    //
    // NOTE — custom() panels are deliberately NOT content-hugged (unlike the
    // unified-TUI panel). An extension sizes its overlay as a FRACTION of
    // `terminal.rows` and scrolls it internally — e.g. pi-subagents' conversation
    // viewer opens with `maxHeight: "70%"` and caps its own j/k viewport at
    // `terminal.rows * 70%`. Shrinking the grid to the rendered content would
    // feed straight back into that fraction and collapse the overlay toward its
    // minimum. So the panel is a STABLE, deterministic box (CSS min-height +
    // max-height: 50vh) that the overlay floats and self-scrolls inside.
    const applyFit = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
        void window.pivis
          .invoke("session.panelResize", {
            sessionId,
            panelId: currentPanel.id,
            cols: term.cols,
            rows: term.rows,
          })
          .catch(() => {});
      } catch {
        // fit() throws before the container has a layout; ignore.
      }
    };
    const resizeObserver = new ResizeObserver(applyFit);
    resizeObserver.observe(container);

    // Wait for CSS constraints to settle before the initial fit (double rAF
    // ensures layout — and the render service's cell metrics — are resolved).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (disposed) return;
        applyFit();
      });
    });

    // ── Cleanup ──
    return () => {
      disposed = true;
      container.removeEventListener("mousedown", refocus);
      onDataDispose.dispose();
      unsubPanel?.();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, panelId]); // Re-create terminal if panel identity changes (NOT on buffer appends)

  // ── Escape key: not a close mechanism ──
  // Extensions own the panel lifecycle via the `done` callback; pi-vis cannot
  // force-close a custom() panel. Escape has no special meaning here — we
  // explicitly do NOT swallow it, so an extension that binds Escape (e.g. to
  // cancel an input) still receives the keystroke through onData.
  const handleKeyDown = useCallback((_e: React.KeyboardEvent) => {
    // Intentionally empty: see comment above.
  }, []);

  if (!panel) return <></>;

  return (
    <div className="custom-panel" onKeyDown={handleKeyDown}>
      {/* Escape hatch: an extension owns the panel lifecycle via done(), but a
          buggy one could never call it and wedge the session. This force-closes
          the panel — the host resolves the extension's custom() promise with
          undefined and tears it down. Rendered as a minimal floating control so
          there is no full-width header bar competing with the panel content. */}
      <button
        type="button"
        className="custom-panel__close"
        title="Force-close this panel (cancels the extension's request)"
        onClick={() => {
          void window.pivis
            .invoke("session.panelClose", { sessionId, panelId: panel.id })
            .catch(() => {});
        }}
      >
        ✕
      </button>
      {/* The xterm canvas owns keystroke capture. Focus is driven by
          term.focus() on mount + the mousedown refocus handler above, so the
          container doesn't need tabIndex (which would trip a11y rules for a
          non-interactive div). */}
      <div ref={containerRef} className="custom-panel__xterm" />
    </div>
  );
}
