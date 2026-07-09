// Splice helpers for diff-edit save.
//
// The model/row text is CR-free (splitAndNormalizeLines strips one trailing
// `\r` per line), while raw `newText` keeps its CRLF / BOM / missing-final
// newline intact. A save must change ONLY the replaced new-side line range
// and preserve every other byte — including EOL style, BOM, and a missing
// final newline. We therefore splice by CHARACTER OFFSETS into raw `newText`,
// never splitting/rejoining the whole file.
//
// EOL rule (matches the model): `\n` and `\r\n` are line endings; a LONE `\r`
// is NOT (so a legacy `\r`-only file is treated as one line — identical to
// splitAndNormalizeLines, which the model already uses).

export type Eol = "\n" | "\r\n";

export interface LineSpan {
  /** Inclusive start offset of the line (including any BOM on line 1). */
  start: number;
  /** Offset of the first char AFTER this line's content (excluding EOL). */
  contentEnd: number;
  /** Offset one past the line's EOL (== contentEnd for the final line w/o `\n`). */
  end: number;
  /** CR-free line text (identical to splitAndNormalizeLines output). */
  text: string;
  /** The EOL sequence that terminated this line, or "" for the last line. */
  eol: "" | Eol;
}

/**
 * Split raw text into per-line spans WITHOUT mutating it. Produces exactly the
 * same line list (same count, same CR-free text) as the model's
 * `splitAndNormalizeLines`, but also records the raw character offsets and the
 * EOL of each line so a caller can splice by offset.
 *
 * `lone \r` is intentionally not an EOL — it stays part of the line, matching
 * the model's splitter.
 */
export function lineSpans(text: string): LineSpan[] {
  if (text === "") return [];
  const spans: LineSpan[] = [];
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    // A `\r` immediately preceding the `\n` is part of the EOL, not content.
    const hasCr = i > 0 && text[i - 1] === "\r";
    const contentEnd = hasCr ? i - 1 : i;
    const eol: Eol = hasCr ? "\r\n" : "\n";
    spans.push({
      start: lineStart,
      contentEnd,
      end: i + 1,
      text: text.slice(lineStart, contentEnd),
      eol,
    });
    lineStart = i + 1;
  }
  // Trailing segment with no final newline (matches splitAndNormalizeLines
  // dropping the empty element after a trailing `\n`).
  if (lineStart < text.length) {
    spans.push({
      start: lineStart,
      contentEnd: text.length,
      end: text.length,
      text: text.slice(lineStart),
      eol: "",
    });
  }
  return spans;
}

/**
 * Detect the dominant EOL of a text. Counts `\r\n` vs lone `\n` (a `\n` whose
 * preceding char is not `\r`). Ties (incl. no EOL at all) resolve to `\n`.
 */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    if (i > 0 && text[i - 1] === "\r") crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * The dominant EOL over a contiguous set of line spans. Falls back to the
 * file-dominant EOL when the region has no EOL of its own.
 */
function regionEol(spans: LineSpan[], startIdx: number, endIdx: number, fallback: Eol): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    const s = spans[i];
    if (!s) continue;
    if (s.eol === "\r\n") crlf++;
    else if (s.eol === "\n") lf++;
  }
  if (crlf > lf) return "\r\n";
  if (lf > crlf) return "\n";
  return fallback;
}

/**
 * Splice `replacementLines` into `rawText`, replacing new-side lines
 * `[startNewNo..endNewNo]` (1-based, inclusive) byte-for-byte.
 *
 * - Bytes OUTSIDE the replaced line range are preserved exactly (EOL style,
 *   BOM, missing final newline). This holds because we slice by raw offsets.
 * - The replacement's lines join with the region-dominant EOL (falling back to
 *   the file-dominant EOL when the region has no EOL of its own), so a CRLF
 *   region stays CRLF and an LF region stays LF.
 * - A trailing EOL is appended iff the replaced region's last line had one
 *   (i.e. the original file had a line after the range) — this keeps the
 *   following line's start offset unchanged, and preserves a missing final
 *   newline when editing the last line.
 *
 * `replacementLines` are CR-free model-text lines. An EMPTY list removes the
 * range entirely (line deletion). Throws if the range is out of bounds.
 */
export function spliceNewLines(
  rawText: string,
  startNewNo: number,
  endNewNo: number,
  replacementLines: string[],
): string {
  const spans = lineSpans(rawText);
  if (startNewNo < 1 || endNewNo < startNewNo || endNewNo > spans.length) {
    throw new Error(
      `spliceNewLines: range [${startNewNo}..${endNewNo}] out of bounds for ${spans.length} line(s)`,
    );
  }
  const startSpan = spans[startNewNo - 1]!;
  const endSpan = spans[endNewNo - 1]!;
  const regionStart = startSpan.start;
  // End one past the replaced region = start of the line after endNewNo, or EOF.
  const regionEnd = endNewNo < spans.length ? spans[endNewNo]!.start : rawText.length;
  const trailingEol = endSpan.eol !== "";

  const eol = regionEol(spans, startNewNo - 1, endNewNo - 1, detectEol(rawText));

  let joined: string;
  if (replacementLines.length === 0) {
    joined = "";
  } else {
    joined = replacementLines.join(eol);
    if (trailingEol) joined += eol;
  }

  return rawText.slice(0, regionStart) + joined + rawText.slice(regionEnd);
}
