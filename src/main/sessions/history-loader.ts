import fs from "node:fs";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import { SessionEntrySchema, SessionHeaderSchema } from "@shared/session-file/entries.js";

type EntryMap = Map<string, Record<string, unknown>>;

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

export function loadHistory(filePath: string): TranscriptBlock[] {
  if (!fs.existsSync(filePath)) return [];

  const { header, entries } = parseEntries(filePath);
  if (!header) return [];

  const headerResult = SessionHeaderSchema.safeParse(header);
  if (!headerResult.success) return [];

  const chain = walkActiveChain(entries);
  const blocks: TranscriptBlock[] = [];
  let skipUntil: string | null = null;

  for (const rawEntry of chain) {
    const parsed = SessionEntrySchema.safeParse(rawEntry);
    if (!parsed.success) continue;
    const entry = parsed.data;

    // After compaction, skip entries until firstKeptEntryId
    if (skipUntil !== null) {
      if ("id" in entry && entry.id === skipUntil) {
        skipUntil = null;
      } else {
        continue;
      }
    }

    if ("__unknown" in entry) continue;

    switch (entry.type) {
      case "compaction": {
        blocks.push({
          id: entry.id,
          type: "compaction",
          data: { summary: entry.summary },
        });
        if (entry.firstKeptEntryId) {
          skipUntil = entry.firstKeptEntryId;
        }
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
        let textContent = "";
        let thinkingContent = "";
        const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];

        if (typeof content === "string") {
          textContent = content;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part !== "object" || part === null) continue;
            const p = part as Record<string, unknown>;
            if (p["type"] === "text") {
              textContent += (p["text"] as string) ?? "";
            } else if (p["type"] === "thinking") {
              thinkingContent += (p["thinking"] as string) ?? "";
            } else if (p["type"] === "toolCall") {
              toolCalls.push({
                id: p["id"] as string,
                name: p["name"] as string,
                arguments: p["arguments"],
              });
            }
          }
        }

        if (role === "user") {
          blocks.push({
            id: entry.id,
            type: "user",
            data: { role: "user", content: textContent },
          });
        } else {
          // assistant: emit assistant block, then tool_call blocks for each tool call
          blocks.push({
            id: entry.id,
            type: "assistant",
            data: { role: "assistant", content: textContent, thinking: thinkingContent },
          });
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
        if (entry.display !== false && entry.content) {
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
      case "branch_summary":
      case "session_info":
        break;
    }
  }

  return blocks;
}
