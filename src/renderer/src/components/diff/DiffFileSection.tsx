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
import type { FileState } from "../../stores/diff-store.js";
import { useDiffStore } from "../../stores/diff-store.js";
import "./DiffFileSection.css";

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
      <button
        type="button"
        className="diff-file__header"
        onClick={() => toggleCollapsed(file.path)}
        aria-expanded={open}
        title={file.path}
      >
        <span className="diff-file__chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <StatusBadge status={file.status} untracked={file.untracked} />
        <FilePath file={file} />
        <Counts insertions={file.insertions} deletions={file.deletions} binary={file.binary} />
      </button>
      {open && (
        <FileBody
          file={file}
          state={state}
          viewMode={viewMode}
          narrowWindow={narrowWindow}
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
  onExpandGap,
}: {
  file: GitChangedFile;
  state: FileState;
  viewMode: "unified" | "split";
  narrowWindow: boolean;
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
  onExpandGap,
}: {
  model: DiffModel;
  gapState: GapState[];
  oldTokens: ThemedToken[][] | null | undefined;
  newTokens: ThemedToken[][] | null | undefined;
  viewMode: "unified" | "split";
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
                  {renderTokens(row.text, oldTokenByLineNo?.(row.leftNo), null, "old")}
                </div>
                <div className="diff-row__num diff-row__num--right">{row.rightNo}</div>
                <div
                  className="diff-row__code"
                  data-side="new"
                  data-selecting="auto"
                  onMouseDown={(e) => onSelectSide(e, "new")}
                >
                  {renderTokens(row.text, newTokenByLineNo?.(row.rightNo), null, "new")}
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
              <div className="diff-row__code">{renderTokens(row.line.text, null, null, "old")}</div>
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
          className="diff-gap__btn"
          title={`Show next ${EXPAND_STEP} lines`}
          onClick={() => onExpand(gapIndex, "down")}
        >
          ▼
        </button>
      )}
      {!isSmall && showUp && (
        <button
          type="button"
          className="diff-gap__btn"
          title={`Show previous ${EXPAND_STEP} lines`}
          onClick={() => onExpand(gapIndex, "up")}
        >
          ▲
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
  // Renders the file path with a separate dirname span (so the
  // dirname absorbs all truncation) and a basename span (never
  // truncated). For renames, we render oldPath → path.
  if (file.status === "R" && file.oldPath) {
    return (
      <span className="diff-file__path" title={`${file.oldPath} → ${file.path}`}>
        <PathPart path={file.oldPath} />
        <span className="diff-file__arrow">→</span>
        <PathPart path={file.path} />
      </span>
    );
  }
  return (
    <span className="diff-file__path" title={file.path}>
      <PathPart path={file.path} />
    </span>
  );
}

function PathPart({ path }: { path: string }): React.ReactElement {
  const slash = path.lastIndexOf("/");
  if (slash === -1) {
    return <span className="diff-file__basename">{path}</span>;
  }
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  return (
    <>
      <span className="diff-file__dirname">{dir}</span>
      <span className="diff-file__basename">{base}</span>
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

function renderTokens(
  text: string,
  tokens: ThemedToken[] | null | undefined,
  emphasis: IntralineRanges | null | undefined,
  side: "old" | "new",
): React.ReactNode {
  const ranges =
    emphasis === null || emphasis === undefined ? [] : side === "old" ? emphasis.old : emphasis.new;
  if (tokens === null || tokens === undefined) {
    return renderPlainWithEmphasis(text, ranges);
  }
  // tokens is the per-line ThemedToken array. Build the input list
  // with care for `exactOptionalPropertyTypes`: only include `color`
  // when it's defined.
  const segs = segmentLine(
    tokens.map((t) =>
      t.color !== undefined ? { text: t.content, color: t.color } : { text: t.content },
    ),
    ranges,
  );
  return segs.map((s, i) => {
    if (s.text === "") return null;
    if (s.em) {
      return (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are recreated per render; no per-segment state
          key={i}
          className="diff-row__em"
          style={s.color ? { color: s.color } : undefined}
        >
          {s.text}
        </span>
      );
    }
    return s.color ? (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are recreated per render; no per-segment state
        key={i}
        style={{ color: s.color }}
      >
        {s.text}
      </span>
    ) : (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are recreated per render; no per-segment state
        key={i}
      >
        {s.text}
      </span>
    );
  });
}

function renderPlainWithEmphasis(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): React.ReactNode {
  if (ranges.length === 0) return text;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i]!;
    if (a > cursor) out.push(text.slice(cursor, a));
    out.push(
      <span key={i} className="diff-row__em">
        {text.slice(a, b)}
      </span>,
    );
    cursor = b;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
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
