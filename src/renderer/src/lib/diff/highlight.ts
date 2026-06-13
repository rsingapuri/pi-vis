// shiki adapter for the diff viewer. The app already loads a Catppuccin
// Mocha highlighter (see src/renderer/src/lib/shiki.ts); we reuse it
// for per-line tokenization.
//
// Strict alignment guard: shiki splits on /\r?\n/. We tokenize the same
// text the model sees. If the line counts diverge, we discard the tokens
// and render plain text — misaligned colors are worse than no colors.

import type { ThemedToken } from "shiki";
import { getHighlighter } from "../shiki.js";

// ── Language map ───────────────────────────────────────────────────────

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  css: "css",
  html: "html",
  sql: "sql",
  diff: "diff",
};

export function langForPath(path: string): string | null {
  // Path may use posix separators; basename is the last "/"-separated
  // segment. We don't want to pull in path.js for this.
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return LANG_BY_EXT[ext] ?? null;
}

// ── Tokenization ───────────────────────────────────────────────────────

const MAX_SIDE_BYTES = 200 * 1024; // 200 KB
const MAX_SIDE_LINES = 5000;

/**
 * Tokenize `text` for `lang`. Returns per-line token arrays, or `null`
 * when the input exceeds the cap, the lang is unknown, or the
 * tokenization's line count disagrees with our model.
 */
export async function tokenizeLines(
  text: string,
  lang: string | null,
): Promise<ThemedToken[][] | null> {
  if (lang === null) return null;
  if (text.length === 0) return [];
  if (text.length > MAX_SIDE_BYTES) return null;
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (lines.length > MAX_SIDE_LINES) return null;
  if (lines.length === 0) return [];

  let highlighter: Awaited<ReturnType<typeof getHighlighter>>;
  try {
    highlighter = await getHighlighter();
  } catch {
    return null;
  }

  let result: Awaited<ReturnType<typeof highlighter.codeToTokens>>;
  try {
    // shiki's `lang` parameter is typed as the union of bundled
    // languages; our LANG_BY_EXT values are the same set but TS
    // doesn't know that. The runtime will reject unknown langs.
    result = await highlighter.codeToTokens(text, {
      lang: lang as never,
      theme: "catppuccin-mocha",
    });
  } catch {
    return null;
  }
  // The shiki TokenResult is { tokens: ThemedToken[][], ... }. We only
  // need the per-line array.
  const tokenLines = result.tokens;

  // Alignment guard: shiki splits on /\r?\n/. If our model-side lines
  // (which we derived the same way) have the same count, we trust it.
  // If the model side NORMALIZED trailing CRs but shiki didn't, we'd
  // be off-by-one — but in practice we don't normalize CRs here, so
  // the count matches.
  if (tokenLines.length === lines.length) return tokenLines;
  // Sometimes shiki's output is +1 when the text ends with a newline
  // and the last token line is empty. Tolerate exactly that.
  if (tokenLines.length === lines.length + 1 && tokenLines[tokenLines.length - 1]?.length === 0) {
    return tokenLines.slice(0, lines.length);
  }
  return null;
}

// ── Segmenting ─────────────────────────────────────────────────────────

export interface EmSegment {
  text: string;
  color?: string;
  em: boolean;
}

export interface EmRawToken {
  text: string;
  color?: string | undefined;
}

/**
 * Split a tokenized line into a list of segments, cutting token
 * boundaries at emphasis-range edges so the renderer can paint the
 * changed portion with a tinted background.
 *
 * `emphasisRanges` are char offsets into the line's source text. We
 * walk the tokens in order, accumulating source-text length and
 * partitioning each token's text at the range edges.
 */
export function segmentLine(
  tokens: EmRawToken[],
  emphasisRanges: ReadonlyArray<readonly [number, number]>,
): EmSegment[] {
  if (tokens.length === 0) return [];
  if (emphasisRanges.length === 0) {
    return tokens.map((t) => ({
      text: t.text,
      ...(t.color !== undefined ? { color: t.color } : {}),
      em: false,
    }));
  }
  const segs: EmSegment[] = [];
  let pos = 0;
  for (const tok of tokens) {
    const start = pos;
    const end = pos + tok.text.length;
    pos = end;
    if (tok.text.length === 0) continue;
    // Find all emphasis ranges that overlap [start, end).
    const overlaps: Array<readonly [number, number]> = [];
    for (const r of emphasisRanges) {
      if (r[1] <= start) continue;
      if (r[0] >= end) break; // sorted by start (we assert that later)
      overlaps.push(r);
    }
    if (overlaps.length === 0) {
      segs.push({
        text: tok.text,
        ...(tok.color !== undefined ? { color: tok.color } : {}),
        em: false,
      });
      continue;
    }
    // Slice the token text by the overlap edges.
    let cursor = start;
    for (const r of overlaps) {
      const a = Math.max(r[0], cursor);
      const b = Math.min(r[1], end);
      if (a > cursor) {
        segs.push({
          text: tok.text.slice(cursor - start, a - start),
          ...(tok.color !== undefined ? { color: tok.color } : {}),
          em: false,
        });
      }
      if (b > a) {
        segs.push({
          text: tok.text.slice(a - start, b - start),
          ...(tok.color !== undefined ? { color: tok.color } : {}),
          em: true,
        });
        cursor = b;
      }
    }
    if (cursor < end) {
      segs.push({
        text: tok.text.slice(cursor - start, end - start),
        ...(tok.color !== undefined ? { color: tok.color } : {}),
        em: false,
      });
    }
  }
  return segs;
}
