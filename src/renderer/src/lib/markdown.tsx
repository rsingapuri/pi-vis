import type React from "react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSettingsStore } from "../stores/settings-store.js";
import { getHighlighter, getShikiTheme, highlightCode } from "./shiki.js";

// Kick off highlighter init immediately so it's ready when needed
void getHighlighter();

interface CodeBlockProps {
  lang: string;
  code: string;
}

function CodeBlock({ lang, code }: CodeBlockProps): React.ReactElement {
  const [html, setHtml] = useState<string | null>(null);
  // Re-run when the active scheme changes; the actual Shiki theme name is
  // resolved from the highlighter (set by settings-store on scheme change),
  // so this works for any theme, not just `catppuccin-*`.
  const colorScheme = useSettingsStore((s) => s.settings.colorScheme);

  // biome-ignore lint/correctness/useExhaustiveDependencies: colorScheme is the re-tokenize trigger — the theme name is read via getShikiTheme() (set by settings-store before this re-runs), so the dep is the scheme change itself, not a value read in the body.
  useEffect(() => {
    let cancelled = false;
    const theme = getShikiTheme();
    getHighlighter().then((h) => {
      if (cancelled) return;
      try {
        const result = h.codeToHtml(code, { lang, theme });
        if (!cancelled) setHtml(result);
      } catch {
        try {
          const result = h.codeToHtml(code, { lang: "text", theme });
          if (!cancelled) setHtml(result);
        } catch {
          /* ignore */
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, colorScheme]);

  if (html) {
    return (
      <div
        className="code-block"
        data-language={lang}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes all code content
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  // Plain pre on first paint — swap in highlighted HTML async
  return (
    <pre className="code-block code-block--plain" data-language={lang}>
      <code>{code}</code>
    </pre>
  );
}

const components: Components = {
  // Block detection lives on <pre> — the only element a fenced or indented
  // code block produces — so blocks without a language annotation (which
  // react-markdown leaves without a `language-*` class on <code>) still
  // render as proper Shiki boxes instead of falling through to inline code.
  pre: ({ node, children }) => {
    const codeEl = node?.children?.[0];
    if (codeEl?.type === "element" && codeEl.tagName === "code") {
      const classes = codeEl.properties?.className;
      const langClass = Array.isArray(classes)
        ? classes.find((c): c is string => typeof c === "string" && c.startsWith("language-"))
        : undefined;
      const lang = langClass ? langClass.replace("language-", "") : "text";
      const textNode = codeEl.children[0];
      const code = (textNode?.type === "text" ? textNode.value : "").replace(/\n$/, "");
      return <CodeBlock lang={lang} code={code} />;
    }
    return <pre>{children}</pre>;
  },
  code: ({ node: _node, children, ...props }) => (
    <code className="inline-code" {...props}>
      {children}
    </code>
  ),
};

export function Markdown({ children }: { children: string }): React.ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
