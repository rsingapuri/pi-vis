import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entriesToTranscript, loadHistory } from "./history-loader.js";

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
          details: { diff: "-old\n+new", fullOutputPath: "/tmp/full-output.log" },
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
    const aData = blocks[1]?.data as Record<string, unknown>;
    const aSegments = aData["segments"] as Array<{ content: string }>;
    expect(aSegments.map((s) => s.content).join("")).toBe("Looking now.");

    // tool_call block, paired with the subsequent toolResult
    expect(blocks[2]?.type).toBe("tool_call");
    const toolData = blocks[2]?.data as Record<string, unknown>;
    expect(toolData["toolCallId"]).toBe("call_1");
    expect(toolData["toolName"]).toBe("read");
    expect(toolData["input"]).toEqual({ path: "a.ts" });
    expect(toolData["outputText"]).toBe("file contents");
    expect(toolData["diff"]).toBe("-old\n+new");
    expect(toolData["resultDetails"]).toEqual({
      diff: "-old\n+new",
      fullOutputPath: "/tmp/full-output.log",
    });
    expect(toolData["isError"]).toBe(false);
    expect(toolData["isStreaming"]).toBe(false);

    // final assistant text
    expect(blocks[3]?.type).toBe("assistant");
    const fData = blocks[3]?.data as Record<string, unknown>;
    const fSegments = fData["segments"] as Array<{ content: string }>;
    expect(fSegments.map((s) => s.content).join("")).toBe("Done.");
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
    const text = (b: TranscriptBlock) =>
      ((b.data as Record<string, unknown>)["segments"] as Array<{ content: string }>)
        .map((s) => s.content)
        .join("");
    const assistantTexts = blocks.filter((b) => b.type === "assistant").map(text);
    expect(assistantTexts).toContain("NEW-FORK");
    expect(assistantTexts).not.toContain("OLD-FORK");
  });

  it("preserves interleaved thinking→text→thinking order from the session file", () => {
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
      {
        id: "00000002",
        parentId: "00000001",
        timestamp: "2024-01-01T00:00:02.000Z",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Hmm" },
            { type: "text", text: "Answer" },
            { type: "thinking", thinking: "more" },
          ],
          timestamp: 1_700_000_002_000,
        },
      },
    ]);

    const blocks = loadHistory(file);
    expect(blocks[1]?.type).toBe("assistant");
    const segs = (blocks[1]?.data as Record<string, unknown>)["segments"] as Array<{
      kind: string;
      content: string;
    }>;
    expect(segs).toEqual([
      { kind: "thinking", content: "Hmm" },
      { kind: "text", content: "Answer" },
      { kind: "thinking", content: "more" },
    ]);
  });
});

describe("entriesToTranscript (pure helper used by /tree navigate)", () => {
  it("returns [] for an empty branch (review S3: navigating to root / leafId null)", () => {
    expect(entriesToTranscript([])).toEqual([]);
  });

  it("renders branch_summary entries as compaction blocks so the recap actually appears (review B2)", () => {
    // Real pi uses `parentId: null` for the root and serializes the new
    // branch_summary as a sibling of the new active leaf. The bridge (or
    // any future caller) MUST coerce `null` parentId → undefined before
    // handing entries to the schema — see plan §3. We omit parentId
    // here so the fixture matches the post-coercion shape.
    const branch = [
      {
        type: "branch_summary",
        id: "bs-1",
        timestamp: "2026-01-01T00:00:00Z",
        summary: "User explored a refactor branch and reverted.",
        fromId: "leaf-prev",
      },
    ];
    const blocks = entriesToTranscript(branch);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      id: "bs-1",
      type: "compaction",
      data: { summary: "User explored a refactor branch and reverted." },
    });
  });

  it("falls back to a placeholder summary when branch_summary.summary is missing", () => {
    const blocks = entriesToTranscript([
      { type: "branch_summary", id: "bs-x", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("compaction");
    expect((blocks[0]?.data as { summary: string }).summary).toMatch(/empty branch summary/i);
  });

  it("skips meta entries (label/model_change/thinking_level_change/session_info/custom)", () => {
    const branch = [
      {
        type: "message",
        id: "u1",
        timestamp: "t1",
        message: { role: "user", content: "hi" },
      },
      {
        type: "label",
        id: "l1",
        parentId: "u1",
        timestamp: "t2",
        targetId: "u1",
        label: "Greeting",
      },
      {
        type: "thinking_level_change",
        id: "tlc1",
        parentId: "u1",
        timestamp: "t3",
        thinkingLevel: "medium",
      },
      {
        type: "message",
        id: "a1",
        parentId: "l1",
        timestamp: "t4",
        message: { role: "assistant", content: [{ type: "text", text: "hello!" }] },
      },
    ];
    const blocks = entriesToTranscript(branch);
    expect(blocks.map((b) => b.type)).toEqual(["user", "assistant"]);
  });

  it("preserves details.diff for standalone tool results with no preceding tool call", () => {
    const blocks = entriesToTranscript([
      {
        type: "message",
        id: "tr1",
        timestamp: "t1",
        message: {
          role: "toolResult",
          toolCallId: "missing-call",
          toolName: "edit",
          content: [{ type: "text", text: "Edited a.ts" }],
          details: { diff: "-before\n+after" },
          isError: false,
        },
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("tool_call");
    const data = blocks[0]?.data as Record<string, unknown>;
    expect(data["diff"]).toBe("-before\n+after");
    expect(data["resultDetails"]).toEqual({ diff: "-before\n+after" });
  });

  it("renders compaction entries as compaction blocks (pre-compaction trimming is the chain walker's job, not ours)", () => {
    // `SessionManager.getBranch()` returns the post-compaction chain —
    // pre-compaction entries are already gone before this helper sees them.
    // We just emit a compaction block for the marker.
    const branch = [
      {
        type: "compaction",
        id: "c1",
        parentId: "u1",
        timestamp: "t2",
        summary: "compacted earlier",
        firstKeptEntryId: "u2",
      },
      {
        type: "message",
        id: "u2",
        parentId: "c1",
        timestamp: "t3",
        message: { role: "user", content: "after" },
      },
    ];
    const blocks = entriesToTranscript(branch);
    expect(blocks.map((b) => b.type)).toEqual(["compaction", "user"]);
    expect((blocks[0]?.data as { summary: string }).summary).toBe("compacted earlier");
    expect((blocks[1]?.data as { content: string }).content).toBe("after");
  });
});
