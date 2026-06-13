import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHistory } from "./history-loader.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-history-"));
  file = path.join(dir, "session.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeEntries(entries: object[]): void {
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

describe("loadHistory (real pi v3 nested message format)", () => {
  it("walks the active chain and returns blocks in order", () => {
    const cwd = "/test/ws";
    writeEntries([
      { type: "session", version: 3, id: "00000000", timestamp: "2024-01-01T00:00:00.000Z", cwd },
      // user
      {
        id: "00000001",
        parentId: "00000000",
        timestamp: "2024-01-01T00:00:01.000Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "fix the bug" }],
          timestamp: 1_700_000_001_000,
        },
      },
      // assistant with text + a toolCall part
      {
        id: "00000002",
        parentId: "00000001",
        timestamp: "2024-01-01T00:00:02.000Z",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Looking now." },
            { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
          ],
          timestamp: 1_700_000_002_000,
        },
      },
      // toolResult for call_1
      {
        id: "00000003",
        parentId: "00000002",
        timestamp: "2024-01-01T00:00:03.000Z",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "file contents" }],
          timestamp: 1_700_000_003_000,
        },
      },
      // final assistant text
      {
        id: "00000004",
        parentId: "00000003",
        timestamp: "2024-01-01T00:00:04.000Z",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          timestamp: 1_700_000_004_000,
        },
      },
    ]);

    const blocks = loadHistory(file);
    expect(blocks).toHaveLength(4);

    // user block
    expect(blocks[0]?.type).toBe("user");
    expect((blocks[0]?.data as Record<string, unknown>)["content"]).toBe("fix the bug");

    // assistant text block
    expect(blocks[1]?.type).toBe("assistant");
    expect((blocks[1]?.data as Record<string, unknown>)["content"]).toBe("Looking now.");

    // tool_call block, paired with the subsequent toolResult
    expect(blocks[2]?.type).toBe("tool_call");
    const toolData = blocks[2]?.data as Record<string, unknown>;
    expect(toolData["toolCallId"]).toBe("call_1");
    expect(toolData["toolName"]).toBe("read");
    expect(toolData["input"]).toEqual({ path: "a.ts" });
    expect(toolData["outputText"]).toBe("file contents");
    expect(toolData["isError"]).toBe(false);
    expect(toolData["isStreaming"]).toBe(false);

    // final assistant text
    expect(blocks[3]?.type).toBe("assistant");
    expect((blocks[3]?.data as Record<string, unknown>)["content"]).toBe("Done.");
  });

  it("picks the leaf with the later ISO timestamp (pins the entryTime fix)", () => {
    // Two leaves after the header — one forked from a mid-chain entry.
    // The chain from e2 (timestamp 02:00Z) is the older fork; the chain
    // from e3 (timestamp 03:00Z) is the newer fork. The newer one wins.
    const cwd = "/test/ws";
    writeEntries([
      { type: "session", version: 3, id: "00000000", timestamp: "2024-01-01T00:00:00.000Z", cwd },
      {
        id: "00000001",
        parentId: "00000000",
        timestamp: "2024-01-01T00:00:01.000Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hi" }],
          timestamp: 1_700_000_001_000,
        },
      },
      // older leaf fork
      {
        id: "00000002",
        parentId: "00000001",
        timestamp: "2024-01-01T00:00:02.000Z",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "OLD-FORK" }],
          timestamp: 1_700_000_002_000,
        },
      },
      // newer leaf fork (must be picked)
      {
        id: "00000003",
        parentId: "00000001",
        timestamp: "2024-01-01T00:00:03.000Z",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "NEW-FORK" }],
          timestamp: 1_700_000_003_000,
        },
      },
    ]);

    const blocks = loadHistory(file);
    const text = (b: TranscriptBlock) => (b.data as Record<string, unknown>)["content"];
    const assistantTexts = blocks.filter((b) => b.type === "assistant").map(text);
    expect(assistantTexts).toContain("NEW-FORK");
    expect(assistantTexts).not.toContain("OLD-FORK");
  });
});
