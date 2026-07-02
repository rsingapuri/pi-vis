// DiffFileSection — one file's diff body + sticky header. Renders either
// unified or split rows based on the parent's `viewMode`.
//
// The body is a CSS grid: each row has a number gutter, marker, and
// code cell. The marker character is rendered by a ::before pseudo so
// it never lands in copied text.

import type { GitChangedFile } from "@shared/git.js";
import type React from "react";
import { useEffect, useMemo } from "react";
import type { ThemedToken } from "shiki";
import {
  type DiffModel,
  type GapState,
  type SplitRow,
  buildSplitRows,
  visibleRows,
} from "../../lib/diff/diff-model.js";
import { segmentLine } from "../../lib/diff/highlight.js";
import type { IntralineRanges } from "../../lib/diff/intraline.js";
import { findOccurrences } from "../../lib/diff/search.js";
import type { MatchSide } from "../../lib/diff/search.js";
import type { FileState } from "../../stores/diff-store.js";
import { useDiffStore } from "../../stores/diff-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconChevronDown, IconChevronRight, IconChevronUp } from "../common/icons.js";
import "./DiffFileSection.css";

/**
 * In-diff find context for one file. `query` is "" when search is closed or
 * empty (the no-op fast path). `active` is the currently-focused occurrence —
 * present only when this file owns the active match — used to paint the one
 * "current" highlight differently from the rest.
 */
export interface SearchHighlight {
  query: string;
  caseSensitive: boolean;
  active: { lineIdx: number; side: MatchSide; occ: number } | null;
}

/** Per-code-cell search info handed to renderTokens. `null` = nothing to do. */
interface CellSearch {
  query: string;
  caseSensitive: boolean;
  /** Occurrence index to mark "current" on this cell, or null. */
  currentOcc: number | null;
}

/** Build the per-cell search payload for a given (lineIdx, matchSide). */
function cellSearch(
  search: SearchHighlight | undefined,
  lineIdx: number | null,
  side: MatchSide,
): CellSearch | null {
  if (!search || search.query === "") return null;
  const a = search.active;
  const currentOcc =
    a && lineIdx !== null && a.lineIdx === lineIdx && a.side === side ? a.occ : null;
  return { query: search.query, caseSensitive: search.caseSensitive, currentOcc };
}

interface DiffFileSectionProps {
  file: GitChangedFile;
  state: FileState;
  viewMode: "unified" | "split";
  narrowWindow: boolean;
  /** Section is the active one (scroll-spy). */
  active: boolean;
  /** Register a ref so the host can scroll-spy and scroll-into-view. */
  sectionRef: (el: HTMLElement | null) => void;
}

export function DiffFileSection({
  file,
  state,
  viewMode,
  narrowWindow,
  active,
  sectionRef,
}: DiffFileSectionProps): React.ReactElement {
  const toggleCollapsed = useDiffStore((s) => s.toggleCollapsed);
  const ensureFileLoaded = useDiffStore((s) => s.ensureFileLoaded);
  const expandGap = useDiffStore((s) => s.expandGap);

  // In-diff find: rendered highlight for this file. Reads only the slices it
  // needs (query/caseSensitive/active-for-this-file) so unrelated store
  // updates don't re-render the body.
  const searchOpen = useDiffStore((s) => s.search.open);
  const searchQuery = useDiffStore((s) => s.search.query);
  const searchCaseSensitive = useDiffStore((s) => s.search.caseSensitive);
  const activeMatch = useDiffStore((s) => {
    const m = s.search.activeMatch;
    return m && m.path === file.path ? m : null;
  });
  const search: SearchHighlight = {
    query: searchOpen ? searchQuery : "",
    caseSensitive: searchCaseSensitive,
    active: activeMatch
      ? { lineIdx: activeMatch.lineIdx, side: activeMatch.side, occ: activeMatch.occ }
      : null,
  };

  // Auto-load: the host attaches IntersectionObserver to each section
  // and calls ensureFileLoaded(path) when the section is in view. We
  // still kick off on mount for the first N files (handled in the host).
  // Collapsed sections don't load.
  useEffect(() => {
    if (state.status === "idle" && !state.collapsed) {
      void ensureFileLoaded(file.path);
    }
  }, [state.status, state.collapsed, file.path, ensureFileLoaded]);

  const open = !state.collapsed;

  return (
    <section
      ref={sectionRef}
      className={`diff-file${open ? " diff-file--open" : ""}${active ? " diff-file--active" : ""}`}
      data-path={file.path}
      data-testid={`diff-section-${file.path}`}
    >
      <div className="diff-file__header" title={file.path}>
        <button
          type="button"
          className="diff-file__chevron-btn"
          onClick={() => toggleCollapsed(file.path)}
          aria-expanded={open}
          aria-label={open ? "Collapse file" : "Expand file"}
        >
          <IconChevronRight className="diff-file__chevron" />
        </button>
        <StatusBadge status={file.status} untracked={file.untracked} />
        <FilePath file={file} />
        <Counts insertions={file.insertions} deletions={file.deletions} binary={file.binary} />
      </div>
      {open && (
        <FileBody
          file={file}
          state={state}
          viewMode={viewMode}
          narrowWindow={narrowWindow}
          search={search}
          onExpandGap={(idx, dir) => expandGap(file.path, idx, dir)}
        />
      )}
    </section>
  );
}

// ── Body ──────────────────────────────────────────────────────────────

function FileBody({
  file,
  state,
  viewMode,
  narrowWindow,
  search,
  onExpandGap,
}: {
  file: GitChangedFile;
  state: FileState;
  viewMode: "unified" | "split";
  narrowWindow: boolean;
  search: SearchHighlight;
  onExpandGap: (idx: number, dir: "up" | "down" | "all") => void;
}): React.ReactElement {
  // We render whatever status the model is in.
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="diff-file__body diff-file__body--open">
        <div className="diff-file__notice diff-file__notice--loading">Loading…</div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="diff-file__body diff-file__body--open">
        <div className="diff-file__notice">
          <span>{state.error ?? "Failed to load file"}</span>
          <RetryButton path={file.path} />
        </div>
      </div>
    );
  }
  const model = state.model;
  if (!model) {
    return (
      <div className="diff-file__body diff-file__body--open">
        <div className="diff-file__notice diff-file__notice--loading">Loading…</div>
      </div>
    );
  }
  if (model.kind === "too-large") {
    return (
      <div className="diff-file__body diff-file__body--open">
        <div className="diff-file__notice">File too large to diff</div>
      </div>
    );
  }
  if (model.kind === "binary") {
    return (
      <div className="diff-file__body diff-file__body--open">
        <div className="diff-file__notice">Binary file not shown</div>
      </div>
    );
  }
  if (model.kind === "ok" && model.changedCount === 0) {
    return (
      <div className="diff-file__body diff-file__body--open">
        <div className="diff-file__notice">No content changes (line endings or file mode only)</div>
      </div>
    );
  }
  if (model.kind !== "ok") {
    return (
      <div className="diff-file__body diff-file__body--open">
        <div className="diff-file__notice">No diff available</div>
      </div>
    );
  }

  const useSplit = viewMode === "split" && !narrowWindow;
  return (
    <RowsView
      model={model}
      gapState={state.gapState ?? model.gaps.map(() => ({ top: 0, bottom: 0 }))}
      oldTokens={state.oldTokens}
      newTokens={state.newTokens}
      viewMode={useSplit ? "split" : "unified"}
      search={search}
      onExpandGap={onExpandGap}
    />
  );
}

// ── RowsView: unified / split switch ─────────────────────────────────

function RowsView({
  model,
  gapState,
  oldTokens,
  newTokens,
  viewMode,
  search,
  onExpandGap,
}: {
  model: DiffModel;
  gapState: GapState[];
  oldTokens: ThemedToken[][] | null | undefined;
  newTokens: ThemedToken[][] | null | undefined;
  viewMode: "unified" | "split";
  search: SearchHighlight;
  onExpandGap: (idx: number, dir: "up" | "down" | "all") => void;
}): React.ReactElement {
  // Compute the gutter width from the max line number so the gutters
  // are uniform across all rows in this file.
  const gutterW = useMemo(() => {
    const max = Math.max(model.oldCount, model.newCount, 1);
    const digits = Math.max(2, String(max).length);
    return `calc(${digits}ch + 1.143rem)`;
  }, [model.oldCount, model.newCount]);

  const rows = useMemo(() => visibleRows(model, gapState), [model, gapState]);
  const splitRows = useMemo(
    () => (viewMode === "split" ? buildSplitRows(rows) : null),
    [rows, viewMode],
  );

  // Build old/new line index → token-line map for split view. Each
  // entry is the (1-based) line number. We index by line number into
  // `oldTokens[newNo - 1]` etc.
  const oldTokenByLineNo = useMemo(() => {
    if (!oldTokens) return null;
    return (lineNo: number | null) => (lineNo !== null ? oldTokens[lineNo - 1] : null);
  }, [oldTokens]);
  const newTokenByLineNo = useMemo(() => {
    if (!newTokens) return null;
    return (lineNo: number | null) => (lineNo !== null ? newTokens[lineNo - 1] : null);
  }, [newTokens]);

  if (viewMode === "split" && splitRows) {
    return (
      <div
        className="diff-file__body diff-file__body--open"
        style={{ ["--gutter-w" as string]: gutterW }}
      >
        {splitRows.map((row, idx) => {
          if (row.type === "split-gap") {
            return (
              <GapRow
                // biome-ignore lint/suspicious/noArrayIndexKey: row stream is rebuilt wholesale; no per-row state
                key={idx}
                gapIndex={row.gapIndex}
                hiddenCount={row.hiddenCount}
                isFileStart={row.isFileStart}
                isFileEnd={row.isFileEnd}
                onExpand={onExpandGap}
              />
            );
          }
          if (row.type === "split-context") {
            return (
              <div
                className="diff-row diff-row--split"
                // biome-ignore lint/suspicious/noArrayIndexKey: row stream is rebuilt wholesale; no per-row state
                key={idx}
              >
                <div className="diff-row__num">{row.leftNo}</div>
                <div
                  className="diff-row__code"
                  data-side="old"
                  data-selecting="auto"
                  onMouseDown={(e) => onSelectSide(e, "old")}
                >
                  {renderTokens(
                    row.text,
                    oldTokenByLineNo?.(row.leftNo),
                    null,
                    "old",
                    cellSearch(search, row.lineIdx, "context"),
                  )}
                </div>
                <div className="diff-row__num diff-row__num--right">{row.rightNo}</div>
                <div
                  className="diff-row__code"
                  data-side="new"
                  data-selecting="auto"
                  onMouseDown={(e) => onSelectSide(e, "new")}
                >
                  {renderTokens(
                    row.text,
                    newTokenByLineNo?.(row.rightNo),
                    null,
                    "new",
                    cellSearch(search, row.lineIdx, "context"),
                  )}
                </div>
              </div>
            );
          }
          return (
            <div
              className="diff-row diff-row--split"
              // biome-ignore lint/suspicious/noArrayIndexKey: row stream is rebuilt wholesale; no per-row state
              key={idx}
            >
              <div className={`diff-row__num${row.leftText === "" ? " diff-row__num--empty" : ""}`}>
                {row.leftNo ?? ""}
              </div>
              <div
                className={`diff-row__code${row.leftText === "" ? " diff-row__code--empty" : ""}`}
                data-side="old"
                data-selecting="auto"
                onMouseDown={(e) => onSelectSide(e, "old")}
              >
                {renderTokens(
                  row.leftText,
                  oldTokenByLineNo?.(row.leftNo),
                  row.leftEmphasis,
                  "old",
                  cellSearch(search, row.leftIdx, "old"),
                )}
              </div>
              <div
                className={`diff-row__num diff-row__num--right${row.rightText === "" ? " diff-row__num--empty" : ""}`}
              >
                {row.rightNo ?? ""}
              </div>
              <div
                className={`diff-row__code${row.rightText === "" ? " diff-row__code--empty" : ""}`}
                data-side="new"
                data-selecting="auto"
                onMouseDown={(e) => onSelectSide(e, "new")}
              >
                {renderTokens(
                  row.rightText,
                  newTokenByLineNo?.(row.rightNo),
                  row.rightEmphasis,
                  "new",
                  cellSearch(search, row.rightIdx, "new"),
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Unified view
  return (
    <div
      className="diff-file__body diff-file__body--open"
      style={{ ["--gutter-w" as string]: gutterW }}
    >
      {rows.map((row, idx) => {
        if (row.type === "gap") {
          return (
            <GapRow
              // biome-ignore lint/suspicious/noArrayIndexKey: row stream is rebuilt wholesale; no per-row state
              key={idx}
              gapIndex={row.gapIndex}
              hiddenCount={row.hiddenCount}
              isFileStart={row.isFileStart}
              isFileEnd={row.isFileEnd}
              onExpand={onExpandGap}
            />
          );
        }
        if (row.type === "context") {
          return (
            <div
              className="diff-row"
              // biome-ignore lint/suspicious/noArrayIndexKey: row stream is rebuilt wholesale; no per-row state
              key={idx}
            >
              <div className="diff-row__num">{row.line.oldNo}</div>
              <div className="diff-row__num">{row.line.newNo}</div>
              <div className="diff-row__marker" />
              <div className="diff-row__code">
                {renderTokens(
                  row.line.text,
                  null,
                  null,
                  "old",
                  cellSearch(search, row.lineIdx, "context"),
                )}
              </div>
            </div>
          );
        }
        if (row.type === "del") {
          return (
            <div
              className="diff-row diff-row--del"
              // biome-ignore lint/suspicious/noArrayIndexKey: row stream is rebuilt wholesale; no per-row state
              key={idx}
            >
              <div className="diff-row__num">{row.line.oldNo}</div>
              <div className="diff-row__num diff-row__num--empty" />
              <div className="diff-row__marker" />
              <div className="diff-row__code">
                {renderTokens(
                  row.line.text,
                  oldTokenByLineNo?.(row.line.oldNo),
                  row.line.emphasis,
                  "old",
                  cellSearch(search, row.lineIdx, "old"),
                )}
              </div>
            </div>
          );
        }
        return (
          <div
            className="diff-row diff-row--add"
            // biome-ignore lint/suspicious/noArrayIndexKey: row stream is rebuilt wholesale; no per-row state
            key={idx}
          >
            <div className="diff-row__num diff-row__num--empty" />
            <div className="diff-row__num">{row.line.newNo}</div>
            <div className="diff-row__marker" />
            <div className="diff-row__code">
              {renderTokens(
                row.line.text,
                newTokenByLineNo?.(row.line.newNo),
                row.line.emphasis,
                "new",
                cellSearch(search, row.lineIdx, "new"),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Gap row ───────────────────────────────────────────────────────────

const EXPAND_STEP = 20;

function GapRow({
  gapIndex,
  hiddenCount,
  isFileStart,
  isFileEnd,
  onExpand,
}: {
  gapIndex: number;
  hiddenCount: number;
  isFileStart: boolean;
  isFileEnd: boolean;
  onExpand: (idx: number, dir: "up" | "down" | "all") => void;
}): React.ReactElement {
  // Spec: ▼ reveals the FIRST 20 hidden lines (downward from the
  // hunk above); ▲ reveals the LAST 20 (upward toward the hunk
  // below). Gap before the first hunk: only ▲ + label. Gap after
  // the last hunk: only ▼ + label. Gap ≤ 20: only the label, which
  // expands to "all".
  const isSmall = hiddenCount <= EXPAND_STEP;
  const showDown = !isFileStart;
  const showUp = !isFileEnd;
  return (
    <div className="diff-gap" data-testid={`diff-gap-${gapIndex}`}>
      <div className="diff-gap__gutter" aria-hidden>
        ⋯
      </div>
      {!isSmall && showDown && (
        <button
          type="button"
          className="diff-gap__btn icon-btn"
          title={`Show next ${EXPAND_STEP} lines`}
          onClick={() => onExpand(gapIndex, "down")}
        >
          <IconChevronDown />
        </button>
      )}
      {!isSmall && showUp && (
        <button
          type="button"
          className="diff-gap__btn icon-btn"
          title={`Show previous ${EXPAND_STEP} lines`}
          onClick={() => onExpand(gapIndex, "up")}
        >
          <IconChevronUp />
        </button>
      )}
      <button
        type="button"
        className="diff-gap__label"
        title={`Show all ${hiddenCount} lines`}
        onClick={() => onExpand(gapIndex, "all")}
      >
        {isSmall
          ? `Expand ${hiddenCount} ${hiddenCount === 1 ? "line" : "lines"}`
          : `${hiddenCount} unchanged lines`}
      </button>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function StatusBadge({
  status,
  untracked,
}: { status: GitChangedFile["status"]; untracked: boolean }): React.ReactElement {
  return (
    <span
      className={`diff-status-badge diff-status-badge--${status}`}
      title={untracked ? "Untracked file" : status}
    >
      {status}
    </span>
  );
}

function Counts({
  insertions,
  deletions,
  binary,
}: {
  insertions: number;
  deletions: number;
  binary: boolean;
}): React.ReactElement {
  if (binary) {
    return <span className="diff-file__counts diff-file__count--bin">BIN</span>;
  }
  return (
    <span className="diff-file__counts">
      {insertions > 0 && <span className="diff-file__count--add">+{insertions}</span>}
      {deletions > 0 && <span className="diff-file__count--del">−{deletions}</span>}
    </span>
  );
}

function FilePath({ file }: { file: GitChangedFile }): React.ReactElement {
  // ONE head-mode FadeText across the whole path: at rest the tail — the
  // basename, the load-bearing part — stays visible while the leading edge
  // fades; hovering glides the full path into view in a single motion.
  // (Splitting dirname/basename into two independent FadeTexts produced a
  // double fade with two tiny disconnected glides, and a stray leading "/"
  // once the dirname had fully collapsed.) For renames, oldPath → path
  // share the same fade.
  if (file.status === "R" && file.oldPath) {
    return (
      <FadeText head className="diff-file__path" title={`${file.oldPath} → ${file.path}`}>
        <PathSpans path={file.oldPath} />
        <span className="diff-file__arrow">→</span>
        <PathSpans path={file.path} />
      </FadeText>
    );
  }
  return (
    <FadeText head className="diff-file__path" title={file.path}>
      <PathSpans path={file.path} />
    </FadeText>
  );
}

/** Dirname (dim, includes the trailing slash) + basename (bright) spans. */
function PathSpans({ path }: { path: string }): React.ReactElement {
  const slash = path.lastIndexOf("/");
  if (slash === -1) {
    return <span className="diff-file__basename">{path}</span>;
  }
  return (
    <>
      <span className="diff-file__dirname">{path.slice(0, slash + 1)}</span>
      <span className="diff-file__basename">{path.slice(slash + 1)}</span>
    </>
  );
}

function RetryButton({ path }: { path: string }): React.ReactElement {
  const ensureFileLoaded = useDiffStore((s) => s.ensureFileLoaded);
  return (
    <button
      type="button"
      className="diff-file__notice__retry"
      onClick={() => void ensureFileLoaded(path)}
    >
      Retry
    </button>
  );
}

// ── Token rendering with intraline emphasis ──────────────────────────

/** A rendered run of line text carrying its highlight layers. */
interface RenderSeg {
  text: string;
  color?: string;
  /** Intraline change emphasis. */
  em: boolean;
  /** A search-query hit. */
  search?: boolean;
  /** The single currently-focused search hit. */
  current?: boolean;
}

function renderTokens(
  text: string,
  tokens: ThemedToken[] | null | undefined,
  emphasis: IntralineRanges | null | undefined,
  side: "old" | "new",
  search: CellSearch | null,
): React.ReactNode {
  const emRanges =
    emphasis === null || emphasis === undefined ? [] : side === "old" ? emphasis.old : emphasis.new;
  const searchRanges =
    search === null ? [] : findOccurrences(text, search.query, search.caseSensitive);

  // Fast path: plain text with no layers at all. Avoids a span wrapper for the
  // overwhelmingly common context line.
  if (
    (tokens === null || tokens === undefined) &&
    emRanges.length === 0 &&
    searchRanges.length === 0
  ) {
    return text;
  }

  // Base segments carry color (shiki) + intraline emphasis. When shiki tokens
  // are absent we feed segmentLine a single whole-line token so the same
  // pipeline produces plain (uncolored) emphasis segments.
  const rawTokens =
    tokens === null || tokens === undefined
      ? [{ text }]
      : tokens.map((t) =>
          t.color !== undefined ? { text: t.content, color: t.color } : { text: t.content },
        );
  let segs: RenderSeg[] = segmentLine(rawTokens, emRanges).map((s) => ({
    text: s.text,
    ...(s.color !== undefined ? { color: s.color } : {}),
    em: s.em,
  }));

  // Overlay the search layer, splitting segments at hit boundaries.
  if (searchRanges.length > 0) {
    segs = overlaySearch(segs, searchRanges, search?.currentOcc ?? null);
  }

  return segs.map((s, i) => {
    if (s.text === "") return null;
    const cls =
      `${s.em ? "diff-row__em " : ""}${s.search ? "diff-search-mark " : ""}${s.current ? "diff-search-mark--current" : ""}`.trim();
    return (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are recreated per render; no per-segment state
        key={i}
        className={cls === "" ? undefined : cls}
        style={s.color !== undefined ? { color: s.color } : undefined}
      >
        {s.text}
      </span>
    );
  });
}

/**
 * Split base segments at search-hit boundaries, tagging the hit slices with
 * `search` (and `current` for the focused occurrence). `ranges` are char
 * offsets into the whole line text, sorted and non-overlapping; segments are
 * contiguous and cover the line in order, so a single left-to-right walk
 * suffices.
 */
function overlaySearch(
  segs: RenderSeg[],
  ranges: Array<[number, number]>,
  currentOcc: number | null,
): RenderSeg[] {
  const out: RenderSeg[] = [];
  let pos = 0;
  const slice = (seg: RenderSeg, from: number, to: number): RenderSeg => ({
    text: seg.text.slice(from, to),
    ...(seg.color !== undefined ? { color: seg.color } : {}),
    em: seg.em,
  });
  for (const seg of segs) {
    const segStart = pos;
    const segEnd = pos + seg.text.length;
    pos = segEnd;
    if (seg.text === "") continue;
    let cursor = segStart;
    for (let ri = 0; ri < ranges.length; ri++) {
      const [a, b] = ranges[ri]!;
      if (b <= cursor) continue;
      if (a >= segEnd) break;
      const lo = Math.max(a, cursor);
      const hi = Math.min(b, segEnd);
      if (lo > cursor) out.push(slice(seg, cursor - segStart, lo - segStart));
      if (hi > lo) {
        out.push({
          ...slice(seg, lo - segStart, hi - segStart),
          search: true,
          ...(ri === currentOcc ? { current: true } : {}),
        });
        cursor = hi;
      }
    }
    if (cursor < segEnd) out.push(slice(seg, cursor - segStart, segEnd - segStart));
  }
  return out;
}

// ── Split-view selection containment ──────────────────────────────────

function onSelectSide(e: React.MouseEvent<HTMLDivElement>, side: "old" | "new"): void {
  const target = e.currentTarget;
  const section = target.closest(".diff-file__body--open");
  if (!section) return;
  section.setAttribute("data-selecting", side);
  // Clear on next mouseup anywhere in the document.
  const clear = (): void => {
    section.removeAttribute("data-selecting");
    document.removeEventListener("mouseup", clear, true);
  };
  document.addEventListener("mouseup", clear, true);
}
