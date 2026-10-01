import { normalizeSafeExternalWebUrl } from "@shared/external-links.js";
import type React from "react";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useState,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useImageViewerStore } from "../stores/image-viewer-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import {
  getCachedHighlightedHtml,
  getHighlighter,
  getShikiTheme,
  setCachedHighlightedHtml,
} from "./shiki.js";

// Kick off highlighter init immediately so it's ready when needed
void getHighlighter();

const HIGHLIGHT_MAX_CHARS = 50_000;
const STREAMING_HIGHLIGHT_DELAY_MS = 150;
const MarkdownStreamingContext = createContext(false);

interface CodeBlockProps {
  lang: string;
  code: string;
}

function CodeBlock({ lang, code }: CodeBlockProps): React.ReactElement {
  const streaming = useContext(MarkdownStreamingContext);
  const [html, setHtml] = useState<string | null>(null);
  // Re-run when the active scheme changes; the actual Shiki theme name is
  // resolved from the highlighter (set by settings-store on scheme change),
  // so this works for any theme, not just `catppuccin-*`.
  const activeColorScheme = useSettingsStore((s) => s.activeColorScheme);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeColorScheme is the re-tokenize trigger — the theme name is read via getShikiTheme() (set by settings-store before this re-runs), so the dep is the scheme change itself, not a value read in the body.
  useEffect(() => {
    if (code.length > HIGHLIGHT_MAX_CHARS) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const theme = getShikiTheme();
    const cached =
      getCachedHighlightedHtml(theme, lang, code) ?? getCachedHighlightedHtml(theme, "text", code);
    if (cached) {
      setHtml(cached);
      return;
    }
    // Do not keep showing highlighted HTML for an older version of a streaming
    // code block while the new highlight is debounce-delayed. Render the plain
    // fallback with the latest text until Shiki catches up.
    setHtml(null);
    const run = () => {
      getHighlighter().then((h) => {
        if (cancelled) return;
        try {
          const result = h.codeToHtml(code, { lang, theme });
          if (!cancelled) {
            setHtml(result);
            if (!streaming) setCachedHighlightedHtml(theme, lang, code, result);
          }
        } catch {
          try {
            const result = h.codeToHtml(code, { lang: "text", theme });
            if (!cancelled) {
              setHtml(result);
              if (!streaming) setCachedHighlightedHtml(theme, "text", code, result);
            }
          } catch {
            /* ignore */
          }
        }
      });
    };
    if (streaming) timer = setTimeout(run, STREAMING_HIGHLIGHT_DELAY_MS);
    else run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [code, lang, activeColorScheme, streaming]);

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

function MarkdownExternalLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
  const safeHref = normalizeSafeExternalWebUrl(href);
  if (!safeHref) {
    // ReactMarkdown strips dangerous schemes to an empty href. Rendering an
    // empty anchor would turn a click into a same-document reload, while
    // preserving file:/data:/custom schemes could hand an untrusted protocol
    // to the OS. Keep the authored label visible but non-interactive.
    return <span className={props.className}>{children}</span>;
  }

  const openExternal = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    // Primary clicks (including keyboard activation and modified clicks) and
    // middle clicks all have one safe destination: the user's system browser.
    // Right click remains available for the native link context menu.
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    void window.pivis.invoke("app.openExternal", { url: safeHref }).catch(() => {
      // Main revalidates the URL. A rejection is intentionally inert: never
      // fall back to navigating the privileged Electron renderer.
    });
  };

  return (
    <a
      {...props}
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      onClick={openExternal}
      onAuxClick={openExternal}
    >
      {children}
    </a>
  );
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
    <MarkdownExternalLink {...linkProps} className={mergedClassName}>
      <img {...imgProps} alt={image.alt ?? ""} className="markdown-image__img" />
    </MarkdownExternalLink>
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
  table: ({ node: _node, children, ...props }) => (
    <div className="markdown-table-shell">
      <div className="markdown-table-scroll">
        <table {...props}>{children}</table>
      </div>
    </div>
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
    const renderedChildren = Children.toArray(children);
    if (renderedChildren.length === 1) {
      const only = renderedChildren[0];
      if (isValidElement<MarkdownImageProps>(only) && only.type === MarkdownImagePreview) {
        if (typeof href === "string" && isPreviewableImageSrc(href)) {
          return cloneElement(only, { previewSrc: href });
        }
        return <LinkedMarkdownImage image={only.props} linkProps={{ ...props, href }} />;
      }
    }
    return (
      <MarkdownExternalLink {...props} href={href}>
        {children}
      </MarkdownExternalLink>
    );
  },
  img: ({ node: _node, ...props }) => <MarkdownImagePreview {...props} />,
};

export function Markdown({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}): React.ReactElement {
  return (
    <MarkdownStreamingContext.Provider value={streaming}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </MarkdownStreamingContext.Provider>
  );
}
