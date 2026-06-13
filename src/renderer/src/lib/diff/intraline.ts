// Intraline emphasis — character-level diff between two corresponding
// lines (one del + one add inside the same change block). The result
// is a pair of ranges the renderer can overlay with a colored background
// to highlight what actually changed within a modified line.
//
// We return `null` (no emphasis) when:
//   - either line is > 500 chars (huge lines: un-highlight reads better)
//   - changed chars > 65% of the longer line (whole-line rewrites)
//   - the surrounding change block has > 200 pairs (intraline is too
//     expensive at scale)
//
// The threshold values match the WP2c spec.

import { diffWordsWithSpace } from "diff";

export interface IntralineRanges {
  /** Sorted, non-overlapping, half-open [start, end) char ranges in the old line. */
  old: Array<[number, number]>;
  /** Same for the new line. */
  new: Array<[number, number]>;
}

const MAX_LINE_LENGTH = 500;
const CHANGED_FRACTION_LIMIT = 0.65;
const MAX_BLOCK_PAIRS = 200;

export function intralineRanges(
  oldLine: string,
  newLine: string,
  blockPairCount = 0,
): IntralineRanges | null {
  if (blockPairCount > MAX_BLOCK_PAIRS) return null;
  if (oldLine.length > MAX_LINE_LENGTH || newLine.length > MAX_LINE_LENGTH) return null;
  if (oldLine === newLine) return null;

  // jsdiff gives us a sequence of (added, removed, value) chunks. We
  // walk them tracking offsets in each side, recording a range for any
  // chunk that differs.
  const changes = diffWordsWithSpace(oldLine, newLine);
  const oldRanges: Array<[number, number]> = [];
  const newRanges: Array<[number, number]> = [];
  let oldOff = 0;
  let newOff = 0;
  let changedOld = 0;
  let changedNew = 0;
  for (const ch of changes) {
    if (!ch.added && !ch.removed) {
      oldOff += ch.value.length;
      newOff += ch.value.length;
      continue;
    }
    if (ch.removed) {
      oldRanges.push([oldOff, oldOff + ch.value.length]);
      oldOff += ch.value.length;
      changedOld += ch.value.length;
    }
    if (ch.added) {
      newRanges.push([newOff, newOff + ch.value.length]);
      newOff += ch.value.length;
      changedNew += ch.value.length;
    }
  }
  const longer = Math.max(oldLine.length, newLine.length);
  if (longer === 0) return null;
  const changedTotal = changedOld + changedNew;
  if (changedTotal / (longer * 2) > CHANGED_FRACTION_LIMIT) return null;

  return { old: mergeRanges(oldRanges), new: mergeRanges(newRanges) };
}

/** Merge adjacent / overlapping ranges in a list. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]!;
    const cur = sorted[i]!;
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push(cur);
    }
  }
  return out;
}
