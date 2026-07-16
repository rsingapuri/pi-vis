import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { KnownSessionEntrySchema } from "@shared/session-file/entries.js";

export type RestorationDisposition = "restore" | "dropped";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Extract text from the user-message shapes Pi has used in session JSONL. */
export function knownUserMessageText(value: unknown): string | undefined {
  const parsed = KnownSessionEntrySchema.safeParse(value);
  if (!parsed.success || parsed.data.type !== "message" || parsed.data.message.role !== "user") {
    return undefined;
  }
  const content = parsed.data.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const candidate = part as { text?: unknown; content?: unknown };
        return typeof candidate.text === "string"
          ? candidate.text
          : typeof candidate.content === "string"
            ? candidate.content
            : "";
      })
      .join("");
    return text || undefined;
  }
  if (
    content &&
    typeof content === "object" &&
    typeof (content as { text?: unknown }).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  return undefined;
}

/**
 * Looks only at JSONL bytes appended after dispatch admission. Any unreadable,
 * malformed, or inconclusive evidence restores the draft; only an exact user
 * message match proves the input was processed.
 */
export async function reconcileRestoration(
  sessionFile: string | undefined,
  offset: number | undefined,
  payloadTexts: readonly string[],
): Promise<RestorationDisposition> {
  const wanted = new Set(payloadTexts.map(normalize).filter(Boolean));
  if (
    !sessionFile ||
    offset === undefined ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    wanted.size === 0
  ) {
    return "restore";
  }
  try {
    const input = createReadStream(sessionFile, { start: offset, encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return "restore";
      }
      const text = knownUserMessageText(value);
      if (text !== undefined && wanted.has(normalize(text))) return "dropped";
    }
    return "restore";
  } catch {
    return "restore";
  }
}
