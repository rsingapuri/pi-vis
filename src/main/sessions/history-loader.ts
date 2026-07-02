import fs from "node:fs";
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
 * `orderedEntries` must be in chronological order (oldest first) and must
 * have pre-compaction entries already stripped (i.e. the chain should start
 * at or after `firstKeptEntryId`). `SessionManager.getBranch()` does this
 * automatically; for file-derived chains use `trimPreCompaction()` first.
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
      case "custom":
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

function parseEntries(filePath: string): {
  header: Record<string, unknown> | null;
  entries: EntryMap;
} {
  const entries: EntryMap = new Map();
  let header: Record<string, unknown> | null = null;
  let firstLine = true;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (firstLine) {
        header = obj;
        firstLine = false;
        continue;
      }
      const id = obj["id"];
      if (typeof id === "string") {
        entries.set(id, obj);
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

// Strip entries that appear before a compaction's firstKeptEntryId so
// loadHistory matches getBranch(): pre-compaction messages are summarized
// and should not render. Pi appends compaction entries with parentId pointing
// to the old leaf, so walkActiveChain includes the entire pre-compaction chain;
// this function trims everything before firstKeptEntryId (inclusive from that
// point — the firstKeptEntryId entry itself is kept).
function trimPreCompaction(chain: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let keepFrom = 0;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i] as Record<string, unknown>;
    if (e["type"] !== "compaction") continue;
    const firstKeptId = e["firstKeptEntryId"];
    if (typeof firstKeptId !== "string") continue;
    for (let j = 0; j < i; j++) {
      const candidate = chain[j] as Record<string, unknown>;
      if (candidate["id"] === firstKeptId) {
        keepFrom = j;
        break;
      }
    }
  }
  return keepFrom > 0 ? chain.slice(keepFrom) : chain;
}

export function loadHistory(filePath: string): TranscriptBlock[] {
  if (!fs.existsSync(filePath)) return [];

  const { header, entries } = parseEntries(filePath);
  if (!header) return [];

  const headerResult = SessionHeaderSchema.safeParse(header);
  if (!headerResult.success) return [];

  const chain = walkActiveChain(entries);
  return entriesToTranscript(trimPreCompaction(chain));
}
