import { PiEventSchema } from "@shared/pi-protocol/events.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import { ExtensionUiRequestSchema } from "@shared/pi-protocol/extension-ui.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import { PiRpcResponseSchema } from "@shared/pi-protocol/responses.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";

export type PiOutbound =
  | { kind: "response"; data: PiRpcResponse }
  | { kind: "event"; data: PiEvent }
  | { kind: "extension_ui_request"; data: ExtensionUiRequest }
  | { kind: "unknown"; raw: unknown };

function parseOutbound(raw: unknown): PiOutbound {
  if (typeof raw !== "object" || raw === null) {
    return { kind: "unknown", raw };
  }

  const obj = raw as Record<string, unknown>;

  if (obj["type"] === "response") {
    const result = PiRpcResponseSchema.safeParse(raw);
    if (result.success) return { kind: "response", data: result.data };
    return { kind: "unknown", raw };
  }

  if (obj["type"] === "extension_ui_request") {
    const result = ExtensionUiRequestSchema.safeParse(raw);
    if (result.success) return { kind: "extension_ui_request", data: result.data };
    return { kind: "unknown", raw };
  }

  // Everything else is an event
  const result = PiEventSchema.safeParse(raw);
  if (result.success) return { kind: "event", data: result.data };
  return { kind: "unknown", raw };
}

export class JsonlStream {
  private buffer = Buffer.alloc(0);
  private onLine: (parsed: PiOutbound) => void;
  private onError: (err: Error) => void;

  constructor(onLine: (parsed: PiOutbound) => void, onError: (err: Error) => void) {
    this.onLine = onLine;
    this.onError = onError;
  }

  // Byte-level splitter — split ONLY on 0x0A (\n), never on Unicode separators
  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] === 0x0a) {
        // Strip trailing \r if present
        const end = i > 0 && this.buffer[i - 1] === 0x0d ? i - 1 : i;
        const line = this.buffer.slice(start, end);
        start = i + 1;

        if (line.length === 0) continue;

        const lineStr = line.toString("utf8");
        try {
          const raw = JSON.parse(lineStr) as unknown;
          this.onLine(parseOutbound(raw));
        } catch (e) {
          this.onError(
            new Error(
              `JSONL parse error: ${e instanceof Error ? e.message : String(e)} on line: ${lineStr.slice(0, 200)}`,
            ),
          );
        }
      }
    }

    this.buffer = this.buffer.slice(start);
  }
}
