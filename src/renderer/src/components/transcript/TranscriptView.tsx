import type { SessionId } from "@shared/ids.js";
import type { TranscriptStyle } from "@shared/settings.js";
import type React from "react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnsiText } from "../../lib/ansi.js";
import { Markdown } from "../../lib/markdown.js";
import { querySession } from "../../lib/session-intent.js";
import { htmlToMarkdown } from "../../lib/turndown.js";
import { useImageViewerStore } from "../../stores/image-viewer-store.js";
import {
  authoritySnapshotFor,
  sessionCompactionActivity,
  sessionMatchesRuntime,
  shouldShowWorkingIndicator,
  useSessionsStore,
} from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import {
  type AssistantBlockData,
  type AssistantSegment,
  type BashBlockData,
  type BranchSummaryBlockData,
  type CompactionBlockData,
  type CustomEntryBlockData,
  type CustomMessageBlockData,
  type ErrorBlockData,
  type ToolCallBlockData,
  type TypedTranscriptBlock,
  type UserBlockData,
  hasAssistantContent,
  lastTranscriptBlock,
  transcriptBlockCount,
} from "../../stores/transcript.js";
import { FadeText } from "../common/FadeText.js";
import { Spinner } from "../common/Spinner.js";
import { IconChevronRight, IconCopy } from "../common/icons.js";
import { DiffBlock } from "./DiffBlock.js";
import "./TranscriptView.css";

const OUTPUT_VIRTUAL_OVERSCAN = 8;
const OUTPUT_DEFAULT_ROW_HEIGHT = 18;
const LARGE_SINGLE_LINE_CHARS = 24_000;
const LARGE_STRUCTURED_TEXT_CHARS = 120_000;
const LARGE_DIFF_CHARS = 240_000;
const LARGE_DIFF_LINES = 1_500;
// Treat only the browser's sub-pixel rounding fringe as the bottom. A small
// intentional scroll must leave bottom-follow immediately instead of sitting
// in a fuzzy zone that later layout/streaming work can snap back down.
const SCROLL_BOTTOM_EPSILON_PX = 1;
// Scroll events can be caused by layout (e.g. a custom/unified panel replacing
// the Composer and shrinking the transcript viewport) as well as by the user.
// Only an actual user scroll input may break bottom-follow.
const USER_SCROLL_INTENT_MS = 1000;

// ── Label visibility ─────────────────────────────────────────────────────
// Only show "You" / "Pi" when the *speaker* changes.  Tool/bash blocks are
// not speakers and do not affect the label decision.

// ── Shared helpers ───────────────────────────────────────────────────────

function splitOutputLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return [];
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

const TOOL_SUBJECT_KEYS: Record<string, string[]> = {
  bash: ["command", "cmd"],
  edit: ["path", "file_path", "filePath", "filename"],
  find: ["pattern", "query", "path"],
  grep: ["pattern", "query", "path"],
  ls: ["path"],
  read: ["path", "file_path", "filePath", "filename"],
  write: ["path", "file_path", "filePath", "filename"],
};
const FALLBACK_SUBJECT_KEYS = [
  "command",
  "cmd",
  "pattern",
  "query",
  "path",
  "file_path",
  "filePath",
  "filename",
  "url",
  "prompt",
  "title",
  "name",
];

// Collapsed cards carry an authored semantic summary, never a lossy body
// preview. The complete input is always one click away in the inspector.
function summarizeInput(toolName: string, input?: Record<string, unknown>): string | null {
  if (!input) return null;
  const keys = [...(TOOL_SUBJECT_KEYS[toolName] ?? []), ...FALLBACK_SUBJECT_KEYS];
  for (const key of new Set(keys)) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.split("\n", 1)[0] ?? value;
    }
  }
  return null;
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function pluralLines(n: number): string {
  return n === 1 ? "line" : "lines";
}

function formatLineCount(n: number): string {
  return `${n.toLocaleString()} ${pluralLines(n)}`;
}

function formatCharCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "character" : "characters"}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmptyLine(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function stripMarkdownChrome(text: string): string {
  return text
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^[-*+]\s+/u, "")
    .replace(/^\d+\.\s+/u, "")
    .replace(/^\*\*(.+)\*\*$/u, "$1")
    .replace(/^__(.+)__$/u, "$1")
    .replace(/^`(.+)`$/u, "$1")
    .trim();
}

function summarizeActivityContent(text: string): string | null {
  const first = firstNonEmptyLine(text);
  if (!first) return null;
  return stripMarkdownChrome(first);
}

/** Formats a millisecond duration as e.g. "12m 37s", "4s", or "1h 05m". */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Authority-gated working phase. Compaction takes label precedence over a
 * simultaneously streaming turn because it is the operation currently making
 * progress. */
function WorkingRow({ sessionId }: { sessionId: SessionId }): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const compaction = sessionCompactionActivity(session);
  const runningSince = authoritySnapshotFor(session)?.sdk.isStreaming
    ? session?.runningSince
    : undefined;
  const elapsedSince = compaction?.startedAt ?? (!compaction ? runningSince : undefined);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (elapsedSince == null) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [elapsedSince]);

  let label: string;
  if (compaction?.state === "cancelling") label = "Cancelling compaction…";
  else if (compaction?.state === "retry_wait") label = "Retrying compaction…";
  else if (compaction) {
    label = compaction.startedAt
      ? `Compacting… ${formatDuration(Date.now() - compaction.startedAt)}`
      : "Compacting…";
  } else {
    label =
      runningSince != null
        ? `Running for ${formatDuration(Date.now() - runningSince)}`
        : "Working…";
  }
  return (
    <div className="working-row">
      <Spinner />
      <span className="working-row__label">{label}</span>
    </div>
  );
}

interface ToolCardShellProps {
  isError: boolean;
  open: boolean;
  onToggle: () => void;
  accessibleLabel: string;
  accessibleSummary?: string | undefined;
  kind: React.ReactNode;
  subject?: React.ReactNode;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}

// Every execution/activity card has exactly one disclosure. The collapsed row
// is an authored summary; one activation reveals the complete retained record.
function ToolCardShell({
  isError,
  open,
  onToggle,
  accessibleLabel,
  accessibleSummary,
  kind,
  subject,
  trailing,
  children,
}: ToolCardShellProps): React.ReactElement {
  const bodyId = useId();
  const classes = ["tool-card", isError ? "tool-card--error" : "", open ? "tool-card--open" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <button
        type="button"
        className="tool-card__header fade-scope"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${accessibleLabel} details${accessibleSummary ? ` — ${accessibleSummary}` : ""}`}
      >
        <IconChevronRight className="tool-card__chevron" />
        <span className="tool-card__identity">
          {kind}
          {subject}
        </span>
        {trailing !== undefined && <span className="tool-card__header-trailing">{trailing}</span>}
      </button>
      {open && (
        <div id={bodyId} className="tool-card__body">
          {children}
        </div>
      )}
    </div>
  );
}

function useCardDisclosure(preserveScroll: (mutate: () => void) => void): {
  open: boolean;
  toggle: () => void;
} {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => {
    preserveScroll(() => setOpen((value) => !value));
  }, [preserveScroll]);

  return { open, toggle };
}

const CopyButton = memo(function CopyButton({
  text,
  label = "Copy all",
}: {
  text: string;
  label?: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await window.pivis.invoke("clipboard.writeText", { text });
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }, [text]);

  return (
    <button type="button" className="tool-card__copy" onClick={copy}>
      <IconCopy />
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
});

function SectionHeader({
  title,
  meta,
  copyText,
  copyLabel,
}: {
  title: string;
  meta?: string | undefined;
  copyText?: string | undefined;
  copyLabel?: string | undefined;
}): React.ReactElement {
  return (
    <div className="tool-card__section-header">
      <span className="tool-card__section-title">{title}</span>
      {meta && <span className="tool-card__section-meta">{meta}</span>}
      {copyText !== undefined && (
        <CopyButton text={copyText} {...(copyLabel ? { label: copyLabel } : {})} />
      )}
    </div>
  );
}

function StructuredPayload({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): React.ReactElement {
  const text = useMemo(() => stringifyForDisplay(value), [value]);
  const isLarge =
    text.length >= LARGE_STRUCTURED_TEXT_CHARS ||
    (!text.includes("\n") && text.length >= LARGE_SINGLE_LINE_CHARS);
  return (
    <section className="tool-card__section">
      <SectionHeader title={label} meta={formatCharCount(text.length)} copyText={text} />
      {isLarge ? (
        <textarea
          className="tool-card__large-payload"
          aria-label={`${label}, complete value`}
          readOnly
          spellCheck={false}
          value={text}
        />
      ) : (
        <div className="tool-card__scroll-frame">
          <div
            className="tool-card__scroll tool-card__scroll--structured"
            aria-label={`${label}, complete value`}
            role="region"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded scroll regions must be keyboard-scrollable
            tabIndex={0}
          >
            <pre className="tool-card__structured-value">{text}</pre>
          </div>
        </div>
      )}
    </section>
  );
}

function EmptySection({
  label,
  children,
}: { label: string; children: string }): React.ReactElement {
  return (
    <section className="tool-card__section">
      <SectionHeader title={label} />
      <p className="tool-card__empty">{children}</p>
    </section>
  );
}

function ProvenanceGrid({
  values,
}: { values: Array<[string, React.ReactNode]> }): React.ReactElement {
  return (
    <dl className="tool-card__provenance">
      {values.map(([label, value]) => (
        <div className="tool-card__provenance-item" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const ImageArtifacts = memo(function ImageArtifacts({
  images,
  label = "Images",
}: {
  images: string[];
  label?: string;
}): React.ReactElement | null {
  const openImages = useImageViewerStore((state) => state.openImages);
  const validImages = useMemo(
    () => images.filter((src) => /^(data:image\/|file:|https?:)/u.test(src)),
    [images],
  );
  const viewerItems = useMemo(
    () => validImages.map((src, index) => ({ src, alt: `Tool result image ${index + 1}` })),
    [validImages],
  );
  if (validImages.length === 0) return null;
  const copyText = validImages.join("\n");
  return (
    <section className="tool-card__section">
      <SectionHeader
        title={label}
        meta={`${validImages.length.toLocaleString()} ${validImages.length === 1 ? "image" : "images"}`}
        copyText={copyText}
        copyLabel={validImages.length === 1 ? "Copy data" : "Copy all data"}
      />
      <div className="tool-card__images">
        {validImages.map((src, index) => {
          const mimeType = /^data:([^;,]+)/u.exec(src)?.[1] ?? "image";
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: result image order is immutable
              key={index}
              type="button"
              className="tool-card__image-button"
              onClick={() => openImages(viewerItems, index)}
              aria-label={`Open tool result image ${index + 1} larger`}
            >
              <img className="tool-card__image" src={src} alt={`Tool result ${index + 1}`} />
              <span className="tool-card__image-meta">{mimeType}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
});

// ── Block renderers ──────────────────────────────────────────────────────

// Memoized on the `data` prop: the transcript reducer (patchBlock) creates a
// new `data` object only for the one block a streaming delta touches, leaving
// every other block's `data` reference stable. Complete persisted/compacted
// history is isolated behind the archive memo boundary below, while unchanged
// blocks in the normally small live tail skip their component render.
const UserBlock = memo(function UserBlock({ data }: { data: UserBlockData }): React.ReactElement {
  const openImages = useImageViewerStore((s) => s.openImages);
  const validImages = useMemo(
    () => data.images?.filter((img) => /^(data:image\/|file:|https?:)/.test(img)) ?? [],
    [data.images],
  );

  const handleOpenImage = useCallback(
    (index: number) => {
      openImages(
        validImages.map((src, i) => ({ src, alt: `Attached image ${i + 1}` })),
        index,
      );
    },
    [openImages, validImages],
  );

  return (
    <div className="transcript-block transcript-block--user">
      <div className="transcript-block__bubble user-content">
        {validImages.length > 0 && (
          <div className="transcript-block__images">
            {validImages.map((img, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: image order is stable for a given user message
                key={i}
                type="button"
                className="transcript-block__image-button"
                onClick={() => handleOpenImage(i)}
                aria-label={`Open attached image ${i + 1} larger`}
                title="Open image preview"
              >
                <img
                  src={img}
                  // biome-ignore lint/a11y/noRedundantAlt: alt describes which attached image, not "what"
                  alt={`Attached image ${i + 1}`}
                  className="transcript-block__image-thumb"
                />
              </button>
            ))}
          </div>
        )}
        <div className="transcript-block__content">{data.content}</div>
      </div>
    </div>
  );
});

const ThinkingSegment = memo(function ThinkingSegment({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}): React.ReactElement {
  return (
    <div className="thinking-block markdown-body">
      <Markdown streaming={streaming}>{content}</Markdown>
    </div>
  );
});

const TextSegment = memo(function TextSegment({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}): React.ReactElement {
  return (
    <div className="transcript-block__content markdown-body">
      <Markdown streaming={streaming}>{content}</Markdown>
    </div>
  );
});

const AssistantSegmentView = memo(function AssistantSegmentView({
  segment,
  streaming,
}: {
  segment: AssistantSegment;
  streaming: boolean;
}): React.ReactElement | null {
  if (!segment.content) return null;
  return segment.kind === "thinking" ? (
    <ThinkingSegment content={segment.content} streaming={streaming} />
  ) : (
    <TextSegment content={segment.content} streaming={streaming} />
  );
});

const AssistantBlock = memo(function AssistantBlock({
  data,
}: {
  data: AssistantBlockData;
}): React.ReactElement {
  return (
    <div className="transcript-block transcript-block--assistant">
      {data.segments.map((seg, i) => (
        <AssistantSegmentView key={`${seg.kind}-${i}`} segment={seg} streaming={data.isStreaming} />
      ))}
    </div>
  );
});

const VirtualizedOutput = memo(function VirtualizedOutput({
  text,
  label = "output",
}: {
  text: string;
  label?: string;
}): React.ReactElement | null {
  const lines = useMemo(() => splitOutputLines(text), [text]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(OUTPUT_DEFAULT_ROW_HEIGHT);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const measured = measureRef.current?.getBoundingClientRect().height;
    if (measured && Math.abs(measured - rowHeight) > 0.5) {
      setRowHeight(measured);
    }
  }, [rowHeight]);

  useEffect(() => {
    const maxScrollTop = Math.max(0, lines.length * rowHeight - viewportHeight);
    if (scrollTop > maxScrollTop) setScrollTop(maxScrollTop);
  }, [lines.length, rowHeight, scrollTop, viewportHeight]);

  if (lines.length === 0) return null;
  if (lines.length === 1 && text.length >= LARGE_SINGLE_LINE_CHARS) {
    return (
      <div className="tool-card__output-panel">
        <SectionHeader
          title={label}
          meta={`${formatLineCount(1)} · ${formatCharCount(text.length)}`}
          copyText={text}
        />
        <textarea
          className="tool-card__large-payload"
          aria-label={`${label}, complete value`}
          readOnly
          spellCheck={false}
          value={text}
        />
      </div>
    );
  }

  const visibleCount = Math.max(1, Math.ceil((viewportHeight || 360) / rowHeight));
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OUTPUT_VIRTUAL_OVERSCAN);
  const end = Math.min(lines.length, start + visibleCount + OUTPUT_VIRTUAL_OVERSCAN * 2);
  const beforeHeight = start * rowHeight;
  const afterHeight = Math.max(0, (lines.length - end) * rowHeight);
  return (
    <div className="tool-card__output-panel">
      <SectionHeader title={label} meta={formatLineCount(lines.length)} copyText={text} />
      <div className="tool-card__output-frame">
        <div
          ref={scrollRef}
          className="tool-card__virtual-scroll"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          aria-label={`${label} (${formatLineCount(lines.length)})`}
          role="region"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded scroll regions must be keyboard-scrollable
          tabIndex={0}
        >
          <div style={{ height: beforeHeight }} aria-hidden="true" />
          {lines.slice(start, end).map((line, offset) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: virtual rows are positional slices of immutable text
              key={start + offset}
              ref={offset === 0 ? measureRef : undefined}
              className="tool-card__output-line"
            >
              {line || "\u00A0"}
            </div>
          ))}
          <div style={{ height: afterHeight }} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
});

function ToolScrollWell({
  children,
  diff = false,
  label = "Complete content",
}: {
  children: React.ReactNode;
  diff?: boolean | undefined;
  label?: string | undefined;
}): React.ReactElement {
  return (
    <div className="tool-card__scroll-frame">
      <div
        className={`tool-card__scroll${diff ? " tool-card__scroll--diff" : ""}`}
        aria-label={label}
        role="region"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded scroll regions must be keyboard-scrollable
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}

function DiffPayload({ text, lines }: { text: string; lines: string[] }): React.ReactElement {
  if (text.length >= LARGE_DIFF_CHARS || lines.length >= LARGE_DIFF_LINES) {
    return (
      <textarea
        className="tool-card__large-payload tool-card__large-payload--diff"
        aria-label="Complete diff"
        readOnly
        spellCheck={false}
        value={text}
      />
    );
  }
  return (
    <ToolScrollWell diff label="Complete diff">
      <DiffBlock diff={text} />
    </ToolScrollWell>
  );
}

const ToolCallBlock = memo(function ToolCallBlock({
  data,
  preserveScroll,
}: {
  data: ToolCallBlockData;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const { open, toggle } = useCardDisclosure(preserveScroll);
  const outputLines = useMemo(() => splitOutputLines(data.outputText), [data.outputText]);
  const isBash = data.toolName === "bash";
  const subject = summarizeInput(data.toolName, data.input);
  const diffLines = useMemo(() => (data.diff ? splitOutputLines(data.diff) : []), [data.diff]);
  const patchLines = useMemo(() => (data.patch ? splitOutputLines(data.patch) : []), [data.patch]);
  const hasDistinctResultContent =
    Object.hasOwn(data, "resultContent") &&
    !(
      typeof data.resultContent === "string" &&
      data.resultContent.length > 0 &&
      data.resultContent === data.outputText
    );
  const truncation = isObjectRecord(data.resultDetails) ? data.resultDetails.truncation : undefined;
  const resultSummary = [
    outputLines.length > 0 ? formatLineCount(outputLines.length) : null,
    data.outputImages?.length
      ? `${data.outputImages.length.toLocaleString()} ${data.outputImages.length === 1 ? "image" : "images"}`
      : null,
    data.diff !== undefined || data.patch !== undefined ? "changes" : null,
    isObjectRecord(truncation) && truncation.truncated === true ? "truncated" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const status = data.isStreaming
    ? "running"
    : data.isError
      ? "error"
      : data.interrupted
        ? "interrupted"
        : "complete";

  const trailing =
    resultSummary || data.isStreaming || data.isError || data.interrupted ? (
      <>
        {resultSummary && <span className="tool-card__summary-meta">{resultSummary}</span>}
        {data.isStreaming && <Spinner className="tool-card__spinner" />}
        {data.isError && <span className="tool-card__badge">error</span>}
        {data.interrupted && !data.isError && (
          <span className="tool-card__badge tool-card__badge--interrupted">interrupted</span>
        )}
      </>
    ) : undefined;

  return (
    <ToolCardShell
      isError={data.isError}
      open={open}
      onToggle={toggle}
      accessibleLabel={`${data.toolName} tool call`}
      accessibleSummary={
        [
          subject,
          resultSummary,
          data.isStreaming ? "running" : null,
          data.isError ? "error" : null,
          data.interrupted && !data.isError ? "interrupted" : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      kind={
        <span className={`tool-card__name ${isBash ? "tool-card__name--bash" : ""}`}>
          {isBash ? "$" : data.toolName}
        </span>
      }
      subject={
        subject ? (
          <FadeText className="tool-card__subject" title={subject}>
            {subject}
          </FadeText>
        ) : undefined
      }
      trailing={trailing}
    >
      <ProvenanceGrid
        values={[
          ["Tool", data.toolName],
          ["Tool call ID", data.toolCallId],
          ["Status", status],
        ]}
      />
      {data.input === undefined ? (
        <EmptySection label="Input">No input was supplied.</EmptySection>
      ) : (
        <StructuredPayload label="Input" value={data.input} />
      )}
      {data.diff !== undefined && (
        <section className="tool-card__section">
          <SectionHeader
            title={data.patch === data.diff ? "Changes" : "Diff"}
            meta={formatLineCount(diffLines.length)}
            copyText={data.diff}
          />
          <DiffPayload text={data.diff} lines={diffLines} />
        </section>
      )}
      {data.patch !== undefined && data.patch !== data.diff && (
        <section className="tool-card__section">
          <SectionHeader
            title="Patch"
            meta={formatLineCount(patchLines.length)}
            copyText={data.patch}
          />
          <DiffPayload text={data.patch} lines={patchLines} />
        </section>
      )}
      {outputLines.length > 0 ? (
        <VirtualizedOutput text={data.outputText} />
      ) : (
        <EmptySection label="Output">The tool returned no text output.</EmptySection>
      )}
      {data.outputImages && <ImageArtifacts images={data.outputImages} />}
      {hasDistinctResultContent && (
        <StructuredPayload label="Result content" value={data.resultContent} />
      )}
      {data.resultDetails !== undefined && (
        <StructuredPayload label="Result metadata" value={data.resultDetails} />
      )}
      {data.resultMetadata !== undefined && (
        <StructuredPayload label="Result fields" value={data.resultMetadata} />
      )}
    </ToolCardShell>
  );
});

const ErrorBlock = memo(function ErrorBlock({
  data,
}: { data: ErrorBlockData }): React.ReactElement {
  return (
    <div className="transcript-block transcript-block--error" role="alert">
      <span className="transcript-block__error-icon" aria-hidden="true">
        ⚠
      </span>
      <div className="transcript-block__error-body">
        <span className="transcript-block__error-title">Model response failed</span>
        <span className="transcript-block__error-message">{data.message}</span>
      </div>
    </div>
  );
});

const BashBlock = memo(function BashBlock({
  data,
  preserveScroll,
}: {
  data: BashBlockData;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const outputLines = useMemo(() => splitOutputLines(data.outputText), [data.outputText]);
  const isError = data.exitCode != null && data.exitCode !== 0;
  const wasInterrupted = !!data.interrupted || !!data.cancelled;
  const { open, toggle } = useCardDisclosure(preserveScroll);
  const status = data.isStreaming
    ? "running"
    : isError
      ? `exited with code ${data.exitCode}`
      : wasInterrupted
        ? "interrupted"
        : "complete";

  const trailing =
    outputLines.length > 0 || data.isStreaming || isError || wasInterrupted || data.truncated ? (
      <>
        {outputLines.length > 0 && (
          <span className="tool-card__summary-meta">{formatLineCount(outputLines.length)}</span>
        )}
        {data.isStreaming && <Spinner className="tool-card__spinner" />}
        {isError && <span className="tool-card__badge">exit {data.exitCode}</span>}
        {wasInterrupted && !isError && (
          <span className="tool-card__badge tool-card__badge--interrupted">interrupted</span>
        )}
        {data.truncated && !isError && !wasInterrupted && (
          <span className="tool-card__badge tool-card__badge--neutral">truncated</span>
        )}
      </>
    ) : undefined;

  return (
    <ToolCardShell
      isError={isError}
      open={open}
      onToggle={toggle}
      accessibleLabel="shell command"
      accessibleSummary={
        [
          firstNonEmptyLine(data.command),
          outputLines.length > 0 ? formatLineCount(outputLines.length) : null,
          data.isStreaming ? "running" : null,
          isError ? `exit ${data.exitCode}` : null,
          wasInterrupted && !isError ? "interrupted" : null,
          data.truncated && !isError && !wasInterrupted ? "truncated" : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      kind={<span className="tool-card__name tool-card__name--bash">$</span>}
      subject={
        <FadeText className="tool-card__subject tool-card__subject--command" title={data.command}>
          {data.command}
        </FadeText>
      }
      trailing={trailing}
    >
      <ProvenanceGrid
        values={[
          ["Kind", "Direct shell command"],
          ["Status", status],
          ...(data.timestamp !== undefined
            ? [["Timestamp", data.timestamp] as [string, React.ReactNode]]
            : []),
        ]}
      />
      <StructuredPayload label="Command" value={data.command} />
      {outputLines.length > 0 ? (
        <VirtualizedOutput text={data.outputText} />
      ) : (
        <EmptySection label="Output">The command produced no output.</EmptySection>
      )}
      {(data.truncated ||
        data.fullOutputPath !== undefined ||
        data.excludeFromContext !== undefined ||
        data.cancelled !== undefined) && (
        <StructuredPayload
          label="Execution metadata"
          value={{
            cancelled: data.cancelled ?? false,
            truncated: data.truncated ?? false,
            fullOutputPath: data.fullOutputPath ?? null,
            excludeFromContext: data.excludeFromContext ?? false,
            timestamp: data.timestamp ?? null,
          }}
        />
      )}
    </ToolCardShell>
  );
});

interface ActivityCardProps {
  label: string;
  subject: string | null;
  content?: string | undefined;
  badge?: string | undefined;
  isError?: boolean | undefined;
  metadata?: unknown;
  images?: string[] | undefined;
  additionalContent?: React.ReactNode;
  preserveScroll: (mutate: () => void) => void;
}

const ActivityCard = memo(function ActivityCard({
  label,
  subject,
  content,
  badge,
  isError = false,
  metadata,
  images,
  additionalContent,
  preserveScroll,
}: ActivityCardProps): React.ReactElement {
  const text = content ?? "";
  const hasRetainedContent = content !== undefined;
  const whitespaceOnly = hasRetainedContent && text.trim().length === 0;
  const { open, toggle } = useCardDisclosure(preserveScroll);
  const largeContent =
    text.length >= LARGE_STRUCTURED_TEXT_CHARS || splitOutputLines(text).length >= LARGE_DIFF_LINES;

  return (
    <ToolCardShell
      isError={isError}
      open={open}
      onToggle={toggle}
      accessibleLabel={`${label} activity`}
      accessibleSummary={[subject, badge].filter(Boolean).join(" · ") || undefined}
      kind={<span className="tool-card__name">{label}</span>}
      subject={subject ? <FadeText className="tool-card__subject">{subject}</FadeText> : undefined}
      trailing={badge ? <span className="tool-card__badge">{badge}</span> : undefined}
    >
      {hasRetainedContent ? (
        <section className="tool-card__section">
          <SectionHeader
            title={label === "context" ? "Summary" : "Message"}
            meta={formatCharCount(text.length)}
            copyText={text}
          />
          {largeContent ? (
            <textarea
              className="tool-card__large-payload"
              aria-label="Complete activity message"
              readOnly
              value={text}
            />
          ) : whitespaceOnly ? (
            <ToolScrollWell label="Complete activity message">
              <pre className="tool-card__structured-value activity-card__raw">{text}</pre>
            </ToolScrollWell>
          ) : (
            <ToolScrollWell label="Complete activity message">
              <div className="transcript-block__content activity-card__markdown markdown-body">
                <Markdown>{text}</Markdown>
              </div>
            </ToolScrollWell>
          )}
        </section>
      ) : (
        <EmptySection label="Message">No message content was retained.</EmptySection>
      )}
      {images && <ImageArtifacts images={images} label="Message images" />}
      {metadata !== undefined && <StructuredPayload label="Metadata" value={metadata} />}
      {additionalContent}
    </ToolCardShell>
  );
});

const CompactionBlock = memo(function CompactionBlock({
  data,
  preserveScroll,
}: {
  data: CompactionBlockData;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const tokens = typeof data.tokensBefore === "number" ? data.tokensBefore.toLocaleString() : null;
  const estimatedTokensAfter =
    typeof data.estimatedTokensAfter === "number"
      ? data.estimatedTokensAfter.toLocaleString()
      : null;
  const reason = data.reason ? data.reason : null;
  const badge = data.aborted ? "aborted" : data.errorMessage ? "error" : undefined;
  const outcome = data.errorMessage
    ? "Compaction failed"
    : data.aborted
      ? "Compaction aborted"
      : "Context compacted";
  const subjectParts = [
    outcome,
    reason,
    tokens ? `${tokens} tokens summarized` : null,
    estimatedTokensAfter ? `≈${estimatedTokensAfter} tokens after` : null,
  ];
  const subject = subjectParts.filter(Boolean).join(" · ");
  const content = data.errorMessage ? data.errorMessage : data.summary;
  const metadata = {
    reason: data.reason ?? null,
    tokensBefore: data.tokensBefore ?? null,
    estimatedTokensAfter: data.estimatedTokensAfter ?? null,
    firstKeptEntryId: data.firstKeptEntryId ?? null,
    aborted: data.aborted ?? false,
    willRetry: data.willRetry ?? false,
    fromHook: data.fromHook ?? false,
    ...(data.details !== undefined ? { details: data.details } : {}),
  };

  return (
    <ActivityCard
      label="context"
      subject={subject}
      content={content}
      badge={badge ?? undefined}
      isError={!!data.errorMessage}
      metadata={metadata}
      preserveScroll={preserveScroll}
    />
  );
});

const BranchSummaryBlock = memo(function BranchSummaryBlock({
  data,
  preserveScroll,
}: {
  data: BranchSummaryBlockData;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const subject = data.fromId ? `Branch summarized · from ${data.fromId}` : "Branch summarized";
  return (
    <ActivityCard
      label="branch"
      subject={subject}
      content={data.summary}
      metadata={{
        fromId: data.fromId ?? null,
        fromHook: data.fromHook ?? false,
        ...(data.details !== undefined ? { details: data.details } : {}),
      }}
      preserveScroll={preserveScroll}
    />
  );
});

const CustomMessageBlock = memo(function CustomMessageBlock({
  sessionId,
  data,
  preserveScroll,
}: {
  sessionId: SessionId;
  data: CustomMessageBlockData;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const contentSummary = summarizeActivityContent(data.content);
  const subject = [data.customType, contentSummary].filter(Boolean).join(" · ") || null;
  const canRenderExtension =
    !!data.customType && typeof data.timestamp === "number" && Number.isFinite(data.timestamp);
  const hasDistinctRawContent =
    Object.hasOwn(data, "rawContent") &&
    !(typeof data.rawContent === "string" && data.rawContent === data.content);
  return (
    <ActivityCard
      label={data.customType ? "extension" : "notice"}
      subject={subject}
      content={data.content}
      images={data.images}
      metadata={{
        customType: data.customType ?? null,
        timestamp: data.timestamp ?? null,
        ...(data.details !== undefined ? { details: data.details } : {}),
      }}
      additionalContent={
        hasDistinctRawContent || canRenderExtension ? (
          <>
            {hasDistinctRawContent && (
              <StructuredPayload label="Raw content" value={data.rawContent} />
            )}
            {canRenderExtension && (
              <ExtensionMessageRender
                sessionId={sessionId}
                customType={data.customType as string}
                timestamp={data.timestamp as number}
              />
            )}
          </>
        ) : undefined
      }
      preserveScroll={preserveScroll}
    />
  );
});

type RenderedEntry = { rendered: boolean; ansi?: string; error?: boolean };

type CustomEntryMeasurement = {
  host: HTMLDivElement;
  content?: HTMLPreElement | undefined;
  measurementBox: HTMLSpanElement;
  probe: HTMLSpanElement;
  applyColumns: (columns: number) => void;
};

// Custom-entry renderers receive terminal columns and are allowed to decline a
// width. Hidden entries must therefore get one real pane-width query too. Batch
// every geometry read before any setState callback so a history containing many
// custom entries cannot recreate per-entry layout thrashing.
const pendingCustomEntryMeasurements = new Map<HTMLDivElement, CustomEntryMeasurement>();
let customEntryMeasurementFrame: number | undefined;

function flushCustomEntryMeasurements(): void {
  customEntryMeasurementFrame = undefined;
  const targets = [...pendingCustomEntryMeasurements.values()];
  pendingCustomEntryMeasurements.clear();
  const measured = targets.flatMap((target) => {
    const widthElement = target.content ?? target.host.closest<HTMLElement>(".transcript-blocks");
    const contentWidth = target.content
      ? target.content.clientWidth
      : (widthElement?.getBoundingClientRect().width ?? target.host.getBoundingClientRect().width);
    const style = getComputedStyle(target.content ?? target.measurementBox);
    const horizontalPadding =
      (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const glyphWidth = target.probe.getBoundingClientRect().width / 10;
    const availableWidth = Math.max(0, contentWidth - horizontalPadding);
    if (availableWidth <= 0 || glyphWidth <= 0) return [];
    return [
      {
        applyColumns: target.applyColumns,
        columns: Math.max(20, Math.min(240, Math.floor(availableWidth / glyphWidth))),
      },
    ];
  });
  for (const { applyColumns, columns } of measured) applyColumns(columns);
}

function queueCustomEntryMeasurement(measurement: CustomEntryMeasurement): void {
  pendingCustomEntryMeasurements.set(measurement.host, measurement);
  if (customEntryMeasurementFrame !== undefined) return;
  if (typeof requestAnimationFrame === "function") {
    customEntryMeasurementFrame = requestAnimationFrame(flushCustomEntryMeasurements);
  } else {
    customEntryMeasurementFrame = -1;
    queueMicrotask(flushCustomEntryMeasurements);
  }
}

function cancelCustomEntryMeasurement(host: HTMLDivElement): void {
  pendingCustomEntryMeasurements.delete(host);
}

const customEntryResizeCallbacks = new Map<Element, Set<() => void>>();
let customEntryResizeObserver: ResizeObserver | undefined;

function observeCustomEntryResize(element: Element | null, callback: () => void): () => void {
  if (!element || typeof ResizeObserver === "undefined") return () => {};
  customEntryResizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      for (const listener of customEntryResizeCallbacks.get(entry.target) ?? []) listener();
    }
  });
  const callbacks = customEntryResizeCallbacks.get(element) ?? new Set<() => void>();
  callbacks.add(callback);
  customEntryResizeCallbacks.set(element, callbacks);
  customEntryResizeObserver.observe(element);
  return () => {
    const current = customEntryResizeCallbacks.get(element);
    current?.delete(callback);
    if (current && current.size === 0) {
      customEntryResizeCallbacks.delete(element);
      customEntryResizeObserver?.unobserve(element);
    }
    if (customEntryResizeCallbacks.size === 0) {
      customEntryResizeObserver?.disconnect();
      customEntryResizeObserver = undefined;
    }
  };
}

const ExtensionMessageRender = memo(function ExtensionMessageRender({
  sessionId,
  customType,
  timestamp,
}: {
  sessionId: SessionId;
  customType: string;
  timestamp: number;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(100);
  const [rendered, setRendered] = useState<RenderedEntry>();
  const hostInstanceId = useSessionsStore(
    (state) => authoritySnapshotFor(state.sessions.get(sessionId))?.owner.hostInstanceId,
  );
  const sessionEpoch =
    useSessionsStore(
      (state) => authoritySnapshotFor(state.sessions.get(sessionId))?.owner.sessionEpoch,
    ) ?? 0;
  const runtime = useMemo(
    () => (hostInstanceId ? { hostInstanceId, sessionEpoch } : undefined),
    [hostInstanceId, sessionEpoch],
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const update = (): void => {
      const width = host.getBoundingClientRect().width;
      if (width <= 0) return;
      const next = Math.max(20, Math.min(240, Math.floor(width / 8)));
      setCols((current) => (current === next ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!runtime) {
      setRendered(undefined);
      return;
    }
    const session = useSessionsStore.getState().sessions.get(sessionId);
    const semantic = session?.authorityProjection?.semantic;
    const cursor =
      semantic?.state === "following" &&
      semantic.cursor.hostInstanceId === runtime.hostInstanceId &&
      semantic.cursor.sessionEpoch === runtime.sessionEpoch
        ? semantic.cursor
        : undefined;
    void querySession(
      sessionId,
      { type: "render_message", customType, timestamp, cols, expanded: true },
      { owner: runtime, ...(cursor ? { cursor } : {}) },
    )
      .then((result) => {
        if (
          cancelled ||
          result.status !== "ok" ||
          result.owner.hostInstanceId !== runtime.hostInstanceId ||
          result.owner.sessionEpoch !== runtime.sessionEpoch ||
          !sessionMatchesRuntime(useSessionsStore.getState().sessions.get(sessionId), runtime)
        )
          return;
        const next = result.response.success
          ? (result.response.data as RenderedEntry | undefined)
          : undefined;
        setRendered(next && typeof next.rendered === "boolean" ? next : undefined);
      })
      .catch(() => {
        if (
          !cancelled &&
          sessionMatchesRuntime(useSessionsStore.getState().sessions.get(sessionId), runtime)
        ) {
          setRendered(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cols, customType, runtime, sessionId, timestamp]);

  return (
    <div ref={hostRef} className="tool-card__extension-host">
      {rendered?.rendered && (
        <section className="tool-card__section">
          <SectionHeader
            title="Extension view"
            meta={rendered.error ? "renderer error" : "custom rendering"}
            copyText={rendered.ansi ?? ""}
          />
          <pre
            className={`tool-card__extension-render${rendered.error ? " tool-card__extension-render--error" : ""}`}
          >
            <AnsiText text={rendered.ansi ?? ""} />
          </pre>
        </section>
      )}
    </div>
  );
});

const CustomEntryBlock = memo(function CustomEntryBlock({
  sessionId,
  data,
  preserveScroll,
}: {
  sessionId: SessionId;
  data: CustomEntryBlockData;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  // Select primitive owner fields rather than snapshot.owner itself: every
  // authority frame carries a fresh object, and a read-only render_entry query
  // can itself publish a frame. Depending on that object/cursor creates a
  // query → frame → query feedback loop that eventually fences the host.
  const hostInstanceId = useSessionsStore(
    (state) => authoritySnapshotFor(state.sessions.get(sessionId))?.owner.hostInstanceId,
  );
  const sessionEpoch =
    useSessionsStore(
      (state) => authoritySnapshotFor(state.sessions.get(sessionId))?.owner.sessionEpoch,
    ) ?? 0;
  const runtime = useMemo(
    () => (hostInstanceId ? { hostInstanceId, sessionEpoch } : undefined),
    [hostInstanceId, sessionEpoch],
  );
  const renderedEpochRef = useRef(sessionEpoch);
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  const measurementBoxRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [cols, setCols] = useState(80);
  const [expanded, setExpanded] = useState(false);
  const [rendered, setRendered] = useState<RenderedEntry>();

  const rendererVisible = rendered?.rendered === true;
  const renderedContentVisible = rendererVisible && expanded;

  useLayoutEffect(() => {
    const host = hostRef.current;
    const measurementBox = measurementBoxRef.current;
    const probe = measureRef.current;
    if (!host || !measurementBox || !probe) return;
    const scheduleMeasure = (): void => {
      queueCustomEntryMeasurement({
        host,
        content: renderedContentVisible ? (contentRef.current ?? undefined) : undefined,
        measurementBox,
        probe,
        applyColumns: (next) => setCols((current) => (current === next ? current : next)),
      });
    };
    // The first real-width query is required even when the 80-column probe was
    // declined. Shared observation keeps hidden entries width-responsive later
    // without installing one ResizeObserver per transcript item.
    scheduleMeasure();
    const stopFeedObservation = observeCustomEntryResize(
      host.closest(".transcript-blocks"),
      scheduleMeasure,
    );
    const stopProbeObservation = observeCustomEntryResize(probe, scheduleMeasure);
    const stopContentObservation = observeCustomEntryResize(contentRef.current, scheduleMeasure);
    return () => {
      stopFeedObservation();
      stopProbeObservation();
      stopContentObservation();
      cancelCustomEntryMeasurement(host);
    };
  }, [renderedContentVisible]);

  useEffect(() => {
    renderedEpochRef.current = sessionEpoch;
    setRendered(undefined);
  }, [sessionEpoch]);

  useEffect(() => {
    let cancelled = false;
    if (!runtime) {
      setRendered(undefined);
      return;
    }
    const session = useSessionsStore.getState().sessions.get(sessionId);
    const semantic = session?.authorityProjection?.semantic;
    const cursor =
      semantic?.state === "following" &&
      semantic.cursor.hostInstanceId === runtime.hostInstanceId &&
      semantic.cursor.sessionEpoch === runtime.sessionEpoch
        ? semantic.cursor
        : undefined;
    const observation = { owner: runtime, ...(cursor ? { cursor } : {}) };
    void querySession(
      sessionId,
      {
        type: "render_entry",
        entryId: data.entryId,
        cols,
        expanded,
      },
      observation,
    )
      .then((result) => {
        if (
          result.status !== "ok" ||
          cancelled ||
          renderedEpochRef.current !== sessionEpoch ||
          result.owner.hostInstanceId !== runtime.hostInstanceId ||
          result.owner.sessionEpoch !== runtime.sessionEpoch ||
          !sessionMatchesRuntime(useSessionsStore.getState().sessions.get(sessionId), runtime)
        )
          return;
        const rendered = result.response.success
          ? (result.response.data as RenderedEntry | undefined)
          : undefined;
        setRendered(rendered && typeof rendered.rendered === "boolean" ? rendered : undefined);
      })
      .catch(() => {
        if (
          cancelled ||
          renderedEpochRef.current !== sessionEpoch ||
          !sessionMatchesRuntime(useSessionsStore.getState().sessions.get(sessionId), runtime)
        )
          return;
        // Match Pi: entries whose extension renderer is unavailable stay hidden.
        setRendered(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, data.entryId, cols, expanded, sessionEpoch, runtime]);

  const toggle = useCallback(
    () => preserveScroll(() => setExpanded((value) => !value)),
    [preserveScroll],
  );

  return (
    <div ref={hostRef} className={`custom-entry${rendererVisible ? " custom-entry--visible" : ""}`}>
      <span ref={measurementBoxRef} className="custom-entry__measurement-box" aria-hidden="true">
        <span ref={measureRef} className="custom-entry__measure">
          0000000000
        </span>
      </span>
      {rendererVisible && (
        <ToolCardShell
          isError={!!rendered.error}
          open={expanded}
          onToggle={toggle}
          accessibleLabel={`${data.customType} extension entry`}
          kind={<span className="tool-card__name">extension</span>}
          subject={<FadeText className="tool-card__subject">{data.customType}</FadeText>}
          trailing={
            rendered.error ? <span className="tool-card__badge">renderer error</span> : undefined
          }
        >
          <ProvenanceGrid
            values={[
              ["Custom type", data.customType],
              ["Entry ID", data.entryId],
            ]}
          />
          <section className="tool-card__section">
            <SectionHeader
              title="Extension view"
              meta={rendered.error ? "renderer error" : "custom rendering"}
              copyText={rendered.ansi ?? ""}
            />
            <pre
              ref={contentRef}
              className={`tool-card__extension-render${rendered.error ? " tool-card__extension-render--error" : ""}`}
            >
              <AnsiText text={rendered.ansi ?? ""} />
            </pre>
          </section>
          {data.data === undefined ? (
            <EmptySection label="Raw data">No raw entry data was retained.</EmptySection>
          ) : (
            <StructuredPayload label="Raw data" value={data.data} />
          )}
        </ToolCardShell>
      )}
    </div>
  );
});

type TranscriptRenderItem =
  | { kind: "block"; block: TypedTranscriptBlock }
  | {
      kind: "assistant_segment";
      blockId: string;
      segment: AssistantSegment;
      segmentIndex: number;
      isStreaming: boolean;
    };

interface CompactGroupStats {
  hasThinking: boolean;
  toolCalls: number;
  compactions: number;
  branchSummaries: number;
  notices: number;
  errors: number;
  interrupted: number;
}

type CompactRenderItem =
  | { kind: "item"; item: TranscriptRenderItem }
  | {
      kind: "compact_group";
      key: string;
      items: TranscriptRenderItem[];
      stats: CompactGroupStats;
      summary: string;
      streaming: boolean;
    };

type CompactGroupRenderItem = Extract<CompactRenderItem, { kind: "compact_group" }>;

function renderItemKey(item: TranscriptRenderItem): string {
  return item.kind === "block" ? item.block.id : `${item.blockId}-segment-${item.segmentIndex}`;
}

function renderItemStreaming(item: TranscriptRenderItem): boolean {
  if (item.kind === "assistant_segment") return item.isStreaming;
  switch (item.block.type) {
    case "assistant":
      return item.block.data.isStreaming;
    case "tool_call":
      return item.block.data.isStreaming;
    case "bash":
      return item.block.data.isStreaming;
    default:
      return false;
  }
}

function compactGroupStats(items: readonly TranscriptRenderItem[]): CompactGroupStats {
  const stats: CompactGroupStats = {
    hasThinking: false,
    toolCalls: 0,
    compactions: 0,
    branchSummaries: 0,
    notices: 0,
    errors: 0,
    interrupted: 0,
  };
  for (const item of items) {
    if (item.kind === "assistant_segment") {
      if (item.segment.kind === "thinking") stats.hasThinking = true;
      continue;
    }
    switch (item.block.type) {
      case "tool_call":
        stats.toolCalls += 1;
        if (item.block.data.isError) stats.errors += 1;
        if (item.block.data.interrupted) stats.interrupted += 1;
        break;
      case "bash":
        stats.toolCalls += 1;
        if (item.block.data.exitCode != null && item.block.data.exitCode !== 0) stats.errors += 1;
        if (item.block.data.interrupted || item.block.data.cancelled) stats.interrupted += 1;
        break;
      case "compaction":
        stats.compactions += 1;
        if (item.block.data.errorMessage) stats.errors += 1;
        if (item.block.data.aborted) stats.interrupted += 1;
        break;
      case "branch_summary":
        stats.branchSummaries += 1;
        break;
      case "custom_message":
        stats.notices += 1;
        break;
      case "error":
        stats.errors += 1;
        break;
      default:
        break;
    }
  }
  return stats;
}

function mergeCompactGroupStats(
  archived: CompactGroupStats,
  live: CompactGroupStats | undefined,
): CompactGroupStats {
  if (!live) return archived;
  return {
    hasThinking: archived.hasThinking || live.hasThinking,
    toolCalls: archived.toolCalls + live.toolCalls,
    compactions: archived.compactions + live.compactions,
    branchSummaries: archived.branchSummaries + live.branchSummaries,
    notices: archived.notices + live.notices,
    errors: archived.errors + live.errors,
    interrupted: archived.interrupted + live.interrupted,
  };
}

function summarizeCompactGroup(stats: CompactGroupStats): string {
  const parts: string[] = [];
  if (stats.hasThinking) parts.push("Thinking");
  if (stats.toolCalls > 0)
    parts.push(`${stats.toolCalls.toLocaleString()} tool call${stats.toolCalls === 1 ? "" : "s"}`);
  if (stats.compactions > 0)
    parts.push(
      `${stats.compactions.toLocaleString()} compaction${stats.compactions === 1 ? "" : "s"}`,
    );
  if (stats.branchSummaries > 0)
    parts.push(
      `${stats.branchSummaries.toLocaleString()} branch ${stats.branchSummaries === 1 ? "summary" : "summaries"}`,
    );
  if (stats.notices > 0)
    parts.push(`${stats.notices.toLocaleString()} notice${stats.notices === 1 ? "" : "s"}`);
  if (stats.errors > 0)
    parts.push(`${stats.errors.toLocaleString()} ${stats.errors === 1 ? "error" : "errors"}`);
  if (stats.interrupted > 0)
    parts.push(
      `${stats.interrupted.toLocaleString()} interrupted ${stats.interrupted === 1 ? "item" : "items"}`,
    );
  return parts.length > 0 ? parts.join(", ") : "Activity";
}

function buildCompactRenderItems(
  blocks: readonly TypedTranscriptBlock[],
  showWorking: boolean,
): CompactRenderItem[] {
  const rendered: CompactRenderItem[] = [];
  let group: TranscriptRenderItem[] = [];

  const flushGroup = (final = false): void => {
    const first = group[0];
    if (!first) return;
    const firstKey = renderItemKey(first);
    const streaming = final && (group.some(renderItemStreaming) || showWorking);
    const stats = compactGroupStats(group);
    rendered.push({
      kind: "compact_group",
      key: `compact-${firstKey}`,
      items: group,
      stats,
      summary: summarizeCompactGroup(stats),
      streaming,
    });
    group = [];
  };

  for (const block of blocks) {
    if (block.type === "assistant") {
      block.data.segments.forEach((segment, segmentIndex) => {
        if (!segment.content) return;
        const item: TranscriptRenderItem = {
          kind: "assistant_segment",
          blockId: block.id,
          segment,
          segmentIndex,
          isStreaming: block.data.isStreaming,
        };
        if (segment.kind === "text") {
          flushGroup();
          rendered.push({ kind: "item", item });
        } else {
          group.push(item);
        }
      });
      continue;
    }

    const item: TranscriptRenderItem = { kind: "block", block };
    if (
      block.type === "user" ||
      block.type === "custom_entry" ||
      (block.type === "error" && !block.data.retryable)
    ) {
      // Custom entries must mount before we know whether Pi's renderer accepts
      // them. Keep them outside collapsed compact groups so an unrendered
      // extension persistence record cannot create a visible group summary.
      flushGroup();
      rendered.push({ kind: "item", item });
    } else {
      group.push(item);
    }
  }

  flushGroup(true);
  return rendered;
}

function TranscriptItemView({
  sessionId,
  item,
  preserveScroll,
}: {
  sessionId: SessionId;
  item: TranscriptRenderItem;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement | null {
  if (item.kind === "assistant_segment") {
    return (
      <AssistantBlock
        data={{ role: "assistant", segments: [item.segment], isStreaming: item.isStreaming }}
      />
    );
  }

  const { block } = item;
  switch (block.type) {
    case "user":
      return <UserBlock data={block.data} />;
    case "assistant":
      if (!hasAssistantContent(block.data)) return null;
      return <AssistantBlock data={block.data} />;
    case "tool_call":
      return <ToolCallBlock data={block.data} preserveScroll={preserveScroll} />;
    case "bash":
      return <BashBlock data={block.data} preserveScroll={preserveScroll} />;
    case "compaction":
      return <CompactionBlock data={block.data} preserveScroll={preserveScroll} />;
    case "branch_summary":
      return <BranchSummaryBlock data={block.data} preserveScroll={preserveScroll} />;
    case "custom_message":
      return (
        <CustomMessageBlock
          sessionId={sessionId}
          data={block.data}
          preserveScroll={preserveScroll}
        />
      );
    case "custom_entry":
      return (
        <CustomEntryBlock sessionId={sessionId} data={block.data} preserveScroll={preserveScroll} />
      );
    case "error":
      return <ErrorBlock data={block.data} />;
    default:
      return null;
  }
}

const EMPTY_COMPACT_GROUP_ITEMS: TranscriptRenderItem[] = [];
const EMPTY_COMPACT_RENDER_ITEMS: CompactRenderItem[] = [];

// Bound both archive presentation commits and the child-card commits inside
// an expanded compact group. A compact group can represent thousands of
// archived blocks while remaining a single transcript disclosure, so counting
// only the outer render item would otherwise bypass cooperative mounting.
const TRANSCRIPT_RENDER_BATCH_SIZE = 100;

// The archive/live boundary group keeps its archived portion behind this memo
// boundary. Live streaming can update the disclosure summary and live items
// without mapping or reconciling the potentially large archived activity run.
const CompactTranscriptGroupItems = memo(function CompactTranscriptGroupItems({
  sessionId,
  items,
  source,
  preserveScroll,
}: {
  sessionId: SessionId;
  items: TranscriptRenderItem[];
  source: "archived" | "live" | "group";
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const [visibleItemCount, setVisibleItemCount] = useState(() =>
    Math.min(items.length, TRANSCRIPT_RENDER_BATCH_SIZE),
  );
  const effectiveVisibleItemCount = Math.min(visibleItemCount, items.length);

  useEffect(() => {
    if (visibleItemCount > items.length) {
      setVisibleItemCount(items.length);
      return;
    }
    if (visibleItemCount >= items.length) return;
    const frame = requestAnimationFrame(() => {
      setVisibleItemCount((current) =>
        Math.min(items.length, current + TRANSCRIPT_RENDER_BATCH_SIZE),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [items.length, visibleItemCount]);

  // Render tests install this dev-only probe to enforce both the archive memo
  // invariant and the bounded child-mount invariant while a disclosure is
  // open. Production builds erase the branch, and normal development has no
  // hook installed.
  if (import.meta.env.DEV) {
    const hook = (
      window as unknown as {
        __pivisTestCompactGroupItemsRender?:
          | ((detail: {
              source: "archived" | "live" | "group";
              itemCount: number;
              visibleItemCount: number;
            }) => void)
          | undefined;
      }
    ).__pivisTestCompactGroupItemsRender;
    hook?.({ source, itemCount: items.length, visibleItemCount: effectiveVisibleItemCount });
  }
  return (
    <>
      {items.slice(0, effectiveVisibleItemCount).map((item) => (
        <TranscriptItemView
          key={renderItemKey(item)}
          sessionId={sessionId}
          item={item}
          preserveScroll={preserveScroll}
        />
      ))}
    </>
  );
});

const CompactTranscriptGroup = memo(function CompactTranscriptGroup({
  sessionId,
  archivedItems = EMPTY_COMPACT_GROUP_ITEMS,
  items,
  summary,
  streaming,
  preserveScroll,
}: {
  sessionId: SessionId;
  archivedItems?: TranscriptRenderItem[] | undefined;
  items: TranscriptRenderItem[];
  summary: string;
  streaming: boolean;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const { open, toggle } = useCardDisclosure(preserveScroll);
  const contentId = useId();

  return (
    <div
      className={`compact-transcript-group${open ? " compact-transcript-group--open" : ""}`}
      aria-busy={streaming || undefined}
    >
      <button
        type="button"
        className="compact-transcript-group__summary"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <IconChevronRight className="compact-transcript-group__chevron" />
        <span>{summary}</span>
      </button>
      {open && (
        <div id={contentId} className="compact-transcript-group__content">
          {archivedItems.length > 0 && (
            <CompactTranscriptGroupItems
              sessionId={sessionId}
              items={archivedItems}
              source="archived"
              preserveScroll={preserveScroll}
            />
          )}
          {items.length > 0 && (
            <CompactTranscriptGroupItems
              sessionId={sessionId}
              items={items}
              source={archivedItems.length > 0 ? "live" : "group"}
              preserveScroll={preserveScroll}
            />
          )}
        </div>
      )}
    </div>
  );
});

interface ArchiveScrollSnapshot {
  scrollHeight: number;
  scrollTop: number;
  pinned: boolean;
}

interface ArchivedTranscriptProps {
  blocks: TypedTranscriptBlock[];
  compactItems: CompactRenderItem[];
  style: TranscriptStyle;
  sessionId: SessionId;
  preserveScroll: (mutate: () => void) => void;
  capturePrependScroll: () => ArchiveScrollSnapshot | undefined;
  restorePrependScroll: (snapshot: ArchiveScrollSnapshot) => void;
}

// Mount complete history cooperatively. This is presentation chunking, not
// history pagination: every block is already in renderer state and all chunks
// are mounted automatically. Keeping each commit bounded prevents one large
// React/DOM/layout task from freezing the renderer.
function chunkArchiveItems<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += TRANSCRIPT_RENDER_BATCH_SIZE) {
    chunks.push(items.slice(start, start + TRANSCRIPT_RENDER_BATCH_SIZE));
  }
  return chunks;
}

const ArchivedVerboseChunk = memo(function ArchivedVerboseChunk({
  blocks,
  sessionId,
  preserveScroll,
}: {
  blocks: TypedTranscriptBlock[];
  sessionId: SessionId;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  return (
    <div className="transcript-archive-chunk">
      {blocks.map((block) => (
        <TranscriptItemView
          key={block.id}
          sessionId={sessionId}
          item={{ kind: "block", block }}
          preserveScroll={preserveScroll}
        />
      ))}
    </div>
  );
});

const ArchivedCompactChunk = memo(function ArchivedCompactChunk({
  items,
  sessionId,
  preserveScroll,
}: {
  items: CompactRenderItem[];
  sessionId: SessionId;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  return (
    <div className="transcript-archive-chunk">
      {items.map((item) =>
        item.kind === "item" ? (
          <TranscriptItemView
            key={renderItemKey(item.item)}
            sessionId={sessionId}
            item={item.item}
            preserveScroll={preserveScroll}
          />
        ) : (
          <CompactTranscriptGroup
            key={item.key}
            sessionId={sessionId}
            items={item.items}
            summary={item.summary}
            streaming={item.streaming}
            preserveScroll={preserveScroll}
          />
        ),
      )}
    </div>
  );
});

// This memo boundary is the archive's streaming-performance invariant. Its
// derived props change only for history/compaction, so live-tail tokens do not
// reconcile, flatten, or map historical render items.
const ArchivedTranscript = memo(function ArchivedTranscript({
  blocks,
  compactItems,
  style,
  sessionId,
  preserveScroll,
  capturePrependScroll,
  restorePrependScroll,
}: ArchivedTranscriptProps): React.ReactElement {
  const verboseChunks = useMemo(() => chunkArchiveItems(blocks), [blocks]);
  const compactChunks = useMemo(() => chunkArchiveItems(compactItems), [compactItems]);
  const chunks = style === "compact" ? compactChunks : verboseChunks;
  const [visibleStart, setVisibleStart] = useState(() => Math.max(0, chunks.length - 1));
  const prependSnapshotRef = useRef<ArchiveScrollSnapshot | undefined>(undefined);
  const effectiveStart = Math.min(visibleStart, chunks.length);

  useEffect(() => {
    if (effectiveStart === 0) return;
    const frame = requestAnimationFrame(() => {
      prependSnapshotRef.current = capturePrependScroll();
      setVisibleStart((current) => Math.max(0, current - 1));
    });
    return () => cancelAnimationFrame(frame);
  }, [capturePrependScroll, effectiveStart]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleStart is the post-commit trigger for a snapshot captured before that state update.
  useLayoutEffect(() => {
    const snapshot = prependSnapshotRef.current;
    if (!snapshot) return;
    prependSnapshotRef.current = undefined;
    restorePrependScroll(snapshot);
  }, [restorePrependScroll, visibleStart]);

  return (
    <>
      {effectiveStart > 0 && (
        <div className="history-loading-row history-loading-row--earlier" role="status">
          <Spinner />
          <span>Loading earlier conversation…</span>
        </div>
      )}
      {style === "compact"
        ? compactChunks
            .slice(effectiveStart)
            .map((items) => (
              <ArchivedCompactChunk
                key={
                  items[0]?.kind === "item"
                    ? renderItemKey(items[0].item)
                    : (items[0]?.key ?? "empty")
                }
                items={items}
                sessionId={sessionId}
                preserveScroll={preserveScroll}
              />
            ))
        : verboseChunks
            .slice(effectiveStart)
            .map((chunkBlocks) => (
              <ArchivedVerboseChunk
                key={chunkBlocks[0]?.id ?? "empty"}
                blocks={chunkBlocks}
                sessionId={sessionId}
                preserveScroll={preserveScroll}
              />
            ))}
    </>
  );
});

const EMPTY_ARCHIVE_CHUNKS: TypedTranscriptBlock[][] = [];
const EMPTY_LIVE_BLOCKS: TypedTranscriptBlock[] = [];

// ── Main view ────────────────────────────────────────────────────────────

interface TranscriptViewProps {
  sessionId: SessionId;
}

export function TranscriptView({ sessionId }: TranscriptViewProps): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const transcriptStyle = useSettingsStore((s) => s.settings.transcriptStyle);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Single source of truth for "follow the bottom". Only a genuine
  // user scroll away from the bottom clears it; reaching the bottom
  // (by any means) sets it back. Compared against `lastPinnedTopRef`
  // rather than `scrollHeight` so a large content chunk arriving
  // between a programmatic pin and its lagging scroll-event echo is
  // not misread as the user scrolling up.
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinnedState] = useState(true);
  const setPinned = useCallback((next: boolean) => {
    pinnedRef.current = next;
    setIsPinnedState((current) => (current === next ? current : next));
  }, []);
  const lastPinnedTopRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  const prevClientHeightRef = useRef(0);
  const prevScrollTopRef = useRef(0);
  const disclosureAnchorRef = useRef<number | null>(null);
  const [scrollFades, setScrollFades] = useState({ top: false, bottom: false });

  const updateScrollFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = {
      top: el.scrollTop > SCROLL_BOTTOM_EPSILON_PX,
      bottom: distance > SCROLL_BOTTOM_EPSILON_PX,
    };
    setScrollFades((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
  }, []);

  // Programmatic pin helper. Always pin to the absolute bottom and record the
  // target so handleScroll can distinguish "we pinned" from "the user moved up
  // from where we were". Clamp to 0 for short transcripts — browsers clamp the
  // assignment anyway, but keeping our sentinel non-negative avoids false
  // comparisons after the viewport later shrinks into an overflowing feed.
  const pinToBottom = useCallback(() => {
    setPinned(true);
    const el = scrollRef.current;
    if (!el) return;
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - target) > SCROLL_BOTTOM_EPSILON_PX) el.scrollTop = target;
    lastPinnedTopRef.current = el.scrollTop;
    prevScrollHeightRef.current = el.scrollHeight;
    prevClientHeightRef.current = el.clientHeight;
    prevScrollTopRef.current = el.scrollTop;
    updateScrollFades();
  }, [setPinned, updateScrollFades]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_MS;
  }, []);

  // Disclosure actions are reading navigation, not streaming output. Anchor
  // the current viewport even when it was following the bottom so expanding a
  // card does not move the clicked header off-screen. Normal output deltas
  // retain bottom-follow behavior.
  const preserveScroll = useCallback(
    (mutate: () => void) => {
      const el = scrollRef.current;
      if (!el) {
        mutate();
        return;
      }
      const prevTop = el.scrollTop;
      disclosureAnchorRef.current = prevTop;
      setPinned(false);
      mutate();
    },
    [setPinned],
  );

  const capturePrependScroll = useCallback((): ArchiveScrollSnapshot | undefined => {
    const el = scrollRef.current;
    if (!el) return undefined;
    if (pinnedRef.current) return { scrollHeight: 0, scrollTop: 0, pinned: true };
    return {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      pinned: false,
    };
  }, []);

  const restorePrependScroll = useCallback(
    (snapshot: ArchiveScrollSnapshot): void => {
      const el = scrollRef.current;
      if (!el) return;
      if (snapshot.pinned) {
        pinToBottom();
        return;
      }
      // Older archive batches are inserted above the visible content. Preserve
      // the same reading anchor rather than jumping the viewport upward.
      const scrollHeight = el.scrollHeight;
      el.scrollTop = snapshot.scrollTop + (scrollHeight - snapshot.scrollHeight);
      prevScrollHeightRef.current = scrollHeight;
      prevClientHeightRef.current = el.clientHeight;
      prevScrollTopRef.current = el.scrollTop;
      updateScrollFades();
    },
    [pinToBottom, updateScrollFades],
  );

  const transcript = session?.transcript;
  const archivedChunks = transcript?.archivedBlockChunks ?? EMPTY_ARCHIVE_CHUNKS;
  const liveBlocks = transcript?.blocks ?? EMPTY_LIVE_BLOCKS;
  const totalBlockCount = transcript ? transcriptBlockCount(transcript) : 0;
  const showHistoryLoading = totalBlockCount === 0 && session?.historyHydrating === true;
  // Complete persisted/compacted history stays in immutable archive chunks,
  // while streaming changes only the live tail. Derive archive rendering once
  // per archive change so historical blocks are not revisited for every token.
  const archivedBlocks = useMemo(
    () =>
      archivedChunks.length === 1
        ? (archivedChunks[0] ?? EMPTY_LIVE_BLOCKS)
        : archivedChunks.flat(),
    [archivedChunks],
  );
  const archivedCompactItems = useMemo(
    () =>
      transcriptStyle === "compact"
        ? buildCompactRenderItems(archivedBlocks, false)
        : EMPTY_COMPACT_RENDER_ITEMS,
    [archivedBlocks, transcriptStyle],
  );
  // Keep a trailing archive activity group at the stable archive/live boundary.
  // It can absorb leading live activity without flattening or regrouping the
  // complete archive, and its disclosure state survives live-tail updates.
  const lastArchivedCompactItem = archivedCompactItems.at(-1);
  const archivedBoundaryGroup: CompactGroupRenderItem | undefined =
    lastArchivedCompactItem?.kind === "compact_group" ? lastArchivedCompactItem : undefined;
  const archivedCompactPrefix = useMemo(
    () => (archivedBoundaryGroup ? archivedCompactItems.slice(0, -1) : archivedCompactItems),
    [archivedBoundaryGroup, archivedCompactItems],
  );
  // Show the "Running for …" indicator for real agent work. Prompt-backed
  // extension UI can set isStreaming while merely waiting on the user, so the
  // store helper applies the UI-vs-tool-work distinction.
  const showWorking = shouldShowWorkingIndicator(session);

  const compactRenderItems = useMemo(
    () =>
      transcriptStyle === "compact"
        ? buildCompactRenderItems(liveBlocks, showWorking)
        : EMPTY_COMPACT_RENDER_ITEMS,
    [showWorking, liveBlocks, transcriptStyle],
  );
  const firstLiveCompactItem = compactRenderItems[0];
  const leadingLiveCompactGroup: CompactGroupRenderItem | undefined =
    firstLiveCompactItem?.kind === "compact_group" ? firstLiveCompactItem : undefined;
  // Combine only fixed-size metadata across the boundary. Archived activity
  // remains a stable array owned by the archive; never copy or rescan it on a
  // live token update.
  const compactBoundaryStats = archivedBoundaryGroup
    ? mergeCompactGroupStats(archivedBoundaryGroup.stats, leadingLiveCompactGroup?.stats)
    : undefined;
  const compactBoundarySummary = compactBoundaryStats
    ? summarizeCompactGroup(compactBoundaryStats)
    : undefined;
  // A terminal archived activity run remains active while the runtime works
  // even before the live assistant has emitted a non-empty segment. Visible
  // live prose (or another non-group item) ends that active presentation.
  const compactBoundaryStreaming =
    leadingLiveCompactGroup?.streaming ?? (compactRenderItems.length === 0 && showWorking);
  const compactLiveItems = useMemo(
    () =>
      archivedBoundaryGroup && leadingLiveCompactGroup
        ? compactRenderItems.slice(1)
        : compactRenderItems,
    [archivedBoundaryGroup, compactRenderItems, leadingLiveCompactGroup],
  );

  // Sticky bottom via distance-from-bottom detection. Robust against:
  //   • content *shrink* (async highlight replacing tall raw text, image
  //     finishing load, tool card collapsing) — the browser clamps
  //     scrollTop downward; distance stays ~0 → re-pins.
  //   • a content chunk arriving between a programmatic pin and its
  //     scroll-event echo — `scrollTop` hasn't moved away from
  //     `lastPinnedTopRef`, so we don't mistake "grew below us" for
  //     "user scrolled up".
  //   • a real wheel/touch up-scroll mid-stream — scrollTop moves above
  //     `lastPinnedTopRef` by more than the margin → unpins.
  //   • the user returning to the bottom — distance ≤ margin → re-pins.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    updateScrollFades();
    if (distance <= SCROLL_BOTTOM_EPSILON_PX) {
      // At/near bottom: re-pin (covers shrink-clamps, growth-clamps, and
      // the user actively returning to the bottom).
      setPinned(true);
      lastPinnedTopRef.current = el.scrollTop;
      prevScrollHeightRef.current = el.scrollHeight;
      prevClientHeightRef.current = el.clientHeight;
      prevScrollTopRef.current = el.scrollTop;
    } else if (el.scrollTop < lastPinnedTopRef.current - SCROLL_BOTTOM_EPSILON_PX) {
      // A layout-only viewport change can also move scrollTop upward (for
      // example when a custom/unified TUI panel replaces the Composer). That
      // must NOT break the "follow bottom unless the user actively scrolled"
      // invariant. Only a recent wheel/touch/keyboard scroll intent may unpin;
      // otherwise restore the bottom immediately.
      const userInitiated = performance.now() <= userScrollIntentUntilRef.current;
      if (userInitiated) {
        setPinned(false);
        prevScrollTopRef.current = el.scrollTop;
      } else if (pinnedRef.current) {
        pinToBottom();
      }
    } else if (pinnedRef.current && performance.now() > userScrollIntentUntilRef.current) {
      // Ambiguous transient (content grew below us or the viewport shrank while
      // scrollTop stayed put). If the user did not cause it, keep following the
      // bottom instead of waiting for the next streamed token.
      pinToBottom();
    }
  }, [pinToBottom, setPinned, updateScrollFades]);

  // Backstop for size changes that do NOT go through a React render — async
  // syntax highlighting swapping in and images finishing load — neither of
  // which re-renders the transcript or fires a scroll event, so the
  // commit-phase pin below can't see them. While pinned, follow them here.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) pinToBottom();
      updateScrollFades();
    });
    observer.observe(content);
    observer.observe(el);
    updateScrollFades();
    return () => observer.disconnect();
  }, [pinToBottom, updateScrollFades]);

  // JS-sized Composer replacements (CustomPanelHost / UnifiedTuiHost) can grow
  // after their React commit when xterm has measured its grid. The panel sizer
  // emits this bubbling event after it applies a new card height; pin in the
  // same turn if the transcript was following the bottom.
  useLayoutEffect(() => {
    const sessionEl = scrollRef.current?.closest(".app__session");
    if (!sessionEl) return;
    const handleComposerSlotResize: EventListener = () => {
      if (pinnedRef.current) pinToBottom();
    };
    sessionEl.addEventListener("pivis:composer-slot-resize", handleComposerSlotResize);
    return () => {
      sessionEl.removeEventListener("pivis:composer-slot-resize", handleComposerSlotResize);
    };
  }, [pinToBottom]);

  // Switching sessions always starts pinned to the bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a mount trigger, not a reactive dep
  useLayoutEffect(() => {
    pinToBottom();
  }, [sessionId, pinToBottom]);

  // Follow the bottom across content growth — the whole "tool call added and
  // then expanding" sequence. New blocks (a tool call appearing) AND in-place
  // growth (streaming text/thinking deltas, tool output) both re-render the
  // transcript, so this commit-phase effect (no dep array → runs after every
  // render) catches them synchronously, before paint, without depending on the
  // ResizeObserver firing in time. The observer above stays as the backstop
  // for growth that does NOT re-render React: async highlighting and images.
  //
  // Crucially, we follow when the viewport was at the bottom BEFORE this
  // commit grew the content — judged from the *live* scrollTop against the
  // PREVIOUS height — OR when we were already pinned and no user scroll input
  // caused the displacement. The explicit input guard keeps real wheel/touch/key
  // scroll-ups from being yanked back down, while layout-only scroll movement
  // (custom/unified panels resizing the Composer slot) cannot silently break
  // the bottom-follow invariant. `pinnedRef` is kept in sync so the
  // ResizeObserver backstop agrees.
  const lastBlockType = transcript ? lastTranscriptBlock(transcript)?.type : undefined;
  const blockCount = totalBlockCount;
  const prevBlockCountRef = useRef(blockCount);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const disclosureAnchor = disclosureAnchorRef.current;
    if (disclosureAnchor !== null) {
      disclosureAnchorRef.current = null;
      setPinned(false);
      el.scrollTop = disclosureAnchor;
      prevScrollHeightRef.current = el.scrollHeight;
      prevClientHeightRef.current = el.clientHeight;
      prevScrollTopRef.current = el.scrollTop;
      prevBlockCountRef.current = blockCount;
      updateScrollFades();
      return;
    }
    const prevHeight = prevScrollHeightRef.current;
    const prevClientHeight = prevClientHeightRef.current;
    const prevScrollTop = prevScrollTopRef.current;
    prevScrollHeightRef.current = el.scrollHeight;
    prevClientHeightRef.current = el.clientHeight;
    prevScrollTopRef.current = el.scrollTop;

    // The user's own send re-pins unconditionally ("I'm caught up"), even if
    // they'd scrolled up.
    const newUserBlock = blockCount > prevBlockCountRef.current && lastBlockType === "user";
    prevBlockCountRef.current = blockCount;
    if (newUserBlock) {
      pinToBottom();
      return;
    }

    // Only react to growth; a shrink (collapse, working-row removed) clamps to
    // the bottom on its own and the ResizeObserver re-pins if needed.
    if (el.scrollHeight <= prevHeight) return;
    // Use the PREVIOUS clientHeight (the viewport size when the user was
    // last at the bottom), NOT the live one. A viewport shrink — the
    // composer growing, or a custom/unified panel replacing it — arrives
    // in the same batched React render as a streaming token, so the live
    // `clientHeight` is already shrunk here while `scrollTop` still sits
    // at the OLD bottom. Mixing old `prevHeight` with the new (smaller)
    // clientHeight makes `wasAtBottom` read the shrink as a scroll-up and
    // silently drop the bottom-follow — and because it also flips
    // `pinnedRef` false, the ResizeObserver backstop (which only re-pins
    // while pinned) won't correct it, so the view stays unpinned for the
    // rest of the stream. Measuring against `prevClientHeight` keeps the
    // detection purely about CONTENT position: a real scroll-up still
    // moves `scrollTop` below the prior bottom and reads as "not at
    // bottom", while a pure viewport change leaves it pinned.
    const measuredAtBottom =
      prevHeight - el.scrollTop - prevClientHeight <= SCROLL_BOTTOM_EPSILON_PX;
    const userInitiated = performance.now() <= userScrollIntentUntilRef.current;
    const shouldFollow = measuredAtBottom || (pinnedRef.current && !userInitiated);
    setPinned(shouldFollow);
    if (shouldFollow) {
      pinToBottom();
    } else {
      // When the user is reading above the bottom, content appended or grown
      // below the viewport must not move the visible text. Chromium can still
      // adjust scrollTop during layout despite scroll anchoring being disabled,
      // so restore the last user/program-visible position after the commit.
      el.scrollTop = prevScrollTop;
      prevScrollTopRef.current = el.scrollTop;
      updateScrollFades();
    }
  });

  useLayoutEffect(() => {
    updateScrollFades();
  });

  const handleClipboard = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const container = scrollRef.current;
    if (!container) return;

    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;

    const fragment = range.cloneContents();
    const markdown = htmlToMarkdown(fragment);

    e.preventDefault();
    e.clipboardData.setData("text/plain", markdown);
  }, []);

  const transcriptClassName = [
    "transcript-view",
    isPinned ? "transcript-view--pinned" : "",
    scrollFades.top ? "transcript-view--fade-top" : "",
    scrollFades.bottom ? "transcript-view--fade-bottom" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={transcriptClassName}
      ref={scrollRef}
      onScroll={handleScroll}
      onWheelCapture={markUserScrollIntent}
      onTouchMoveCapture={markUserScrollIntent}
      onKeyDownCapture={(e) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
          markUserScrollIntent();
        }
      }}
      onCopy={handleClipboard}
    >
      <div className="transcript-blocks" ref={contentRef}>
        <ArchivedTranscript
          key={`${sessionId}:${session?.historyGeneration ?? 0}:${transcriptStyle}`}
          blocks={archivedBlocks}
          compactItems={archivedCompactPrefix}
          style={transcriptStyle}
          sessionId={sessionId}
          preserveScroll={preserveScroll}
          capturePrependScroll={capturePrependScroll}
          restorePrependScroll={restorePrependScroll}
        />
        {transcriptStyle === "compact" && archivedBoundaryGroup && compactBoundarySummary && (
          <CompactTranscriptGroup
            key={archivedBoundaryGroup.key}
            sessionId={sessionId}
            archivedItems={archivedBoundaryGroup.items}
            items={leadingLiveCompactGroup?.items ?? EMPTY_COMPACT_GROUP_ITEMS}
            summary={compactBoundarySummary}
            streaming={compactBoundaryStreaming}
            preserveScroll={preserveScroll}
          />
        )}
        {transcriptStyle === "compact"
          ? compactLiveItems.map((item) =>
              item.kind === "item" ? (
                <TranscriptItemView
                  key={renderItemKey(item.item)}
                  sessionId={sessionId}
                  item={item.item}
                  preserveScroll={preserveScroll}
                />
              ) : (
                <CompactTranscriptGroup
                  key={item.key}
                  sessionId={sessionId}
                  items={item.items}
                  summary={item.summary}
                  streaming={item.streaming}
                  preserveScroll={preserveScroll}
                />
              ),
            )
          : liveBlocks.map((block) => (
              <TranscriptItemView
                key={block.id}
                sessionId={sessionId}
                item={{ kind: "block", block }}
                preserveScroll={preserveScroll}
              />
            ))}
        {showWorking && <WorkingRow sessionId={sessionId} />}
        {showHistoryLoading && (
          <div className="history-loading-row" role="status">
            <Spinner />
            <span>Loading conversation history…</span>
          </div>
        )}
      </div>
    </div>
  );
}
