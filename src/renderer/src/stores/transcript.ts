import type { TranscriptBlock } from "@shared/ipc-contract.js";
import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import { detectTurnError } from "@shared/pi-protocol/turn-error.js";
import { assertNever } from "@shared/result.js";

// All TranscriptBlock data shapes
export interface UserBlockData {
  role: "user";
  content: string;
  images?: string[] | undefined;
}

/**
 * One ordered piece of an assistant message. A single model message may
 * interleave several thinking and text content blocks (e.g. thinking, then
 * text, then *more* thinking). Modeling the message as an ordered list of
 * segments — instead of two flat `thinkingContent`/`textContent` fields —
 * preserves the model's real output order, matching pi's TUI. (The flat
 * fields demuxed every thinking delta into one bucket and every text delta
 * into another, so later thinking was visually lifted *above* text that
 * chronologically preceded it.)
 *
 * `contentIndex` is the wire content-block index (from `*_start`/`*_delta`/
 * `*_end` events). It keys a segment so a resumed content block (thinking
 * reopened after some text) routes its deltas to the right segment instead
 * of appending to a new one. Absent on segments reconstructed from history
 * (the session file is already ordered, so no routing is needed) and on
 * events that omit it (defensive fallbacks then apply).
 */
export type AssistantSegment =
  | { kind: "thinking"; content: string; contentIndex?: number | undefined }
  | { kind: "text"; content: string; contentIndex?: number | undefined };

export interface AssistantBlockData {
  role: "assistant";
  segments: AssistantSegment[];
  isStreaming: boolean;
}

/** True if the block has any visible (non-empty) content. */
export function hasAssistantContent(data: AssistantBlockData): boolean {
  return data.segments.some((s) => s.content.length > 0);
}

export interface ToolCallBlockData {
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown> | undefined;
  outputText: string;
  diff?: string | undefined;
  patch?: string | undefined;
  resultDetails?: Record<string, unknown> | undefined;
  isError: boolean;
  isStreaming: boolean;
}

export interface BashBlockData {
  command: string;
  outputText: string;
  isStreaming: boolean;
  exitCode?: number | undefined;
}

export interface CompactionBlockData {
  summary?: string | undefined;
  reason?: "manual" | "threshold" | "overflow" | undefined;
  tokensBefore?: number | undefined;
  firstKeptEntryId?: string | undefined;
  aborted?: boolean | undefined;
  willRetry?: boolean | undefined;
  errorMessage?: string | undefined;
}

export interface CustomMessageBlockData {
  content: string;
}

/**
 * A model/provider failure surfaced into the transcript. pi records a
 * failed assistant turn as a `message_end` with `stopReason: "error"`
 * (and usually an `errorMessage`). Without rendering this, a provider
 * drop looks identical to "the stream mysteriously cut off". We surface
 * it as a visible block so the cause is obvious and the user knows to
 * retry / switch models.
 */
export interface ErrorBlockData {
  message: string;
}

export type TypedTranscriptBlock =
  | { id: string; type: "user"; data: UserBlockData }
  | { id: string; type: "assistant"; data: AssistantBlockData }
  | { id: string; type: "tool_call"; data: ToolCallBlockData }
  | { id: string; type: "bash"; data: BashBlockData }
  | { id: string; type: "compaction"; data: CompactionBlockData }
  | { id: string; type: "custom_message"; data: CustomMessageBlockData }
  | { id: string; type: "error"; data: ErrorBlockData };

let blockCounter = 0;
function newBlockId(): string {
  return `blk-${++blockCounter}`;
}

/**
 * Recent-context window retained in the live in-memory transcript across a
 * compaction. pi compacts by summarising everything *before* the compaction
 * point, so blocks prior to the most recent compaction marker are already
 * represented by that marker's summary and are dropped to bound memory
 * (reload from the session file restores the full history). On the *first*
 * compaction there is no prior marker to anchor a trim, so we keep this many
 * of the most recent pre-compaction blocks as a scroll-back window — large
 * enough to cover the renderer's MAX_VISIBLE_BLOCKS (150) plus headroom.
 */
const MAX_PRE_COMPACTION_KEEP = 200;

export interface TranscriptState {
  blocks: TypedTranscriptBlock[];
  // active ids for streaming
  activeAssistantId: string | null;
  activeToolCallIds: Map<string, string>; // toolCallId → blockId
  activeBashId: string | null;
  /**
   * FIFO of optimistic user-prompt texts the Composer added via
   * `addUserBlock(registerEcho: true)`. When a `message_start` with
   * `role: "user"` arrives, we extract the text and compare against the
   * head; if it matches, we consume the head (pi's authoritative echo
   * is the same text, so we don't add a duplicate). If it does not match
   * (e.g. a prompt template expanded to a different text, or a steered
   * message in a different order), we append a fresh user block.
   */
  pendingEchoes: string[];
}

export function createTranscriptState(): TranscriptState {
  return {
    blocks: [],
    activeAssistantId: null,
    activeToolCallIds: new Map(),
    activeBashId: null,
    pendingEchoes: [],
  };
}

export function finalizeActiveBlocks(state: TranscriptState): TranscriptState {
  const activeIds = new Set<string>();
  if (state.activeAssistantId) activeIds.add(state.activeAssistantId);
  if (state.activeBashId) activeIds.add(state.activeBashId);
  for (const blockId of state.activeToolCallIds.values()) activeIds.add(blockId);
  if (activeIds.size === 0) return state;

  const blocks = state.blocks.map((block): TypedTranscriptBlock => {
    if (!activeIds.has(block.id)) return block;
    switch (block.type) {
      case "assistant":
        return block.data.isStreaming
          ? { ...block, data: { ...block.data, isStreaming: false } }
          : block;
      case "tool_call":
        return block.data.isStreaming
          ? { ...block, data: { ...block.data, isStreaming: false } }
          : block;
      case "bash":
        return block.data.isStreaming
          ? { ...block, data: { ...block.data, isStreaming: false } }
          : block;
      default:
        return block;
    }
  });

  return {
    ...state,
    blocks,
    activeAssistantId: null,
    activeToolCallIds: new Map(),
    activeBashId: null,
  };
}

export function seedFromHistory(
  state: TranscriptState,
  history: TranscriptBlock[],
): TranscriptState {
  const blocks: TypedTranscriptBlock[] = history
    .map((b): TypedTranscriptBlock | null => {
      const d = b.data as Record<string, unknown>;
      if (b.type === "user") {
        return {
          id: b.id,
          type: "user",
          data: {
            role: "user",
            content: (d.content as string) ?? "",
            images: d.images as string[] | undefined,
          },
        };
      }
      if (b.type === "assistant") {
        // Reconstruct the ordered segment list. The history loader already
        // preserves content-block order from the session file; `contentIndex`
        // is irrelevant here (no streaming routing) so segments are built
        // without it. A legacy `content`/`thinking` pair (older history-loader
        // output, or any stale shape) is folded back into order
        // thinking-then-text so reload never regresses.
        const segs = d.segments;
        let segments: AssistantSegment[];
        if (Array.isArray(segs)) {
          segments = (segs as Array<Record<string, unknown>>)
            .map((s): AssistantSegment | null => {
              if (s["kind"] === "thinking") {
                return { kind: "thinking", content: (s["content"] as string) ?? "" };
              }
              if (s["kind"] === "text") {
                return { kind: "text", content: (s["content"] as string) ?? "" };
              }
              return null;
            })
            .filter((s): s is AssistantSegment => s !== null);
        } else {
          segments = [];
          const thinking = (d.thinking as string) ?? "";
          const text = (d.content as string) ?? "";
          if (thinking) segments.push({ kind: "thinking", content: thinking });
          if (text) segments.push({ kind: "text", content: text });
        }
        return {
          id: b.id,
          type: "assistant",
          data: {
            role: "assistant",
            segments,
            isStreaming: false,
          },
        };
      }
      if (b.type === "tool_call") {
        return {
          id: b.id,
          type: "tool_call",
          data: {
            toolCallId: (d.toolCallId as string) ?? "",
            toolName: (d.toolName as string) ?? "",
            input: d.input as Record<string, unknown> | undefined,
            outputText: (d.outputText as string) ?? "",
            diff: d.diff as string | undefined,
            patch: d.patch as string | undefined,
            resultDetails: d.resultDetails as Record<string, unknown> | undefined,
            isError: (d.isError as boolean) ?? false,
            isStreaming: (d.isStreaming as boolean) ?? false,
          },
        };
      }
      if (b.type === "bash") {
        return {
          id: b.id,
          type: "bash",
          data: {
            command: (d.command as string) ?? "",
            outputText: (d.outputText as string) ?? "",
            isStreaming: (d.isStreaming as boolean) ?? false,
            exitCode: d.exitCode as number | undefined,
          },
        };
      }
      if (b.type === "compaction") {
        return {
          id: b.id,
          type: "compaction",
          data: {
            summary: d.summary as string | undefined,
            reason: d.reason as CompactionBlockData["reason"],
            tokensBefore: d.tokensBefore as number | undefined,
            firstKeptEntryId: d.firstKeptEntryId as string | undefined,
            aborted: d.aborted as boolean | undefined,
            willRetry: d.willRetry as boolean | undefined,
            errorMessage: d.errorMessage as string | undefined,
          },
        };
      }
      if (b.type === "custom_message") {
        return { id: b.id, type: "custom_message", data: { content: (d.content as string) ?? "" } };
      }
      if (b.type === "error") {
        return { id: b.id, type: "error", data: { message: (d.message as string) ?? "" } };
      }
      // Unknown block type — drop it instead of synthesising an empty
      // user bubble, which would be confusing to the user.
      return null;
    })
    .filter((b): b is TypedTranscriptBlock => b !== null);
  return { ...state, blocks };
}

// tool_execution_end carries the final output in result.content[].text on the
// real wire (updates with partialResult may never arrive at all)
function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const item of r.content) {
      if (item && typeof item === "object") {
        const c = item as Record<string, unknown>;
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof r.output === "string") return r.output;
  return "";
}

/**
 * Extract the user-prompt text from a `message: { role: "user", content }`
 * snapshot. The content is either a plain string (legacy/simple) or an
 * array of `{ type: "text" | "image", text: string }` blocks. We collapse
 * the text blocks (concatenated) and ignore images; the result is what
 * the Composer would show in a user bubble.
 */
function extractUserText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { content?: unknown };
  const content = m.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function extractResultDiff(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (r.details && typeof r.details === "object") {
    const d = r.details as Record<string, unknown>;
    if (typeof d.diff === "string") return d.diff;
  }
  if (typeof r.diff === "string") return r.diff;
  return undefined;
}

function extractResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as Record<string, unknown>)["details"];
  return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
}

// ── Assistant segment helpers ───────────────────────────────────────────
// Pure transforms over a message's ordered `AssistantSegment[]`. They route
// streaming deltas to the correct content block so a resumed block (e.g.
// thinking reopened after some text) appends to its existing segment instead
// of spawning a new one — preserving the model's true output order.
//
// contentIndex (from the wire) is the canonical key when present. When it's
// absent (some providers/older paths omit it) the helpers fall back to
// positional rules that match historical flat-field behavior.

function findSegmentByIndex(
  segments: AssistantSegment[],
  contentIndex: number | undefined,
  kind: AssistantSegment["kind"],
): number {
  if (contentIndex !== undefined) {
    // Match on both contentIndex and kind. The wire contract makes
    // contentIndex unique per content block, but requiring kind to agree
    // too keeps us robust to a provider that reuses an index across types
    // (a text_delta would otherwise silently append to a thinking segment).
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (s?.contentIndex === contentIndex && s.kind === kind) return i;
    }
    return -1;
  }
  // No contentIndex: the most recently appended segment of this kind.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.kind === kind) return i;
  }
  return -1;
}

/** `*_start`: open a new (empty) segment for a content block. Idempotent on
 *  contentIndex so a duplicate start never creates a phantom segment. */
function startSegment(
  segments: AssistantSegment[],
  kind: AssistantSegment["kind"],
  contentIndex: number | undefined,
): AssistantSegment[] {
  if (contentIndex !== undefined && findSegmentByIndex(segments, contentIndex, kind) >= 0) {
    return segments;
  }
  return [...segments, { kind, content: "", contentIndex }];
}

/** `*_delta`: append to the matching segment. Without a contentIndex the rule
 *  is "the last segment overall, if it's the same kind" — appending a new
 *  segment otherwise — so a thinking→text→thinking stream (no starts, no
 *  contentIndex) interleaves correctly rather than merging into one bucket. */
function appendSegmentDelta(
  segments: AssistantSegment[],
  kind: AssistantSegment["kind"],
  contentIndex: number | undefined,
  delta: string,
): AssistantSegment[] {
  let idx: number;
  if (contentIndex !== undefined) {
    idx = findSegmentByIndex(segments, contentIndex, kind);
  } else {
    const last = segments[segments.length - 1];
    idx = last && last.kind === kind ? segments.length - 1 : -1;
  }
  if (idx < 0) {
    return [...segments, { kind, content: delta, contentIndex }];
  }
  const cur = segments[idx]!;
  const next = segments.slice();
  next[idx] = { ...cur, content: cur.content + delta };
  return next;
}

/** `*_end`: backfill the segment from the snapshot if streaming missed it.
 *  Never overwrites content already received via deltas. */
function endSegment(
  segments: AssistantSegment[],
  kind: AssistantSegment["kind"],
  contentIndex: number | undefined,
  snapshot: string,
): AssistantSegment[] {
  if (!snapshot) return segments;
  const idx = findSegmentByIndex(segments, contentIndex, kind);
  if (idx < 0) {
    return [...segments, { kind, content: snapshot, contentIndex }];
  }
  const cur = segments[idx]!;
  if (cur.content.length > 0) return segments; // keep streamed content
  const next = segments.slice();
  next[idx] = { ...cur, content: snapshot };
  return next;
}

export function applyPiEvent(state: TranscriptState, event: KnownPiEvent): TranscriptState {
  const { blocks, activeAssistantId, activeToolCallIds, activeBashId, pendingEchoes } = state;

  // Helper: immutably update a block by id. Pure O(n) copy — used for the
  // *lifecycle* events (message_end, tool_execution_end, text_end, …) that
  // fire once per block, not per token, so the aggregate cost over a session
  // is O(n) total, never O(n²).
  function updateBlock(
    id: string,
    updater: (b: TypedTranscriptBlock) => TypedTranscriptBlock,
  ): TypedTranscriptBlock[] {
    return blocks.map((b) => (b.id === id ? updater(b) : b));
  }

  // Streaming update for the per-token path (text_delta, thinking_delta,
  // tool_execution_update). Returns a *fresh* array (so the `blocks`
  // reference changes — referential integrity for any ref-equality consumer)
  // but copies only the array spine, leaving every element reference except
  // the streamed one untouched. That keeps the React reconcile O(1): the
  // block renderers are React.memo'd on their `data` prop, so only the one
  // changed slot (new `data` ref) re-renders and every unchanged slot (same
  // `data` ref) skips.
  //
  // Why not `updateBlock` (i.e. `.map`)? `.map` runs the callback once per
  // element, which made streaming O(n²) over a long session (the freeze).
  // `blocks.slice()` is a single bulk copy of the spine — far cheaper — and
  // the array is bounded to a few hundred blocks by the compaction trim, so
  // the per-token cost is negligible.
  //
  // We scan from the tail because the active assistant / tool-call block is
  // always among the most recently appended, so the match is found in O(1)
  // for the common case rather than scanning the whole array from the front.
  function patchBlock(
    id: string,
    updater: (b: TypedTranscriptBlock) => TypedTranscriptBlock,
  ): TypedTranscriptBlock[] {
    let idx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.id === id) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return blocks;
    const cur = blocks[idx];
    if (!cur) return blocks;
    const nextBlock = updater(cur);
    if (nextBlock === cur) return blocks;
    const next = blocks.slice();
    next[idx] = nextBlock;
    return next;
  }

  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "agent_end":
    case "turn_end":
    case "queue_update":
    case "auto_retry_start":
    case "auto_retry_end":
    case "extension_error":
      return state;

    case "message_start": {
      const role = event.message?.role;
      if (role === "assistant") {
        const blockId = newBlockId();
        const newBlock: TypedTranscriptBlock = {
          id: blockId,
          type: "assistant",
          data: { role: "assistant", segments: [], isStreaming: true },
        };
        return {
          ...state,
          blocks: [...blocks, newBlock],
          activeAssistantId: blockId,
        };
      }
      if (role === "user") {
        // pi echoes the delivered prompt. We dedupe by *position*, not by
        // exact string equality: an optimistic `addUserBlock` always
        // expects exactly one echo, so we consume the head of
        // `pendingEchoes` whenever one is pending — regardless of whether
        // pi normalized the text (trailing newline, whitespace) or
        // expanded a template/skill. The user's originally-typed
        // optimistic text stands; we never replace it.
        //
        // If there is no pending echo, the message must be
        // server-/extension-originated (slash command dispatched via
        // `prompt` with `commandSource: "extension"`); render the echoed
        // text as a fresh user block.
        if (pendingEchoes.length > 0) {
          return { ...state, pendingEchoes: pendingEchoes.slice(1) };
        }
        const echoed = extractUserText(event.message);
        return echoed !== null ? addUserBlock(state, echoed, undefined, false) : state;
      }
      if (role === "custom") {
        // Match pi's TUI (interactive-mode.js `addMessageToChat` →
        // `case "custom"`): a custom message is rendered ONLY when `display`
        // is truthy — `display` is a boolean visibility gate, NOT the text.
        // The rendered text comes from `content` (pi's CustomMessageComponent
        // renders `message.content`, using `display` only to decide whether
        // to show the block at all). Rendering `display` would print "true"
        // for every legitimate `display: true` custom message — which is
        // exactly the bug that surfaced when an extension sent a custom
        // message with `content: true` and no `display` (the old fallback
        // JSON-stringified `content` → "true").
        const msg = event.message as { display?: unknown; content?: unknown } | undefined;
        if (!msg?.display) return state;
        const content = msg.content;
        let text: string | undefined;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          // Mirror pi's CustomMessageComponent: join text blocks.
          text = content
            .filter(
              (c): c is { type: "text"; text: string } =>
                !!c &&
                typeof c === "object" &&
                (c as { type?: unknown }).type === "text" &&
                typeof (c as { text?: unknown }).text === "string",
            )
            .map((c) => c.text)
            .join("\n");
        }
        // Non-string/non-array content (e.g. a boolean) has no renderable
        // text — skip, matching pi which would likewise produce nothing.
        if (!text) return state;
        const blockId = newBlockId();
        return {
          ...state,
          blocks: [...blocks, { id: blockId, type: "custom_message", data: { content: text } }],
        };
      }
      // Unknown role (toolResult, bashExecution, etc.) — ignore for now;
      // these have their own dedicated event types in the wire.
      return state;
    }

    case "message_update": {
      if (!activeAssistantId || !event.assistantMessageEvent) return state;
      const msgEvent = event.assistantMessageEvent;
      const ci = (msgEvent as { contentIndex?: number | undefined }).contentIndex;

      switch (msgEvent.type) {
        case "text_start":
          // Open a new text segment. contentIndex keys it so later
          // text_delta/text_end for the same content block route here —
          // preserving order when the model interleaves thinking/text.
          return {
            ...state,
            blocks: patchBlock(activeAssistantId, (b) =>
              b.type === "assistant"
                ? { ...b, data: { ...b.data, segments: startSegment(b.data.segments, "text", ci) } }
                : b,
            ),
          };
        case "text_delta":
          return {
            ...state,
            blocks: patchBlock(activeAssistantId, (b) =>
              b.type === "assistant"
                ? {
                    ...b,
                    data: {
                      ...b.data,
                      segments: appendSegmentDelta(b.data.segments, "text", ci, msgEvent.delta),
                    },
                  }
                : b,
            ),
          };
        case "thinking_start":
          return {
            ...state,
            blocks: patchBlock(activeAssistantId, (b) =>
              b.type === "assistant"
                ? {
                    ...b,
                    data: { ...b.data, segments: startSegment(b.data.segments, "thinking", ci) },
                  }
                : b,
            ),
          };
        case "thinking_delta":
          return {
            ...state,
            blocks: patchBlock(activeAssistantId, (b) =>
              b.type === "assistant"
                ? {
                    ...b,
                    data: {
                      ...b.data,
                      segments: appendSegmentDelta(b.data.segments, "thinking", ci, msgEvent.delta),
                    },
                  }
                : b,
            ),
          };
        case "text_end": {
          const content = (msgEvent as { content?: string }).content;
          if (!content) return state;
          return {
            ...state,
            blocks: updateBlock(activeAssistantId, (b) =>
              b.type === "assistant"
                ? {
                    ...b,
                    data: { ...b.data, segments: endSegment(b.data.segments, "text", ci, content) },
                  }
                : b,
            ),
          };
        }
        case "thinking_end": {
          const content = (msgEvent as { content?: string }).content;
          if (!content) return state;
          return {
            ...state,
            blocks: updateBlock(activeAssistantId, (b) =>
              b.type === "assistant"
                ? {
                    ...b,
                    data: {
                      ...b.data,
                      segments: endSegment(b.data.segments, "thinking", ci, content),
                    },
                  }
                : b,
            ),
          };
        }
        default:
          return state;
      }
    }

    case "message_end": {
      // Only assistant messages own the streaming state machine; closing a
      // non-assistant stream (user / custom) is a no-op.
      if (event.message?.role !== "assistant") return state;

      const { isError, message: errorMessage } = detectTurnError(event.message);

      // Normal close — just stop streaming on the active assistant block.
      if (!isError) {
        if (!activeAssistantId) return state;
        return {
          ...state,
          blocks: updateBlock(activeAssistantId, (b) => {
            if (b.type !== "assistant") return b;
            return { ...b, data: { ...b.data, isStreaming: false } };
          }),
          activeAssistantId: null,
        };
      }

      // Error close — surface a visible error block. If the active
      // assistant block already accumulated partial text/thinking, keep it
      // (the partial output is still useful context) and append the error
      // block after it. If the block is empty, drop it so the user doesn't
      // see a blank assistant bubble — the error block stands in for it.
      const errorBlock: TypedTranscriptBlock = {
        id: newBlockId(),
        type: "error",
        data: { message: errorMessage },
      };

      if (!activeAssistantId) {
        return { ...state, blocks: [...blocks, errorBlock], activeAssistantId: null };
      }

      const activeIndex = blocks.findIndex((b) => b.id === activeAssistantId);
      const active = activeIndex >= 0 ? blocks[activeIndex] : undefined;
      const hasContent = active?.type === "assistant" && hasAssistantContent(active.data);

      // Insert the error block immediately after the assistant block (rather
      // than at the array end) so the in-session order matches what the
      // history loader reconstructs on reload, even when later blocks (e.g.
      // tool calls) were appended during the turn.
      if (hasContent) {
        const next = updateBlock(activeAssistantId, (b) =>
          b.type === "assistant" ? { ...b, data: { ...b.data, isStreaming: false } } : b,
        );
        next.splice(activeIndex + 1, 0, errorBlock);
        return { ...state, blocks: next, activeAssistantId: null };
      }

      // Drop the empty assistant block; the error block replaces it in place.
      const next = blocks.filter((b) => b.id !== activeAssistantId);
      next.splice(activeIndex, 0, errorBlock);
      return { ...state, blocks: next, activeAssistantId: null };
    }

    case "tool_execution_start": {
      const blockId = newBlockId();
      const newBlock: TypedTranscriptBlock = {
        id: blockId,
        type: "tool_call",
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args as Record<string, unknown> | undefined,
          outputText: "",
          isError: false,
          isStreaming: true,
        },
      };
      const newActiveIds = new Map(activeToolCallIds);
      newActiveIds.set(event.toolCallId, blockId);
      return {
        ...state,
        blocks: [...blocks, newBlock],
        activeToolCallIds: newActiveIds,
      };
    }

    case "tool_execution_update": {
      const blockId = activeToolCallIds.get(event.toolCallId);
      if (!blockId) return state;
      const partialText = extractResultText(event.partialResult);
      const partialDetails = extractResultDetails(event.partialResult);
      const partialDiff = extractResultDiff(event.partialResult);
      const replacesOutput =
        event.partialResult !== null &&
        typeof event.partialResult === "object" &&
        !Array.isArray(event.partialResult);
      return {
        ...state,
        blocks: patchBlock(blockId, (b) => {
          if (b.type !== "tool_call") return b;
          return {
            ...b,
            data: {
              ...b.data,
              outputText: partialText
                ? replacesOutput
                  ? partialText
                  : b.data.outputText + partialText
                : b.data.outputText,
              diff: b.data.diff ?? partialDiff,
              resultDetails: partialDetails
                ? { ...b.data.resultDetails, ...partialDetails }
                : b.data.resultDetails,
            },
          };
        }),
      };
    }

    case "tool_execution_end": {
      const blockId = activeToolCallIds.get(event.toolCallId);
      if (!blockId) return state;
      const newActiveIds = new Map(activeToolCallIds);
      newActiveIds.delete(event.toolCallId);
      const resultText = extractResultText(event.result);
      const resultDiff = extractResultDiff(event.result);
      const resultDetails = extractResultDetails(event.result);
      return {
        ...state,
        blocks: updateBlock(blockId, (b) => {
          if (b.type !== "tool_call") return b;
          return {
            ...b,
            data: {
              ...b.data,
              isStreaming: false,
              isError: event.isError,
              outputText: resultText || b.data.outputText,
              diff: resultDiff ?? b.data.diff,
              resultDetails: resultDetails
                ? { ...b.data.resultDetails, ...resultDetails }
                : b.data.resultDetails,
            },
          };
        }),
        activeToolCallIds: newActiveIds,
      };
    }

    case "compaction_start":
      return state;

    case "compaction_end": {
      const blockId = newBlockId();
      const newCompactionBlock: TypedTranscriptBlock = {
        id: blockId,
        type: "compaction",
        data: {
          summary: event.result?.summary,
          reason: event.reason,
          tokensBefore: event.result?.tokensBefore,
          firstKeptEntryId: event.result?.firstKeptEntryId,
          aborted: event.aborted,
          willRetry: event.willRetry,
          errorMessage: event.errorMessage,
        },
      };
      // Bound the in-memory transcript at the compaction boundary. Find the
      // most recent existing compaction marker; everything before it has
      // already been summarised by that compaction and is dropped — the live
      // session no longer needs it (pi has the summary, and reload from the
      // session file restores the full history). On the first compaction
      // (no prior marker) keep a recent window (MAX_PRE_COMPACTION_KEEP) so
      // the user can still scroll back through the just-compacted context.
      let lastCompactionIdx = -1;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b?.type === "compaction") {
          lastCompactionIdx = i;
          break;
        }
      }
      const kept =
        lastCompactionIdx >= 0
          ? blocks.slice(lastCompactionIdx)
          : blocks.slice(Math.max(0, blocks.length - MAX_PRE_COMPACTION_KEEP));
      return { ...state, blocks: [...kept, newCompactionBlock] };
    }

    case "thinking_level_changed":
      // The thinking level lives on the session record in the store, not on
      // the transcript. Acknowledging the event here keeps the reducer total
      // so `applyEvent` in sessions-store can read `event.level` safely.
      return state;

    case "session_info_changed":
      // The session name lives on the session record in the store, not on
      // the transcript. Acknowledging the event here keeps the reducer total
      // so `applyEvent` in sessions-store can read `event.name` safely.
      return state;

    default:
      return assertNever(event);
  }
}

// User sends a prompt — add user block immediately.
//
// `registerEcho` is true for plain Composer text submissions, where the
// optimistic block is the user's own text and pi will echo it back via
// `message_start` with `role: "user"`. We register the text in
// `pendingEchoes` so the reducer can suppress the duplicate echo.
//
// `registerEcho` is false for extension-originated prompts (slash
// commands dispatched via `prompt` with `commandSource: "extension"`),
// which the Composer does not optimistically render; the message_start
// echo is the first and only user block in those cases.
export function addUserBlock(
  state: TranscriptState,
  content: string,
  images?: string[],
  registerEcho = false,
): TranscriptState {
  const blockId = newBlockId();
  return {
    ...state,
    blocks: [
      ...state.blocks,
      { id: blockId, type: "user", data: { role: "user", content, images } },
    ],
    pendingEchoes: registerEcho ? [...state.pendingEchoes, content] : state.pendingEchoes,
  };
}

export function clearPendingUserEcho(state: TranscriptState, content: string): TranscriptState {
  const index = state.pendingEchoes.indexOf(content);
  let pendingEchoes = state.pendingEchoes;
  if (index !== -1) {
    pendingEchoes = [
      ...state.pendingEchoes.slice(0, index),
      ...state.pendingEchoes.slice(index + 1),
    ];
  }

  // A failed prompt/steer never reaches pi, so remove the optimistic user
  // bubble as well as its echo token. Prefer the tail-most matching user block:
  // it is the just-submitted optimistic block, while older identical prompts
  // are legitimate history.
  const blockIndex = [...state.blocks]
    .reverse()
    .findIndex((block) => block.type === "user" && block.data.content === content);
  if (blockIndex === -1) {
    return pendingEchoes === state.pendingEchoes ? state : { ...state, pendingEchoes };
  }
  const removeIndex = state.blocks.length - 1 - blockIndex;
  return {
    ...state,
    pendingEchoes,
    blocks: [...state.blocks.slice(0, removeIndex), ...state.blocks.slice(removeIndex + 1)],
  };
}

// User sends a bash command
export function addBashBlock(state: TranscriptState, command: string): TranscriptState {
  const blockId = newBlockId();
  return {
    ...state,
    blocks: [
      ...state.blocks,
      { id: blockId, type: "bash", data: { command, outputText: "", isStreaming: true } },
    ],
    activeBashId: blockId,
  };
}

// Append a custom_message block. Used by /session (TUI parity — the TUI
// renders session info inside the chat, not as a toast) and by any future
// renderer-initiated info block.
export function addCustomMessageBlock(state: TranscriptState, content: string): TranscriptState {
  const blockId = newBlockId();
  return {
    ...state,
    blocks: [...state.blocks, { id: blockId, type: "custom_message", data: { content } }],
  };
}

// Bash command finished — the output arrives in the RPC response, not as events
export function finishBashBlock(
  state: TranscriptState,
  output: string,
  exitCode?: number,
): TranscriptState {
  const id = state.activeBashId;
  if (!id) return state;
  return {
    ...state,
    blocks: state.blocks.map((b) =>
      b.id === id && b.type === "bash"
        ? { ...b, data: { ...b.data, outputText: output, isStreaming: false, exitCode } }
        : b,
    ),
    activeBashId: null,
  };
}
