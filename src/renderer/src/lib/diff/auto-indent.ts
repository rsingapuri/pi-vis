// Pure auto-indent / tab helpers for the diff edit card's textareas.
//
// All functions are PURE: they take the buffer text + caret/selection offsets
// and return either the text to insert (Enter) or a {range, replacement,
// selection} patch (Tab / Shift+Tab). The component applies the result via
// `document.execCommand("insertText", …)` + `setSelectionRange`, so native
// undo survives (programmatic edits are folded into the textarea's undo
// stack) and `.value` is never assigned after mount.

export type IndentUnit = "\t" | string; // "\t" or a run of spaces

const INDENT_TRIGGER_CHARS = new Set(["{", "(", "[", ":"]);

/**
 * Detect the dominant indent unit of a buffer.
 *   - More tab-indented lines than space-indented → "\t".
 *   - Else the most common of 2-space / 4-space runs.
 *   - Default "  " (2 spaces) when there is no indentation to infer from.
 */
export function detectIndentUnit(text: string): IndentUnit {
  let tabs = 0;
  let twos = 0;
  let fours = 0;
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const ws = line.match(/^[ \t]+/)?.[0];
    if (!ws) continue;
    if (ws[0] === "\t") {
      tabs++;
      continue;
    }
    const n = ws.length;
    if (n >= 4 && n % 4 === 0) fours++;
    else if (n >= 2 && n % 2 === 0) twos++;
    else if (n === 1) twos++;
  }
  if (tabs > twos && tabs > fours) return "\t";
  if (fours > twos) return "    ";
  if (twos > 0) return "  ";
  if (tabs > 0) return "\t";
  return "  ";
}

/** Leading whitespace (spaces/tabs) of a line. */
function leadingWhitespace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? "";
}

/**
 * The text to insert when the user presses Enter at `caret`.
 *
 *   "\n" + (the current line's leading whitespace) + (one extra `unit`
 *   when the trimmed text before the caret ends with `{`, `(`, `[`, or `:`).
 *
 * Pure: returns the insertion only; the caller inserts it.
 */
export function enterInsertion(buffer: string, caret: number, unit: IndentUnit): string {
  const lineStart = buffer.lastIndexOf("\n", caret - 1) + 1;
  const before = buffer.slice(lineStart, caret);
  const ws = leadingWhitespace(before);
  const trimmedTrailing = before.replace(/[ \t]+$/, "");
  const extra =
    trimmedTrailing.length > 0 && INDENT_TRIGGER_CHARS.has(trimmedTrailing.slice(-1)!) ? unit : "";
  return `\n${ws}${extra}`;
}

export interface TextPatch {
  /** Range to replace (inclusive start, exclusive end). */
  replaceStart: number;
  replaceEnd: number;
  /** Replacement text for [replaceStart, replaceEnd). */
  replacement: string;
  /** Selection to restore after the replacement is applied. */
  selStart: number;
  selEnd: number;
}

/** Line-start offset of the line containing `pos` (offset of the char after the preceding `\n`). */
function lineStartAt(buffer: string, pos: number): number {
  return buffer.lastIndexOf("\n", pos - 1) + 1;
}

/**
 * Produce a patch that indents (`dir === "in"`) or dedents (`dir === "out"`)
 * the textarea's current selection.
 *
 *   - Collapsed selection: "in" inserts one `unit` at the caret; "out" dedents
 *     the current line by one unit.
 *   - Multi-line selection: indents/dedents every line that the selection
 *     touches (from the start of the line containing selStart through the line
 *     containing selEnd).
 */
export function indentEdit(
  buffer: string,
  selStart: number,
  selEnd: number,
  unit: IndentUnit,
  dir: "in" | "out",
): TextPatch {
  const collapsed = selStart === selEnd;
  if (collapsed) {
    if (dir === "in") {
      return {
        replaceStart: selStart,
        replaceEnd: selStart,
        replacement: unit,
        selStart: selStart + unit.length,
        selEnd: selStart + unit.length,
      };
    }
    // Dedent the current line: strip one unit from its leading whitespace.
    const ls = lineStartAt(buffer, selStart);
    const line = buffer.slice(
      ls,
      buffer.indexOf("\n", selStart) === -1 ? buffer.length : buffer.indexOf("\n", selStart),
    );
    const stripped = stripUnit(line, unit);
    const delta = line.length - stripped.length;
    return {
      replaceStart: ls,
      replaceEnd: ls + line.length,
      replacement: stripped,
      selStart: Math.max(ls, selStart - delta),
      selEnd: Math.max(ls, selEnd - delta),
    };
  }

  // Multi-line: operate over [firstLineStart, lastLineEnd) where lastLineEnd
  // is the end of the line containing the selection end (its newline is kept
  // untouched after the region). This dedents the FULL last touched line even
  // when the selection ends mid-line, instead of stripping a partial line's
  // indentation.
  const start = Math.min(selStart, selEnd);
  const end = Math.max(selStart, selEnd);
  const firstLineStart = lineStartAt(buffer, start);
  // If the selection ends at column 0 of a line (right after a `\n`), that
  // line is NOT touched — mirroring VS Code (selecting "b\n" indents only b).
  // Otherwise the last touched line is the one containing `end`, extended to
  // the end of its content (the next `\n` or EOF).
  let lastLineEnd: number;
  if (end > 0 && buffer[end - 1] === "\n") {
    lastLineEnd = end - 1;
  } else {
    const nlIdx = buffer.indexOf("\n", end);
    lastLineEnd = nlIdx === -1 ? buffer.length : nlIdx;
  }
  const linesText = buffer.slice(firstLineStart, lastLineEnd);
  const lines = linesText.split("\n");
  const out = lines.map((ln) => (dir === "in" ? unit + ln : stripUnit(ln, unit)));
  const replacement = out.join("\n");
  return {
    replaceStart: firstLineStart,
    replaceEnd: lastLineEnd,
    replacement,
    selStart: firstLineStart,
    selEnd: firstLineStart + replacement.length,
  };
}

/** Remove one indent unit from the start of a line (spaces: up to unit length; tab: one `\t`). */
function stripUnit(line: string, unit: IndentUnit): string {
  if (unit === "\t") {
    return line.startsWith("\t") ? line.slice(1) : line.replace(/^[ ]+/, "");
  }
  // Space unit: remove up to unit.length leading spaces.
  let i = 0;
  const max = unit.length;
  while (i < max && line[i] === " ") i++;
  return line.slice(i);
}
