/**
 * UnifiedTuiHost — embedded xterm.js for the persistent unified-TUI panel.
 *
 * Rendered (in place of the Composer) when a session has a `unifiedPanel` —
 * i.e. an extension registered a factory `setWidget` and the SDK host built a
 * real pi-tui `TUI` hosting the Editor + widget components. The host writes
 * ANSI to this panel; keystrokes flow back over `session.panelInput` exactly as
 * for a custom() panel, so the TUI's `handleInput` chain (`inputListeners` +
 * the focused Editor) receives them.
 *
 * Sibling of `CustomPanelHost`, but:
 *  - persistent + non-modal (no `done()`/force-close) — the extension owns the
 *    lifecycle via `setWidget(key, undefined)` → `panel_close`;
 *  - reads `unifiedPanel` (not `panel`), so it never collides with a custom()
 *    overlay and `extensionUiActive` doesn't treat it as a blocking dialog.
 *
 * Lifecycle mirrors CustomPanelHost: rebuild xterm only on panel-identity
 * change (not on every streamed frame); live `panel_data` arrives via the
 * `session.panelEvent` subscription.
 */

import type { SessionId } from "@shared/ids.js";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type React from "react";
import { useEffect, useRef } from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { getTheme } from "../../theme/registry.js";
import { buildXtermTheme } from "../../theme/xterm.js";
import "@xterm/xterm/css/xterm.css";
import "./CustomPanelHost.css";

// ─── Props ───────────────────────────────────────────────────────────────

interface UnifiedTuiHostProps {
  sessionId: SessionId;
}

/** The slice of xterm's private core we read for the exact rendered cell height
 *  (font-metric accurate — the public API doesn't expose it). */
interface XtermCore {
  _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } };
}

function resolveMonoFont(): string {
  const fromVar = getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim();
  return fromVar || "ui-monospace, Menlo, monospace";
}

// ─── Component ────────────────────────────────────────────────────────────

export function UnifiedTuiHost({ sessionId }: UnifiedTuiHostProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const panelRef = useRef<{ id: number; buffer: string[]; mode?: "content" | "viewport" } | null>(
    null,
  );
  // The current sizing pass, exposed by the lifecycle effect so the mode-change
  // effect below can re-run it without taking sync's deps.
  const syncRef = useRef<(() => void) | null>(null);
  // Display mode, read live by sync() without being a rebuild dep (mode flips
  // mid-panel must NOT tear down xterm).
  const modeRef = useRef<"content" | "viewport">("content");
  const { unifiedPanel } = useSessionsStore((s) => s.sessions.get(sessionId)) ?? {};
  // Keep panelRef in sync so the lifecycle effect (dep = panelId only) can read
  // the current buffer without taking it as a reactive dep (which would rebuild
  // xterm on every streamed frame).
  panelRef.current = unifiedPanel ?? null;
  const panelId = unifiedPanel?.id;
  const panelMode = unifiedPanel?.mode ?? "content";
  modeRef.current = panelMode;

  // Re-run the sizing pass when the mode flips (overlay shown/hidden). The
  // lifecycle effect is keyed on panelId only, so it doesn't re-fire here — but
  // viewport↔content needs an immediate re-size, not just on the next frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: panelMode is the trigger; the body deliberately only re-runs the current sync
  useEffect(() => {
    syncRef.current?.();
  }, [panelMode]);

  // One lifecycle effect: build terminal, stream data, handle input, cleanup.
  // Rebuild xterm ONLY when the panel identity changes (NOT on buffer appends).

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild terminal on panel identity change only, not buffer appends
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
      fontSize: fonts?.code?.sizePx ?? 14,
      fontFamily,
      theme: buildXtermTheme(getTheme(colorScheme ?? "mocha")),
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    term.open(container);

    // Focus on mount + refocus on click so the TUI's Editor receives keystrokes.
    term.focus();
    const refocus = () => term.focus();
    container.addEventListener("mousedown", refocus);

    // The card (.unified-panel) is the visible box we clip/scroll; the mount
    // (.custom-panel__xterm) holds the terminal grid.
    const panelEl = container.parentElement as HTMLElement;
    const sessionEl = container.closest(".app__session") as HTMLElement | null;

    // ── Sizing model (the load-bearing part) ────────────────────────────────
    //
    // pi-tui writes ALL of its rendered lines (joined by \r\n) with no clamp to
    // the terminal `rows`: when content is taller than the grid, the terminal
    // SCROLLS and bottom-anchors, pushing the top into scrollback (the cut-off
    // top line). So the grid must TRACK the content height — a fixed budget is
    // wrong. The invariant:
    //
    //   • grid `rows` = contentRows + 1  (a one-row blank "sentinel" so we can
    //     tell "the content fits" from "the content filled the grid and may be
    //     clipped"). Reported to the host so its TUI lays out into exactly this
    //     grid — every line stays in the viewport, top-anchored, nothing scrolls
    //     into scrollback.
    //   • mount height = grid height (rows × cell).
    //   • card height  = min(contentRows, maxDisplayRows) × cell — the box hugs
    //     the content, capped at a deterministic max derived from the transcript
    //     column. Trailing blanks (incl. the sentinel) are clipped.
    //   • card overflows ONLY when contentRows > maxDisplayRows — then it scrolls
    //     through the content (the spec's "scrollbar only past the max").
    //
    // Convergence: a height change makes pi-tui fullRender(true) (clears
    // scrollback + re-lays-out), so growing the grid brings a clipped top back;
    // shrinking removes trailing blanks. Settles in ≤2 resizes, then is stable
    // (rows == contentRows+1 leaves exactly one sentinel blank, no oscillation).

    const MAX_HEIGHT_FRACTION = 0.5;

    // Real rendered cell height from xterm's render service (font-metric exact,
    // not the old fontSize*1.2 guess that desynced the math). Falls back before
    // the first measurement tick.
    const cellHeight = (): number => {
      const core = (term as unknown as { _core?: XtermCore })._core;
      const h = core?._renderService?.dimensions?.css?.cell?.height;
      return typeof h === "number" && h > 0 ? h : (fonts?.code?.sizePx ?? 14) * 1.2;
    };

    const sessionHeight = (): number => sessionEl?.clientHeight ?? window.innerHeight;

    // The visible cap — half the transcript column. Past this the card scrolls.
    const maxDisplayRows = (): number =>
      Math.max(1, Math.floor((sessionHeight() * MAX_HEIGHT_FRACTION) / cellHeight()));

    // Safety ceiling on the grid so a runaway extension can't make a 1000-row
    // terminal. Generous (the full column), well above any real fleet roster.
    const hardMaxRows = (): number =>
      Math.max(maxDisplayRows() * 2, Math.floor(sessionHeight() / cellHeight()), 24);

    // Rows occupied by content (last non-blank + 1), and whether the content
    // reached the bottom grid row (no trailing blank → it may be clipped into
    // scrollback, so the grid needs to grow). Never reports below the caret row,
    // so the editor's (possibly blank) input line is always kept.
    const measureContent = (): { rows: number; filled: boolean } => {
      const buf = term.buffer.active;
      let lastNonBlank = -1;
      for (let i = 0; i < term.rows; i++) {
        const line = buf.getLine(buf.baseY + i);
        if (line && line.translateToString(true).length > 0) lastNonBlank = i;
      }
      const rows = Math.max(lastNonBlank + 1, buf.cursorY + 1, 1);
      return { rows, filled: lastNonBlank >= term.rows - 1 };
    };

    // Vertical chrome (padding + border) of the card, so the JS heights produce
    // the intended CONTENT area regardless of box-sizing.
    const cardChrome = (): number => {
      const cs = window.getComputedStyle(panelEl);
      return (
        Number.parseFloat(cs.paddingTop) +
        Number.parseFloat(cs.paddingBottom) +
        Number.parseFloat(cs.borderTopWidth) +
        Number.parseFloat(cs.borderBottomWidth)
      );
    };

    let lastCols = -1;
    let lastRows = -1;

    // Push the current grid size to the host (only on change — avoids redundant
    // IPC + host re-renders).
    const reportSize = (cols: number, rows: number): void => {
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      void window.pivis
        .invoke("session.panelResize", { sessionId, panelId: currentPanel.id, cols, rows })
        .catch(() => {});
    };

    // Pin a FIXED grid of `rows` (no content tracking) and size mount + card to
    // match. Used in viewport mode (a pi-tui overlay is up — its geometry tracks
    // the rows we give it, so a stable grid yields a stable render) and as the
    // resize-storm circuit breaker. cols still tracks the mount width.
    const applyFixedViewport = (rows: number, cols: number, cell: number): void => {
      const gridRows = Math.max(1, Math.min(rows, hardMaxRows()));
      if (cols !== term.cols || gridRows !== term.rows) term.resize(cols, gridRows);
      reportSize(cols, gridRows);
      const displayRows = Math.min(gridRows, maxDisplayRows());
      container.style.height = `${gridRows * cell}px`;
      panelEl.style.height = `${displayRows * cell + cardChrome()}px`;
      panelEl.style.overflowY = gridRows > maxDisplayRows() ? "auto" : "hidden";
    };

    // ── Resize-storm circuit breaker (damping) ──────────────────────────────
    // Defense-in-depth for any extension whose rendered height is coupled to the
    // grid we report (so content-tracking would never converge) but that does NOT
    // send a viewport signal. If the grid resizes too many times in a short
    // window, declare the panel unstable: pin to the tallest size seen and stop
    // tracking for a cooldown, then re-evaluate (the content may have settled).
    const RESIZE_WINDOW_MS = 400;
    const MAX_RESIZES_PER_WINDOW = 6;
    const COOLDOWN_MS = 1000;
    let resizeTimes: number[] = [];
    let pinnedRows = 0; // > 0 while the breaker is engaged
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

    // Coalesce a burst of sync triggers (streamed frames, resize observer, the
    // post-resize convergence pass) into at most one pass per animation frame.
    let syncQueued = false;
    const scheduleSync = (): void => {
      if (syncQueued || disposed) return;
      syncQueued = true;
      requestAnimationFrame(() => {
        syncQueued = false;
        if (!disposed) sync();
      });
    };

    // Single sizing pass. In content mode resizes the grid toward `contentRows+1`
    // and converges over ≤2 frames; in viewport mode (or while the breaker is
    // engaged) pins a fixed grid instead. Re-runs are coalesced via scheduleSync.
    const sync = (): void => {
      if (disposed) return;
      const cell = cellHeight();

      // Width (cols) tracks the mount; height (rows) tracks the content.
      let cols = term.cols;
      try {
        cols = fitAddon.proposeDimensions()?.cols ?? cols;
      } catch {
        // proposeDimensions throws before the mount has a layout; keep current.
      }

      // Viewport mode: a pi-tui overlay is compositing against `rows`. Give it a
      // steady screen (the display cap) and never chase its height — that chase
      // is the wiggle. cols still tracks width.
      if (modeRef.current === "viewport") {
        applyFixedViewport(maxDisplayRows(), cols, cell);
        return;
      }

      // Breaker engaged: hold the pinned grid until the cooldown re-opens tracking.
      if (pinnedRows > 0) {
        applyFixedViewport(pinnedRows, cols, cell);
        return;
      }

      const { rows: contentRows, filled } = measureContent();
      const hardMax = hardMaxRows();
      // If the content filled the grid it may be clipped → jump to the ceiling so
      // the next render reveals the true height; otherwise hug content + sentinel.
      const targetRows =
        filled && term.rows < hardMax ? hardMax : Math.min(contentRows + 1, hardMax);

      if (cols !== term.cols || targetRows !== term.rows) {
        // Trip the breaker if resizes are coming too fast to be a real settle.
        const now = Date.now();
        resizeTimes.push(now);
        resizeTimes = resizeTimes.filter((t) => now - t < RESIZE_WINDOW_MS);
        if (resizeTimes.length > MAX_RESIZES_PER_WINDOW) {
          pinnedRows = Math.min(hardMax, Math.max(term.rows, targetRows));
          resizeTimes = [];
          if (cooldownTimer) clearTimeout(cooldownTimer);
          cooldownTimer = setTimeout(() => {
            cooldownTimer = null;
            pinnedRows = 0; // re-open tracking — content may have settled
            scheduleSync();
          }, COOLDOWN_MS);
          applyFixedViewport(pinnedRows, cols, cell);
          return;
        }

        term.resize(cols, targetRows);
        reportSize(cols, targetRows);
        // The grid changed: xterm reflows the existing buffer into the new
        // dimensions (and the host re-renders a fresh frame too). Re-measure on
        // the next frame to converge — don't depend on a host frame arriving,
        // so this settles in the preview/host-less case as well.
        scheduleSync();
        return;
      }
      reportSize(cols, targetRows);

      // Settled. Mount holds the full grid; the card hugs the content, capped.
      container.style.height = `${term.rows * cell}px`;
      const displayRows = Math.min(contentRows, maxDisplayRows());
      panelEl.style.height = `${displayRows * cell + cardChrome()}px`;
      // Scroll (via the card) only when the content is taller than the cap.
      panelEl.style.overflowY = contentRows > maxDisplayRows() ? "auto" : "hidden";
    };

    // Expose the (coalesced) sizing pass so the mode-change effect can re-run it.
    syncRef.current = scheduleSync;

    // Replay the remount snapshot. Measure in the write CALLBACK (fires after
    // xterm has parsed the bytes) — measuring synchronously read a not-yet-
    // parsed buffer on cold mount, which is why the panel opened too short and
    // only corrected on a later remount.
    for (const chunk of currentPanel.buffer) {
      term.write(chunk);
    }
    term.write("", () => {
      if (!disposed) scheduleSync();
    });

    unsubPanel = window.pivis.on("session.panelEvent", ({ sessionId: eventSid, event }) => {
      if (eventSid !== sessionId) return;
      if (event.type === "panel_data" && event.panelId === currentPanel.id) {
        term.write(event.data, () => {
          if (!disposed) scheduleSync();
        });
      }
    });

    // User keystrokes → host TUI (panelInput is shared with custom() panels).
    const onDataDispose = term.onData((data) => {
      void window.pivis
        .invoke("session.panelInput", { sessionId, panelId: currentPanel.id, data })
        .catch(() => {});
    });

    // Re-derive sizing when the transcript column resizes (window resize,
    // sidebar collapse, font change) — both cols and the display cap depend on
    // it. The column is never sized BY us, so this can't feed back.
    const resizeObserver = new ResizeObserver(() => scheduleSync());
    if (sessionEl) resizeObserver.observe(sessionEl);

    // Wait for the render service to measure cell dimensions before the first
    // sizing pass (double rAF: layout + paint).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (disposed) return;
        sync();
      });
    });

    return () => {
      disposed = true;
      if (cooldownTimer) clearTimeout(cooldownTimer);
      syncRef.current = null;
      container.removeEventListener("mousedown", refocus);
      onDataDispose.dispose();
      unsubPanel?.();
      resizeObserver.disconnect();
      panelEl.style.height = "";
      panelEl.style.overflowY = "";
      container.style.height = "";
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, panelId]);

  return (
    <div className="custom-panel unified-panel">
      {/* No header/close button: the unified panel is persistent and the
          extension owns its lifecycle (setWidget(key, undefined) → panel_close).
          A modal-style ✕ would contradict that. */}
      <div ref={containerRef} className="custom-panel__xterm" />
    </div>
  );
}
