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
  it("walks the active chain and returns blocks in order", async () => {
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

    const blocks = await loadHistory(file);
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

  it("picks the leaf with the later ISO timestamp (pins the entryTime fix)", async () => {
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

    const blocks = await loadHistory(file);
    const text = (b: TranscriptBlock) =>
      ((b.data as Record<string, unknown>)["segments"] as Array<{ content: string }>)
        .map((s) => s.content)
        .join("");
    const assistantTexts = blocks.filter((b) => b.type === "assistant").map(text);
    expect(assistantTexts).toContain("NEW-FORK");
    expect(assistantTexts).not.toContain("OLD-FORK");
  });

  it("preserves interleaved thinking→text→thinking order from the session file", async () => {
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

    const blocks = await loadHistory(file);
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

describe("loadHistory complete scrollback and cache", () => {
  function linearUserEntries(count: number): object[] {
    const entries: object[] = [
      {
        type: "session",
        version: 3,
        id: "root",
        timestamp: "2024-01-01T00:00:00.000Z",
        cwd: "/test/ws",
      },
    ];
    let parentId = "root";
    for (let i = 1; i <= count; i++) {
      const id = `u${i}`;
      entries.push({
        id,
        parentId,
        timestamp: new Date(Date.UTC(2024, 0, 1) + i * 1_000).toISOString(),
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `msg-${i}` }] },
      });
      parentId = id;
    }
    return entries;
  }

  function blockTexts(blocks: TranscriptBlock[]): string[] {
    return blocks.map((b) => (b.data as { content?: string }).content ?? "");
  }

  it("returns the complete transcript without a block limit", async () => {
    writeEntries(linearUserEntries(750));

    const blocks = await loadHistory(file);

    expect(blocks).toHaveLength(750);
    expect(blockTexts(blocks).slice(0, 2)).toEqual(["msg-1", "msg-2"]);
    expect(blockTexts(blocks).slice(-2)).toEqual(["msg-749", "msg-750"]);
  });

  it("coalesces concurrent and settlement-window loads into one parsed result", async () => {
    writeEntries(linearUserEntries(1));

    const first = loadHistory(file);
    const second = loadHistory(file);
    // A waiter resumed from the shared promise used to run after in-flight
    // deletion but before cache insertion, opening a one-microtask duplicate
    // parse window. Re-enter from settlement to pin that ordering.
    const third = second.then(() => loadHistory(file));
    const [firstBlocks, secondBlocks, thirdBlocks] = await Promise.all([first, second, third]);

    expect(firstBlocks).toBe(secondBlocks);
    expect(thirdBlocks).toBe(firstBlocks);
  });

  it("reuses the single-file history cache when file identity is unchanged", async () => {
    writeEntries(linearUserEntries(1));
    const fixedTime = new Date("2024-02-02T00:00:00.000Z");
    fs.utimesSync(file, fixedTime, fixedTime);

    expect(blockTexts(await loadHistory(file))).toEqual(["msg-1"]);
    writeEntries([
      {
        type: "session",
        version: 3,
        id: "root",
        timestamp: "2024-01-01T00:00:00.000Z",
        cwd: "/test/ws",
      },
      {
        id: "u1",
        parentId: "root",
        timestamp: "2024-01-01T00:00:01.000Z",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "MSG-1" }] },
      },
    ]);
    fs.utimesSync(file, fixedTime, fixedTime);

    expect(blockTexts(await loadHistory(file))).toEqual(["msg-1"]);
  });

  it("evicts old complete histories from the bounded history cache", async () => {
    const paths = Array.from({ length: 4 }, (_, index) => path.join(dir, `session-${index}.jsonl`));
    const fixedTime = new Date("2024-02-02T00:00:00.000Z");
    for (const candidate of paths) {
      fs.writeFileSync(
        candidate,
        `${linearUserEntries(1)
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
      );
      fs.utimesSync(candidate, fixedTime, fixedTime);
      expect(blockTexts(await loadHistory(candidate))).toEqual(["msg-1"]);
    }

    const replacement = linearUserEntries(1) as Array<Record<string, unknown>>;
    const message = replacement[1]?.["message"] as Record<string, unknown>;
    message["content"] = [{ type: "text", text: "MSG-1" }];
    fs.writeFileSync(
      paths[0]!,
      `${replacement.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    fs.utimesSync(paths[0]!, fixedTime, fixedTime);

    expect(blockTexts(await loadHistory(paths[0]!))).toEqual(["MSG-1"]);
  });

  it("invalidates the history cache when mtime changes even if size is unchanged", async () => {
    writeEntries(linearUserEntries(1));
    const firstTime = new Date("2024-02-02T00:00:00.000Z");
    const secondTime = new Date("2024-02-02T00:00:02.000Z");
    fs.utimesSync(file, firstTime, firstTime);
    const stat = fs.statSync(file);
    expect(blockTexts(await loadHistory(file))).toEqual(["msg-1"]);

    writeEntries([
      {
        type: "session",
        version: 3,
        id: "root",
        timestamp: "2024-01-01T00:00:00.000Z",
        cwd: "/test/ws",
      },
      {
        id: "u1",
        parentId: "root",
        timestamp: "2024-01-01T00:00:01.000Z",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "MSG-1" }] },
      },
    ]);
    fs.utimesSync(file, secondTime, secondTime);
    expect(fs.statSync(file).size).toBe(stat.size);

    expect(blockTexts(await loadHistory(file))).toEqual(["MSG-1"]);
  });

  it("keeps pre-compaction entries available for persisted transcript scrollback", async () => {
    writeEntries([
      { type: "session", version: 3, id: "root", timestamp: "2024-01-01T00:00:00Z", cwd: "/ws" },
      {
        id: "u1",
        parentId: "root",
        timestamp: "2024-01-01T00:00:01Z",
        type: "message",
        message: { role: "user", content: "before-compaction" },
      },
      {
        id: "u2",
        parentId: "u1",
        timestamp: "2024-01-01T00:00:02Z",
        type: "message",
        message: { role: "user", content: "kept" },
      },
      {
        id: "c1",
        parentId: "u2",
        timestamp: "2024-01-01T00:00:03Z",
        type: "compaction",
        summary: "summary",
        firstKeptEntryId: "u2",
      },
      {
        id: "u3",
        parentId: "c1",
        timestamp: "2024-01-01T00:00:04Z",
        type: "message",
        message: { role: "user", content: "after" },
      },
    ]);

    const blocks = await loadHistory(file);

    expect(blocks.map((b) => b.id)).toEqual(["u1", "u2", "c1", "u3"]);
  });
});

describe("entriesToTranscript (pure helper used by /tree navigate)", () => {
  it("returns [] for an empty branch (review S3: navigating to root / leafId null)", async () => {
    expect(await entriesToTranscript([])).toEqual([]);
  });

  it("yields to the event loop before a large conversion resolves", async () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      type: "message",
      id: `u${index}`,
      timestamp: index,
      message: { role: "user", content: `message-${index}` },
    }));
    let resolved = false;
    const conversion = entriesToTranscript(entries).then((blocks) => {
      resolved = true;
      return blocks;
    });

    await new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(resolved).toBe(false);
        resolve();
      }),
    );
    await expect(conversion).resolves.toHaveLength(5_000);
  });

  it("renders branch_summary entries as compaction blocks so the recap actually appears (review B2)", async () => {
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
    const blocks = await entriesToTranscript(branch);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      id: "bs-1",
      type: "compaction",
      data: { summary: "User explored a refactor branch and reverted." },
    });
  });

  it("falls back to a placeholder summary when branch_summary.summary is missing", async () => {
    const blocks = await entriesToTranscript([
      { type: "branch_summary", id: "bs-x", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("compaction");
    expect((blocks[0]?.data as { summary: string }).summary).toMatch(/empty branch summary/i);
  });

  it("skips non-rendering meta entries (label/model_change/thinking_level_change/session_info)", async () => {
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
    const blocks = await entriesToTranscript(branch);
    expect(blocks.map((b) => b.type)).toEqual(["user", "assistant"]);
  });

  it("preserves Pi 0.80.4 custom entries for SDK-host rendering", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "custom",
        id: "custom-1",
        timestamp: "t1",
        customType: "status-card",
        data: { count: 17 },
      },
    ]);
    expect(blocks).toEqual([
      {
        id: "custom-1",
        type: "custom_entry",
        data: { entryId: "custom-1", customType: "status-card" },
      },
    ]);
  });

  it("uses newline-separated text parts and finalizes the matching tool call", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "message",
        id: "a1",
        timestamp: "t1",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        },
      },
      {
        type: "message",
        id: "tr1",
        timestamp: "t2",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          content: [
            { type: "text", text: "first part" },
            { type: "text", text: "second part" },
          ],
          details: { diff: "-old\n+new", fullOutputPath: "/tmp/output" },
        },
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("tool_call");
    expect(blocks[0]?.data).toMatchObject({
      toolCallId: "call-1",
      outputText: "first part\nsecond part",
      resultDetails: { diff: "-old\n+new", fullOutputPath: "/tmp/output" },
      diff: "-old\n+new",
      isStreaming: false,
    });
  });

  it("settles an unmatched tool call as interrupted", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "message",
        id: "a1",
        timestamp: "t1",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        },
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.data).toMatchObject({
      toolCallId: "call-1",
      isStreaming: false,
      interrupted: true,
    });
  });

  it("marks only unmatched tool calls as interrupted", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "message",
        id: "a1",
        timestamp: "t1",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "paired", name: "read", arguments: {} },
            { type: "toolCall", id: "unpaired", name: "edit", arguments: {} },
          ],
        },
      },
      {
        type: "message",
        id: "tr1",
        timestamp: "t2",
        message: {
          role: "toolResult",
          toolCallId: "paired",
          content: [{ type: "text", text: "contents" }],
        },
      },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.data).toMatchObject({
      toolCallId: "paired",
      outputText: "contents",
      isStreaming: false,
    });
    expect((blocks[0]?.data as Record<string, unknown>)["interrupted"]).toBeUndefined();
    expect(blocks[1]?.data).toMatchObject({
      toolCallId: "unpaired",
      isStreaming: false,
      interrupted: true,
    });
  });

  it("matches a duplicate toolCallId to the most recent tool call", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "message",
        id: "a1",
        timestamp: "t1",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "duplicate", name: "first", arguments: {} }],
        },
      },
      {
        type: "message",
        id: "a2",
        timestamp: "t2",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "duplicate", name: "second", arguments: {} }],
        },
      },
      {
        type: "message",
        id: "tr1",
        timestamp: "t3",
        message: {
          role: "toolResult",
          toolCallId: "duplicate",
          content: [{ type: "text", text: "latest output" }],
        },
      },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.data).toMatchObject({
      toolName: "first",
      isStreaming: false,
      interrupted: true,
    });
    expect(blocks[1]?.data).toMatchObject({
      toolName: "second",
      outputText: "latest output",
      isStreaming: false,
    });
  });

  it("preserves details.diff for standalone tool results with no preceding tool call", async () => {
    const blocks = await entriesToTranscript([
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

  it("renders compaction entries as compaction blocks (pre-compaction trimming is the chain walker's job, not ours)", async () => {
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
    const blocks = await entriesToTranscript(branch);
    expect(blocks.map((b) => b.type)).toEqual(["compaction", "user"]);
    expect((blocks[0]?.data as { summary: string }).summary).toBe("compacted earlier");
    expect((blocks[1]?.data as { content: string }).content).toBe("after");
  });
});
