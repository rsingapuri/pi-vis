import { type Highlighter, createHighlighter } from "shiki";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (initPromise) return initPromise;

  initPromise = createHighlighter({
    themes: ["catppuccin-mocha"],
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

export function highlightCode(code: string, lang: string): string {
  if (!highlighter) return "";
  try {
    return highlighter.codeToHtml(code, {
      lang,
      theme: "catppuccin-mocha",
    });
  } catch {
    // Fallback for unknown languages
    try {
      return highlighter.codeToHtml(code, { lang: "text", theme: "catppuccin-mocha" });
    } catch {
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
