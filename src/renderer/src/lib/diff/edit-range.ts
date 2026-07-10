// Pure selection → edit-range mapping for the diff edit card.
//
// A selection covers a contiguous range of model line indices [startIdx..endIdx].
// We project it into a SEQUENCE of blocks preserving exact original row order:
//
//   - {kind:"edit", lineIdxs, newNos, initialText}  — a run of editable
//     context/add lines (the new-side text the user can change). Each segment
//     owns one textarea; comments BREAK segments.
//   - {kind:"del", lineIdx}                          — legacy inert removed
//     line block. New ranges do not emit these; removed lines inside a selection
//     are hidden while editing and omitted from the editable text.
//   - {kind:"comment", newNo}                        — an inert comment
//     thread row that stays in place while editing.
//
// A commented context/add line ENDS its edit segment (so the thread row can
// sit exactly where it was). Removed (del) lines are never editable and never
// silently re-enter the file: leading/trailing removed lines are trimmed out of
// the edit range, and interior removed lines are skipped so the save output is
// exactly the editable-segment buffers.
//
// `resolveEditRange` returns null for:
//   - a hidden (collapsed-gap) line inside the range, and
//   - a range with zero context/add (editable) lines (del-only selection).

import type { DiffModel } from "./diff-model.js";

export interface EditBlock {
  kind: "edit";
  /** Model line indices in this segment (all context/add). */
  lineIdxs: number[];
  /** New-side line numbers (1-based) for the lines in `lineIdxs`, in order. */
  newNos: number[];
  /** The segment's editable text (model lines joined by "\n"). */
  initialText: string;
}

export interface DelBlock {
  kind: "del";
  /** Model line index of the removed line. */
  lineIdx: number;
}

export interface CommentBlock {
  kind: "comment";
  /** New-side line number the comment thread is anchored to. */
  newNo: number;
}

export type EditBlockKind = EditBlock | DelBlock | CommentBlock;

export interface EditRange {
  /** First model line index in the selection (inclusive). */
  startLineIdx: number;
  /** Last model line index in the selection (inclusive). */
  endLineIdx: number;
  /** New-side line number of the first editable line in the range. */
  startNewNo: number;
  /** New-side line number of the last editable line in the range. */
  endNewNo: number;
  /** Ordered block sequence covering [startLineIdx..endLineIdx]. */
  blocks: EditBlockKind[];
}

/**
 * Resolve a selection into an EditRange, or null if it is not editable.
 *
 * @param model       the file's diff model (kind === "ok").
 * @param visibleIdxs model line indices currently rendered as rows (NOT hidden
 *                    in a collapsed gap). A hidden line inside the selection
 *                    disqualifies the range.
 * @param startIdx    selection start model line index (inclusive).
 * @param endIdx      selection end model line index (inclusive).
 * @param commentedNewNos  new-side line numbers that carry a comment thread
 *                    (so we can break segments / emit comment blocks).
 */
export function resolveEditRange(
  model: DiffModel,
  visibleIdxs: Set<number>,
  startIdx: number,
  endIdx: number,
  commentedNewNos: Set<number>,
): EditRange | null {
  if (model.kind !== "ok") return null;
  const lines = model.lines;
  let lo = startIdx;
  let hi = endIdx;
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  if (lo < 0 || hi >= lines.length) return null;

  // Removed lines at the selection edges are not part of the editable new-side
  // range. Treat them as if they were never selected so the card replaces the
  // first selected context/add row in place (no top ghost row, no movement).
  while (lo <= hi && lines[lo]?.type === "del") lo++;
  while (hi >= lo && lines[hi]?.type === "del") hi--;
  if (lo > hi) return null;

  // Disqualify: any line in the trimmed range is hidden (collapsed-gap).
  for (let i = lo; i <= hi; i++) {
    if (!visibleIdxs.has(i)) return null;
  }

  const blocks: EditBlockKind[] = [];
  let cur: { lineIdxs: number[]; newNos: number[]; parts: string[] } | null = null;
  let firstNewNo: number | null = null;
  let lastNewNo: number | null = null;
  let editableCount = 0;

  const flush = (): void => {
    if (!cur) return;
    blocks.push({
      kind: "edit",
      lineIdxs: cur.lineIdxs,
      newNos: cur.newNos,
      initialText: cur.parts.join("\n"),
    });
    cur = null;
  };

  for (let i = lo; i <= hi; i++) {
    const ln = lines[i];
    if (!ln) continue;
    if (ln.type === "del") continue;
    // context or add — editable.
    const newNo = ln.newNo;
    if (newNo === null) continue;
    editableCount++;
    if (firstNewNo === null) firstNewNo = newNo;
    lastNewNo = newNo;
    if (!cur) cur = { lineIdxs: [], newNos: [], parts: [] };
    cur.lineIdxs.push(i);
    cur.newNos.push(newNo);
    cur.parts.push(ln.text);
    // A commented line ends its editable segment so the thread row can sit
    // exactly where it was; emit an inert comment block after it.
    if (commentedNewNos.has(newNo)) {
      flush();
      blocks.push({ kind: "comment", newNo });
    }
  }
  flush();

  if (editableCount === 0) return null; // del-only selection
  if (firstNewNo === null || lastNewNo === null) return null;

  return {
    startLineIdx: lo,
    endLineIdx: hi,
    startNewNo: firstNewNo,
    endNewNo: lastNewNo,
    blocks,
  };
}
