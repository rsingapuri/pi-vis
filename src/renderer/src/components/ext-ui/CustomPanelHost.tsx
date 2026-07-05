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
 * 4. Close: session.panelEvent (panel_close) → unmount; or force-close button
 *
 * Sizing: a STABLE, deterministic viewport box (shared `createPanelSizer` in
 * "viewport" mode). Unlike the sibling UnifiedTuiHost — whose base render (the
 * Editor + widget containers) has an intrinsic content height and so
 * content-tracks — a custom() panel is ALWAYS a pi-tui *overlay*, composited
 * full-frame against terminal.rows (blank-padded, often centered — e.g. /rtk's
 * `maxHeight:"85%" anchor:center` modal). Its rendered height is therefore a
 * FUNCTION of the grid we report, not an intrinsic height, so content-tracking
 * chases the centering padding and thrashes (a huge mostly-blank box with the
 * modal shoved to an edge and clipped). Instead we pin the grid to the display
 * cap (~half the transcript column), re-derived on resize (deterministic +
 * re-expands, no window-resize hysteresis), and let the overlay self-scroll
 * inside it; if the overlay is taller than the box pi-tui clips it (accepted at
 * small window sizes — the extension's own look is preserved). See panel-sizer.ts.
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
import { DEFAULT_HEIGHT_FRACTION, createPanelSizer } from "./panel-sizer.js";
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

// Bounds for the manual resize (fraction of the transcript column). Mirrors
// the Zod clamp on settings.customPanelHeightFraction.
export const CUSTOM_PANEL_MIN_HEIGHT_FRACTION = 0.2;
export const CUSTOM_PANEL_MAX_HEIGHT_FRACTION = 0.9;

// ─── Component ────────────────────────────────────────────────────────────

export function CustomPanelHost({ sessionId }: CustomPanelHostProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const panelRef = useRef<{
    id: number;
    overlay: boolean;
    buffer: string[];
    mode?: "content" | "viewport";
  } | null>(null);
  const { panel } = useSessionsStore((s) => s.sessions.get(sessionId)) ?? {};
  // Claim ESC while a custom panel is open so the panel keeps parity with
  // terminal pi: Escape belongs to the extension surface, not to global abort.
  useEscapeClaim(!!panel);
  // Keep panelRef in sync with the latest panel so the lifecycle effect (which
  // depends on panelId only) can read the current panel + its buffer without
  // taking panel/panel.buffer as reactive deps (which would rebuild xterm on
  // every streamed chunk).
  panelRef.current = panel ?? null;
  const panelId = panel?.id;
  // Display mode, read live by the sizer without being a rebuild dep. custom()
  // panels default to "viewport" (a stable pinned grid) because they are always
  // full-frame overlays — content-tracking them chases the overlay's centering
  // padding and thrashes. A host `panel_mode` event can still override this
  // (e.g. a future content-sized custom panel), but none is sent today.
  const panelMode = panel?.mode ?? "viewport";
  const modeRef = useRef<"content" | "viewport">("viewport");
  modeRef.current = panelMode;

  // ── Manual height override (drag the top handle) ──
  // The effective height fraction is: the in-flight drag value (set while the
  // user is dragging, so the panel resizes in real time), else the persisted
  // preference (settings.customPanelHeightFraction), else the default. Read
  // LIVE by the sizer via a ref so a drag / settings change re-runs sync
  // WITHOUT rebuilding xterm (the lifecycle effect is keyed on panelId only).
  // dragFractionRef resets to null when the panel unmounts, so a freshly-opened
  // panel reads the persisted preference (the cross-session default).
  const dragFractionRef = useRef<number | null>(null);
  const fractionGetterRef = useRef<() => number>(() => DEFAULT_HEIGHT_FRACTION);
  fractionGetterRef.current = () => {
    const drag = dragFractionRef.current;
    if (drag != null) return drag;
    const persisted = useSettingsStore.getState().settings.customPanelHeightFraction;
    return persisted ?? DEFAULT_HEIGHT_FRACTION;
  };

  // Live re-theme: the host emits role-identity ANSI indices; xterm resolves
  // them against `term.options.theme.extendedAnsi` at paint time, so swapping
  // the palette recolors every buffered cell with no re-emit. The Terminal
  // persists across scheme changes (lifecycle effect rebuilds on panelId
  // only), so we update its theme in place here.
  const activeColorScheme = useSettingsStore((s) => s.activeColorScheme);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(getTheme(activeColorScheme));
  }, [activeColorScheme]);

  // Re-run the sizing pass when the mode flips (overlay shown/hidden). The
  // lifecycle effect is keyed on panelId only, so it doesn't re-fire here.
  const syncRef = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: panelMode is the trigger; the body deliberately only re-runs the current sync
  useEffect(() => {
    syncRef.current?.();
  }, [panelMode]);

  // Re-run the sizing pass when the persisted height preference changes (e.g.
  // committed at the end of a drag, or reset by a double-click). The lifecycle
  // effect is keyed on panelId only, so it doesn't re-fire here; the sizer reads
  // the new fraction live via fractionGetterRef.
  const customPanelHeightFraction = useSettingsStore((s) => s.settings.customPanelHeightFraction);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the persisted fraction is the trigger; re-run the current sync only
  useEffect(() => {
    syncRef.current?.();
  }, [customPanelHeightFraction]);

  // The resize grab strip is rendered above the dock in App (so it sits at the
  // top of the widget tray, not on the custom view itself). App sends live
  // fractions through a DOM event; keeping the in-flight value here lets the
  // sizer update immediately without persisting settings on every mousemove.
  useEffect(() => {
    const onResize = (event: Event): void => {
      const { fraction } = (event as CustomEvent<{ fraction: number }>).detail;
      dragFractionRef.current = fraction;
      syncRef.current?.();
    };
    const onReset = (): void => {
      dragFractionRef.current = null;
      syncRef.current?.();
    };
    window.addEventListener("pivis:custom-panel-resize", onResize);
    window.addEventListener("pivis:custom-panel-resize-reset", onReset);
    return () => {
      window.removeEventListener("pivis:custom-panel-resize", onResize);
      window.removeEventListener("pivis:custom-panel-resize-reset", onReset);
    };
  }, []);

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
    const { settings, activeColorScheme } = useSettingsStore.getState();
    const { fonts } = settings;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      // Honor the user's configured code-font size (matches the rest of the
      // app); the TUI's cols/rows derive from this, so it must not be hardcoded.
      fontSize: fonts?.code?.sizePx ?? 14,
      fontFamily,
      theme: buildXtermTheme(getTheme(activeColorScheme)),
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

    // The scroll wrapper (.custom-panel__scroll) is the visible box the sizer
    // clips/scrolls; the mount (.custom-panel__xterm) holds the terminal grid.
    // The force-close button lives on the outer card (a non-scrolling ancestor)
    // so it stays put when the wrapper scrolls a tall panel.
    const panelEl = container.parentElement as HTMLElement;
    const sessionEl = container.closest(".app__session") as HTMLElement | null;

    // Deterministic grid-tracks-content sizing (shared with UnifiedTuiHost —
    // see panel-sizer.ts). The grid grows toward the content height, the card
    // hugs it capped at ~half the transcript column, and scrolls only past that
    // cap. This replaces the old fixed 50vh box, which clipped taller content
    // with no way to scroll to it and never re-expanded when the window grew.
    const sizer = createPanelSizer({
      term,
      container,
      panelEl,
      sessionEl,
      fitAddon,
      getMode: () => modeRef.current,
      getHeightFraction: () => fractionGetterRef.current(),
      fallbackFontSize: fonts?.code?.sizePx ?? 14,
      onReportSize: (cols, rows) => {
        void window.pivis
          .invoke("session.panelResize", { sessionId, panelId: currentPanel.id, cols, rows })
          .catch(() => {});
      },
    });
    syncRef.current = sizer.scheduleSync;

    // ── Write buffered ANSI from the panel's pre-existing buffer ──
    // panel.buffer is a snapshot at mount; live updates arrive via the
    // session.panelEvent subscription below. Measure in the write CALLBACK
    // (fires after xterm parses the bytes) so the first sizing pass reads the
    // real content height, not a not-yet-parsed buffer.
    for (const chunk of currentPanel.buffer) {
      term.write(chunk);
    }
    term.write("", () => {
      if (!disposed) sizer.scheduleSync();
    });

    // ── Listen for new panel data ──
    unsubPanel = window.pivis.on("session.panelEvent", ({ sessionId: eventSid, event }) => {
      if (eventSid !== sessionId) return;
      if (event.type === "panel_data" && event.panelId === currentPanel.id) {
        term.write(event.data, () => {
          if (!disposed) sizer.scheduleSync();
        });
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
    // Re-derive sizing when the transcript column resizes (window resize,
    // sidebar collapse, font change) — both cols and the display cap depend on
    // it. Observing the column (never sized BY us) makes the panel size a pure
    // function of the current column height, so growing the window re-expands
    // the panel deterministically (no dependence on how it got to that size).
    const resizeObserver = new ResizeObserver(() => sizer.scheduleSync());
    if (sessionEl) resizeObserver.observe(sessionEl);

    // Wait for the render service to measure cell dimensions before the first
    // sizing pass (double rAF: layout + paint).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (disposed) return;
        sizer.sync();
      });
    });

    // ── Cleanup ──
    return () => {
      disposed = true;
      syncRef.current = null;
      container.removeEventListener("mousedown", refocus);
      onDataDispose.dispose();
      unsubPanel?.();
      resizeObserver.disconnect();
      sizer.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, panelId]); // Re-create terminal if panel identity changes (NOT on buffer appends)

  // ── Escape key: not a panel-close mechanism ──
  // Extensions own the panel lifecycle via the `done` callback; pi-vis cannot
  // treat Escape as force-close or global abort while this surface is open.
  // Escape has no special pi-vis meaning here and still reaches extensions
  // that bind it (e.g. to cancel an input) through onData.
  const handleKeyDown = useCallback((_e: React.KeyboardEvent) => {
    // Intentionally empty: see comment above.
  }, []);

  if (!panel) return <></>;

  return (
    <div className="custom-panel" onKeyDown={handleKeyDown}>
      {/* Force-close escape hatch — a minimal floating control in the top-right
          corner (no full-width header bar). Low-prominence until hovered so it
          doesn't compete with the panel content; positioned over the terminal
          grid. It lives on the (non-scrolling) card, NOT the scroll wrapper, so
          it stays reachable when a tall panel scrolls. */}
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
      {/* The scroll wrapper is the JS-sized, scrolling box; the xterm mount
          inside it holds the full terminal grid. Focus is driven by
          term.focus() on mount + the mousedown refocus handler above, so the
          container doesn't need tabIndex (which would trip a11y rules for a
          non-interactive div). */}
      <div className="custom-panel__scroll">
        <div ref={containerRef} className="custom-panel__xterm" />
      </div>
    </div>
  );
}
