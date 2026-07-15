/**
 * panel-sizer — the deterministic grid-tracks-content sizing engine shared by
 * the two inline xterm.js panels (UnifiedTuiHost + CustomPanelHost).
 *
 * The load-bearing fact both panels share: pi-tui writes ALL of its rendered
 * lines (joined by \r\n) with NO clamp to the terminal `rows`. When content is
 * taller than the grid, the terminal SCROLLS and bottom-anchors, pushing the
 * top into scrollback (the "cut-off line" bug) with no way to scroll back. So
 * the grid is not a fixed budget — it must TRACK the content height. The
 * invariant this engine maintains:
 *
 *   • for ordinary content, grid `rows` = contentRows + 1 (a one-row blank
 *     "sentinel" so we can tell "content fits" from "content filled the grid
 *     and may be clipped"). Content
 *     measurement includes xterm scrollback, so one oversized first frame can
 *     recover its hidden top in one resize. Reported to the host so its TUI lays
 *     out into exactly this grid — every line stays in the viewport, top-anchored.
 *   • mount height = grid height (rows × cell).
 *   • card height  = min(contentRows, maxDisplayRows) × cell — the box hugs the
 *     content, capped at a deterministic max derived from the transcript column
 *     (NOT from window-resize history). Trailing blanks (incl. the sentinel) are
 *     clipped.
 *   • card overflows (scrolls) when ordinary intrinsic content is taller than
 *     maxDisplayRows. Extremely tall intrinsic content keeps a small xterm grid
 *     and uses xterm's virtualized scrollback instead, avoiding thousands of DOM
 *     viewport rows while keeping the complete frame reachable.
 *
 * Determinism: the size is a pure function of the transcript-column height
 * (sessionEl) and the content. Growing the window re-derives a larger cap and
 * re-expands; shrinking re-derives a smaller one. There is no hysteresis — the
 * path taken to reach the current window size never affects the result.
 *
 * Convergence: a height change makes pi-tui fullRender(true) (clears scrollback
 * + re-lays-out), so growing the grid brings a clipped top back and shrinking
 * removes trailing blanks. Intrinsic content settles directly or switches to
 * virtualized scrollback; coupling detection intentionally takes two probes.
 *
 * Two modes:
 *   • "content" (default): track the content as above.
 *   • "viewport": a pi-tui overlay is compositing against `rows`, so its rendered
 *     height is a function of the grid we report — content-tracking and the
 *     overlay would chase each other (the "wiggle"). Pin a FIXED grid (the
 *     display cap) instead and stop tracking.
 *
 * Some widgets do not signal viewport mode but render one screenful based on the
 * `rows` they receive. After two matching growth probes, they are treated as an
 * implicit viewport and pinned to the
 * visible cap. A resize-storm circuit breaker remains defense-in-depth for other
 * grid-coupled output.
 */

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** The slice of xterm's private core we read for the exact rendered cell height
 *  (font-metric accurate — the public API doesn't expose it). */
interface XtermCore {
  _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } };
}

export interface PanelSizerOptions {
  /** The xterm terminal whose grid we resize. */
  term: Terminal;
  /** The xterm mount (`.custom-panel__xterm`) — holds the full grid. */
  container: HTMLElement;
  /** The visible card (`.custom-panel` / `.unified-panel`) — clipped/scrolled. */
  panelEl: HTMLElement;
  /** The transcript column the panel sits inside (`.app__session`), or null. */
  sessionEl: HTMLElement | null;
  /** For proposeDimensions() → the mount-width-driven column count. */
  fitAddon: FitAddon;
  /** Live display-mode read (must NOT be a rebuild dep — a mid-panel flip
   *  reconfigures sizing without tearing down xterm). */
  getMode: () => "content" | "viewport";
  /** Live read of the user's preferred panel height as a fraction of the
   *  session column (0–1), overriding the default cap. Omit for the default
   *  (~half). CustomPanelHost passes the drag/persisted override; UnifiedTuiHost
   *  omits it (content-tracks against the default cap). Must NOT be a rebuild
   *  dep (a drag / settings change re-runs sync without rebuilding xterm). */
  getHeightFraction?: () => number;
  /** Minimum intrinsic grid rows retained while content frames converge. */
  minimumRows?: number;
  /** Font size to fall back to before xterm has measured its cell metrics. */
  fallbackFontSize: number;
  /** Push the current grid size to the host (deduped by the sizer). */
  onReportSize: (cols: number, rows: number) => void;
}

export interface PanelSizer {
  /** Run one sizing pass immediately. */
  sync: () => void;
  /** Coalesce a burst of triggers into at most one pass per animation frame. */
  scheduleSync: () => void;
  /** Tear down: cancel timers and reset the styles the sizer set. */
  dispose: () => void;
}

/** Half the transcript column: the default cap past which the card scrolls
 *  instead of growing. A CustomPanelHost may override this with the user's
 *  drag-resized preference (getHeightFraction); UnifiedTuiHost uses the default. */
export const DEFAULT_HEIGHT_FRACTION = 0.5;

/** Retained xterm history for virtualized intrinsic panels. xterm allocates this
 * lazily; the large bound keeps extension frames reachable without creating one
 * DOM viewport row per rendered line. */
export const PANEL_SCROLLBACK_ROWS = 1_000_000;

// Above this, intrinsic content switches from an outer-scrolled full xterm grid
// to xterm's internally virtualized scrollback. This is a presentation threshold,
// not a content ceiling: rows beyond it remain retained and reachable.
const MAX_CONTENT_GRID_ROWS = 2048;

// Resize-storm circuit breaker tuning.
const RESIZE_WINDOW_MS = 400;
const MAX_RESIZES_PER_WINDOW = 6;
const COOLDOWN_MS = 1000;

export function createPanelSizer(opts: PanelSizerOptions): PanelSizer {
  const { term, container, panelEl, sessionEl, fitAddon, getMode, fallbackFontSize, onReportSize } =
    opts;
  const heightFraction: () => number = opts.getHeightFraction ?? (() => DEFAULT_HEIGHT_FRACTION);
  const minimumRows = Math.max(1, Math.floor(opts.minimumRows ?? 1));

  let disposed = false;

  // Real rendered cell height from xterm's render service (font-metric exact,
  // not a fontSize*1.2 guess that would desync the math). Falls back before the
  // first measurement tick.
  const cellHeight = (): number => {
    const core = (term as unknown as { _core?: XtermCore })._core;
    const h = core?._renderService?.dimensions?.css?.cell?.height;
    return typeof h === "number" && h > 0 ? h : fallbackFontSize * 1.2;
  };

  const sessionHeight = (): number => sessionEl?.clientHeight ?? window.innerHeight;

  // The visible cap — a fraction of the transcript column (default ~half,
  // or the user's drag-resized preference). Past this the card scrolls.
  const maxDisplayRows = (): number =>
    Math.max(1, Math.floor((sessionHeight() * heightFraction()) / cellHeight()));

  // Rows occupied by the current frame (last non-blank + 1), and whether it
  // reached the visible grid's bottom row. Scan the complete active buffer, not
  // only `baseY..baseY+rows`: when an oversized frame scrolls on first paint its
  // hidden top lives before baseY. Ignoring those rows was what stranded large
  // widgets in scrollback and made the sizer stop at an arbitrary viewport-sized
  // ceiling. Height-triggered pi-tui full renders clear scrollback, so after the
  // probe this buffer represents the newly laid-out frame rather than history.
  const measureContent = (): { rows: number; filled: boolean } => {
    const buf = term.buffer.active;
    let lastNonBlank = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).length > 0) {
        lastNonBlank = i;
        break;
      }
    }
    const cursorRow = buf.baseY + buf.cursorY;
    const rows = Math.max(lastNonBlank + 1, cursorRow + 1, 1);
    const viewportBottom = buf.baseY + term.rows - 1;
    // A blank final row still occupies the grid when the caret/cursor reached it.
    // Ignoring cursor occupancy lets `rows + k` widgets with trailing blanks grow
    // forever without ever entering the coupling probes.
    return { rows, filled: Math.max(lastNonBlank, cursorRow) >= viewportBottom };
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

  // Tell the transcript that the Composer slot changed height outside a React
  // layout pass (xterm measures/render-resizes asynchronously). When the feed is
  // bottom-pinned it must re-pin immediately, otherwise the new panel appears to
  // cover the latest transcript lines until another token arrives.
  const notifyComposerSlotResize = (): void => {
    panelEl.dispatchEvent(new CustomEvent("pivis:composer-slot-resize", { bubbles: true }));
  };

  // Push the current grid size to the host (only on change — avoids redundant
  // IPC + host re-renders).
  const reportSize = (cols: number, rows: number): void => {
    if (cols === lastCols && rows === lastRows) return;
    lastCols = cols;
    lastRows = rows;
    onReportSize(cols, rows);
  };

  // Pin a FIXED grid of `rows` (no content tracking) and size mount + card to
  // match. Used in viewport mode (a pi-tui overlay is up — its geometry tracks
  // the rows we give it, so a stable grid yields a stable render) and as the
  // resize-storm circuit breaker. cols still tracks the mount width.
  const applyFixedViewport = (rows: number, cols: number, cell: number): void => {
    const gridRows = Math.max(1, rows);
    if (cols !== term.cols || gridRows !== term.rows) term.resize(cols, gridRows);
    reportSize(cols, gridRows);
    const displayRows = Math.min(gridRows, maxDisplayRows());
    container.style.height = `${gridRows * cell}px`;
    panelEl.style.height = `${displayRows * cell + cardChrome()}px`;
    panelEl.style.overflowY = gridRows > maxDisplayRows() ? "auto" : "hidden";
    notifyComposerSlotResize();
  };

  // Extremely tall intrinsic content uses xterm's own scrollback viewport. The
  // outer card remains fixed-size; xterm renders only visible rows and owns the
  // scrollbar. `virtualTopPending` opens a newly entered/repainted frame at top.
  let virtualizedIntrinsic = false;
  let virtualTopPending = false;
  const applyVirtualizedIntrinsic = (cols: number, cell: number): void => {
    const gridRows = maxDisplayRows();
    const gridChanged = cols !== term.cols || gridRows !== term.rows;
    if (gridChanged) {
      term.resize(cols, gridRows);
      virtualTopPending = true;
    }
    reportSize(cols, gridRows);
    container.style.height = `${gridRows * cell}px`;
    panelEl.style.height = `${gridRows * cell + cardChrome()}px`;
    panelEl.style.overflowY = "hidden";
    if (virtualTopPending && !gridChanged) {
      term.scrollToTop();
      virtualTopPending = false;
    }
    notifyComposerSlotResize();
  };

  // ── Resize-storm circuit breaker (damping) ──────────────────────────────
  let resizeTimes: number[] = [];
  let pinnedRows = 0; // > 0 while the breaker is engaged
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  // Detect output coupled to the reported grid by comparing TWO consecutive
  // overflow probes. One equality is ambiguous at xterm's scrollback boundary;
  // two matching deltas distinguish `rows + k` widgets from fixed intrinsic
  // frames. This is separate from explicit panel_mode because third-party
  // setWidget factories have no mode signal.
  let overflowProbe: {
    targetRows: number;
    sourceRows: number;
    sourceContentRows: number;
    coupledPasses: number;
  } | null = null;
  let implicitViewport = false;
  let implicitViewportExtraRows = 0;

  let syncQueued = false;
  const scheduleSync = (): void => {
    if (syncQueued || disposed) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      if (!disposed) sync();
    });
  };

  // Single sizing pass. Content mode resizes ordinary grids toward
  // `contentRows+1`, virtualizes extremely tall intrinsic frames, and probes
  // grid-coupled content. Viewport mode (or the breaker) pins a fixed grid.
  // Re-runs are coalesced via scheduleSync.
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
    if (getMode() === "viewport") {
      overflowProbe = null;
      implicitViewport = false;
      implicitViewportExtraRows = 0;
      virtualizedIntrinsic = false;
      virtualTopPending = false;
      applyFixedViewport(maxDisplayRows(), cols, cell);
      return;
    }

    const measured = measureContent();

    // Extremely tall intrinsic content is retained in xterm scrollback and
    // presented through xterm's virtualized viewport. If it later shrinks below
    // the threshold, return to the normal grid-tracks-content path.
    if (virtualizedIntrinsic) {
      if (measured.rows + 1 > MAX_CONTENT_GRID_ROWS) {
        applyVirtualizedIntrinsic(cols, cell);
        return;
      }
      virtualizedIntrinsic = false;
      virtualTopPending = false;
      overflowProbe = null;
    }

    // A setWidget component can be viewport-coupled without an explicit mode
    // signal. Keep it fixed while its height continues to track the grid; release
    // it if later content becomes intrinsic overflow or shrinks.
    if (implicitViewport) {
      if (measured.filled && measured.rows <= term.rows + implicitViewportExtraRows) {
        applyFixedViewport(maxDisplayRows(), cols, cell);
        return;
      }
      implicitViewport = false;
      implicitViewportExtraRows = 0;
      overflowProbe = null;
    }

    // Breaker engaged: hold the pinned grid until the cooldown re-opens tracking.
    if (pinnedRows > 0) {
      applyFixedViewport(pinnedRows, cols, cell);
      return;
    }

    const { rows: contentRows, filled } = measured;
    let coupledPasses = 0;
    if (filled && overflowProbe?.targetRows === term.rows) {
      const gridGrowth = term.rows - overflowProbe.sourceRows;
      const contentGrowth = contentRows - overflowProbe.sourceContentRows;
      coupledPasses =
        gridGrowth > 0 && contentGrowth === gridGrowth ? overflowProbe.coupledPasses + 1 : 0;
      if (coupledPasses >= 2) {
        overflowProbe = null;
        implicitViewport = true;
        implicitViewportExtraRows = Math.max(0, contentRows - term.rows);
        applyFixedViewport(maxDisplayRows(), cols, cell);
        return;
      }
    }

    // Intrinsic overflow gets a sentinel. Once that full grid would exceed the
    // DOM-row threshold, switch presentation to xterm's retained, virtualized
    // scrollback instead of clipping or allocating an unbounded viewport.
    const targetRows = Math.max(minimumRows, contentRows + 1);
    if (targetRows > MAX_CONTENT_GRID_ROWS) {
      overflowProbe = null;
      virtualizedIntrinsic = true;
      virtualTopPending = true;
      applyVirtualizedIntrinsic(cols, cell);
      return;
    }
    overflowProbe = filled
      ? {
          targetRows,
          sourceRows: term.rows,
          sourceContentRows: contentRows,
          coupledPasses,
        }
      : null;

    if (cols !== term.cols || targetRows !== term.rows) {
      // Trip the breaker if resizes are coming too fast to be a real settle.
      const now = Date.now();
      resizeTimes.push(now);
      resizeTimes = resizeTimes.filter((t) => now - t < RESIZE_WINDOW_MS);
      if (resizeTimes.length > MAX_RESIZES_PER_WINDOW) {
        pinnedRows = Math.max(term.rows, targetRows);
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
      // The host re-renders a fresh frame after every reported grid change.
      // Re-measure from that panel_data callback; measuring xterm's local reflow
      // here would mistake the old frame for the overflow probe's response.
      return;
    }
    reportSize(cols, targetRows);

    // Settled. Mount holds the full grid; the card hugs the content, capped.
    container.style.height = `${term.rows * cell}px`;
    const displayRows = Math.min(contentRows, maxDisplayRows());
    panelEl.style.height = `${displayRows * cell + cardChrome()}px`;
    // Scroll (via the card) only when the content is taller than the cap.
    panelEl.style.overflowY = contentRows > maxDisplayRows() ? "auto" : "hidden";
    notifyComposerSlotResize();
  };

  const dispose = (): void => {
    disposed = true;
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = null;
    panelEl.style.height = "";
    panelEl.style.overflowY = "";
    container.style.height = "";
    notifyComposerSlotResize();
  };

  return { sync, scheduleSync, dispose };
}
