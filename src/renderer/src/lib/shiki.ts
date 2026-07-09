import { BUNDLED_THEMES, type Theme } from "@shared/theme";
import catppuccinFrappe from "@shikijs/themes/catppuccin-frappe";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinMacchiato from "@shikijs/themes/catppuccin-macchiato";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import { type Highlighter, createHighlighter } from "shiki";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

const HTML_CACHE_MAX_ENTRIES = 100;
const HTML_CACHE_MAX_TOTAL_CHARS = 2_000_000;
const htmlCache = new Map<string, { html: string; chars: number }>();
let htmlCacheChars = 0;

function cacheKey(theme: string, lang: string, code: string): string {
  return `${theme}\0${lang}\0${code}`;
}

export function getCachedHighlightedHtml(theme: string, lang: string, code: string): string | null {
  const key = cacheKey(theme, lang, code);
  const hit = htmlCache.get(key);
  if (!hit) return null;
  htmlCache.delete(key);
  htmlCache.set(key, hit);
  return hit.html;
}

export function setCachedHighlightedHtml(
  theme: string,
  lang: string,
  code: string,
  html: string,
): void {
  const key = cacheKey(theme, lang, code);
  const existing = htmlCache.get(key);
  if (existing) htmlCacheChars -= existing.chars;
  htmlCache.delete(key);
  const chars = code.length;
  htmlCache.set(key, { html, chars });
  htmlCacheChars += chars;
  while (htmlCache.size > HTML_CACHE_MAX_ENTRIES || htmlCacheChars > HTML_CACHE_MAX_TOTAL_CHARS) {
    const first = htmlCache.entries().next().value as [string, { chars: number }] | undefined;
    if (!first) break;
    htmlCache.delete(first[0]);
    htmlCacheChars -= first[1].chars;
  }
}

// Active Shiki theme NAME. Defaults to Mocha so SSR / preview-stub paths
// (no settings store yet) still tokenize. settings-store calls
// setShikiTheme on load + update.
let currentTheme = "catppuccin-mocha";

/**
 * Patch a single theme object's comment foreground for better contrast.
 * Returns a shallow clone with the comment rule updated.
 */
function patchCommentFg(theme: typeof catppuccinMocha, target: string): typeof catppuccinMocha {
  const clone = { ...theme, tokenColors: (theme.tokenColors ?? []).map((tc) => ({ ...tc })) };
  for (const rule of clone.tokenColors) {
    const scopes = typeof rule.scope === "string" ? [rule.scope] : (rule.scope ?? []);
    if (scopes.some((s) => s === "comment" || s === "punctuation.definition.comment")) {
      // Preserve fontStyle (italic), only bump the foreground
      rule.settings = { ...rule.settings, foreground: target };
    }
  }
  return clone;
}

// Contrast-patched Catppuccin syntax themes, keyed by Shiki theme name. These
// are the objects we register (so the comment bump sticks); a theme whose
// `syntax.ref` names one of these reuses the patched object rather than the
// raw bundled theme.
const PATCHED_CATPPUCCIN: Record<string, typeof catppuccinMocha> = {
  "catppuccin-latte": patchCommentFg(catppuccinLatte, "#6c6f85"),
  "catppuccin-frappe": patchCommentFg(catppuccinFrappe, "#838ba7"),
  "catppuccin-macchiato": patchCommentFg(catppuccinMacchiato, "#8087a2"),
  "catppuccin-mocha": patchCommentFg(catppuccinMocha, "#7f849c"),
};

/**
 * Resolve a theme's syntax spec to the value Shiki's `loadTheme` accepts:
 * a patched Catppuccin object, a bundled-theme name string (lazy-loaded by
 * Shiki), or an inline TextMate theme object.
 */
function syntaxInput(theme: Theme): string | Record<string, unknown> {
  const s = theme.syntax;
  if ("ref" in s) return PATCHED_CATPPUCCIN[s.ref] ?? s.ref;
  return s.inline;
}

/** The Shiki theme NAME a theme resolves to (for codeToHtml). */
function syntaxName(theme: Theme): string {
  const s = theme.syntax;
  return "ref" in s ? s.ref : s.inline.name;
}

// Partition the bundled themes into inputs that are guaranteed resolvable
// (concrete TextMate objects — the patched Catppuccin themes and any inline
// theme) and string refs that may name a theme NOT shipped with Shiki (e.g. a
// bundled/user theme whose `syntax.ref` isn't in Shiki's bundle). Deduped by
// Shiki name.
//
// `createHighlighter` resolves its `themes` array ATOMICALLY: a single
// unresolvable ref throws and aborts init, leaving the highlighter null — and
// with it EVERY caller (diff tokenization returns null → no diff colors;
// markdown CodeBlock's rejected getHighlighter() promise never fires its
// .then → plain fallback). A bad ref in one theme must not take down
// highlighting app-wide, so we construct from the safe set only and then
// `loadTheme` each ref individually, skipping any that don't resolve. A bad
// ref degrades to "that theme renders via the default" instead of "no
// highlighting anywhere". User themes are already loaded this way in
// setShikiTheme (which has its own try/catch).
function partitionBundledThemes(): {
  safe: Array<Record<string, unknown>>;
  refs: Array<{ name: string; input: string }>;
} {
  const seen = new Set<string>();
  const safe: Array<Record<string, unknown>> = [];
  const refs: Array<{ name: string; input: string }> = [];
  for (const theme of BUNDLED_THEMES) {
    const name = syntaxName(theme);
    if (seen.has(name)) continue;
    seen.add(name);
    const input = syntaxInput(theme);
    if (typeof input === "string") refs.push({ name, input });
    else safe.push(input);
  }
  return { safe, refs };
}

export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { safe, refs } = partitionBundledThemes();
    const h = await createHighlighter({
      // Concrete objects always resolve, which guarantees the highlighter
      // initializes even if every ref below is bad. The four Catppuccin themes
      // are hardcoded patched objects in BUNDLED_THEMES, so `safe` is always
      // non-empty (≥4 entries) — an inline-only future would need a different
      // guarantee, but that's not the current shape.
      themes: safe,
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
    // Load string-ref themes one at a time so a single unresolvable ref
    // (bundled or a future user theme) can never abort highlighting.
    for (const { name, input } of refs) {
      if (h.getLoadedThemes().includes(name)) continue;
      try {
        // `input` is a Shiki theme name string; shiki types it as a literal
        // union, so mirror the `lang as never` cast used in tokenizeLines.
        // A name not in the bundle throws here and is caught below.
        await h.loadTheme(input as never);
      } catch {
        // Unresolvable ref — render falls back to the default theme for it.
      }
    }
    return h;
  })();

  highlighter = await initPromise;
  return highlighter;
}

/**
 * Switch the active Shiki theme to the given app theme's syntax theme.
 * `currentTheme` is updated synchronously so `getShikiTheme()` reflects the
 * choice immediately; the theme object is then ensured-loaded (a no-op for
 * preloaded bundled themes, an async `loadTheme` for a user theme's ref/inline
 * the highlighter hasn't seen yet).
 */
export async function setShikiTheme(theme: Theme): Promise<void> {
  const name = syntaxName(theme);
  currentTheme = name;
  const h = await getHighlighter();
  if (!h.getLoadedThemes().includes(name)) {
    try {
      await h.loadTheme(syntaxInput(theme) as Parameters<typeof h.loadTheme>[0]);
    } catch {
      // Unknown ref / malformed inline theme — fall back to the default so
      // highlighting still works (codeToHtml would otherwise throw).
      currentTheme = "catppuccin-mocha";
    }
  }
}

/** Get the current Shiki theme name (used by diff highlighting + markdown). */
export function getShikiTheme(): string {
  return currentTheme;
}

/**
 * The warm highlighter singleton, or null if it hasn't finished initializing yet.
 * Used by the diff editor's synchronous per-keystroke tokenization: if it isn't
 * ready yet, text renders plain (never blocks). Once warmed at app boot it is
 * effectively synchronous.
 */
export function getLoadedHighlighter(): Highlighter | null {
  return highlighter;
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
