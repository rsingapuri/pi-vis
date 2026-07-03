import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../../lib/markdown.js";
import { htmlToMarkdown } from "../../lib/turndown.js";
import { useImageViewerStore } from "../../stores/image-viewer-store.js";
import { shouldShowWorkingIndicator, useSessionsStore } from "../../stores/sessions-store.js";
import {
  type AssistantBlockData,
  type AssistantSegment,
  type BashBlockData,
  type CompactionBlockData,
  type CustomMessageBlockData,
  type ErrorBlockData,
  type ToolCallBlockData,
  type TypedTranscriptBlock,
  type UserBlockData,
  hasAssistantContent,
} from "../../stores/transcript.js";
import { FadeText } from "../common/FadeText.js";
import { DiffBlock } from "./DiffBlock.js";
import "./TranscriptView.css";

const MAX_VISIBLE_BLOCKS = 150;
const OUTPUT_PREVIEW_LINES = 4;
const DIFF_PREVIEW_LINES = 12;
const ACTIVITY_PREVIEW_CHARS = 420;
// Any upward scroll unsticks; scrolling back to within this distance of the
// bottom re-sticks.
const SCROLL_RESTICK_PX = 24;
// Scroll events can be caused by layout (e.g. a custom/unified panel replacing
// the Composer and shrinking the transcript viewport) as well as by the user.
// Only an actual user scroll input may break bottom-follow.
const USER_SCROLL_INTENT_MS = 1000;

// ── Label visibility ─────────────────────────────────────────────────────
// Only show "You" / "Pi" when the *speaker* changes.  Tool/bash blocks are
// not speakers and do not affect the label decision.

// ── Shared helpers ───────────────────────────────────────────────────────

function splitOutputLines(text: string): string[] {
  const trimmed = text.replace(/\s+$/u, "");
  return trimmed ? trimmed.split("\n") : [];
}

const SUBJECT_KEYS = [
  "file_path",
  "filePath",
  "path",
  "filename",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "prompt",
  "title",
  "name",
];

// One-line summary of a tool call's primary argument, e.g. `read src/main.ts`
function summarizeInput(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  for (const key of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const firstLine = value.split("\n", 1)[0] ?? value;
      return firstLine.length > 96 ? `${firstLine.slice(0, 96)}…` : firstLine;
    }
  }
  return null;
}

const COMPACT_VALUE_MAX = 80;
const FULL_JSON_REVEAL_THRESHOLD = 240;

/** Format tool-call args as a compact `key=value key=value` one-liner. */
function formatArgsCompact(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    let s: string;
    if (typeof value === "string") s = value;
    else s = JSON.stringify(value);
    if (s.length > COMPACT_VALUE_MAX) s = `${s.slice(0, COMPACT_VALUE_MAX - 1)}…`;
    parts.push(`${key}=${s}`);
  }
  return parts.join("  ");
}

/** Render tool-call args as a compact one-liner. If the full JSON is
 *  substantially larger than the compact form, wrap it in <details> so
 *  the user can reveal the full input on demand. */
function renderArgs(input: Record<string, unknown> | undefined): React.ReactNode {
  if (!input || Object.keys(input).length === 0) return null;
  const compact = formatArgsCompact(input);
  const full = JSON.stringify(input, null, 2);
  const fullIsLonger =
    full.length > FULL_JSON_REVEAL_THRESHOLD && full.length > compact.length + 80;
  if (fullIsLonger) {
    return (
      <details className="tool-card__args">
        <summary className="tool-card__args-summary">
          <span className="tool-card__args-label">input</span>
          <span>{compact}</span>
        </summary>
        <pre className="tool-card__args-full">{full}</pre>
      </details>
    );
  }
  return (
    <div className="tool-card__args">
      <span className="tool-card__args-label">input</span>
      <span>{compact}</span>
    </div>
  );
}

function pluralLines(n: number): string {
  return n === 1 ? "line" : "lines";
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
  const stripped = stripMarkdownChrome(first);
  return stripped.length > 96 ? `${stripped.slice(0, 96)}…` : stripped;
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

/** The working indicator row. Shows a spinner plus a live "Running for …"
 *  countdown driven by `runningSince`. The timer is started on the first
 *  agent_start of a turn and stopped only on a final agent_end; retries do
 *  not reset it, so the elapsed time reflects the full wait across retries. */
function WorkingRow({ sessionId }: { sessionId: SessionId }): React.ReactElement {
  const runningSince = useSessionsStore((s) => s.sessions.get(sessionId)?.runningSince);
  const [, setTick] = useState(0);
  // Re-render once a second while a turn is actively running so the elapsed
  // display stays live. `runningSince` is undefined between turns, in which
  // case there's nothing to count and no interval is scheduled.
  useEffect(() => {
    if (runningSince == null) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [runningSince]);

  const label =
    runningSince != null ? `Running for ${formatDuration(Date.now() - runningSince)}` : "Working…";
  return (
    <div className="working-row">
      <span className="spinner" />
      <span className="working-row__label">{label}</span>
    </div>
  );
}

function Chevron(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M4 6.5l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ToolCardShellProps {
  isError: boolean;
  open: boolean;
  expandable: boolean;
  onToggle: () => void;
  header: React.ReactNode;
  children?: React.ReactNode;
}

// Card chrome shared by tool calls and bash blocks: header row, optional
// body, expand arrow pinned to the bottom-right corner.
function ToolCardShell({
  isError,
  open,
  expandable,
  onToggle,
  header,
  children,
}: ToolCardShellProps): React.ReactElement {
  const classes = [
    "tool-card",
    isError ? "tool-card--error" : "",
    open ? "tool-card--open" : "",
    expandable ? "tool-card--expandable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      {expandable ? (
        <button
          type="button"
          className="tool-card__header fade-scope"
          onClick={onToggle}
          aria-expanded={open}
        >
          {header}
        </button>
      ) : (
        <div className="tool-card__header fade-scope">{header}</div>
      )}
      {children}
      {expandable && (
        <button
          type="button"
          className="tool-card__expand"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? "Collapse" : "Expand"}
        >
          <Chevron />
        </button>
      )}
    </div>
  );
}

// ── Block renderers ──────────────────────────────────────────────────────

// memo'd on the `data` prop: the transcript reducer (patchBlock) creates a
// new `data` object only for the one block a streaming delta touches,
// leaving every other block's `data` reference stable. So a per-token
// re-render of the parent reconciles in O(1) — only the streamed block's
// memo bails out (new `data` ref) and re-renders; the ~150 other visible
// blocks keep a stable `data` ref and skip. Without this, the parent
// re-renders all visible blocks on every token (O(150) reconcile per delta).
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
}: {
  content: string;
}): React.ReactElement {
  return (
    <div className="thinking-block">
      <Markdown>{content}</Markdown>
    </div>
  );
});

const TextSegment = memo(function TextSegment({
  content,
}: {
  content: string;
}): React.ReactElement {
  return (
    <div className="transcript-block__content">
      <Markdown>{content}</Markdown>
    </div>
  );
});

const AssistantSegmentView = memo(function AssistantSegmentView({
  segment,
}: {
  segment: AssistantSegment;
}): React.ReactElement | null {
  if (!segment.content) return null;
  return segment.kind === "thinking" ? (
    <ThinkingSegment content={segment.content} />
  ) : (
    <TextSegment content={segment.content} />
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
        <AssistantSegmentView key={`${seg.kind}-${i}`} segment={seg} />
      ))}
    </div>
  );
});

const ToolCallBlock = memo(function ToolCallBlock({
  data,
  preserveScroll,
}: {
  data: ToolCallBlockData;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => preserveScroll(() => setOpen((v) => !v)), [preserveScroll]);

  const diff = data.diff ?? data.patch;
  const diffLines = useMemo(() => (diff ? splitOutputLines(diff) : []), [diff]);
  const outputLines = useMemo(() => splitOutputLines(data.outputText), [data.outputText]);
  const hiddenOutput = Math.max(0, outputLines.length - OUTPUT_PREVIEW_LINES);
  const hiddenDiff = Math.max(0, diffLines.length - DIFF_PREVIEW_LINES);

  const isBash = data.toolName === "bash";
  const subject = summarizeInput(data.input);
  const expandable =
    data.input !== undefined ||
    hiddenDiff > 0 ||
    (diff ? outputLines.length > 0 : hiddenOutput > 0);

  const header = (
    <>
      <span className={`tool-card__name ${isBash ? "tool-card__name--bash" : ""}`}>
        {isBash ? "$" : data.toolName}
      </span>
      {subject && <FadeText className="tool-card__subject">{subject}</FadeText>}
      {data.isStreaming && <span className="spinner tool-card__spinner" />}
      {data.isError && <span className="tool-card__badge">error</span>}
    </>
  );

  let body: React.ReactNode = null;
  if (open) {
    const argsNode = renderArgs(data.input);
    const diffNode = diff ? <DiffBlock diff={diff} /> : null;
    const outputNode =
      outputLines.length > 0 ? (
        <pre className="tool-card__output">{outputLines.join("\n")}</pre>
      ) : null;
    body = (
      <div className="tool-card__body">
        <div className="tool-card__scroll">
          {argsNode}
          {diffNode}
          {outputNode}
        </div>
      </div>
    );
  } else if (diff) {
    // Diffs truncate from the bottom — the head is the interesting part
    body = (
      <div className="tool-card__body">
        <div className="tool-card__scroll">
          <DiffBlock
            diff={hiddenDiff > 0 ? diffLines.slice(0, DIFF_PREVIEW_LINES).join("\n") : diff}
          />
        </div>
        {hiddenDiff > 0 && (
          <div className="tool-card__more">
            … {hiddenDiff} more {pluralLines(hiddenDiff)}
          </div>
        )}
      </div>
    );
  } else if (outputLines.length > 0) {
    // Output truncates from the top — the tail is the interesting part
    body = (
      <div className="tool-card__body">
        {hiddenOutput > 0 && (
          <div className="tool-card__more">
            … {hiddenOutput} earlier {pluralLines(hiddenOutput)}
          </div>
        )}
        <div className="tool-card__scroll">
          <pre className="tool-card__output">
            {outputLines.slice(-OUTPUT_PREVIEW_LINES).join("\n")}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <ToolCardShell
      isError={data.isError}
      open={open}
      expandable={expandable}
      onToggle={toggle}
      header={header}
    >
      {body}
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
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => preserveScroll(() => setOpen((v) => !v)), [preserveScroll]);

  const outputLines = useMemo(() => splitOutputLines(data.outputText), [data.outputText]);
  const hiddenOutput = Math.max(0, outputLines.length - OUTPUT_PREVIEW_LINES);
  const isError = data.exitCode != null && data.exitCode !== 0;
  const expandable = hiddenOutput > 0;

  const header = (
    <>
      <span className="tool-card__name tool-card__name--bash">$</span>
      <FadeText className="tool-card__subject tool-card__subject--command">{data.command}</FadeText>
      {data.isStreaming && <span className="spinner tool-card__spinner" />}
      {isError && <span className="tool-card__badge">exit {data.exitCode}</span>}
    </>
  );

  return (
    <ToolCardShell
      isError={isError}
      open={open}
      expandable={expandable}
      onToggle={toggle}
      header={header}
    >
      {outputLines.length > 0 && (
        <div className="tool-card__body">
          {!open && hiddenOutput > 0 && (
            <div className="tool-card__more">
              … {hiddenOutput} earlier {pluralLines(hiddenOutput)}
            </div>
          )}
          <div className="tool-card__scroll">
            <pre className="tool-card__output">
              {open ? outputLines.join("\n") : outputLines.slice(-OUTPUT_PREVIEW_LINES).join("\n")}
            </pre>
          </div>
        </div>
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
  preserveScroll: (mutate: () => void) => void;
}

const ActivityCard = memo(function ActivityCard({
  label,
  subject,
  content,
  badge,
  isError = false,
  preserveScroll,
}: ActivityCardProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => preserveScroll(() => setOpen((v) => !v)), [preserveScroll]);

  const text = content?.trim() ?? "";
  const lines = useMemo(() => splitOutputLines(text), [text]);
  const hiddenLines = Math.max(0, lines.length - OUTPUT_PREVIEW_LINES);
  const expandable = text.length > 0;
  const linePreview = lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n");
  const preview =
    linePreview.length > ACTIVITY_PREVIEW_CHARS
      ? `${linePreview.slice(0, ACTIVITY_PREVIEW_CHARS - 1)}…`
      : linePreview;
  const hasHiddenPreview = hiddenLines > 0 || preview !== text;
  const showCollapsedBody = label === "context" || lines.length > 1 || text.length > 120;
  const showBody = text.length > 0 && (open || showCollapsedBody);

  const header = (
    <>
      <span className="tool-card__name">{label}</span>
      {subject && <FadeText className="tool-card__subject">{subject}</FadeText>}
      {badge && <span className="tool-card__badge">{badge}</span>}
    </>
  );

  return (
    <ToolCardShell
      isError={isError}
      open={open}
      expandable={expandable}
      onToggle={toggle}
      header={header}
    >
      {showBody && (
        <div className="tool-card__body">
          <div className="tool-card__scroll">
            <div className="transcript-block__content activity-card__markdown">
              <Markdown>{open ? text : preview}</Markdown>
            </div>
          </div>
          {!open && hasHiddenPreview && (
            <div className="tool-card__more">
              {hiddenLines > 0
                ? `… ${hiddenLines} more ${pluralLines(hiddenLines)}`
                : "… more details"}
            </div>
          )}
        </div>
      )}
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
  const reason = data.reason ? data.reason : null;
  const badge = data.aborted ? "aborted" : data.errorMessage ? "error" : undefined;
  const subjectParts = ["Context compacted", reason, tokens ? `${tokens} tokens summarized` : null];
  const subject = subjectParts.filter(Boolean).join(" · ");
  const content = data.errorMessage ? data.errorMessage : data.summary;

  return (
    <ActivityCard
      label="context"
      subject={subject}
      content={content}
      badge={badge ?? undefined}
      isError={!!data.errorMessage}
      preserveScroll={preserveScroll}
    />
  );
});

const CustomMessageBlock = memo(function CustomMessageBlock({
  data,
  preserveScroll,
}: {
  data: CustomMessageBlockData;
  preserveScroll: (mutate: () => void) => void;
}): React.ReactElement {
  const subject = summarizeActivityContent(data.content);
  return (
    <ActivityCard
      label="notice"
      subject={subject}
      content={data.content}
      preserveScroll={preserveScroll}
    />
  );
});

// ── Main view ────────────────────────────────────────────────────────────

interface TranscriptViewProps {
  sessionId: SessionId;
}

export function TranscriptView({ sessionId }: TranscriptViewProps): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const [showAll, setShowAll] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Single source of truth for "follow the bottom". Only a genuine
  // user scroll away from the bottom clears it; reaching the bottom
  // (by any means) sets it back. Compared against `lastPinnedTopRef`
  // rather than `scrollHeight` so a large content chunk arriving
  // between a programmatic pin and its lagging scroll-event echo is
  // not misread as the user scrolling up.
  const pinnedRef = useRef(true);
  const lastPinnedTopRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  const prevClientHeightRef = useRef(0);
  const [scrollFades, setScrollFades] = useState({ top: false, bottom: false });

  const updateScrollFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = {
      top: el.scrollTop > 1,
      bottom: distance > 1,
    };
    setScrollFades((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
  }, []);

  // Programmatic pin helper. Always pin to the absolute bottom and record the
  // target so handleScroll can distinguish "we pinned" from "the user moved up
  // from where we were". Clamp to 0 for short transcripts — browsers clamp the
  // assignment anyway, but keeping our sentinel non-negative avoids false
  // comparisons after the viewport later shrinks into an overflowing feed.
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = target;
    lastPinnedTopRef.current = el.scrollTop;
    prevScrollHeightRef.current = el.scrollHeight;
    prevClientHeightRef.current = el.clientHeight;
    updateScrollFades();
  }, [updateScrollFades]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_MS;
  }, []);

  // Preserve scroll position during expand/collapse toggles.
  // When the user is scrolled up (not pinned), we snapshot
  // scrollTop before the mutation and restore it after layout commits.
  const preserveScroll = useCallback((mutate: () => void) => {
    const el = scrollRef.current;
    if (!el || pinnedRef.current) {
      mutate();
      return;
    }
    const prevTop = el.scrollTop;
    mutate();
    requestAnimationFrame(() => {
      el.scrollTop = prevTop;
    });
  }, []);

  const allBlocks: TypedTranscriptBlock[] = session?.transcript.blocks ?? [];
  // Show the "Running for …" indicator only when the agent is genuinely
  // computing — NOT while an extension command is blocked on its own UI (a
  // dialog or custom panel), during which pi still reports the turn active.
  // See shouldShowWorkingIndicator for the full rationale.
  const showWorking = shouldShowWorkingIndicator(session);

  const visibleBlocks =
    showAll || allBlocks.length <= MAX_VISIBLE_BLOCKS
      ? allBlocks
      : allBlocks.slice(allBlocks.length - MAX_VISIBLE_BLOCKS);

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
    if (distance <= SCROLL_RESTICK_PX) {
      // At/near bottom: re-pin (covers shrink-clamps, growth-clamps, and
      // the user actively returning to the bottom).
      pinnedRef.current = true;
      lastPinnedTopRef.current = el.scrollTop;
      prevScrollHeightRef.current = el.scrollHeight;
      prevClientHeightRef.current = el.clientHeight;
    } else if (el.scrollTop < lastPinnedTopRef.current - SCROLL_RESTICK_PX) {
      // A layout-only viewport change can also move scrollTop upward (for
      // example when a custom/unified TUI panel replaces the Composer). That
      // must NOT break the "follow bottom unless the user actively scrolled"
      // invariant. Only a recent wheel/touch/keyboard scroll intent may unpin;
      // otherwise restore the bottom immediately.
      const userInitiated = performance.now() <= userScrollIntentUntilRef.current;
      if (userInitiated) {
        pinnedRef.current = false;
      } else if (pinnedRef.current) {
        pinToBottom();
      }
    } else if (pinnedRef.current && performance.now() > userScrollIntentUntilRef.current) {
      // Ambiguous transient (content grew below us or the viewport shrank while
      // scrollTop stayed put). If the user did not cause it, keep following the
      // bottom instead of waiting for the next streamed token.
      pinToBottom();
    }
  }, [pinToBottom, updateScrollFades]);

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
    setShowAll(false);
    pinnedRef.current = true;
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
  const lastBlockType = allBlocks[allBlocks.length - 1]?.type;
  const blockCount = allBlocks.length;
  const prevBlockCountRef = useRef(blockCount);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevHeight = prevScrollHeightRef.current;
    const prevClientHeight = prevClientHeightRef.current;
    prevScrollHeightRef.current = el.scrollHeight;
    prevClientHeightRef.current = el.clientHeight;

    // The user's own send re-pins unconditionally ("I'm caught up"), even if
    // they'd scrolled up.
    const newUserBlock = blockCount > prevBlockCountRef.current && lastBlockType === "user";
    prevBlockCountRef.current = blockCount;
    if (newUserBlock) {
      pinnedRef.current = true;
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
    const measuredAtBottom = prevHeight - el.scrollTop - prevClientHeight <= SCROLL_RESTICK_PX;
    const userInitiated = performance.now() <= userScrollIntentUntilRef.current;
    const shouldFollow = measuredAtBottom || (pinnedRef.current && !userInitiated);
    pinnedRef.current = shouldFollow;
    if (shouldFollow) pinToBottom();
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
        {!showAll && allBlocks.length > MAX_VISIBLE_BLOCKS && (
          <button type="button" className="show-earlier-btn" onClick={() => setShowAll(true)}>
            Show {allBlocks.length - MAX_VISIBLE_BLOCKS} earlier messages
          </button>
        )}
        {visibleBlocks.map((block) => {
          switch (block.type) {
            case "user":
              return <UserBlock key={block.id} data={block.data} />;
            case "assistant":
              if (!hasAssistantContent(block.data)) {
                return null;
              }
              return <AssistantBlock key={block.id} data={block.data} />;
            case "tool_call":
              return (
                <ToolCallBlock key={block.id} data={block.data} preserveScroll={preserveScroll} />
              );
            case "bash":
              return <BashBlock key={block.id} data={block.data} preserveScroll={preserveScroll} />;
            case "compaction":
              return (
                <CompactionBlock key={block.id} data={block.data} preserveScroll={preserveScroll} />
              );
            case "custom_message":
              return (
                <CustomMessageBlock
                  key={block.id}
                  data={block.data}
                  preserveScroll={preserveScroll}
                />
              );
            case "error":
              return <ErrorBlock key={block.id} data={block.data} />;
            default:
              return null;
          }
        })}
        {showWorking && <WorkingRow sessionId={sessionId} />}
      </div>
    </div>
  );
}
