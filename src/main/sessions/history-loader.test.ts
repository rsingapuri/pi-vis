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
          details: {
            diff: "-old\n+new",
            patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
            fullOutputPath: "/tmp/full-output.log",
          },
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
    expect(toolData["patch"]).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new");
    expect(toolData["resultDetails"]).toEqual({
      diff: "-old\n+new",
      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
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
        tokensBefore: 500,
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

  it("preserves branch_summary as an honest, distinct activity block", async () => {
    // Real pi uses `parentId: null` for the root and serializes the new
    // branch_summary as a sibling of the new active leaf.
    const branch = [
      {
        type: "branch_summary",
        id: "bs-1",
        timestamp: "2026-01-01T00:00:00Z",
        summary: "User explored a refactor branch and reverted.",
        fromId: "leaf-prev",
        details: ["extension-owned"],
        fromHook: true,
        usage: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 2,
          totalTokens: 127,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
        },
      },
    ];
    const blocks = await entriesToTranscript(branch);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      id: "bs-1",
      type: "branch_summary",
      data: {
        summary: "User explored a refactor branch and reverted.",
        fromId: "leaf-prev",
        details: ["extension-owned"],
        fromHook: true,
        usage: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 2,
          totalTokens: 127,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
        },
      },
    });
  });

  it("falls back to a placeholder summary when branch_summary.summary is missing", async () => {
    const blocks = await entriesToTranscript([
      { type: "branch_summary", id: "bs-x", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("branch_summary");
    expect((blocks[0]?.data as { summary: string }).summary).toMatch(/empty branch summary/i);
  });

  it("skips non-rendering model-context and meta entries", async () => {
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
        id: "system1",
        parentId: "tlc1",
        timestamp: "t3a",
        message: { role: "system", content: "private model context" },
      },
      {
        type: "context_edit",
        id: "edit1",
        parentId: "system1",
        timestamp: "t3b",
        targetId: "u1",
        replacement: null,
      },
      {
        type: "usage",
        id: "usage1",
        parentId: "edit1",
        timestamp: "t3c",
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude-sonnet",
        usage: {
          input: 10,
          output: 0,
          cacheRead: 10,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0.001, cacheWrite: 0, total: 0.001 },
        },
      },
      {
        type: "message",
        id: "a1",
        parentId: "usage1",
        timestamp: "t4",
        message: { role: "assistant", content: [{ type: "text", text: "hello!" }] },
      },
    ];
    const blocks = await entriesToTranscript(branch);
    expect(blocks.map((b) => b.type)).toEqual(["user", "assistant"]);
  });

  it("preserves normalized retain-none compaction state and nested tool result metadata", async () => {
    const nestedUsage = {
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 2,
      totalTokens: 127,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
    };
    const blocks = await entriesToTranscript([
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "parent-call",
              name: "codemode",
              arguments: { code: "await tools.read(...)" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "result-1",
        parentId: "assistant-1",
        message: {
          role: "toolResult",
          toolCallId: "parent-call",
          toolName: "codemode",
          content: [{ type: "text", text: "complete" }],
          nestedCalls: {
            calls: [
              {
                id: "child-call",
                name: "read",
                arguments: { path: "README.md" },
                status: "ok",
                durationMs: 2,
              },
            ],
            complete: true,
          },
          usage: nestedUsage,
          isError: false,
        },
      },
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "result-1",
        summary: "fresh start",
        firstKeptEntryId: "compaction-1",
        tokensBefore: 500,
        systemMessage: {
          role: "system",
          content: "Updated prompt",
          timestamp: 1_700_000_000_000,
        },
      },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "tool_call",
      data: {
        toolCallId: "parent-call",
        outputText: "complete",
        resultMetadata: {
          nestedCalls: {
            calls: [expect.objectContaining({ id: "child-call", name: "read", status: "ok" })],
            complete: true,
          },
        },
        usage: nestedUsage,
      },
    });
    expect(blocks[1]).toMatchObject({
      type: "compaction",
      data: {
        summary: "fresh start",
        firstKeptEntryId: "compaction-1",
        systemMessage: {
          role: "system",
          content: "Updated prompt",
          timestamp: 1_700_000_000_000,
        },
      },
    });
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
        data: {
          entryId: "custom-1",
          customType: "status-card",
          data: { count: 17 },
        },
      },
    ]);
  });

  it("rehydrates Shell Turn provenance and completion metadata around Pi's canonical bash message", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "custom",
        id: "shell-start",
        timestamp: "2024-01-01T00:00:01.000Z",
        customType: "pivis.shell_turn_start",
        data: {
          version: 1,
          executionId: "shell-1",
          command: "npm init",
          excludeFromContext: true,
          startedAt: 1_700_000_001_000,
          cwd: "/workspace",
          pty: true,
        },
      },
      {
        type: "message",
        id: "shell-result",
        timestamp: "2024-01-01T00:00:02.000Z",
        message: {
          role: "bashExecution",
          command: "npm init",
          output: "package name: demo",
          exitCode: 0,
          cancelled: false,
          excludeFromContext: true,
          timestamp: 1_700_000_002_000,
        },
      },
      {
        type: "custom",
        id: "shell-complete",
        timestamp: "2024-01-01T00:00:03.000Z",
        customType: "pivis.shell_turn_complete",
        data: {
          version: 1,
          executionId: "shell-1",
          durationMs: 625,
          signal: "SIGINT",
          normalization: "terminal_buffer",
        },
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: "shell-result",
      type: "bash",
      data: {
        executionId: "shell-1",
        command: "npm init",
        outputText: "package name: demo",
        exitCode: 0,
        excludeFromContext: true,
        pty: true,
        startedAt: 1_700_000_001_000,
        cwd: "/workspace",
        durationMs: 625,
        signal: "SIGINT",
        normalization: "terminal_buffer",
      },
    });
  });

  it("marks an orphaned Shell Turn interrupted without claiming an unrelated bash message", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "custom",
        id: "orphan-start",
        timestamp: "2024-01-01T00:00:01.000Z",
        customType: "pivis.shell_turn_start",
        data: {
          executionId: "shell-orphan",
          command: "vim package.json",
          excludeFromContext: false,
          startedAt: 1_700_000_001_000,
          cwd: "/workspace",
          pty: true,
        },
      },
      {
        type: "message",
        id: "agent-bash",
        timestamp: "2024-01-01T00:00:02.000Z",
        message: {
          role: "bashExecution",
          command: "git status",
          output: "clean",
          exitCode: 0,
          timestamp: 1_700_000_002_000,
        },
      },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      id: "interrupted-shell-orphan",
      type: "bash",
      data: {
        executionId: "shell-orphan",
        command: "vim package.json",
        isStreaming: false,
        interrupted: true,
        pty: true,
        cwd: "/workspace",
      },
    });
    expect(blocks[1]).toMatchObject({
      id: "agent-bash",
      type: "bash",
      data: { command: "git status", executionId: undefined },
    });
  });

  it("correlates repeated commands by exact completion id without letting an orphan steal the result", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "custom",
        id: "old-start",
        timestamp: "2024-01-01T00:00:01.000Z",
        customType: "pivis.shell_turn_start",
        data: {
          executionId: "shell-old",
          command: "pwd",
          excludeFromContext: false,
          startedAt: 1_700_000_001_000,
          cwd: "/old",
          pty: true,
        },
      },
      {
        type: "custom",
        id: "new-start",
        timestamp: "2024-01-01T00:00:02.000Z",
        customType: "pivis.shell_turn_start",
        data: {
          executionId: "shell-new",
          command: "pwd",
          excludeFromContext: false,
          startedAt: 1_700_000_002_000,
          cwd: "/new",
          pty: true,
        },
      },
      {
        type: "message",
        id: "new-result",
        timestamp: "2024-01-01T00:00:03.000Z",
        message: {
          role: "bashExecution",
          command: "pwd",
          output: "/new\n",
          exitCode: 0,
          timestamp: 1_700_000_003_000,
        },
      },
      {
        type: "custom",
        id: "new-complete",
        timestamp: "2024-01-01T00:00:04.000Z",
        customType: "pivis.shell_turn_complete",
        data: {
          executionId: "shell-new",
          durationMs: 20,
          normalization: "terminal_buffer",
        },
      },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      id: "interrupted-shell-old",
      type: "bash",
      data: {
        executionId: "shell-old",
        command: "pwd",
        cwd: "/old",
        interrupted: true,
      },
    });
    expect(blocks[1]).toMatchObject({
      id: "new-result",
      type: "bash",
      data: {
        executionId: "shell-new",
        command: "pwd",
        outputText: "/new\n",
        cwd: "/new",
        durationMs: 20,
      },
    });
  });

  it("does not assign an identical agent bash command to an orphan without a completion marker", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "custom",
        id: "orphan-start",
        timestamp: "2024-01-01T00:00:01.000Z",
        customType: "pivis.shell_turn_start",
        data: {
          executionId: "shell-orphan",
          command: "pwd",
          excludeFromContext: false,
          startedAt: 1_700_000_001_000,
          cwd: "/workspace",
          pty: true,
        },
      },
      {
        type: "message",
        id: "agent-bash",
        timestamp: "2024-01-01T00:00:02.000Z",
        message: {
          role: "bashExecution",
          command: "pwd",
          output: "/workspace\n",
          exitCode: 0,
          timestamp: 1_700_000_002_000,
        },
      },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      id: "interrupted-shell-orphan",
      type: "bash",
      data: { executionId: "shell-orphan", interrupted: true },
    });
    expect(blocks[1]).toMatchObject({
      id: "agent-bash",
      type: "bash",
      data: { executionId: undefined, command: "pwd" },
    });
  });

  it("rehydrates a post-admission spawn failure as failed rather than interrupted", async () => {
    const blocks = await entriesToTranscript([
      {
        type: "custom",
        id: "failed-start",
        timestamp: "2024-01-01T00:00:01.000Z",
        customType: "pivis.shell_turn_start",
        data: {
          executionId: "failed-shell",
          command: "missing-command",
          excludeFromContext: false,
          startedAt: 1_700_000_001_000,
          cwd: "/workspace",
          pty: true,
        },
      },
      {
        type: "custom",
        id: "failed-complete",
        timestamp: "2024-01-01T00:00:02.000Z",
        customType: "pivis.shell_turn_complete",
        data: {
          executionId: "failed-shell",
          durationMs: 7,
          interrupted: false,
          errorMessage: "spawn failed",
          normalization: "terminal_buffer",
        },
      },
    ]);

    expect(blocks).toEqual([
      expect.objectContaining({
        id: "failed-failed-shell",
        type: "bash",
        data: expect.objectContaining({
          executionId: "failed-shell",
          command: "missing-command",
          outputText: "spawn failed",
          isStreaming: false,
          interrupted: false,
          errorMessage: "spawn failed",
          durationMs: 7,
          normalization: "terminal_buffer",
        }),
      }),
    ]);
  });

  it("preserves public tool, bash, custom-message, and compaction payloads", async () => {
    const customEntryTimestamp = "2024-01-01T00:00:04.000Z";
    const blocks = await entriesToTranscript([
      {
        type: "message",
        id: "tool-result",
        parentId: null,
        timestamp: "2024-01-01T00:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "standalone",
          toolName: "image",
          content: [
            { type: "text", text: "created", textSignature: "signed-created" },
            {
              type: "image",
              data: "aW1hZ2U=",
              mimeType: "image/png",
              extensionField: "retained-image-field",
            },
            { type: "text", text: "after image", extensionField: { retained: true } },
          ],
          output: "distinct direct output",
          details: 42,
          addedToolNames: ["inspect_image"],
          terminate: true,
          isError: false,
          timestamp: 1_700_000_001_000,
        },
      },
      {
        type: "message",
        id: "bash",
        timestamp: "2024-01-01T00:00:02.000Z",
        message: {
          role: "bashExecution",
          command: "npm test",
          output: "cancelled\n",
          exitCode: 130,
          cancelled: true,
          truncated: true,
          fullOutputPath: "/tmp/pi-bash.log",
          excludeFromContext: true,
          timestamp: 1_700_000_002_000,
        },
      },
      {
        type: "message",
        id: "custom-role",
        timestamp: "2024-01-01T00:00:03.000Z",
        message: {
          role: "custom",
          customType: "artifact",
          display: true,
          content: [
            { type: "text", text: "artifact preview", textSignature: "signed-preview" },
            { type: "image", data: "YXJ0", mimeType: "image/webp" },
          ],
          details: ["opaque"],
          timestamp: 1_700_000_003_000,
        },
      },
      {
        type: "custom_message",
        id: "custom-entry",
        timestamp: customEntryTimestamp,
        customType: "notice",
        display: true,
        content: [
          { type: "image", data: "bm90aWNl", mimeType: "image/jpeg" },
          { type: "text", text: "after notice image", textSignature: "signed-notice" },
        ],
        details: null,
      },
      {
        type: "compaction",
        id: "compaction",
        timestamp: "2024-01-01T00:00:05.000Z",
        summary: "summary",
        firstKeptEntryId: "custom-entry",
        tokensBefore: 500,
        details: "extension-details",
        fromHook: true,
      },
    ]);

    expect(blocks.map((block) => block.type)).toEqual([
      "tool_call",
      "bash",
      "custom_message",
      "custom_message",
      "compaction",
    ]);
    expect(blocks[0]?.data).toMatchObject({
      outputText: "created\nafter image",
      outputImages: ["data:image/png;base64,aW1hZ2U="],
      resultContent: [
        { type: "text", text: "created", textSignature: "signed-created" },
        {
          type: "image",
          data: "aW1hZ2U=",
          mimeType: "image/png",
          extensionField: "retained-image-field",
        },
        { type: "text", text: "after image", extensionField: { retained: true } },
      ],
      resultDetails: 42,
      resultMetadata: {
        output: "distinct direct output",
        addedToolNames: ["inspect_image"],
        terminate: true,
        timestamp: 1_700_000_001_000,
      },
    });
    expect(blocks[1]?.data).toMatchObject({
      command: "npm test",
      outputText: "cancelled\n",
      exitCode: 130,
      cancelled: true,
      truncated: true,
      fullOutputPath: "/tmp/pi-bash.log",
      excludeFromContext: true,
      timestamp: 1_700_000_002_000,
    });
    expect(blocks[2]?.data).toEqual({
      content: "artifact preview",
      images: ["data:image/webp;base64,YXJ0"],
      rawContent: [
        { type: "text", text: "artifact preview", textSignature: "signed-preview" },
        { type: "image", data: "YXJ0", mimeType: "image/webp" },
      ],
      customType: "artifact",
      details: ["opaque"],
      timestamp: 1_700_000_003_000,
    });
    expect(blocks[3]?.data).toEqual({
      content: "after notice image",
      images: ["data:image/jpeg;base64,bm90aWNl"],
      rawContent: [
        { type: "image", data: "bm90aWNl", mimeType: "image/jpeg" },
        { type: "text", text: "after notice image", textSignature: "signed-notice" },
      ],
      customType: "notice",
      details: null,
      timestamp: Date.parse(customEntryTimestamp),
    });
    expect(blocks[4]?.data).toMatchObject({
      summary: "summary",
      details: "extension-details",
      fromHook: true,
    });
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
          details: {
            diff: "-old\n+new",
            patch: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new",
            fullOutputPath: "/tmp/output",
          },
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
      patch: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new",
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
          details: {
            diff: "-before\n+after",
            patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after",
          },
          isError: false,
        },
      },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("tool_call");
    const data = blocks[0]?.data as Record<string, unknown>;
    expect(data["diff"]).toBe("-before\n+after");
    expect(data["patch"]).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after");
    expect(data["resultDetails"]).toEqual({
      diff: "-before\n+after",
      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after",
    });
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
        tokensBefore: 500,
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
