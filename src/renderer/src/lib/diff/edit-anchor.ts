// Pure edit-aware comment re-anchoring for diff-edit save (invariant 6).
//
// Unlike the generic `reconcileDiffCommentsForFile` (which fuzzy-matches by
// saved line text and would mark every below-range comment "relocated" — or
// "stale" for non-unique text like `}`), this pass KNOWS the exact edit, so
// re-anchoring is deterministic:
//
//   - above-range comment: untouched.
//   - below-range comment: lineNumber AND originalLineNumber += delta, with
//     anchorStatus preserved (no new "relocated"/"stale" badges from
//     renumbering alone).
//   - in-range comment whose saved text survives uniquely in the replacement:
//     renumber to that line, keeping its status.
//   - in-range comment whose text does not survive: → `stale`, lineNumber
//     clamped to the new file length, with a nearest-free-line walk on key
//     collision so two comments never share a line.
//
// Comments are NEVER auto-deleted by this pass.

import type { CodeComment } from "../diff-comments.js";
import { splitAndNormalizeLines } from "./diff-model.js";

export interface EditAnchorInput {
  startNewNo: number;
  endNewNo: number;
  /** The CR-free replacement lines for [startNewNo..endNewNo]. */
  replacementLines: string[];
  /** Total new-side line count of the file AFTER the edit (for clamping). */
  newLineCount: number;
}

/**
 * Re-anchor every comment on `filePath` for a known edit. Pure: returns a new
 * array (comments on other files pass through unchanged). Callers re-key the
 * session comment Map by (filePath, lineNumber).
 */
export function reanchorCommentsForEdit(
  comments: readonly CodeComment[],
  filePath: string,
  edit: EditAnchorInput,
): CodeComment[] {
  const { startNewNo, endNewNo, replacementLines, newLineCount } = edit;
  const rangeSize = endNewNo - startNewNo + 1;
  const delta = replacementLines.length - rangeSize;

  // First pass: compute each in-file comment's target line + new fields.
  interface Plan {
    comment: CodeComment;
    target: number;
    next: Partial<CodeComment> | null; // null = unchanged
  }
  const plans: Plan[] = [];
  for (const comment of comments) {
    if (comment.filePath !== filePath) {
      plans.push({ comment, target: -1, next: null });
      continue;
    }
    const ln = comment.lineNumber;
    if (ln < startNewNo) {
      // above range — untouched
      plans.push({ comment, target: ln, next: null });
      continue;
    }
    if (ln > endNewNo) {
      // below range — shift both numbers, preserve status
      plans.push({
        comment,
        target: ln + delta,
        next: { lineNumber: ln + delta, originalLineNumber: comment.originalLineNumber + delta },
      });
      continue;
    }
    // in range — does the saved text survive uniquely in the replacement?
    const matchIdx = uniqueIndexOf(replacementLines, comment.lineText);
    if (matchIdx !== -1) {
      const newLn = startNewNo + matchIdx;
      plans.push({
        comment,
        target: newLn,
        next: { lineNumber: newLn }, // keep status + originalLineNumber
      });
    } else {
      // unmatched → stale, clamp to file length
      const clamped = Math.min(Math.max(1, ln), Math.max(1, newLineCount));
      plans.push({
        comment,
        target: clamped,
        next: { lineNumber: clamped, anchorStatus: "stale" },
      });
    }
  }

  // Second pass: resolve key collisions via a nearest-free-line walk. We only
  // walk comments that actually target a line (in/below/in-range-stale); an
  // unchanged comment keeps its line. Walk outward ±1, ±2, … from the target.
  const taken = new Set<number>();
  // Seed taken lines with unchanged comments on THIS file only. Comments on
  // other files have independent (filePath,lineNumber) keys and must not force
  // edited-file comments to walk away from their correct line.
  for (const p of plans) {
    if (p.next === null && p.comment.filePath === filePath) taken.add(p.comment.lineNumber);
  }
  const result: CodeComment[] = [];
  // Process on-file movers in target order for deterministic walk resolution.
  const movers = plans.filter((p) => p.next !== null).sort((a, b) => a.target - b.target);
  for (const p of movers) {
    let target = p.target;
    if (taken.has(target)) target = nearestFree(target, taken, newLineCount);
    taken.add(target);
    result.push({ ...p.comment, ...p.next, lineNumber: target });
  }
  // Unchanged comments pass through verbatim.
  for (const p of plans) {
    if (p.next === null) result.push(p.comment);
  }
  return result;
}

/** Index of `needle` in `hay` iff it appears EXACTLY once; else -1. */
function uniqueIndexOf(hay: readonly string[], needle: string): number {
  let found = -1;
  for (let i = 0; i < hay.length; i++) {
    if (hay[i] !== needle) continue;
    if (found !== -1) return -1; // ambiguous
    found = i;
  }
  return found;
}

/**
 * Walk outward from `from` (±1, ±2, …) to the nearest line number not in
 * `taken`, clamped to [1, max]. Used only on collision.
 */
function nearestFree(from: number, taken: Set<number>, max: number): number {
  for (let step = 1; step <= max + 1; step++) {
    const up = from + step;
    if (up <= max && !taken.has(up)) return up;
    const down = from - step;
    if (down >= 1 && !taken.has(down)) return down;
  }
  return from;
}

/**
 * Find the unique 1-based [startLine..endLine] of a contiguous block of
 * original edited lines inside a fresh file's line list. Returns null when the
 * block is absent or appears more than once (ambiguous). Fresh text is split
 * with the model's splitter so a CRLF file re-anchors correctly.
 */
export function findUniqueBlock(
  freshRawText: string,
  block: readonly string[],
): { startLine: number; endLine: number } | null {
  if (block.length === 0) return null;
  const lines = splitAndNormalizeLines(freshRawText);
  let found: { startLine: number; endLine: number } | null = null;
  for (let i = 0; i + block.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (found !== null) return null; // ambiguous
    found = { startLine: i + 1, endLine: i + block.length };
  }
  return found;
}
