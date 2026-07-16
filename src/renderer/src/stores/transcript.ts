import type { TranscriptBlock } from "@shared/ipc-contract.js";
import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import { extractToolResult } from "@shared/pi-protocol/tool-result.js";
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
  interrupted?: boolean | undefined;
}

export interface BashBlockData {
  command: string;
  outputText: string;
  isStreaming: boolean;
  interrupted?: boolean | undefined;
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

export interface CustomEntryBlockData {
  entryId: string;
  customType: string;
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
  /** Transient provider failure followed by an automatic retry. */
  retryable?: boolean | undefined;
}

export type TypedTranscriptBlock =
  | { id: string; type: "user"; data: UserBlockData }
  | { id: string; type: "assistant"; data: AssistantBlockData }
  | { id: string; type: "tool_call"; data: ToolCallBlockData }
  | { id: string; type: "bash"; data: BashBlockData }
  | { id: string; type: "compaction"; data: CompactionBlockData }
  | { id: string; type: "custom_message"; data: CustomMessageBlockData }
  | { id: string; type: "custom_entry"; data: CustomEntryBlockData }
  | { id: string; type: "error"; data: ErrorBlockData };

let blockCounter = 0;
function newBlockId(): string {
  return `blk-${++blockCounter}`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return Math.round(tokens).toLocaleString();
}

export interface TranscriptState {
  /** Immutable historical chunks. Successful compaction and history loading
   * move blocks here so streaming only copies the small mutable live tail. */
  archivedBlockChunks: TypedTranscriptBlock[][];
  /** Cached aggregate keeps hot count/viewport selectors O(1). */
  archivedBlockCount: number;
  /** Blocks created since the latest archive boundary. */
  blocks: TypedTranscriptBlock[];
  // active ids for streaming
  activeAssistantId: string | null;
  activeToolCallIds: Map<string, string>; // toolCallId → blockId
  activeBashId: string | null;
  /** Error block created by the current failed assistant turn, awaiting the
   * following agent_end to tell us whether it will be retried. This scopes
   * retryable marking to the current turn and prevents relabeling older final
   * errors when a retry event arrives without a fresh message_end error. */
  pendingRetryErrorBlockId: string | null;
  /** Accepted queued prompts whose optimistic bubble owns the eventual echo.
   * Host-decorated intent identity, never text, transfers that ownership. */
  pendingEchoes: Array<{ intentId: string; blockId: string; content: string }>;
  /** Monotonic count plus a bounded ledger of authoritative user echoes.
   * Submission custody can cross renderer IPC after its message_start; the
   * ledger lets a queued acknowledgement reconcile that legal ordering. */
  userMessageSequence: number;
  authoritativeUserEchoes: Array<{
    sequence: number;
    intentId?: string | undefined;
    content: string;
    images: string[] | undefined;
  }>;
}

export function createTranscriptState(): TranscriptState {
  return {
    archivedBlockChunks: [],
    archivedBlockCount: 0,
    blocks: [],
    activeAssistantId: null,
    activeToolCallIds: new Map(),
    activeBashId: null,
    pendingRetryErrorBlockId: null,
    pendingEchoes: [],
    userMessageSequence: 0,
    authoritativeUserEchoes: [],
  };
}

export function transcriptBlockCount(state: TranscriptState): number {
  return state.archivedBlockCount + state.blocks.length;
}

export function transcriptHasBlocks(state: TranscriptState): boolean {
  return transcriptBlockCount(state) > 0;
}

export function lastTranscriptBlock(state: TranscriptState): TypedTranscriptBlock | undefined {
  const live = state.blocks.at(-1);
  if (live) return live;
  for (let index = state.archivedBlockChunks.length - 1; index >= 0; index -= 1) {
    const block = state.archivedBlockChunks[index]?.at(-1);
    if (block) return block;
  }
  return undefined;
}

/** Flatten only for explicit full-history consumers. Hot streaming views keep
 * immutable archive chunks separate from the mutable live tail. */
export function allTranscriptBlocks(state: TranscriptState): TypedTranscriptBlock[] {
  return [...state.archivedBlockChunks.flat(), ...state.blocks];
}

function replaceUserBlockById(
  state: TranscriptState,
  id: string,
  content: string,
  images: string[] | undefined,
): Pick<TranscriptState, "archivedBlockChunks" | "blocks"> & { replaced: boolean } {
  const unchanged = {
    archivedBlockChunks: state.archivedBlockChunks,
    blocks: state.blocks,
    replaced: false,
  };
  const liveIndex = state.blocks.findIndex((block) => block.id === id);
  if (liveIndex >= 0) {
    const block = state.blocks[liveIndex];
    if (block?.type !== "user") return unchanged;
    const blocks = state.blocks.slice();
    blocks[liveIndex] = { ...block, data: { role: "user", content, images } };
    return { archivedBlockChunks: state.archivedBlockChunks, blocks, replaced: true };
  }
  for (let chunkIndex = state.archivedBlockChunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
    const chunk = state.archivedBlockChunks[chunkIndex];
    const blockIndex = chunk?.findIndex((block) => block.id === id) ?? -1;
    if (!chunk || blockIndex < 0) continue;
    const block = chunk[blockIndex];
    if (block?.type !== "user") return unchanged;
    const nextChunk = chunk.slice();
    nextChunk[blockIndex] = { ...block, data: { role: "user", content, images } };
    const archivedBlockChunks = state.archivedBlockChunks.slice();
    archivedBlockChunks[chunkIndex] = nextChunk;
    return { archivedBlockChunks, blocks: state.blocks, replaced: true };
  }
  return unchanged;
}

function transcriptHasBlockId(state: TranscriptState, id: string): boolean {
  return (
    state.blocks.some((block) => block.id === id) ||
    state.archivedBlockChunks.some((chunk) => chunk.some((block) => block.id === id))
  );
}

export function finalizeActiveBlocks(
  state: TranscriptState,
  opts: { markInterrupted?: boolean } = {},
): TranscriptState {
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
          ? {
              ...block,
              data: {
                ...block.data,
                isStreaming: false,
                interrupted: opts.markInterrupted ? true : block.data.interrupted,
              },
            }
          : block;
      case "bash":
        return block.data.isStreaming
          ? {
              ...block,
              data: {
                ...block.data,
                isStreaming: false,
                interrupted: opts.markInterrupted ? true : block.data.interrupted,
              },
            }
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

export function mapHistoryBlocks(history: TranscriptBlock[]): TypedTranscriptBlock[] {
  return history
    .map((b): TypedTranscriptBlock | null => {
      // History is persisted data and can be malformed by older extensions or
      // interrupted writes. Treat non-record data as an empty record rather
      // than allowing property access below to throw.
      const d =
        b.data && typeof b.data === "object" && !Array.isArray(b.data)
          ? (b.data as Record<string, unknown>)
          : {};
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
          segments = segs
            .map((segment): AssistantSegment | null => {
              if (!segment || typeof segment !== "object" || Array.isArray(segment)) return null;
              const s = segment as Record<string, unknown>;
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
            // History is an idle baseline, so a persisted streaming claim is
            // an interrupted operation rather than a live tool call.
            isStreaming: false,
            interrupted: d.interrupted === true || d.isStreaming === true ? true : undefined,
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
            // History is an idle baseline, so a persisted streaming claim is
            // an interrupted operation rather than a live bash command.
            isStreaming: false,
            interrupted: d.interrupted === true || d.isStreaming === true ? true : undefined,
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
      if (b.type === "custom_entry") {
        const entryId = typeof d.entryId === "string" ? d.entryId : b.id;
        if (typeof d.customType !== "string") return null;
        return { id: b.id, type: "custom_entry", data: { entryId, customType: d.customType } };
      }
      if (b.type === "error") {
        return {
          id: b.id,
          type: "error",
          data: {
            message: (d.message as string) ?? "",
            retryable: d.retryable as boolean | undefined,
          },
        };
      }
      // Unknown block type — drop it instead of synthesising an empty
      // user bubble, which would be confusing to the user.
      return null;
    })
    .filter((b): b is TypedTranscriptBlock => b !== null);
}

export function seedFromHistory(
  state: TranscriptState,
  history: TranscriptBlock[],
): TranscriptState {
  const blocks = mapHistoryBlocks(history);
  return {
    ...state,
    archivedBlockChunks: blocks.length > 0 ? [blocks] : [],
    archivedBlockCount: blocks.length,
    blocks: [],
    // A history seed is a complete presentation baseline, not an incremental
    // merge with a potentially stale stream from the prior session view.
    activeAssistantId: null,
    activeToolCallIds: new Map(),
    activeBashId: null,
    pendingRetryErrorBlockId: null,
    pendingEchoes: [],
    authoritativeUserEchoes: [],
  };
}

/** Extract text and attachment data from Pi's authoritative user message. */
function extractUserMessage(
  message: unknown,
): { content: string; images: string[] | undefined } | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return { content, images: undefined };
  if (!Array.isArray(content)) return null;
  const textParts: string[] = [];
  const images: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const part = block as {
      type?: unknown;
      text?: unknown;
      data?: unknown;
      mimeType?: unknown;
    };
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    } else if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    ) {
      images.push(`data:${part.mimeType};base64,${part.data}`);
    }
  }
  if (textParts.length === 0 && images.length === 0) return null;
  return {
    content: textParts.join(""),
    images: images.length > 0 ? images : undefined,
  };
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
  if (contentIndex === undefined) {
    const last = segments.at(-1);
    // Providers that omit contentIndex can still replay an immediate start.
    // Reuse only the still-empty tail segment; once content exists, a later
    // same-kind start is a legitimate new ordered block.
    if (last?.kind === kind && last.content === "" && last.contentIndex === undefined) {
      return segments;
    }
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
  const {
    blocks,
    activeAssistantId,
    activeToolCallIds,
    activeBashId,
    pendingRetryErrorBlockId,
    pendingEchoes,
  } = state;

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
  // `blocks.slice()` is a single bulk copy of the spine — far cheaper than
  // invoking a mapping callback for every element.
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
    case "agent_end": {
      if (!event.willRetry) return { ...state, pendingRetryErrorBlockId: null };
      if (!pendingRetryErrorBlockId) return state;
      let idx = -1;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i]?.id === pendingRetryErrorBlockId) {
          idx = i;
          break;
        }
      }
      const block = idx >= 0 ? blocks[idx] : undefined;
      if (!block || block.type !== "error" || block.data.retryable) {
        return { ...state, pendingRetryErrorBlockId: null };
      }
      const next = blocks.slice();
      next[idx] = { ...block, data: { ...block.data, retryable: true } };
      return { ...state, blocks: next, pendingRetryErrorBlockId: null };
    }
    case "agent_start":
      return { ...state, pendingRetryErrorBlockId: null };
    case "agent_settled":
    case "turn_start":
    case "turn_end":
    case "queue_update":
    case "auto_retry_start":
    case "auto_retry_end":
    case "extension_error":
      return state;

    case "cache_miss_notice": {
      if (transcriptHasBlockId(state, event.noticeId)) return state;
      let label = "Cache miss";
      if (event.modelChanged) label = "Cache miss after model switch";
      else if (event.idleMs >= 5 * 60_000) {
        label = `Cache miss after ${Math.round(event.idleMs / 60_000)}m idle`;
      }
      const cost = event.missedCost >= 0.01 ? ` (~$${event.missedCost.toFixed(2)})` : "";
      const content = `${label}: ${formatCompactTokens(event.missedTokens)} tokens re-billed${cost}`;
      const block: TypedTranscriptBlock = {
        id: event.noticeId,
        type: "custom_message",
        data: { content },
      };
      if (!event.afterEntryId) return { ...state, blocks: [...blocks, block] };

      const toolPrefix = `${event.afterEntryId}-tool-`;
      const matchesAnchor = (candidate: TypedTranscriptBlock) =>
        candidate.id === event.afterEntryId || candidate.id.startsWith(toolPrefix);
      let anchorIndex = -1;
      for (let index = 0; index < blocks.length; index += 1) {
        const candidate = blocks[index];
        if (candidate && matchesAnchor(candidate)) anchorIndex = index;
      }
      if (anchorIndex >= 0) {
        return {
          ...state,
          blocks: [...blocks.slice(0, anchorIndex + 1), block, ...blocks.slice(anchorIndex + 1)],
        };
      }
      for (
        let chunkIndex = state.archivedBlockChunks.length - 1;
        chunkIndex >= 0;
        chunkIndex -= 1
      ) {
        const chunk = state.archivedBlockChunks[chunkIndex];
        if (!chunk) continue;
        let archivedAnchorIndex = -1;
        for (let index = 0; index < chunk.length; index += 1) {
          const candidate = chunk[index];
          if (candidate && matchesAnchor(candidate)) archivedAnchorIndex = index;
        }
        if (archivedAnchorIndex < 0) continue;
        const chunks = state.archivedBlockChunks.slice();
        chunks[chunkIndex] = [
          ...chunk.slice(0, archivedAnchorIndex + 1),
          block,
          ...chunk.slice(archivedAnchorIndex + 1),
        ];
        return {
          ...state,
          archivedBlockChunks: chunks,
          archivedBlockCount: state.archivedBlockCount + 1,
        };
      }
      // The notice belongs to an entry outside the current transcript (for
      // example after branch navigation). A later history seed can replay it
      // once the assistant anchor is present.
      return state;
    }

    case "entry_appended": {
      const entry = event.entry;
      if (entry.type !== "custom" || typeof entry.customType !== "string") return state;
      if (transcriptHasBlockId(state, entry.id)) return state;
      const block: TypedTranscriptBlock = {
        id: entry.id,
        type: "custom_entry",
        data: { entryId: entry.id, customType: entry.customType },
      };
      // Pi persists the assistant message only after message_end. If an
      // extension appends an entry while that message is streaming, file order
      // places the custom entry before the assistant; mirror Pi 0.80.4's TUI.
      const assistantIndex = activeAssistantId
        ? blocks.findIndex((candidate) => candidate.id === activeAssistantId)
        : -1;
      if (assistantIndex < 0) return { ...state, blocks: [...blocks, block] };
      return {
        ...state,
        blocks: [...blocks.slice(0, assistantIndex), block, ...blocks.slice(assistantIndex)],
      };
    }

    case "message_start": {
      const role = event.message?.role;
      if (role === "assistant") {
        // message_start may be replayed. The existing stream owns subsequent
        // deltas, so creating another block here would orphan the first one.
        if (activeAssistantId) return state;
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
        // Pi echoes a queued prompt only when it is delivered. Match that
        // event to its optimistic token without allowing an unrelated
        // server-/extension-originated user event to consume the token.
        const echoed = extractUserMessage(event.message);
        if (echoed === null) return state;
        const sequence = state.userMessageSequence + 1;
        const authoritativeState: TranscriptState = {
          ...state,
          userMessageSequence: sequence,
          authoritativeUserEchoes: [
            ...state.authoritativeUserEchoes,
            {
              sequence,
              intentId: event.queueIntentId,
              content: echoed.content,
              images: echoed.images,
            },
          ].slice(-256),
        };
        const pendingIndex = event.queueIntentId
          ? pendingEchoes.findIndex((pending) => pending.intentId === event.queueIntentId)
          : -1;
        if (pendingIndex !== -1) {
          const pending = pendingEchoes[pendingIndex]!;
          const replaced = replaceUserBlockById(
            state,
            pending.blockId,
            echoed.content,
            echoed.images,
          );
          const nextPendingEchoes = [
            ...pendingEchoes.slice(0, pendingIndex),
            ...pendingEchoes.slice(pendingIndex + 1),
          ];
          const { replaced: didReplace, ...replacementState } = replaced;
          if (didReplace) {
            return {
              ...authoritativeState,
              ...replacementState,
              // The existing optimistic bubble consumed this echo. Do not
              // leave it claimable by a later submission acknowledgement.
              authoritativeUserEchoes: state.authoritativeUserEchoes,
              pendingEchoes: nextPendingEchoes,
            };
          }
          // The optimistic block may have been removed while its queued
          // intent was in flight. Retire the token, but preserve this real
          // echo both on screen and in the authoritative acknowledgement
          // ledger so later IPC cannot mistake it for unseen delivery.
          return addUserBlock(
            { ...authoritativeState, pendingEchoes: nextPendingEchoes },
            echoed.content,
            echoed.images,
            false,
          );
        }
        return addUserBlock(authoritativeState, echoed.content, echoed.images, false);
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
        if (!activeAssistantId) return { ...state, pendingRetryErrorBlockId: null };
        return {
          ...state,
          blocks: updateBlock(activeAssistantId, (b) => {
            if (b.type !== "assistant") return b;
            return { ...b, data: { ...b.data, isStreaming: false } };
          }),
          activeAssistantId: null,
          pendingRetryErrorBlockId: null,
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
        return {
          ...state,
          blocks: [...blocks, errorBlock],
          activeAssistantId: null,
          pendingRetryErrorBlockId: errorBlock.id,
        };
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
        return {
          ...state,
          blocks: next,
          activeAssistantId: null,
          pendingRetryErrorBlockId: errorBlock.id,
        };
      }

      // Drop the empty assistant block; the error block replaces it in place.
      const next = blocks.filter((b) => b.id !== activeAssistantId);
      next.splice(activeIndex, 0, errorBlock);
      return {
        ...state,
        blocks: next,
        activeAssistantId: null,
        pendingRetryErrorBlockId: errorBlock.id,
      };
    }

    case "tool_execution_start": {
      // A duplicate start for an in-flight call must keep the original block
      // as the target for updates/end, rather than replacing its map entry.
      if (activeToolCallIds.has(event.toolCallId)) return state;
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
      const partial = extractToolResult(event.partialResult);
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
              outputText: partial.text
                ? replacesOutput
                  ? partial.text
                  : b.data.outputText + partial.text
                : b.data.outputText,
              diff: b.data.diff ?? partial.diff,
              resultDetails: partial.details
                ? { ...b.data.resultDetails, ...partial.details }
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
      const result = extractToolResult(event.result);
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
              outputText: result.text || b.data.outputText,
              diff: result.diff ?? b.data.diff,
              resultDetails: result.details
                ? { ...b.data.resultDetails, ...result.details }
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
      // A successful compaction is an immutable archive boundary: preserve
      // the old live array by reference and start a small mutable tail at the
      // marker. Failed/retrying attempts are activity only and stay in-tail.
      const succeeded =
        event.aborted !== true && event.willRetry !== true && event.errorMessage === undefined;
      if (!succeeded) return { ...state, blocks: [...blocks, newCompactionBlock] };

      // Compaction establishes an archive boundary. Never archive a live
      // streaming block: terminal events can be absent around compaction, so
      // defensively finalize every active presentation block first.
      const finalized = finalizeActiveBlocks(state);
      const finalizedBlocks = finalized.blocks;
      return {
        ...finalized,
        archivedBlockChunks:
          finalizedBlocks.length > 0
            ? [...state.archivedBlockChunks, finalizedBlocks]
            : state.archivedBlockChunks,
        archivedBlockCount: state.archivedBlockCount + finalizedBlocks.length,
        blocks: [newCompactionBlock],
        pendingRetryErrorBlockId: null,
      };
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

// Add an accepted prompt before its authoritative echo.
//
// `registerEcho` is true for Composer text accepted into Pi's active-turn
// queue. The optimistic block is the user's own text and pi will echo it via
// `message_start` with `role: "user"`. We register its intent and block ID so
// delivery replaces that one bubble with authoritative (possibly transformed)
// content instead of adding a duplicate.
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
  echoIntentId?: string,
): TranscriptState {
  const blockId = newBlockId();
  return {
    ...state,
    blocks: [
      ...state.blocks,
      { id: blockId, type: "user", data: { role: "user", content, images } },
    ],
    pendingEchoes:
      registerEcho && echoIntentId
        ? [...state.pendingEchoes, { intentId: echoIntentId, blockId, content }]
        : state.pendingEchoes,
  };
}

export function retirePendingUserEchoesByIntent(
  state: TranscriptState,
  intentIds: readonly string[],
): TranscriptState {
  if (intentIds.length === 0 || state.pendingEchoes.length === 0) return state;
  const intents = new Set(intentIds);
  const retired = state.pendingEchoes.filter((pending) => intents.has(pending.intentId));
  if (retired.length === 0) return state;
  const blockIds = new Set(retired.map((pending) => pending.blockId));
  let archivedRemoved = 0;
  let archiveChanged = false;
  const archivedBlockChunks = state.archivedBlockChunks.map((chunk) => {
    const filtered = chunk.filter((block) => !blockIds.has(block.id));
    if (filtered.length === chunk.length) return chunk;
    archiveChanged = true;
    archivedRemoved += chunk.length - filtered.length;
    return filtered;
  });
  const blocks = state.blocks.filter((block) => !blockIds.has(block.id));
  return {
    ...state,
    archivedBlockChunks: archiveChanged ? archivedBlockChunks : state.archivedBlockChunks,
    archivedBlockCount: state.archivedBlockCount - archivedRemoved,
    blocks,
    pendingEchoes: state.pendingEchoes.filter((pending) => !intents.has(pending.intentId)),
  };
}

export function clearPendingUserEcho(state: TranscriptState, content: string): TranscriptState {
  const index = state.pendingEchoes.findIndex((pending) => pending.content === content);
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
  if (blockIndex !== -1) {
    const removeIndex = state.blocks.length - 1 - blockIndex;
    return {
      ...state,
      pendingEchoes,
      blocks: [...state.blocks.slice(0, removeIndex), ...state.blocks.slice(removeIndex + 1)],
    };
  }
  for (let chunkIndex = state.archivedBlockChunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
    const chunk = state.archivedBlockChunks[chunkIndex];
    if (!chunk) continue;
    const reverseIndex = [...chunk]
      .reverse()
      .findIndex((block) => block.type === "user" && block.data.content === content);
    if (reverseIndex < 0) continue;
    const removeIndex = chunk.length - 1 - reverseIndex;
    const chunks = state.archivedBlockChunks.slice();
    chunks[chunkIndex] = [...chunk.slice(0, removeIndex), ...chunk.slice(removeIndex + 1)];
    return {
      ...state,
      pendingEchoes,
      archivedBlockChunks: chunks,
      archivedBlockCount: state.archivedBlockCount - 1,
    };
  }
  return pendingEchoes === state.pendingEchoes ? state : { ...state, pendingEchoes };
}

// User sends a bash command
export function addBashBlock(state: TranscriptState, command: string): TranscriptState {
  const blockId = newBlockId();
  // RPC bash execution has no event stream to guarantee an end before the
  // next command begins. Close the old presentation block before replacing
  // its active id so it can never be orphaned as permanently streaming.
  const blocks = state.activeBashId
    ? state.blocks.map((block) =>
        block.id === state.activeBashId && block.type === "bash" && block.data.isStreaming
          ? { ...block, data: { ...block.data, isStreaming: false } }
          : block,
      )
    : state.blocks;
  return {
    ...state,
    blocks: [
      ...blocks,
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
