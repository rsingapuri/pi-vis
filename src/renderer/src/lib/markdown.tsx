import type React from "react";
import { Children, cloneElement, isValidElement, useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useImageViewerStore } from "../stores/image-viewer-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { getHighlighter, getShikiTheme } from "./shiki.js";

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

function openMarkdownImage(src: string, alt: string | undefined): void {
  useImageViewerStore.getState().openImage({ src, alt: alt?.trim() || "Image preview" });
}

function isPreviewableImageSrc(src: string): boolean {
  return /^(data:image\/|file:|https?:\/\/.*\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$)/i.test(
    src,
  );
}

function markdownUrlTransform(url: string): string {
  if (/^data:image\//i.test(url) || /^file:/i.test(url)) return url;
  return defaultUrlTransform(url);
}

type MarkdownImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  previewSrc?: string | undefined;
};

function MarkdownImagePreview({
  src,
  alt,
  className,
  previewSrc,
  ...props
}: MarkdownImageProps): React.ReactElement | null {
  const imageSrc = typeof src === "string" ? src : undefined;
  if (!imageSrc) return null;
  const lightboxSrc = previewSrc ?? imageSrc;
  const label = alt?.trim() ? `Open image: ${alt}` : "Open image preview";
  const mergedClassName = className ? `markdown-image ${className}` : "markdown-image";
  return (
    <button
      type="button"
      className={mergedClassName}
      title="Open image preview"
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMarkdownImage(lightboxSrc, alt);
      }}
    >
      <img {...props} src={imageSrc} alt={alt ?? ""} className="markdown-image__img" />
    </button>
  );
}

function LinkedMarkdownImage({
  image,
  linkProps,
}: {
  image: MarkdownImageProps;
  linkProps: React.AnchorHTMLAttributes<HTMLAnchorElement>;
}): React.ReactElement {
  const { previewSrc: _previewSrc, className, ...imgProps } = image;
  const mergedClassName = className ? `markdown-image ${className}` : "markdown-image";
  return (
    <a {...linkProps} className={mergedClassName}>
      <img {...imgProps} alt={image.alt ?? ""} className="markdown-image__img" />
    </a>
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
  a: ({ node, href, children, ...props }) => {
    const child = node?.children?.[0];
    if (node?.children?.length === 1 && child?.type === "element" && child.tagName === "img") {
      const imageProps = child.properties as MarkdownImageProps;
      if (typeof href === "string" && isPreviewableImageSrc(href)) {
        return <MarkdownImagePreview {...imageProps} previewSrc={href} />;
      }
      return <LinkedMarkdownImage image={imageProps} linkProps={{ ...props, href }} />;
    }
    if (Children.count(children) === 1) {
      const only = Children.only(children);
      if (isValidElement<MarkdownImageProps>(only) && only.type === MarkdownImagePreview) {
        if (typeof href === "string" && isPreviewableImageSrc(href)) {
          return cloneElement(only, { previewSrc: href });
        }
        return <LinkedMarkdownImage image={only.props} linkProps={{ ...props, href }} />;
      }
    }
    return (
      <a {...props} href={href}>
        {children}
      </a>
    );
  },
  img: ({ node: _node, ...props }) => <MarkdownImagePreview {...props} />,
};

export function Markdown({ children }: { children: string }): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      urlTransform={markdownUrlTransform}
    >
      {children}
    </ReactMarkdown>
  );
}
