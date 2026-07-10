// Diff model — pure functions that turn two file contents into the
// structure consumed by the view. No React, no DOM, no IPC.
//
// Pipeline:
//   buildDiffModel(oldText, newText)
//     → flat lines with del/add pairing, intraline ranges, hunk indices
//   visibleRows(model, gapState)
//     → row stream the view renders (with collapsed gaps)
//   buildSplitRows(rows)
//     → split-view alignment of the same rows
//
// The correctness core lives here. Components stay dumb and only project.

import { diffLines } from "diff";
import { intralineRanges } from "./intraline.js";
import type { IntralineRanges } from "./intraline.js";

// ── Public types ───────────────────────────────────────────────────────

export type DiffLineType = "context" | "del" | "add";

export interface ContextLine {
  type: "context";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DelLine {
  type: "del";
  oldNo: number;
  text: string;
  /** Index of the matching add in `lines`, or undefined for an unpaired del. */
  pair?: number;
  emphasis?: IntralineRanges;
}

export interface AddLine {
  type: "add";
  newNo: number;
  text: string;
  /** Index of the matching del in `lines`, or undefined for an unpaired add. */
  pair?: number;
  emphasis?: IntralineRanges;
}

export type DiffLine = ContextLine | DelLine | AddLine;

export interface DiffHunk {
  /** Inclusive index into `lines` where the hunk starts (first kept line). */
  startIdx: number;
  /** Inclusive index into `lines` where the hunk ends (last kept line). */
  endIdx: number;
  /** Index of this hunk in the model's `hunks` array (0-based). */
  index: number;
}

export interface DiffGap {
  /**
   * Index into `lines` of the first line in the gap (or the boundary
   * line — see `isFileStart`/`isFileEnd`).
   */
  startIdx: number;
  /** Inclusive last index in the gap. */
  endIdx: number;
  /** True if this gap precedes the first hunk (file start). */
  isFileStart: boolean;
  /** True if this gap follows the last hunk (file end). */
  isFileEnd: boolean;
  /** Total number of original lines in the gap. */
  size: number;
  /** Index in the model's `gaps` array. */
  index: number;
}

export interface DiffModel {
  kind: "ok";
  lines: DiffLine[];
  hunks: DiffHunk[];
  gaps: DiffGap[];
  changedCount: number;
  /** Final old line number, or 0 if there were no old lines. */
  oldCount: number;
  /** Final new line number, or 0 if there were no new lines. */
  newCount: number;
}

export interface TooLargeModel {
  kind: "too-large";
  oldSize: number;
  newSize: number;
}

export interface BinaryModel {
  kind: "binary";
}

export type AnyDiffModel = DiffModel | TooLargeModel | BinaryModel;

/** Per-gap state owned by the store: how many lines are revealed on each end. */
export interface GapState {
  top: number;
  bottom: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const CONTEXT_LINES = 3;
const EXPAND_STEP = 20;
/** Cap that triggers a too-large model. Either side is the upper bound.
 *  Paired with FILE_TOO_LARGE (5 MiB) in main's git.ts — this is the
 *  line-count guard that bounds jsdiff's work on a file that's under the
 *  byte cap but pathologically long. */
const TOO_LARGE_LINE_TOTAL = 50_000;

// ── buildDiffModel ─────────────────────────────────────────────────────

/**
 * Build a complete diff model from two file contents.
 *
 *   1. Split into lines. Drop the trailing empty element that
 *      `split("\n")` adds when the text ends with `\n`. Strip one
 *      trailing `\r` per line (CRLF normalize) on both sides.
 *   2. Run jsdiff `diffLines` and walk the chunks, tracking 1-based
 *      `oldNo`/`newNo` counters and pairing adjacent del/add runs.
 *   3. Group into hunks with 3 context lines; merge overlapping/adjacent
 *      hunks. Capture all three kinds of gaps (start/between/end).
 *   4. Cap with the too-large sentinel when either side is enormous.
 */
export function buildDiffModel(oldText: string, newText: string): AnyDiffModel {
  const oldLines = splitAndNormalizeLines(oldText);
  const newLines = splitAndNormalizeLines(newText);
  // Too-large guard. We measure *both* sides (not just the sum) so a
  // single huge file is caught.
  if (oldLines.length > TOO_LARGE_LINE_TOTAL || newLines.length > TOO_LARGE_LINE_TOTAL) {
    return { kind: "too-large", oldSize: oldLines.length, newSize: newLines.length };
  }

  // Use newline-joined text; jsdiff's diffLines compares text not
  // arrays. We re-derive the line list from the result.
  const oldJoined = oldLines.length === 0 ? "" : `${oldLines.join("\n")}\n`;
  const newJoined = newLines.length === 0 ? "" : `${newLines.join("\n")}\n`;

  const chunks = diffLines(oldJoined, newJoined);
  const lines: DiffLine[] = [];

  let oldNo = 0;
  let newNo = 0;

  for (const chunk of chunks) {
    // Normalize the chunk's text into individual lines (jsdiff may
    // bundle multiple lines in a single value).
    const text = chunk.value;
    const chunkLines = text.length === 0 ? [] : splitAndNormalizeLines(text);
    if (chunkLines.length === 0) continue;

    if (!chunk.added && !chunk.removed) {
      for (const ln of chunkLines) {
        oldNo++;
        newNo++;
        lines.push({ type: "context", oldNo, newNo, text: ln });
      }
      continue;
    }

    if (chunk.removed) {
      for (const ln of chunkLines) {
        oldNo++;
        lines.push({ type: "del", oldNo, text: ln });
      }
      continue;
    }

    if (chunk.added) {
      for (const ln of chunkLines) {
        newNo++;
        lines.push({ type: "add", newNo, text: ln });
      }
    }
  }

  // ── Pair adjacent del/add runs into change blocks ───────────────────
  // A maximal run of consecutive dels followed immediately by a maximal
  // run of adds is a change block. Pair del[i] ↔ add[i] for the length
  // of the shorter side; extras stay unpaired.
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i];
    if (!start || start.type !== "del") continue;
    let delEnd = i;
    while (delEnd + 1 < lines.length && lines[delEnd + 1]?.type === "del") delEnd++;
    const addStart = delEnd + 1;
    if (addStart >= lines.length || lines[addStart]?.type !== "add") continue;
    let addEnd = addStart;
    while (addEnd + 1 < lines.length && lines[addEnd + 1]?.type === "add") addEnd++;
    const pairCount = Math.min(delEnd - i + 1, addEnd - addStart + 1);
    const computeEmphasis = pairCount <= 200;
    for (let k = 0; k < pairCount; k++) {
      const delIdx = i + k;
      const addIdx = addStart + k;
      const delLine = lines[delIdx] as DelLine;
      const addLine = lines[addIdx] as AddLine;
      delLine.pair = addIdx;
      addLine.pair = delIdx;
      if (computeEmphasis) {
        const em = intralineRanges(delLine.text, addLine.text, pairCount);
        if (em) {
          delLine.emphasis = em;
          addLine.emphasis = em;
        }
      }
    }
    i = addEnd;
  }

  // ── Hunks with 3 context lines; merge adjacent ones ─────────────────
  const changeIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln && (ln.type === "del" || ln.type === "add")) changeIdxs.push(i);
  }

  const hunks: DiffHunk[] = [];
  if (changeIdxs.length > 0) {
    let curStart = Math.max(0, (changeIdxs[0] ?? 0) - CONTEXT_LINES);
    let curEnd = Math.min(lines.length - 1, (changeIdxs[0] ?? 0) + CONTEXT_LINES);
    for (let k = 1; k < changeIdxs.length; k++) {
      const idx = changeIdxs[k] ?? 0;
      const wantStart = Math.max(0, idx - CONTEXT_LINES);
      const wantEnd = Math.min(lines.length - 1, idx + CONTEXT_LINES);
      if (wantStart <= curEnd + 1) {
        // Adjacent or overlapping → merge.
        curEnd = Math.max(curEnd, wantEnd);
      } else {
        hunks.push({ startIdx: curStart, endIdx: curEnd, index: hunks.length });
        curStart = wantStart;
        curEnd = wantEnd;
      }
    }
    hunks.push({ startIdx: curStart, endIdx: curEnd, index: hunks.length });
  }

  // ── Gaps: before first hunk, between hunks, after last hunk to EOF ─
  const gaps: DiffGap[] = [];
  if (hunks.length === 0) {
    // No changes → one big gap covering the whole file.
    if (lines.length > 0) {
      gaps.push({
        startIdx: 0,
        endIdx: lines.length - 1,
        isFileStart: true,
        isFileEnd: true,
        size: lines.length,
        index: 0,
      });
    }
  } else {
    const first = hunks[0]!;
    if (first.startIdx > 0) {
      gaps.push({
        startIdx: 0,
        endIdx: first.startIdx - 1,
        isFileStart: true,
        isFileEnd: false,
        size: first.startIdx,
        index: 0,
      });
    }
    for (let k = 0; k < hunks.length - 1; k++) {
      const a = hunks[k]!;
      const b = hunks[k + 1]!;
      const start = a.endIdx + 1;
      const end = b.startIdx - 1;
      if (end >= start) {
        gaps.push({
          startIdx: start,
          endIdx: end,
          isFileStart: false,
          isFileEnd: false,
          size: end - start + 1,
          index: gaps.length,
        });
      }
    }
    const last = hunks[hunks.length - 1]!;
    if (last.endIdx < lines.length - 1) {
      gaps.push({
        startIdx: last.endIdx + 1,
        endIdx: lines.length - 1,
        isFileStart: false,
        isFileEnd: true,
        size: lines.length - last.endIdx - 1,
        index: gaps.length,
      });
    }
  }

  // ── changedCount ────────────────────────────────────────────────────
  let changedCount = 0;
  for (const ln of lines) {
    if (ln.type === "del" || ln.type === "add") changedCount++;
  }

  return {
    kind: "ok",
    lines,
    hunks,
    gaps,
    changedCount,
    oldCount: oldNo,
    newCount: newNo,
  };
}

// ── visibleRows ────────────────────────────────────────────────────────

export type Row =
  | { type: "context"; line: ContextLine; lineIdx: number }
  | { type: "del"; line: DelLine; lineIdx: number }
  | { type: "add"; line: AddLine; lineIdx: number }
  | {
      type: "gap";
      gapIndex: number;
      hiddenCount: number;
      isFileStart: boolean;
      isFileEnd: boolean;
    };

/**
 * Project a model + per-gap reveal state into the row stream the view
 * renders. Pure: same inputs → same rows.
 *
 * Semantics for collapsed gaps:
 *   - ▼ "expand down" reveals the FIRST `top` lines of the gap.
 *   - ▲ "expand up" reveals the LAST `bottom` lines of the gap.
 *   - A gap with top+bottom >= size is fully consumed (no row emitted).
 *   - Gap ≤ 20 lines: caller should set both top and bottom to size and
 *     render only an "Expand N lines" affordance. We still emit a
 *     gap row with hiddenCount=0 so the view knows it's collapsed.
 *
 * The row's `lineIdx` is the index into `model.lines` for non-gap rows.
 * For gap rows it's the gap's index.
 */
export function visibleRows(model: AnyDiffModel, gapState: GapState[], limit?: number): Row[] {
  const out: Row[] = [];
  visitVisibleRows(model, gapState, (row) => {
    if (limit !== undefined && out.length >= limit) return false;
    out.push(row);
    return true;
  });
  return out;
}

export function visitVisibleRows(
  model: AnyDiffModel,
  gapState: GapState[],
  visit: (row: Row) => boolean,
): void {
  if (model.kind !== "ok") return;
  const lines = model.lines;
  const gaps = model.gaps;

  // The first emitted non-gap index. We walk lines and decide per
  // (gap, hunk) pair. To keep the math straightforward, we iterate
  // gaps in order, emitting everything between gaps/hunks.
  let cursor = 0;
  for (const gap of gaps) {
    // Emit lines [cursor .. gap.startIdx - 1] (the hunk just before).
    for (let i = cursor; i < gap.startIdx; i++) {
      const ln = lines[i];
      if (!ln) continue;
      if (!visit(rowFor(ln, i))) return;
    }
    const state = gapState[gap.index] ?? { top: 0, bottom: 0 };
    const revealed = state.top + state.bottom;
    if (revealed >= gap.size) {
      // Fully consumed: emit all lines as plain rows.
      for (let i = gap.startIdx; i <= gap.endIdx; i++) {
        const ln = lines[i];
        if (!ln) continue;
        if (!visit(rowFor(ln, i))) return;
      }
      cursor = gap.endIdx + 1;
      continue;
    }
    // Emit the `top` revealed lines from the start of the gap.
    const topEnd = gap.startIdx + state.top - 1;
    for (let i = gap.startIdx; i <= topEnd; i++) {
      const ln = lines[i];
      if (!ln) continue;
      if (!visit(rowFor(ln, i))) return;
    }
    // Emit the gap row itself.
    if (
      !visit({
        type: "gap",
        gapIndex: gap.index,
        hiddenCount: gap.size - revealed,
        isFileStart: gap.isFileStart,
        isFileEnd: gap.isFileEnd,
      })
    ) {
      return;
    }
    // Emit the `bottom` revealed lines from the end of the gap.
    const bottomStart = gap.endIdx - state.bottom + 1;
    for (let i = bottomStart; i <= gap.endIdx; i++) {
      const ln = lines[i];
      if (!ln) continue;
      if (!visit(rowFor(ln, i))) return;
    }
    cursor = gap.endIdx + 1;
  }
  // Trailing lines after the last gap.
  for (let i = cursor; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    if (!visit(rowFor(ln, i))) return;
  }
}

export function visibleRowsSlice(
  model: AnyDiffModel,
  gapState: GapState[],
  start: number,
  count: number,
): Row[] {
  if (count <= 0) return [];
  const out: Row[] = [];
  let rowIndex = 0;
  visitVisibleRows(model, gapState, (row) => {
    if (rowIndex >= start) out.push(row);
    rowIndex++;
    return out.length < count;
  });
  return out;
}

function rowFor(ln: DiffLine, idx: number): Row {
  if (ln.type === "context") return { type: "context", line: ln, lineIdx: idx };
  if (ln.type === "del") return { type: "del", line: ln, lineIdx: idx };
  return { type: "add", line: ln, lineIdx: idx };
}

// ── buildSplitRows ─────────────────────────────────────────────────────

/**
 * Project unified rows into split-view rows. A change block
 * (del+add) becomes `max(dels, adds)` rows pairing `del[i]`/`add[i]`,
 * with empty cells for the unpaired side.
 *
 * Input rows are expected to come from visibleRows; gap rows span both
 * columns. The optional limit applies to projected split rows after pairing.
 */
export type SplitRow =
  | {
      type: "split-pair";
      leftNo: number | null;
      leftText: string;
      leftEmphasis: IntralineRanges | undefined;
      /** Index into model.lines for the left (del) line, or null when empty. */
      leftIdx: number | null;
      rightNo: number | null;
      rightText: string;
      rightEmphasis: IntralineRanges | undefined;
      /** Index into model.lines for the right (add) line, or null when empty. */
      rightIdx: number | null;
    }
  | {
      type: "split-gap";
      gapIndex: number;
      hiddenCount: number;
      isFileStart: boolean;
      isFileEnd: boolean;
    }
  | {
      type: "split-context";
      leftNo: number;
      rightNo: number;
      text: string;
      /** Index into model.lines for this context line. */
      lineIdx: number;
    };

export function buildSplitRows(rows: Row[], limit?: number): SplitRow[] {
  const out: SplitRow[] = [];
  const pushRow = (row: SplitRow): boolean => {
    if (limit !== undefined && out.length >= limit) return false;
    out.push(row);
    return true;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.type === "gap") {
      if (
        !pushRow({
          type: "split-gap",
          gapIndex: r.gapIndex,
          hiddenCount: r.hiddenCount,
          isFileStart: r.isFileStart,
          isFileEnd: r.isFileEnd,
        })
      ) {
        return out;
      }
      continue;
    }
    if (r.type === "context") {
      if (
        !pushRow({
          type: "split-context",
          leftNo: r.line.oldNo ?? 0,
          rightNo: r.line.newNo ?? 0,
          text: r.line.text,
          lineIdx: r.lineIdx,
        })
      ) {
        return out;
      }
      continue;
    }
    // Change block: collect consecutive del+add rows.
    const block: Row[] = [r];
    while (true) {
      const next = rows[i + 1];
      if (!next) break;
      if (next.type === "del" || next.type === "add") {
        block.push(next);
        i++;
        continue;
      }
      break;
    }
    const dels = block.filter((x) => x.type === "del") as Array<Extract<Row, { type: "del" }>>;
    const adds = block.filter((x) => x.type === "add") as Array<Extract<Row, { type: "add" }>>;
    const rows2 = Math.max(dels.length, adds.length);
    for (let k = 0; k < rows2; k++) {
      const d = dels[k];
      const a = adds[k];
      if (
        !pushRow({
          type: "split-pair",
          leftNo: d?.line.oldNo ?? null,
          leftText: d?.line.text ?? "",
          leftEmphasis: d?.line.emphasis,
          leftIdx: d?.lineIdx ?? null,
          rightNo: a?.line.newNo ?? null,
          rightText: a?.line.text ?? "",
          rightEmphasis: a?.line.emphasis,
          rightIdx: a?.lineIdx ?? null,
        })
      ) {
        return out;
      }
    }
  }
  return out;
}

/**
 * Project a model directly into split-view rows. The optional limit applies
 * after split pairing, not to the unified input stream, so large replacement
 * blocks still pair old/new sides before the DOM safety cap is enforced.
 */
export function visibleSplitRows(
  model: AnyDiffModel,
  gapState: GapState[],
  limit?: number,
): SplitRow[] {
  const out: SplitRow[] = [];
  const pushRow = (row: SplitRow): boolean => {
    if (limit !== undefined && out.length >= limit) return false;
    out.push(row);
    return true;
  };

  type DelRow = Extract<Row, { type: "del" }>;
  type AddRow = Extract<Row, { type: "add" }>;
  let dels: DelRow[] = [];
  let adds: AddRow[] = [];
  let delCount = 0;
  let addCount = 0;

  const resetBlock = (): void => {
    dels = [];
    adds = [];
    delCount = 0;
    addCount = 0;
  };
  const remainingLimit = (): number =>
    limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit - out.length);
  const flushBlock = (): boolean => {
    const rows2 = Math.max(delCount, addCount);
    if (rows2 === 0) return limit === undefined || out.length < limit;
    const toEmit = limit === undefined ? rows2 : Math.min(rows2, limit - out.length);
    for (let k = 0; k < toEmit; k++) {
      const d = dels[k];
      const a = adds[k];
      if (
        !pushRow({
          type: "split-pair",
          leftNo: d?.line.oldNo ?? null,
          leftText: d?.line.text ?? "",
          leftEmphasis: d?.line.emphasis,
          leftIdx: d?.lineIdx ?? null,
          rightNo: a?.line.newNo ?? null,
          rightText: a?.line.text ?? "",
          rightEmphasis: a?.line.emphasis,
          rightIdx: a?.lineIdx ?? null,
        })
      ) {
        resetBlock();
        return false;
      }
    }
    resetBlock();
    return limit === undefined || out.length < limit;
  };
  const collectChangeRow = (row: DelRow | AddRow): boolean => {
    const keep = remainingLimit();
    if (row.type === "del") {
      delCount++;
      if (dels.length < keep) dels.push(row);
    } else {
      addCount++;
      if (adds.length < keep) adds.push(row);
    }
    // Once both sides have enough rows to fill the remaining output, later
    // rows in this change block cannot affect the capped prefix.
    if (limit !== undefined && dels.length >= keep && adds.length >= keep) {
      return flushBlock();
    }
    return true;
  };

  visitVisibleRows(model, gapState, (row) => {
    if (row.type === "del" || row.type === "add") return collectChangeRow(row);
    if (!flushBlock()) return false;
    if (row.type === "gap") {
      return pushRow({
        type: "split-gap",
        gapIndex: row.gapIndex,
        hiddenCount: row.hiddenCount,
        isFileStart: row.isFileStart,
        isFileEnd: row.isFileEnd,
      });
    }
    return pushRow({
      type: "split-context",
      leftNo: row.line.oldNo ?? 0,
      rightNo: row.line.newNo ?? 0,
      text: row.line.text,
      lineIdx: row.lineIdx,
    });
  });
  flushBlock();
  return out;
}

export function visibleSplitRowsSlice(
  model: AnyDiffModel,
  gapState: GapState[],
  start: number,
  count: number,
): SplitRow[] {
  if (count <= 0) return [];
  return visibleSplitRows(model, gapState, start + count).slice(start);
}

// ── line helpers ───────────────────────────────────────────────────────

/**
 * Split a text into individual lines and normalize trailing CRs.
 * Drops the empty element that `split("\n")` adds when the text ends
 * with `\n` (so "a\nb\n" → ["a", "b"], not ["a", "b", ""]).
 *
 * Exported so the diff-edit machinery (splice / re-anchor) splits conflict-fresh
 * text with the EXACT same rule the model used — a CRLF file's lines must
 * re-align after a save without a trailing-\r throwing off the line count.
 * The model line text is CR-free; raw `newText` keeps its CRLF/BOM intact.
 */
export function splitAndNormalizeLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p?.endsWith("\r")) parts[i] = p.slice(0, -1);
  }
  return parts;
}

// ── Edit-support: visible-line / gap carry-over ────────────────────────

/**
 * The set of model line indices currently rendered as rows — i.e. NOT hidden
 * inside a collapsed gap. (The edit bubble deliberately does NOT use this for
 * eligibility — it passes every model index so a gap-crossing selection stays
 * editable, with the card revealing the hidden lines.)
 */
export function visibleLineIndices(model: AnyDiffModel, gapState: GapState[]): Set<number> {
  const set = new Set<number>();
  for (const row of visibleRows(model, gapState)) {
    if (row.type === "gap") continue;
    set.add(row.lineIdx);
  }
  return set;
}

/**
 * The set of OLD-side line numbers currently visible (revealed gap lines plus
 * always-visible hunk lines). Save never changes the old side, so old-side line
 * numbers are a stable key for carrying gap reveal state across a save.
 */
export function visibleOldLineNos(model: DiffModel, gapState: GapState[]): Set<number> {
  const set = new Set<number>();
  for (const row of visibleRows(model, gapState)) {
    if (row.type === "context") {
      if (row.line.oldNo !== null) set.add(row.line.oldNo);
    } else if (row.type === "del") {
      set.add(row.line.oldNo);
    }
  }
  return set;
}

/**
 * Reconstruct gap reveal state for a freshly-built model so revealed context
 * stays revealed after a save (the edit changes only new-side text, so old-side
 * line numbers key the carry-over). A new gap whose old-side lines were ALL
 * visible before stays fully revealed; otherwise it collapses (the user can
 * re-expand). This handles "edit inside a revealed gap → both halves stay
 * revealed".
 */
export function carryGapState(newModel: DiffModel, visibleOldNos: Set<number>): GapState[] {
  return newModel.gaps.map((gap) => {
    let anyOld = false;
    let allVisible = true;
    for (let i = gap.startIdx; i <= gap.endIdx; i++) {
      const ln = newModel.lines[i];
      if (!ln) continue;
      const oldNo = ln.type === "del" ? ln.oldNo : ln.type === "context" ? ln.oldNo : null;
      if (oldNo === null) continue;
      anyOld = true;
      if (!visibleOldNos.has(oldNo)) {
        allVisible = false;
        break;
      }
    }
    if (anyOld && allVisible) return { top: gap.size, bottom: gap.size };
    return { top: 0, bottom: 0 };
  });
}

// ── Intraline ranges (re-exported for convenience) ─────────────────────
