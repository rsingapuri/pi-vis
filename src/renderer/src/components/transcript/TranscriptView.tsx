import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../../lib/markdown.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import type {
  AssistantBlockData,
  BashBlockData,
  ToolCallBlockData,
  TypedTranscriptBlock,
  UserBlockData,
} from "../../stores/transcript.js";
import { DiffBlock } from "./DiffBlock.js";
import "./TranscriptView.css";

const MAX_VISIBLE_BLOCKS = 150;
const OUTPUT_PREVIEW_LINES = 4;
const DIFF_PREVIEW_LINES = 12;
// Any upward scroll unsticks; scrolling back to within this distance of the
// bottom re-sticks.
const SCROLL_RESTICK_PX = 24;

// ── Label visibility ─────────────────────────────────────────────────────
// Only show "You" / "Pi" when the *speaker* changes.  Tool/bash blocks are
// not speakers and do not affect the label decision.

type Speaker = "user" | "assistant";

function speakerOf(block: TypedTranscriptBlock): Speaker | null {
  if (block.type === "user") return "user";
  if (block.type === "assistant") return "assistant";
  return null;
}

function shouldShowLabel(blocks: TypedTranscriptBlock[], index: number): boolean {
  const current = blocks[index];
  if (!current) return false;
  const curSpeaker = speakerOf(current);
  // Non-speaker blocks never get a label
  if (!curSpeaker) return false;

  for (let i = index - 1; i >= 0; i--) {
    const prev = blocks[i]!;
    const prevSpeaker = speakerOf(prev);
    if (prevSpeaker === null) continue; // skip tool/bash blocks
    return prevSpeaker !== curSpeaker;
  }
  // First speaker block always gets a label
  return true;
}

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

function pluralLines(n: number): string {
  return n === 1 ? "line" : "lines";
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
        <button type="button" className="tool-card__header" onClick={onToggle} aria-expanded={open}>
          {header}
        </button>
      ) : (
        <div className="tool-card__header">{header}</div>
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

function UserBlock({ data }: { data: UserBlockData }): React.ReactElement {
  return (
    <div className="transcript-block transcript-block--user">
      <div className="transcript-block__bubble user-content">
        {data.images && data.images.length > 0 && (
          <div className="transcript-block__images">
            {data.images.map((img, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: image order is stable for a given user message
              <a key={i} href={img} target="_blank" rel="noreferrer">
                <img
                  src={img}
                  // biome-ignore lint/a11y/noRedundantAlt: alt describes which attached image, not "what"
                  alt={`Attached image ${i + 1}`}
                  className="transcript-block__image-thumb"
                />
              </a>
            ))}
          </div>
        )}
        <div className="transcript-block__content">{data.content}</div>
      </div>
    </div>
  );
}

function AssistantBlock({
  showLabel,
  data,
}: {
  showLabel: boolean;
  data: AssistantBlockData;
}): React.ReactElement {
  return (
    <div className="transcript-block transcript-block--assistant">
      {showLabel && <div className="transcript-block__label">Pi</div>}
      {data.thinkingContent && <div className="thinking-block">{data.thinkingContent}</div>}
      {data.textContent && (
        <div className="transcript-block__content">
          <Markdown>{data.textContent}</Markdown>
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ data }: { data: ToolCallBlockData }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

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
      {subject && <span className="tool-card__subject">{subject}</span>}
      {data.isStreaming && <span className="spinner tool-card__spinner" />}
      {data.isError && <span className="tool-card__badge">error</span>}
    </>
  );

  let body: React.ReactNode = null;
  if (open) {
    body = (
      <div className="tool-card__body">
        {data.input !== undefined && (
          <pre className="tool-card__args">{JSON.stringify(data.input, null, 2)}</pre>
        )}
        {diff && <DiffBlock diff={diff} />}
        {outputLines.length > 0 && (
          <pre className="tool-card__output">{outputLines.join("\n")}</pre>
        )}
      </div>
    );
  } else if (diff) {
    // Diffs truncate from the bottom — the head is the interesting part
    body = (
      <div className="tool-card__body">
        <DiffBlock
          diff={hiddenDiff > 0 ? diffLines.slice(0, DIFF_PREVIEW_LINES).join("\n") : diff}
        />
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
        <pre className="tool-card__output">
          {outputLines.slice(-OUTPUT_PREVIEW_LINES).join("\n")}
        </pre>
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
}

function BashBlock({ data }: { data: BashBlockData }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const outputLines = useMemo(() => splitOutputLines(data.outputText), [data.outputText]);
  const hiddenOutput = Math.max(0, outputLines.length - OUTPUT_PREVIEW_LINES);
  const isError = data.exitCode != null && data.exitCode !== 0;
  const expandable = hiddenOutput > 0;

  const header = (
    <>
      <span className="tool-card__name tool-card__name--bash">$</span>
      <span className="tool-card__subject tool-card__subject--command">{data.command}</span>
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
          <pre className="tool-card__output">
            {open ? outputLines.join("\n") : outputLines.slice(-OUTPUT_PREVIEW_LINES).join("\n")}
          </pre>
        </div>
      )}
    </ToolCardShell>
  );
}

// ── Main view ────────────────────────────────────────────────────────────

interface TranscriptViewProps {
  sessionId: SessionId;
}

export function TranscriptView({ sessionId }: TranscriptViewProps): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const [showAll, setShowAll] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const allBlocks: TypedTranscriptBlock[] = session?.transcript.blocks ?? [];
  const isStreaming = session?.isStreaming ?? false;

  const visibleBlocks =
    showAll || allBlocks.length <= MAX_VISIBLE_BLOCKS
      ? allBlocks
      : allBlocks.slice(allBlocks.length - MAX_VISIBLE_BLOCKS);

  // Sticky bottom: any upward scroll unsticks; scrolling back down to the
  // bottom re-sticks.  Programmatic pins land exactly at the bottom, so they
  // re-confirm stickiness rather than fighting the user.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const goingUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (goingUp) {
      stickRef.current = false;
    } else if (distance <= SCROLL_RESTICK_PX) {
      stickRef.current = true;
    }
  }, []);

  // While stuck, pin on every content/viewport size change.  A ResizeObserver
  // catches growth the block count misses: streaming text deltas, image loads,
  // and async syntax highlighting.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const pin = () => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    };
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Switching sessions always starts pinned to the bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a mount trigger, not a reactive dep
  useLayoutEffect(() => {
    setShowAll(false);
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, [sessionId]);

  // Sending your own message snaps the view back to the bottom
  const lastBlockType = allBlocks[allBlocks.length - 1]?.type;
  const blockCount = allBlocks.length;
  const prevBlockCountRef = useRef(blockCount);
  useLayoutEffect(() => {
    if (blockCount > prevBlockCountRef.current && lastBlockType === "user") {
      stickRef.current = true;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevBlockCountRef.current = blockCount;
  }, [blockCount, lastBlockType]);

  return (
    <div className="transcript-view" ref={scrollRef} onScroll={handleScroll}>
      <div className="transcript-blocks" ref={contentRef}>
        {!showAll && allBlocks.length > MAX_VISIBLE_BLOCKS && (
          <button type="button" className="show-earlier-btn" onClick={() => setShowAll(true)}>
            Show {allBlocks.length - MAX_VISIBLE_BLOCKS} earlier messages
          </button>
        )}
        {visibleBlocks.map((block, idx) => {
          const showLabel = block.type === "assistant" && shouldShowLabel(visibleBlocks, idx);

          switch (block.type) {
            case "user":
              return <UserBlock key={block.id} data={block.data} />;
            case "assistant":
              if (!block.data.textContent && !block.data.thinkingContent) {
                return null;
              }
              return <AssistantBlock key={block.id} showLabel={showLabel} data={block.data} />;
            case "tool_call":
              return <ToolCallBlock key={block.id} data={block.data} />;
            case "bash":
              return <BashBlock key={block.id} data={block.data} />;
            case "compaction":
              return (
                <div key={block.id} className="compaction-marker">
                  <div className="compaction-marker__line" />
                  <span className="compaction-marker__label">Context compacted</span>
                  <div className="compaction-marker__line" />
                  {block.data.summary && (
                    <div className="compaction-marker__summary">{block.data.summary}</div>
                  )}
                </div>
              );
            case "custom_message":
              return (
                <div key={block.id} className="transcript-block transcript-block--custom">
                  {block.data.content}
                </div>
              );
            default:
              return null;
          }
        })}
        {isStreaming && (
          <div className="working-row">
            <span className="spinner" />
            <span className="working-row__label">Working…</span>
          </div>
        )}
      </div>
    </div>
  );
}
