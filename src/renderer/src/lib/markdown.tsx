import type React from "react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSettingsStore } from "../stores/settings-store.js";
import { getHighlighter, highlightCode } from "./shiki.js";

// Kick off highlighter init immediately so it's ready when needed
void getHighlighter();

interface CodeBlockProps {
  className?: string | undefined;
  children?: React.ReactNode | undefined;
}

function CodeBlock({ className, children }: CodeBlockProps): React.ReactElement {
  const lang = className?.replace("language-", "") ?? "text";
  const code = String(children ?? "").replace(/\n$/, "");
  const [html, setHtml] = useState<string | null>(null);
  const colorScheme = useSettingsStore((s) => s.settings.colorScheme);

  useEffect(() => {
    let cancelled = false;
    const theme = `catppuccin-${colorScheme}`;
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
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return (
      <code className="mcm-inline-code" {...props}>
        {children}
      </code>
    );
  },
};

export function Markdown({ children }: { children: string }): React.ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
