import fs from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import { extractToolResult } from "@shared/pi-protocol/tool-result.js";
import { detectTurnError } from "@shared/pi-protocol/turn-error.js";
import { SessionEntrySchema, SessionHeaderSchema } from "@shared/session-file/entries.js";

type EntryMap = Map<string, Record<string, unknown>>;

/**
 * Convert an ordered list of session-tree entries (root→leaf, the shape
 * `SessionManager.getBranch()` returns and the shape the host sends back
 * in `navigate_tree`'s response) into the renderer-facing TranscriptBlock[].
 *
 * This is the same conversion that `loadHistory()` runs over the
 * file-derived active chain — extracted so that `/tree`'s navigate path
 * can reuse it without re-reading the session file (which can be stale
 * for freshly-appended entries such as a synthesized `branch_summary`).
 *
 * `orderedEntries` must be in chronological order (oldest first). Tree
 * navigation may supply Pi's compacted active-context branch, while persisted
 * history supplies the complete on-disk branch so transcript scrollback can
 * reach messages that predate a compaction.
 */
export async function entriesToTranscript(
  orderedEntries: Array<Record<string, unknown>>,
): Promise<TranscriptBlock[]> {
  const blocks: TranscriptBlock[] = [];
  const toolCallsById = new Map<string, TranscriptBlock>();
  const pushBlock = (block: TranscriptBlock): void => {
    blocks.push(block);
    if (block.type === "tool_call") {
      const toolCallId = (block.data as Record<string, unknown>)["toolCallId"];
      if (typeof toolCallId === "string") toolCallsById.set(toolCallId, block);
    }
  };
  let processed = 0;

  for (const rawEntry of orderedEntries) {
    processed++;
    if (processed % 500 === 0) await yieldImmediate();

    // These metadata entries never render, so avoid the comparatively
    // expensive schema validation for the common no-op path.
    const rawType = rawEntry["type"];
    if (
      rawType === "label" ||
      rawType === "model_change" ||
      rawType === "thinking_level_change" ||
      rawType === "session_info"
    ) {
      continue;
    }

    const parsed = SessionEntrySchema.safeParse(rawEntry);
    if (!parsed.success) continue;
    const entry = parsed.data;

    if ("__unknown" in entry) continue;

    switch (entry.type) {
      case "compaction": {
        pushBlock({
          id: entry.id,
          type: "compaction",
          data: {
            summary: entry.summary,
            reason: entry.reason,
            tokensBefore: entry.tokensBefore,
            firstKeptEntryId: entry.firstKeptEntryId,
          },
        });
        break;
      }
      case "branch_summary": {
        // Pi synthesizes a branch_summary entry on the new active leaf
        // whenever the user navigates away from a branch with the
        // summarize toggle on. Render the summary text using the existing
        // compaction renderer — the user-facing distinction ("you left
        // this branch; here's a recap") isn't worth a new block type or a
        // transcript.ts change just to expose it (review B2 in the plan).
        pushBlock({
          id: entry.id,
          type: "compaction",
          data: { summary: entry.summary ?? "(empty branch summary)" },
        });
        break;
      }
      case "message": {
        const msg = entry.message;
        const role = msg.role;
        const content = msg.content;

        if (role === "toolResult") {
          // Keep persisted results identical to the live reducer, including
          // newline-separated adjacent text parts and output fallback.
          const result = extractToolResult(msg);
          // Find the matching tool_call block (created from the preceding assistant message)
          const toolCallId = msg.toolCallId;
          const matchingBlock = toolCallId ? toolCallsById.get(toolCallId) : undefined;
          if (matchingBlock) {
            const data = matchingBlock.data as Record<string, unknown>;
            data["outputText"] = result.text;
            data["resultDetails"] = result.details;
            data["diff"] = result.diff;
            data["isError"] = msg.isError ?? false;
            data["isStreaming"] = false;
          } else {
            // Standalone tool result with no prior toolCall block — create one
            pushBlock({
              id: entry.id,
              type: "tool_call",
              data: {
                toolCallId: toolCallId ?? "",
                toolName: msg.toolName ?? "",
                input: undefined,
                outputText: result.text,
                resultDetails: result.details,
                diff: result.diff,
                isError: msg.isError ?? false,
                isStreaming: false,
              },
            });
          }
          break;
        }

        // user or assistant message
        // Build the ordered content-block list. The session file stores
        // content as an ordered array of parts (text/thinking/toolCall), so
        // we map it directly to segments — preserving the model's true output
        // order (e.g. thinking → text → more thinking) rather than demuxing
        // into two flat buckets. toolCall parts are collected separately and
        // emitted as follow-on tool_call blocks.
        const segments: Array<
          { kind: "thinking"; content: string } | { kind: "text"; content: string }
        > = [];
        const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];

        if (typeof content === "string") {
          segments.push({ kind: "text", content });
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part !== "object" || part === null) continue;
            const p = part as Record<string, unknown>;
            if (p["type"] === "text") {
              segments.push({ kind: "text", content: (p["text"] as string) ?? "" });
            } else if (p["type"] === "thinking") {
              segments.push({ kind: "thinking", content: (p["thinking"] as string) ?? "" });
            } else if (p["type"] === "toolCall") {
              toolCalls.push({
                id: p["id"] as string,
                name: p["name"] as string,
                arguments: p["arguments"],
              });
            }
          }
        }

        const hasAssistantText = segments.some((s) => s.content.length > 0);

        if (role === "user") {
          pushBlock({
            id: entry.id,
            type: "user",
            data: {
              role: "user",
              content:
                segments
                  .filter((s) => s.kind === "text")
                  .map((s) => s.content)
                  .join("") || "",
            },
          });
        } else {
          // assistant: emit assistant block, then tool_call blocks for each tool call.
          // A failed provider turn is recorded by pi with `stopReason: "error"`
          // (and usually an `errorMessage`) and empty content. Surface that as a
          // visible error block instead of a blank assistant bubble so the cause
          // of a "stream just stopped" is obvious on reload.
          const { isError, message: errorMessage } = detectTurnError(msg);
          if (isError && !hasAssistantText) {
            pushBlock({
              id: entry.id,
              type: "error",
              data: { message: errorMessage },
            });
            break;
          }
          if (hasAssistantText) {
            pushBlock({
              id: entry.id,
              type: "assistant",
              data: { role: "assistant", segments },
            });
          }
          if (isError) {
            pushBlock({
              id: `${entry.id}-error`,
              type: "error",
              data: { message: errorMessage },
            });
          }
          for (const tc of toolCalls) {
            pushBlock({
              id: `${entry.id}-tool-${tc.id}`,
              type: "tool_call",
              data: {
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.arguments as Record<string, unknown> | undefined,
                outputText: "", // filled in by subsequent toolResult
                isError: false,
                isStreaming: true,
              },
            });
          }
        }
        break;
      }
      case "custom_message": {
        // Match the live reducer (transcript.ts) and pi's TUI: render only
        // when `display` is truthy. `display` is a boolean visibility gate;
        // `content` is the text. The old `display !== false` gate rendered
        // entries pi's own TUI hides (display absent). Truthy (not
        // `=== true`) so a truthy non-boolean `display` from an extension is
        // handled the same as in the live path.
        if (entry.display && entry.content) {
          pushBlock({
            id: entry.id,
            type: "custom_message",
            data: { content: entry.content },
          });
        }
        break;
      }
      case "custom": {
        // Pi >= 0.80.4 extensions can pair appendEntry(customType, data) with
        // registerEntryRenderer(). Preserve the entry in transcript history;
        // the renderer asks the live SDK host to run that pi-tui renderer at
        // the current column width. Entries with no renderer resolve hidden.
        if (typeof entry.customType === "string") {
          pushBlock({
            id: entry.id,
            type: "custom_entry",
            data: { entryId: entry.id, customType: entry.customType },
          });
        }
        break;
      }
      case "label":
      case "model_change":
      case "thinking_level_change":
      case "session_info":
        break;
    }
  }

  // Persisted history is only hydrated once the runtime is idle, so any
  // unresolved tool call is an interrupted turn, never a live one. Sweep the
  // blocks rather than toolCallsById because duplicate ids shadow older calls.
  for (const block of blocks) {
    if (block.type !== "tool_call") continue;
    const data = block.data as Record<string, unknown>;
    if (data["isStreaming"] === true) {
      data["isStreaming"] = false;
      data["interrupted"] = true;
    }
  }

  return blocks;
}

function entryTime(e: Record<string, unknown>): number {
  const t = e["timestamp"];
  if (typeof t === "number") return t;
  if (typeof t === "string") {
    const p = Date.parse(t);
    return Number.isNaN(p) ? 0 : p;
  }
  return 0;
}

async function parseEntries(filePath: string): Promise<{
  header: Record<string, unknown> | null;
  entries: EntryMap;
}> {
  const entries: EntryMap = new Map();
  let header: Record<string, unknown> | null = null;
  let firstLine = true;
  let pending = "";
  let lines = 0;

  for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (firstLine) {
            header = obj;
            firstLine = false;
          } else {
            const id = obj["id"];
            if (typeof id === "string") entries.set(id, obj);
          }
        } catch {
          /* skip */
        }
      }
      lines++;
      if (lines % 2000 === 0) await yieldImmediate();
      newline = pending.indexOf("\n");
    }
  }

  if (pending.trim()) {
    try {
      const obj = JSON.parse(pending) as Record<string, unknown>;
      if (firstLine) header = obj;
      else {
        const id = obj["id"];
        if (typeof id === "string") entries.set(id, obj);
      }
    } catch {
      /* skip */
    }
  }

  return { header, entries };
}

// v1 fallback: walk from last entry to root via parentId, then reverse
// Known limitation: may not be the active leaf after forks/tree navigation
function walkActiveChain(entries: EntryMap): Array<Record<string, unknown>> {
  // Find all entry ids referenced as a parentId (these are NOT leaves)
  const hasChild = new Set<string>();
  for (const entry of entries.values()) {
    const parent = entry["parentId"];
    if (typeof parent === "string") {
      hasChild.add(parent);
    }
  }

  // Pick the candidate leaf with the highest timestamp in one pass. Sorting
  // every leaf allocated another O(file-size) array and made fork-heavy files
  // O(leaves log leaves) in one non-yielding main-process step.
  let leaf: Record<string, unknown> | undefined;
  let leafTimestamp = Number.NEGATIVE_INFINITY;
  for (const entry of entries.values()) {
    const id = entry["id"];
    if (typeof id !== "string" || hasChild.has(id)) continue;
    const timestamp = entryTime(entry);
    if (!leaf || timestamp > leafTimestamp) {
      leaf = entry;
      leafTimestamp = timestamp;
    }
  }

  if (!leaf) return [];

  const chain: Array<Record<string, unknown>> = [];
  let cur: Record<string, unknown> | undefined = leaf;
  const visited = new Set<string>();

  while (cur) {
    const id = cur["id"];
    if (typeof id !== "string" || visited.has(id)) break;
    visited.add(id);
    chain.push(cur);
    const parentId: unknown = cur["parentId"];
    cur = typeof parentId === "string" ? entries.get(parentId) : undefined;
  }

  return chain.reverse();
}

// Converted histories can be tens of megabytes. Keep only a small working set
// so opening many long sessions cannot retain every complete JSONL branch in
// the main process indefinitely.
const MAX_CACHED_HISTORY_FILES = 3;
const historyCache = new Map<
  string,
  {
    mtimeMs: number;
    size: number;
    blocks: TranscriptBlock[];
  }
>();

const inFlightHistoryLoads = new Map<string, Promise<TranscriptBlock[]>>();

export function loadHistory(filePath: string): Promise<TranscriptBlock[]> {
  const cacheKey = path.resolve(filePath);
  const inFlight = inFlightHistoryLoads.get(cacheKey);
  if (inFlight) return inFlight;

  let cacheEntry:
    | {
        mtimeMs: number;
        size: number;
        blocks: TranscriptBlock[];
      }
    | undefined;
  const load = (async (): Promise<TranscriptBlock[]> => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(cacheKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const mtimeMs = stat.mtimeMs;
    const cached = historyCache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === stat.size) {
      // Refresh insertion order so Map acts as a tiny LRU.
      historyCache.delete(cacheKey);
      historyCache.set(cacheKey, cached);
      return cached.blocks;
    }
    if (cached) historyCache.delete(cacheKey);

    const { header, entries } = await parseEntries(cacheKey);
    if (!header) return [];

    const headerResult = SessionHeaderSchema.safeParse(header);
    if (!headerResult.success) return [];

    const chain = walkActiveChain(entries);
    // Compaction bounds Pi's active model context; it must not erase GUI
    // scrollback. Convert the complete persisted branch, including messages
    // before compaction markers.
    const blocks = await entriesToTranscript(chain);
    cacheEntry = { mtimeMs, size: stat.size, blocks };
    return blocks;
  })();

  // Cache publication happens before in-flight retirement. Otherwise a caller
  // resumed from the shared raw promise can arrive in the microtask between
  // deletion and cache insertion and start a duplicate full-file conversion.
  const managed = load
    .then((blocks) => {
      if (cacheEntry) {
        historyCache.set(cacheKey, cacheEntry);
        while (historyCache.size > MAX_CACHED_HISTORY_FILES) {
          const oldest = historyCache.keys().next().value;
          if (oldest === undefined) break;
          historyCache.delete(oldest);
        }
      }
      return blocks;
    })
    .finally(() => {
      if (inFlightHistoryLoads.get(cacheKey) === managed) {
        inFlightHistoryLoads.delete(cacheKey);
      }
    });
  inFlightHistoryLoads.set(cacheKey, managed);
  return managed;
}
