import React from "react";

/**
 * Minimal ANSI SGR parser for status/widget text coming from pi extensions.
 * Handles colors (named, 256, truecolor) and bold/dim/italic/underline;
 * every other escape sequence is stripped.
 */

export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecoration?: "underline";
  opacity?: number;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

// Theme-aware ANSI named colors — resolved via CSS custom properties so
// they adapt to the active Catppuccin flavor (Latte/Frappé/Macchiato/Mocha).
const NAMED_COLORS: Record<number, string> = {
  0: "var(--surface-2)", // black
  1: "var(--danger)",
  2: "var(--success)",
  3: "var(--warning)",
  4: "var(--info)",
  5: "var(--magenta)", // magenta
  6: "var(--cyan)", // cyan
  7: "var(--text-secondary)", // white
  8: "var(--surface-3)", // bright black
  9: "var(--danger)",
  10: "var(--success)",
  11: "var(--warning)",
  12: "var(--info)",
  13: "var(--magenta)",
  14: "var(--cyan)",
  15: "var(--text-muted)", // bright white
};

// Standard xterm 256-color → rgb
function color256(n: number): string {
  if (n < 16) return NAMED_COLORS[n] ?? "var(--text)";
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const idx = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(idx / 36) % 6] ?? 0;
  const g = steps[Math.floor(idx / 6) % 6] ?? 0;
  const b = steps[idx % 6] ?? 0;
  return `rgb(${r},${g},${b})`;
}

// Apply one SGR parameter sequence (the codes between "\x1b[" and "m")
function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  const next = { ...style };
  let i = 0;
  while (i < params.length) {
    const p = params[i] ?? 0;
    if (p === 0) {
      return {};
    }
    if (p === 1) {
      next.fontWeight = "bold";
    } else if (p === 2) {
      next.opacity = 0.6;
    } else if (p === 3) {
      next.fontStyle = "italic";
    } else if (p === 4) {
      next.textDecoration = "underline";
    } else if (p === 22) {
      delete next.fontWeight;
      delete next.opacity;
    } else if (p === 23) {
      delete next.fontStyle;
    } else if (p === 24) {
      delete next.textDecoration;
    } else if (p >= 30 && p <= 37) {
      next.color = NAMED_COLORS[p - 30] ?? "var(--text)";
    } else if (p >= 90 && p <= 97) {
      next.color = NAMED_COLORS[p - 90 + 8] ?? "var(--text)";
    } else if (p === 39) {
      delete next.color;
    } else if (p >= 40 && p <= 47) {
      next.backgroundColor = NAMED_COLORS[p - 40] ?? "var(--bg)";
    } else if (p >= 100 && p <= 107) {
      next.backgroundColor = NAMED_COLORS[p - 100 + 8] ?? "var(--bg)";
    } else if (p === 49) {
      delete next.backgroundColor;
    } else if (p === 38 || p === 48) {
      const target = p === 38 ? "color" : "backgroundColor";
      const mode = params[i + 1];
      if (mode === 2) {
        const [r, g, b] = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0];
        next[target] = `rgb(${r},${g},${b})`;
        i += 4;
      } else if (mode === 5) {
        next[target] = color256(params[i + 2] ?? 0);
        i += 2;
      }
    }
    i++;
  }
  return next;
}

// CSI ... letter | OSC ... (BEL or ST) | lone 2-char escapes
const ANSI_TOKEN = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;

export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let lastIndex = 0;

  for (const match of text.matchAll(ANSI_TOKEN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, index), style });
    }
    lastIndex = index + match[0].length;
    if (match[1] !== undefined) {
      // SGR sequence — update the running style; other escapes are dropped
      const params = match[1] === "" ? [0] : match[1].split(";").map((n) => Number.parseInt(n, 10) || 0);
      style = applySgr(style, params);
    }
  }
  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex), style });
  }
  return spans;
}

export function stripAnsi(text: string): string {
  return parseAnsi(text)
    .map((s) => s.text)
    .join("");
}

export function AnsiText({ text }: { text: string }): React.ReactElement {
  const spans = parseAnsi(text);
  return (
    <>
      {spans.map((span, i) => {
        const hasStyle = Object.keys(span.style).length > 0;
        return hasStyle ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: ANSI spans are stream-stable per render
          <span key={i} style={span.style}>
            {span.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: ANSI spans are stream-stable per render
          <React.Fragment key={i}>{span.text}</React.Fragment>
        );
      })}
    </>
  );
}
