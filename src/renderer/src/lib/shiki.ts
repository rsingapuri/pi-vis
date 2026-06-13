import { type Highlighter, createHighlighter } from "shiki";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinFrappe from "@shikijs/themes/catppuccin-frappe";
import catppuccinMacchiato from "@shikijs/themes/catppuccin-macchiato";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

// Active Shiki theme. Defaults to Mocha so SSR / preview-stub paths
// (no settings store yet) still tokenize. settings-store calls
// setShikiScheme on load + update.
let currentTheme = "catppuccin-mocha";

/**
 * Patch a single theme object's comment foreground for better contrast.
 * Returns a shallow clone with the comment rule updated.
 */
function patchCommentFg(
  theme: typeof catppuccinMocha,
  target: string,
): typeof catppuccinMocha {
  const clone = { ...theme, tokenColors: (theme.tokenColors ?? []).map((tc) => ({ ...tc })) };
  for (const rule of clone.tokenColors) {
    const scopes = typeof rule.scope === "string" ? [rule.scope] : rule.scope ?? [];
    if (scopes.some((s) => s === "comment" || s === "punctuation.definition.comment")) {
      // Preserve fontStyle (italic), only bump the foreground
      rule.settings = { ...rule.settings, foreground: target };
    }
  }
  return clone;
}

type PatchedTheme = ReturnType<typeof patchCommentFg>;

const themeNameMap: Record<string, PatchedTheme> = {
  "catppuccin-latte": patchCommentFg(catppuccinLatte, "#6c6f85"),
  "catppuccin-frappe": patchCommentFg(catppuccinFrappe, "#838ba7"),
  "catppuccin-macchiato": patchCommentFg(catppuccinMacchiato, "#8087a2"),
  "catppuccin-mocha": patchCommentFg(catppuccinMocha, "#7f849c"),
};

export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (initPromise) return initPromise;

  initPromise = createHighlighter({
    themes: Object.values(themeNameMap),
    langs: [
      "typescript",
      "javascript",
      "tsx",
      "jsx",
      "python",
      "rust",
      "go",
      "bash",
      "sh",
      "json",
      "yaml",
      "markdown",
      "css",
      "html",
      "sql",
      "diff",
    ],
  });

  highlighter = await initPromise;
  return highlighter;
}

/** Set the active Shiki theme to match the chosen Catppuccin flavor. */
export function setShikiScheme(scheme: "latte" | "frappe" | "macchiato" | "mocha"): void {
  currentTheme = `catppuccin-${scheme}`;
}

/** Get the current Shiki theme name (used by diff highlighting). */
export function getShikiTheme(): string {
  return currentTheme;
}

export function highlightCode(code: string, lang: string): string {
  if (!highlighter) return "";
  try {
    return highlighter.codeToHtml(code, {
      lang,
      theme: getShikiTheme(),
    });
  } catch {
    // Fallback for unknown languages
    try {
      return highlighter.codeToHtml(code, { lang: "text", theme: getShikiTheme() });
    } catch {
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
