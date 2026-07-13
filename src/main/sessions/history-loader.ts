import fs from "node:fs";
import { createReadStream } from "node:fs";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
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
export function entriesToTranscript(
  orderedEntries: Array<Record<string, unknown>>,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];

  for (const rawEntry of orderedEntries) {
    const parsed = SessionEntrySchema.safeParse(rawEntry);
    if (!parsed.success) continue;
    const entry = parsed.data;

    if ("__unknown" in entry) continue;

    switch (entry.type) {
      case "compaction": {
        blocks.push({
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
        blocks.push({
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
          // Extract result text from toolResult content array
          let outputText = "";
          if (typeof content === "string") {
            outputText = content;
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (
                typeof part === "object" &&
                part !== null &&
                (part as Record<string, unknown>)["type"] === "text"
              ) {
                outputText += ((part as Record<string, unknown>)["text"] as string) ?? "";
              }
            }
          }
          // Find the matching tool_call block (created from the preceding assistant message)
          const toolCallId = msg.toolCallId;
          let matched = false;
          if (toolCallId) {
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (
                b?.type === "tool_call" &&
                (b.data as Record<string, unknown>)["toolCallId"] === toolCallId
              ) {
                (b.data as Record<string, unknown>)["outputText"] = outputText;
                if (msg.details && typeof msg.details === "object") {
                  const details = msg.details as Record<string, unknown>;
                  (b.data as Record<string, unknown>)["resultDetails"] = details;
                  if (typeof details.diff === "string") {
                    (b.data as Record<string, unknown>)["diff"] = details.diff;
                  }
                }
                (b.data as Record<string, unknown>)["isError"] = msg.isError ?? false;
                (b.data as Record<string, unknown>)["isStreaming"] = false;
                matched = true;
                break;
              }
            }
          }
          if (!matched) {
            // Standalone tool result with no prior toolCall block — create one
            blocks.push({
              id: entry.id,
              type: "tool_call",
              data: {
                toolCallId: toolCallId ?? "",
                toolName: msg.toolName ?? "",
                input: undefined,
                outputText,
                resultDetails:
                  msg.details && typeof msg.details === "object"
                    ? (msg.details as Record<string, unknown>)
                    : undefined,
                diff:
                  msg.details &&
                  typeof msg.details === "object" &&
                  typeof (msg.details as Record<string, unknown>).diff === "string"
                    ? ((msg.details as Record<string, unknown>).diff as string)
                    : undefined,
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
          blocks.push({
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
            blocks.push({
              id: entry.id,
              type: "error",
              data: { message: errorMessage },
            });
            break;
          }
          if (hasAssistantText) {
            blocks.push({
              id: entry.id,
              type: "assistant",
              data: { role: "assistant", segments },
            });
          }
          if (isError) {
            blocks.push({
              id: `${entry.id}-error`,
              type: "error",
              data: { message: errorMessage },
            });
          }
          for (const tc of toolCalls) {
            blocks.push({
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
          blocks.push({
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
          blocks.push({
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

  // Candidate leaves: entries not referenced as parent
  const leaves = Array.from(entries.values()).filter(
    (e) => typeof e["id"] === "string" && !hasChild.has(e["id"] as string),
  );

  // Pick the leaf with highest timestamp. Real pi writes entry-level
  // timestamps as ISO strings, so accept both shapes here.
  const leaf = leaves.sort((a, b) => entryTime(b) - entryTime(a))[0];

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

export async function loadHistory(filePath: string): Promise<TranscriptBlock[]> {
  if (!fs.existsSync(filePath)) return [];
  const stat = await fs.promises.stat(filePath);
  const mtimeMs = stat.mtimeMs;
  const cached = historyCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === stat.size) {
    // Refresh insertion order so Map acts as a tiny LRU.
    historyCache.delete(filePath);
    historyCache.set(filePath, cached);
    return cached.blocks;
  }
  if (cached) historyCache.delete(filePath);

  const { header, entries } = await parseEntries(filePath);
  if (!header) return [];

  const headerResult = SessionHeaderSchema.safeParse(header);
  if (!headerResult.success) return [];

  const chain = walkActiveChain(entries);
  // Compaction bounds Pi's active model context; it must not erase GUI
  // scrollback. Convert the complete persisted branch, including messages
  // before compaction markers.
  const blocks = entriesToTranscript(chain);
  historyCache.set(filePath, { mtimeMs, size: stat.size, blocks });
  while (historyCache.size > MAX_CACHED_HISTORY_FILES) {
    const oldest = historyCache.keys().next().value;
    if (oldest === undefined) break;
    historyCache.delete(oldest);
  }
  return blocks;
}
