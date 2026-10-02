import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import { describe, expect, it } from "vitest";
import {
  addUserBlock,
  allTranscriptBlocks,
  applyPiEvent,
  clearPendingUserEcho,
  createTranscriptState,
  restoreActiveShellTurn,
  seedFromHistory,
  transcriptBlockCount,
} from "./transcript.js";

function e<T extends KnownPiEvent>(event: T): T {
  return event;
}

// Minimal wire AgentMessage stubs for events that require a message snapshot
const USER_MSG = { role: "user" as const, content: "hello", timestamp: 0 };
const ASST_MSG = {
  role: "assistant" as const,
  content: [],
  api: "test",
  provider: "test",
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  stopReason: "stop",
  timestamp: 0,
};
const PI_USAGE = {
  input: 100,
  output: 20,
  cacheRead: 5,
  cacheWrite: 2,
  totalTokens: 127,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
};

describe("transcript reducer", () => {
  it("starts empty", () => {
    const state = createTranscriptState();
    expect(state.blocks).toHaveLength(0);
  });

  it("adds user block", () => {
    const state = addUserBlock(createTranscriptState(), "Hello pi");
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("user");
  });

  it("settles streaming history blocks and marks them interrupted", () => {
    const state = seedFromHistory(createTranscriptState(), [
      {
        id: "tool-streaming",
        type: "tool_call",
        data: {
          toolCallId: "call-1",
          toolName: "read",
          outputText: "",
          isError: false,
          isStreaming: true,
        },
      },
      {
        id: "bash-streaming",
        type: "bash",
        data: { command: "sleep 10", outputText: "", isStreaming: true },
      },
      {
        id: "tool-interrupted",
        type: "tool_call",
        data: {
          toolCallId: "call-2",
          toolName: "write",
          outputText: "",
          isError: false,
          isStreaming: false,
          interrupted: true,
        },
      },
    ]);

    expect(allTranscriptBlocks(state)).toMatchObject([
      { type: "tool_call", data: { isStreaming: false, interrupted: true } },
      { type: "bash", data: { isStreaming: false, interrupted: true } },
      { type: "tool_call", data: { isStreaming: false, interrupted: true } },
    ]);
  });

  it("assembles assistant text from deltas", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "world" },
      }),
    );
    state = applyPiEvent(state, e({ type: "message_end", message: ASST_MSG }));

    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0];
    expect(block?.type).toBe("assistant");
    if (block?.type === "assistant") {
      expect(block.data.segments.map((s) => s.content).join("")).toBe("Hello world");
      expect(block.data.isStreaming).toBe(false);
    }
  });

  it("tracks thinking content separately", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "thinking_delta", delta: "Hmm" },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "Answer" },
      }),
    );
    state = applyPiEvent(state, e({ type: "message_end", message: ASST_MSG }));

    const block = state.blocks[0];
    if (block?.type === "assistant") {
      expect(block.data.segments).toEqual([
        { kind: "thinking", content: "Hmm", contentIndex: undefined },
        { kind: "text", content: "Answer", contentIndex: undefined },
      ]);
    }
  });

  it("streams tool calls with output updates", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "read_file",
        args: { path: "foo.txt" },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "read_file",
        args: {},
        partialResult: "line1\n",
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "read_file",
        args: {},
        partialResult: "line2\n",
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "read_file",
        result: "line1\nline2\n",
        isError: false,
      }),
    );

    const block = state.blocks[0];
    expect(block?.type).toBe("tool_call");
    if (block?.type === "tool_call") {
      expect(block.data.outputText).toBe("line1\nline2\n");
      expect(block.data.resultContent).toBe("line1\nline2\n");
      expect(block.data.isStreaming).toBe(false);
      expect(block.data.isError).toBe(false);
    }
  });

  it("extracts final output from tool_execution_end result (real wire shape, no updates)", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "read",
        args: { file_path: "package.json" },
      }),
    );
    // Real pi often sends no tool_execution_update at all — the output
    // arrives only in the end event's result.content[].text
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "read",
        result: {
          content: [{ type: "text", text: '{\n  "name": "pi-vis"\n}' }],
          details: { truncation: { truncated: false } },
        },
        isError: false,
      }),
    );

    const block = state.blocks[0];
    expect(block?.type).toBe("tool_call");
    if (block?.type === "tool_call") {
      expect(block.data.outputText).toBe('{\n  "name": "pi-vis"\n}');
      expect(block.data.resultContent).toEqual([
        { type: "text", text: '{\n  "name": "pi-vis"\n}' },
      ]);
      expect(block.data.resultDetails).toEqual({ truncation: { truncated: false } });
      expect(block.data.isStreaming).toBe(false);
    }
  });

  it("preserves mixed output, arbitrary details, and all public result metadata", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "tool_execution_start",
        toolCallId: "t-rich",
        toolName: "generated_image",
        args: { prompt: "sunset" },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_end",
        toolCallId: "t-rich",
        toolName: "generated_image",
        result: {
          content: [
            { type: "text", text: "created", textSignature: "signed-created" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png", source: "tool" },
            { type: "text", text: "after image", extensionField: 1 },
          ],
          output: "legacy output kept separately",
          details: ["extension", "owned"],
          addedToolNames: ["inspect_image"],
          terminate: true,
        },
        isError: false,
      }),
    );
    // Pi's following toolResult message contributes persisted-envelope fields
    // (notably timestamp) without creating a duplicate card.
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: {
          role: "toolResult",
          toolCallId: "t-rich",
          toolName: "generated_image",
          content: [
            { type: "text", text: "created", textSignature: "signed-created" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png", source: "tool" },
            { type: "text", text: "after image", extensionField: 1 },
          ],
          details: ["extension", "owned"],
          addedToolNames: ["inspect_image"],
          isError: false,
          timestamp: 1_700_000_000_000,
        },
      }),
    );

    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0];
    if (block?.type === "tool_call") {
      expect(block.data.outputText).toBe("created\nafter image");
      expect(block.data.outputImages).toEqual(["data:image/png;base64,aW1hZ2U="]);
      expect(block.data.resultContent).toEqual([
        { type: "text", text: "created", textSignature: "signed-created" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png", source: "tool" },
        { type: "text", text: "after image", extensionField: 1 },
      ]);
      expect(block.data.resultDetails).toEqual(["extension", "owned"]);
      expect(block.data.resultMetadata).toEqual({
        output: "legacy output kept separately",
        addedToolNames: ["inspect_image"],
        terminate: true,
        timestamp: 1_700_000_000_000,
      });
    }
  });

  it("replaces accumulated structured partial results instead of appending snapshots", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "make" },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
        partialResult: {
          content: [{ type: "text", text: "step 1\n" }],
          details: { truncation: { truncated: false } },
        },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
        partialResult: {
          content: [{ type: "text", text: "step 1\nstep 2\n" }],
          details: { fullOutputPath: "/tmp/pi-bash.log" },
        },
      }),
    );

    const block = state.blocks[0];
    if (block?.type === "tool_call") {
      expect(block.data.outputText).toBe("step 1\nstep 2\n");
      expect(block.data.resultContent).toEqual([{ type: "text", text: "step 1\nstep 2\n" }]);
      expect(block.data.resultDetails).toEqual({
        truncation: { truncated: false },
        fullOutputPath: "/tmp/pi-bash.log",
      });
    }
  });

  it("prefers the authoritative end result over accumulated partials and picks up diffs", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "edit",
        args: { file_path: "a.ts" },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "edit",
        args: {},
        partialResult: {
          content: [{ type: "text", text: "working...\n" }],
          details: { diff: "-partial" },
        },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "Edited a.ts" }],
          details: {
            diff: "-old\n+new",
            patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        },
        isError: false,
      }),
    );

    const block = state.blocks[0];
    if (block?.type === "tool_call") {
      expect(block.data.outputText).toBe("Edited a.ts");
      expect(block.data.diff).toBe("-old\n+new");
      expect(block.data.patch).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new");
      expect(block.data.resultDetails).toMatchObject({
        diff: "-old\n+new",
        patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
      });
    }
  });

  it("keeps accumulated partial output when the end result has no text", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "make" },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
        partialResult: "step 1\n",
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
        partialResult: "step 2\n",
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        result: null,
        isError: false,
      }),
    );

    const block = state.blocks[0];
    if (block?.type === "tool_call") {
      expect(block.data.outputText).toBe("step 1\nstep 2\n");
    }
  });

  it("interleaves thinking and tool blocks", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." },
      }),
    );
    state = applyPiEvent(
      state,
      e({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_end",
        toolCallId: "t2",
        toolName: "bash",
        result: null,
        isError: false,
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "done" },
      }),
    );
    state = applyPiEvent(state, e({ type: "message_end", message: ASST_MSG }));

    expect(state.blocks).toHaveLength(2); // assistant + tool
    expect(state.blocks[0]?.type).toBe("assistant");
    expect(state.blocks[1]?.type).toBe("tool_call");
  });

  it("inserts compaction marker on compaction_end", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "compaction_end",
        result: {
          summary: "Compacted 500 tokens",
          firstKeptEntryId: "kept-entry",
          tokensBefore: 1_750,
          estimatedTokensAfter: 1_250,
        },
      }),
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("compaction");
    if (state.blocks[0]?.type === "compaction") {
      expect(state.blocks[0].data.summary).toBe("Compacted 500 tokens");
      expect(state.blocks[0].data.estimatedTokensAfter).toBe(1_250);
    }
  });

  it("streams direct bash updates into one execution block", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "bash_execution_start",
        id: "bash-1",
        command: "printf hello",
        excludeFromContext: true,
      }),
    );
    state = applyPiEvent(state, e({ type: "bash_execution_update", id: "bash-1", delta: "hel" }));
    state = applyPiEvent(state, e({ type: "bash_execution_update", id: "bash-1", delta: "lo" }));
    state = applyPiEvent(
      state,
      e({
        type: "bash_execution_end",
        id: "bash-1",
        command: "printf hello",
        output: "hello",
        exitCode: 0,
        cancelled: false,
        excludeFromContext: true,
      }),
    );

    expect(state.activeBashExecutionId).toBeNull();
    expect(state.blocks).toMatchObject([
      {
        type: "bash",
        data: {
          command: "printf hello",
          outputText: "hello",
          exitCode: 0,
          excludeFromContext: true,
          isStreaming: false,
        },
      },
    ]);
  });

  it("keeps raw PTY replay transient and settles on normalized Shell Turn output", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "bash_execution_start",
        id: "shell-pty-1",
        command: "vim notes.txt",
        excludeFromContext: true,
        pty: true,
        startedAt: 1_786_000_000_000,
        cwd: "/workspace/project",
        cols: 100,
        rows: 24,
      }),
    );

    expect(state.activeBashExecutionId).toBe("shell-pty-1");
    expect(state.blocks).toMatchObject([
      {
        type: "bash",
        data: {
          executionId: "shell-pty-1",
          command: "vim notes.txt",
          outputText: "",
          terminalOutput: "",
          terminalOutputSequence: 0,
          terminalOutputChunks: [],
          terminalOutputChunkChars: 0,
          terminalMode: "compact",
          pty: true,
          isStreaming: true,
          excludeFromContext: true,
          startedAt: 1_786_000_000_000,
          timestamp: 1_786_000_000_000,
          cwd: "/workspace/project",
        },
      },
    ]);

    // Pi's text bash-update record is not a terminal screen and must not be
    // mixed into the normalized persisted output of a PTY-backed turn.
    state = applyPiEvent(
      state,
      e({
        type: "bash_execution_update",
        id: "shell-pty-1",
        delta: "text projection that must stay out of the terminal replay",
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "bash_terminal_data",
        id: "shell-pty-1",
        data: "\u001b[2J\u001b[Hediting",
        sequence: 1,
        mode: "compact",
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "bash_terminal_data",
        id: "shell-pty-1",
        data: "\u001b[?1049hfull screen",
        sequence: 2,
        mode: "fullscreen",
      }),
    );

    const liveBlock = state.blocks[0];
    expect(liveBlock?.type).toBe("bash");
    if (liveBlock?.type === "bash") {
      expect(liveBlock.data.outputText).toBe("");
      expect(liveBlock.data.terminalOutput).toBe("");
      expect(liveBlock.data.terminalOutputSequence).toBe(2);
      expect(liveBlock.data.terminalOutputChunks).toEqual([
        { sequence: 1, data: "\u001b[2J\u001b[Hediting" },
        { sequence: 2, data: "\u001b[?1049hfull screen" },
      ]);
      expect(liveBlock.data.terminalMode).toBe("fullscreen");
    }

    const beforeStaleData = state;
    state = applyPiEvent(
      state,
      e({
        type: "bash_terminal_data",
        id: "different-shell",
        data: "stale bytes",
        sequence: 3,
      }),
    );
    expect(state).toBe(beforeStaleData);

    state = applyPiEvent(
      state,
      e({
        type: "bash_execution_end",
        id: "shell-pty-1",
        command: "vim notes.txt",
        output: "final alternate-screen snapshot\n",
        exitCode: 130,
        cancelled: true,
        truncated: true,
        fullOutputPath: "/tmp/shell-pty-1.log",
        excludeFromContext: true,
        pty: true,
        durationMs: 1_234,
        signal: "SIGINT",
        normalization: "alternate_screen_final",
      }),
    );

    expect(state.activeBashId).toBeNull();
    expect(state.activeBashExecutionId).toBeNull();
    expect(state.blocks).toMatchObject([
      {
        type: "bash",
        data: {
          executionId: "shell-pty-1",
          command: "vim notes.txt",
          outputText: "final alternate-screen snapshot\n",
          terminalOutput: "",
          terminalOutputChunks: [],
          terminalOutputChunkChars: 0,
          terminalMode: "fullscreen",
          terminalOutputSequence: 2,
          pty: true,
          isStreaming: false,
          exitCode: 130,
          cancelled: true,
          truncated: true,
          fullOutputPath: "/tmp/shell-pty-1.log",
          excludeFromContext: true,
          durationMs: 1_234,
          signal: "SIGINT",
          normalization: "alternate_screen_final",
          startedAt: 1_786_000_000_000,
          cwd: "/workspace/project",
        },
      },
    ]);
  });

  it("retains an admitted PTY failure as a failed Shell Turn", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "bash_execution_start",
        id: "failed-shell",
        command: "missing-command",
        pty: true,
        startedAt: 1_786_000_000_000,
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "bash_execution_end",
        id: "failed-shell",
        command: "missing-command",
        output: "[Shell execution failed: spawn failed]",
        errorMessage: "spawn failed",
        pty: true,
        durationMs: 4,
        normalization: "terminal_buffer",
      }),
    );

    expect(state.blocks).toMatchObject([
      {
        type: "bash",
        data: {
          executionId: "failed-shell",
          outputText: "[Shell execution failed: spawn failed]",
          errorMessage: "spawn failed",
          isStreaming: false,
          pty: true,
          durationMs: 4,
        },
      },
    ]);
  });

  it("bounds live PTY replay to the newest one MiB without accepting stale execution data", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "bash_execution_start",
        id: "bounded-shell",
        command: "generate-output",
        pty: true,
      }),
    );
    const prefix = "old-prefix";
    const newest = "n".repeat(1024 * 1024);
    state = applyPiEvent(
      state,
      e({
        type: "bash_terminal_data",
        id: "bounded-shell",
        data: `${prefix}${newest}`,
        sequence: 9,
      }),
    );

    const block = state.blocks[0];
    expect(block?.type).toBe("bash");
    if (block?.type === "bash") {
      expect(block.data.terminalOutput).toBe("");
      expect(block.data.terminalReconstructionSequence).toBe(0);
      expect(block.data.terminalOutputSequence).toBe(9);
      expect(block.data.terminalOutputChunks).toEqual([
        { sequence: 9, data: newest, truncated: true },
      ]);
    }
  });

  it("keeps a reconstruction base static across sustained small live chunks", () => {
    const base = `\u001b[2J\u001b[H${"k".repeat(1024 * 1024 - 10)}`;
    let state = restoreActiveShellTurn(createTranscriptState(), {
      id: "sustained-shell",
      command: "yes",
      owner: { hostInstanceId: "shell-host", sessionEpoch: 4 },
      startedAt: 1_786_000_000_100,
      cols: 120,
      rows: 30,
      mode: "compact",
      ansi: base,
      outputThroughSequence: 100,
      reconstructionFenceToken: 1,
      inputAcknowledgedThrough: 0,
      resizeRevision: 0,
    });

    for (let sequence = 101; sequence <= 2_100; sequence += 1) {
      state = applyPiEvent(
        state,
        e({
          type: "bash_terminal_data",
          id: "sustained-shell",
          data: `line-${sequence}\r\n`,
          sequence,
        }),
      );
    }

    const block = state.blocks[0];
    expect(block?.type).toBe("bash");
    if (block?.type === "bash") {
      expect(block.data.terminalOutput).toBe(base);
      expect(block.data.terminalOutput).toHaveLength(base.length);
      expect(block.data.terminalOutputSequence).toBe(2_100);
      expect(block.data.terminalOutputChunks?.length).toBeLessThanOrEqual(512);
      expect(block.data.terminalOutputChunkChars).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  it("restores and refreshes one active Shell Turn from a bounded reconstruction keyframe", () => {
    const owner = { hostInstanceId: "shell-host", sessionEpoch: 4 };
    const shell = {
      id: "restored-shell",
      command: "python",
      owner,
      startedAt: 1_786_000_000_100,
      cwd: "/workspace/restored",
      excludeFromContext: false,
      cols: 120,
      rows: 30,
      mode: "compact" as const,
      ansi: "\u001b[2J\u001b[H>>> ",
      outputThroughSequence: 7,
      reconstructionFenceToken: 1,
      inputAcknowledgedThrough: 3,
      resizeRevision: 2,
      interruptRequestedAt: 1_786_000_000_500,
      replayTruncated: true,
    };

    const restored = restoreActiveShellTurn(createTranscriptState(), shell);
    const restoredBlock = restored.blocks[0];
    expect(restored.activeBashId).toBe(restoredBlock?.id);
    expect(restored.activeBashExecutionId).toBe("restored-shell");
    expect(restoredBlock).toMatchObject({
      type: "bash",
      data: {
        executionId: "restored-shell",
        command: "python",
        outputText: "",
        terminalOutput: "\u001b[2J\u001b[H>>> ",
        terminalReconstructionSequence: 7,
        terminalReconstructionFenceToken: 1,
        terminalOutputSequence: 7,
        terminalOutputChunks: [],
        terminalOutputChunkChars: 0,
        liveReplayTruncated: true,
        terminalMode: "compact",
        inputAcknowledgedThrough: 3,
        resizeRevision: 2,
        interruptRequestedAt: 1_786_000_000_500,
        pty: true,
        isStreaming: true,
        excludeFromContext: false,
        startedAt: 1_786_000_000_100,
        timestamp: 1_786_000_000_100,
        cwd: "/workspace/restored",
      },
    });

    const refreshed = restoreActiveShellTurn(restored, {
      ...shell,
      mode: "fullscreen",
      ansi: "\u001b[2J\u001b[Hfull-screen keyframe",
      outputThroughSequence: 12,
      reconstructionFenceToken: 2,
      inputAcknowledgedThrough: 8,
      resizeRevision: 5,
      cols: 160,
      rows: 48,
      replayTruncated: false,
    });
    expect(refreshed.blocks).toHaveLength(1);
    expect(refreshed.blocks[0]?.id).toBe(restoredBlock?.id);
    expect(refreshed.blocks[0]).toMatchObject({
      type: "bash",
      data: {
        terminalOutput: "\u001b[2J\u001b[Hfull-screen keyframe",
        terminalReconstructionSequence: 12,
        terminalReconstructionFenceToken: 2,
        terminalOutputSequence: 12,
        terminalOutputChunks: [],
        terminalOutputChunkChars: 0,
        liveReplayTruncated: false,
        terminalMode: "fullscreen",
        inputAcknowledgedThrough: 8,
        resizeRevision: 5,
      },
    });
  });

  it("restores non-PTY output, deduplicates covered replay, and settles from the final result", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "bash_execution_start",
        id: "restored-non-pty",
        command: "remote-build",
        pty: false,
        startedAt: 1_786_000_000_100,
        cwd: "/workspace/remote",
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "bash_execution_update",
        id: "restored-non-pty",
        delta: "pre-attach one\n",
        sequence: 1,
      }),
    );

    state = restoreActiveShellTurn(state, {
      id: "restored-non-pty",
      command: "remote-build",
      owner: { hostInstanceId: "shell-host", sessionEpoch: 4 },
      startedAt: 1_786_000_000_100,
      cwd: "/workspace/remote",
      pty: false,
      outputText: "retained baseline\n",
      outputThroughSequence: 2,
      replayTruncated: true,
    });
    state = applyPiEvent(
      state,
      e({
        type: "bash_execution_update",
        id: "restored-non-pty",
        delta: "covered replay\n",
        sequence: 2,
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "bash_execution_update",
        id: "restored-non-pty",
        delta: "live continuation\n",
        sequence: 3,
      }),
    );

    expect(state.blocks).toMatchObject([
      {
        type: "bash",
        data: {
          executionId: "restored-non-pty",
          command: "remote-build",
          outputText:
            "[Earlier shell output omitted during reload]\nretained baseline\nlive continuation\n",
          pty: false,
          isStreaming: true,
          streamOutputSequence: 3,
          liveReplayTruncated: true,
        },
      },
    ]);
    const active = state.blocks[0];
    expect(active?.type).toBe("bash");
    if (active?.type === "bash") {
      expect(active.data.terminalOutput).toBeUndefined();
      expect(active.data.terminalOutputSequence).toBeUndefined();
      expect(active.data.terminalMode).toBeUndefined();
    }

    state = applyPiEvent(
      state,
      e({
        type: "bash_execution_end",
        id: "restored-non-pty",
        command: "remote-build",
        output: "complete canonical output\n",
        exitCode: 0,
        pty: false,
        durationMs: 900,
      }),
    );
    expect(state.activeBashId).toBeNull();
    expect(state.activeBashExecutionId).toBeNull();
    expect(state.blocks).toMatchObject([
      {
        type: "bash",
        data: {
          outputText: "complete canonical output\n",
          exitCode: 0,
          isStreaming: false,
          pty: false,
        },
      },
    ]);
  });

  it("preserves usage on live tool results and compaction summaries", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "tool_execution_start",
        toolCallId: "usage-tool",
        toolName: "search",
        args: {},
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_end",
        toolCallId: "usage-tool",
        toolName: "search",
        result: { content: [{ type: "text", text: "done" }], usage: PI_USAGE },
        isError: false,
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "compaction_end",
        result: {
          summary: "summary",
          firstKeptEntryId: "kept-entry",
          tokensBefore: 500,
          usage: PI_USAGE,
        },
      }),
    );

    const blocks = allTranscriptBlocks(state);
    expect(blocks[0]).toMatchObject({ type: "tool_call", data: { usage: PI_USAGE } });
    expect(blocks[1]).toMatchObject({ type: "compaction", data: { usage: PI_USAGE } });
  });

  it("keeps nested ctx.executeTool activity inside the parent result", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "tool_execution_start",
        toolCallId: "parent",
        toolName: "codemode",
        args: { code: "await tools.read(...)" },
      }),
    );
    for (const event of [
      {
        type: "tool_execution_start" as const,
        toolCallId: "child",
        toolName: "read",
        args: { path: "README.md" },
        parentToolCallId: "parent",
      },
      {
        type: "tool_execution_update" as const,
        toolCallId: "child",
        toolName: "read",
        args: { path: "README.md" },
        partialResult: { content: [{ type: "text", text: "partial" }] },
        parentToolCallId: "parent",
      },
      {
        type: "tool_execution_end" as const,
        toolCallId: "child",
        toolName: "read",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
        parentToolCallId: "parent",
      },
    ]) {
      state = applyPiEvent(state, e(event));
    }
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_end",
        toolCallId: "parent",
        toolName: "codemode",
        result: {
          content: [{ type: "text", text: "complete" }],
          structuredContent: { value: 42 },
        },
        isError: false,
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: {
          role: "toolResult",
          toolCallId: "parent",
          toolName: "codemode",
          content: [{ type: "text", text: "complete" }],
          nestedCalls: {
            calls: [
              {
                id: "child",
                name: "read",
                arguments: { path: "README.md" },
                status: "ok",
                durationMs: 2,
              },
            ],
            complete: true,
          },
          usage: PI_USAGE,
          isError: false,
          timestamp: 1_700_000_000_000,
        },
      }),
    );

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      type: "tool_call",
      data: {
        toolCallId: "parent",
        outputText: "complete",
        resultMetadata: {
          structuredContent: { value: 42 },
          nestedCalls: {
            calls: [expect.objectContaining({ id: "child", name: "read", status: "ok" })],
            complete: true,
          },
        },
        usage: PI_USAGE,
      },
    });
  });
});

/**
 * WP3 — Transcript reconciliation for `role: "user"` and `role: "custom"`
 * message_start events. The optimistic user bubble from `addUserBlock(registerEcho)`
 * must dedupe against pi's authoritative echo.
 */
describe("transcript reducer — role-based message_start", () => {
  it("user message_start with matching head of pendingEchoes is consumed silently", () => {
    let state = createTranscriptState();
    state = addUserBlock(state, "hello", undefined, true, "intent-hello");
    expect(state.blocks).toHaveLength(1);
    expect(state.pendingEchoes).toEqual([
      expect.objectContaining({ intentId: "intent-hello", content: "hello" }),
    ]);

    state = applyPiEvent(
      state,
      e({ type: "message_start", message: USER_MSG, queueIntentId: "intent-hello" }),
    );
    // No new block — the optimistic user bubble stands.
    expect(state.blocks).toHaveLength(1);
    expect(state.pendingEchoes).toEqual([]);
  });

  it("a non-matching authoritative user event does not steal a queued echo", () => {
    let state = createTranscriptState();
    state = addUserBlock(state, "queued prompt", undefined, true, "intent-queued");
    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "user", content: "independent prompt" } }),
    );

    expect(
      state.blocks.map((block) => (block.type === "user" ? block.data.content : undefined)),
    ).toEqual(["queued prompt", "independent prompt"]);
    expect(state.pendingEchoes).toEqual([
      expect.objectContaining({ intentId: "intent-queued", content: "queued prompt" }),
    ]);

    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: { role: "user", content: "transformed queued prompt" },
        queueIntentId: "intent-queued",
      }),
    );
    expect(state.blocks).toHaveLength(2);
    expect(
      state.blocks.map((block) => (block.type === "user" ? block.data.content : undefined)),
    ).toEqual(["transformed queued prompt", "independent prompt"]);
    expect(state.pendingEchoes).toEqual([]);
  });

  it("clearing a failed optimistic echo lets a later server user message render", () => {
    let state = createTranscriptState();
    state = addUserBlock(state, "failed send", undefined, true, "intent-failed");
    state = clearPendingUserEcho(state, "failed send");
    expect(state.pendingEchoes).toEqual([]);

    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "user", content: "from server later" } }),
    );
    expect(state.blocks).toHaveLength(1);
    if (state.blocks[0]?.type === "user") {
      expect(state.blocks[0].data.content).toBe("from server later");
    }
  });

  it("clears only the tail-most matching user block, preserving an identical earlier one", () => {
    // Two identical prompts: an earlier legitimate one already in history and a
    // just-submitted optimistic one whose send then fails. Clearing must drop
    // only the tail-most (optimistic) block, never the historical echo.
    let state = createTranscriptState();
    state = addUserBlock(state, "retry me", undefined, false); // history — no echo token
    const historicalId = state.blocks[0]?.id;
    state = addUserBlock(state, "retry me", undefined, true, "intent-retry"); // optimistic
    expect(state.blocks).toHaveLength(2);
    expect(state.pendingEchoes).toEqual([
      expect.objectContaining({ intentId: "intent-retry", content: "retry me" }),
    ]);

    state = clearPendingUserEcho(state, "retry me");

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.id).toBe(historicalId);
    expect(state.pendingEchoes).toEqual([]);
  });

  it("a no-echo optimistic steer does not suppress the next real user echo", () => {
    let state = createTranscriptState();
    state = addUserBlock(state, "steer text", undefined, false);
    expect(state.pendingEchoes).toEqual([]);

    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "user", content: "next prompt" } }),
    );

    expect(state.blocks).toHaveLength(2);
    if (state.blocks[1]?.type === "user") {
      expect(state.blocks[1].data.content).toBe("next prompt");
    }
  });

  it("user message_start with no pending echo appends a fresh user block (server/extension-originated)", () => {
    // When there is no optimistic block waiting for an echo, a
    // role:"user" message_start must still render — this covers
    // server-/extension-originated user messages (slash command
    // dispatched via `prompt` with `commandSource: "extension"`), which
    // don't go through the optimistic addUserBlock(registerEcho) path.
    let state = createTranscriptState();
    expect(state.pendingEchoes).toEqual([]);
    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "user", content: "from extension" } }),
    );
    expect(state.blocks).toHaveLength(1);
    if (state.blocks[0]?.type === "user") {
      expect(state.blocks[0].data.content).toBe("from extension");
    }
    expect(state.pendingEchoes).toEqual([]);
  });

  it("keeps repeated identical authoritative prompts as distinct messages", () => {
    let state = createTranscriptState();
    const event = e({ type: "message_start", message: { role: "user", content: "repeat" } });
    state = applyPiEvent(state, event);
    state = applyPiEvent(state, event);

    expect(state.blocks).toHaveLength(2);
    expect(
      state.blocks.map((block) => (block.type === "user" ? block.data.content : undefined)),
    ).toEqual(["repeat", "repeat"]);
  });

  it("authoritative transformed text replaces its optimistic bubble by intent", () => {
    let state = createTranscriptState();
    state = addUserBlock(state, "hi", undefined, true, "intent-hi");
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: { role: "user", content: "rewritten hi\n" },
        queueIntentId: "intent-hi",
      }),
    );
    expect(state.blocks).toHaveLength(1);
    if (state.blocks[0]?.type === "user") {
      expect(state.blocks[0].data.content).toBe("rewritten hi\n");
    }
    expect(state.pendingEchoes).toEqual([]);
  });

  it("custom message_start with display:true renders content (not display)", () => {
    // `display` is a boolean visibility gate; `content` is the rendered text.
    // (Mirrors pi's TUI: CustomMessageComponent renders message.content.)
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: {
          role: "custom",
          customType: "skill",
          display: true,
          content: "ran skill brave-search",
        },
      }),
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("custom_message");
    if (state.blocks[0]?.type === "custom_message") {
      expect(state.blocks[0].data.content).toBe("ran skill brave-search");
    }

    // content as an array of text blocks is joined (pi's CustomMessageComponent
    // does the same).
    state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: {
          role: "custom",
          customType: "skill",
          display: true,
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      }),
    );
    expect(state.blocks).toHaveLength(1);
    if (state.blocks[0]?.type === "custom_message") {
      expect(state.blocks[0].data.content).toBe("line one\nline two");
    }
  });

  it("preserves image/details/timestamp fields on public custom messages", () => {
    const state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "message_start",
        message: {
          role: "custom",
          customType: "artifact-preview",
          display: true,
          content: [
            { type: "text", text: "preview" },
            { type: "image", data: "cHJldmlldw==", mimeType: "image/webp" },
          ],
          details: null,
          timestamp: 1_700_000_000_123,
        },
      }),
    );

    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0];
    if (block?.type === "custom_message") {
      expect(block.data).toEqual({
        content: "preview",
        images: ["data:image/webp;base64,cHJldmlldw=="],
        rawContent: [
          { type: "text", text: "preview" },
          { type: "image", data: "cHJldmlldw==", mimeType: "image/webp" },
        ],
        customType: "artifact-preview",
        details: null,
        timestamp: 1_700_000_000_123,
      });
    }
  });

  it("retains otherwise non-renderable custom content for inspection", () => {
    const state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "message_start",
        message: { role: "custom", display: true, content: { extensionPayload: true } },
      }),
    );

    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0];
    if (block?.type === "custom_message") {
      expect(block.data.rawContent).toEqual({ extensionPayload: true });
      expect(block.data.content).toBe("");
    }
  });

  it("materializes every public bashExecution field", () => {
    const state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "message_start",
        message: {
          role: "bashExecution",
          command: "npm test",
          output: "partial output\n",
          exitCode: 130,
          cancelled: true,
          truncated: true,
          fullOutputPath: "/tmp/pi-bash-full.log",
          excludeFromContext: true,
          timestamp: 1_700_000_000_456,
        },
      }),
    );

    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0];
    if (block?.type === "bash") {
      expect(block.data).toEqual({
        command: "npm test",
        outputText: "partial output\n",
        isStreaming: false,
        exitCode: 130,
        cancelled: true,
        truncated: true,
        fullOutputPath: "/tmp/pi-bash-full.log",
        excludeFromContext: true,
        timestamp: 1_700_000_000_456,
      });
    }
  });

  it("renders Pi 0.80.4 opt-in cache-miss notices", () => {
    const state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "cache_miss_notice",
        noticeId: "cache-miss-1",
        missedTokens: 25_000,
        missedCost: 0.12,
        idleMs: 6 * 60_000,
        modelChanged: false,
      }),
    );
    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0];
    if (block?.type === "custom_message") {
      expect(block.id).toBe("cache-miss-1");
      expect(block.data.content).toBe("Cache miss after 6m idle: 25K tokens re-billed (~$0.12)");
    }
  });

  it("anchors replayed cache notices in history and deduplicates live notices", () => {
    const event = e({
      type: "cache_miss_notice",
      noticeId: "cache-miss-history",
      afterEntryId: "assistant-1",
      missedTokens: 25_000,
      missedCost: 0.12,
      idleMs: 0,
      modelChanged: false,
    });
    const initial = seedFromHistory(createTranscriptState(), [
      { id: "assistant-1", type: "assistant", data: { role: "assistant", content: "Done" } },
      {
        id: "assistant-1-tool-call-1",
        type: "tool_call",
        data: {
          toolCallId: "call-1",
          toolName: "read",
          outputText: "ok",
          isError: false,
          isStreaming: false,
        },
      },
      { id: "user-2", type: "user", data: { content: "Next" } },
    ]);
    const withNotice = applyPiEvent(initial, event);
    expect(allTranscriptBlocks(withNotice).map((block) => block.id)).toEqual([
      "assistant-1",
      "assistant-1-tool-call-1",
      "cache-miss-history",
      "user-2",
    ]);
    expect(applyPiEvent(withNotice, event)).toBe(withNotice);
  });

  it("anchors replayed cache-warming notices inside hydrated history", () => {
    const initial = seedFromHistory(createTranscriptState(), [
      { id: "assistant-1", type: "assistant", data: { role: "assistant", content: "Done" } },
      {
        id: "assistant-1-tool-call-1",
        type: "tool_call",
        data: {
          toolCallId: "call-1",
          toolName: "read",
          outputText: "ok",
          isError: false,
          isStreaming: false,
        },
      },
      { id: "user-2", type: "user", data: { content: "Next" } },
    ]);
    const event = e({
      type: "cache_warming_notice",
      noticeId: "cache-warm:warm-1",
      usage: PI_USAGE,
      provider: "anthropic",
      model: "claude-sonnet",
      note: "extension override",
      afterEntryId: "assistant-1",
    });

    const withNotice = applyPiEvent(initial, event);
    const withSecondNotice = applyPiEvent(
      withNotice,
      e({
        ...event,
        noticeId: "cache-warm:warm-2",
        note: "second refresh",
        afterEntryId: "cache-warm:warm-1",
      }),
    );
    expect(allTranscriptBlocks(withSecondNotice).map((block) => block.id)).toEqual([
      "assistant-1",
      "assistant-1-tool-call-1",
      "cache-warm:warm-1",
      "cache-warm:warm-2",
      "user-2",
    ]);
    expect(withSecondNotice.archivedBlockCount).toBe(5);
    expect(allTranscriptBlocks(withSecondNotice)[2]).toMatchObject({
      type: "custom_message",
      data: { content: "Cache warmed (extension override): $3.300" },
    });
    expect(applyPiEvent(withNotice, event)).toBe(withNotice);
  });

  it("ignores replayed cache notices whose history anchor is absent", () => {
    const initial = seedFromHistory(createTranscriptState(), [
      { id: "user-2", type: "user", data: { content: "Next" } },
    ]);
    const next = applyPiEvent(
      initial,
      e({
        type: "cache_miss_notice",
        noticeId: "cache-miss-earlier",
        afterEntryId: "assistant-earlier",
        missedTokens: 25_000,
        missedCost: 0.12,
        idleMs: 0,
        modelChanged: false,
      }),
    );
    expect(next).toBe(initial);
  });

  it("renders Pi 0.80.4 custom entries before a live assistant block", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "assistant", content: [] } }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "entry_appended",
        entry: { id: "entry-1", type: "custom", customType: "status-card", data: { count: 2 } },
      }),
    );

    expect(state.blocks.map((block) => block.type)).toEqual(["custom_entry", "assistant"]);
    const first = state.blocks[0];
    if (first?.type === "custom_entry") {
      expect(first.data).toEqual({
        entryId: "entry-1",
        customType: "status-card",
        data: { count: 2 },
      });
    }
  });

  it("renders new public entry_appended payloads without exposing context-only rows", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "entry_appended",
        entry: {
          id: "custom-message-1",
          type: "custom_message",
          customType: "notice",
          display: true,
          content: [{ type: "text", text: "visible" }],
          details: { retained: true },
        },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "entry_appended",
        entry: {
          id: "compaction-1",
          type: "compaction",
          summary: "fresh start",
          firstKeptEntryId: "compaction-1",
          tokensBefore: 500,
          systemMessage: {
            role: "system",
            content: "new prompt",
            timestamp: 1_700_000_000_000,
          },
        },
      }),
    );
    const visible = state;
    state = applyPiEvent(
      state,
      e({
        type: "entry_appended",
        entry: {
          id: "context-edit-1",
          type: "context_edit",
          targetId: "system-1",
          replacement: null,
        },
      }),
    );
    state = applyPiEvent(
      state,
      e({
        type: "entry_appended",
        entry: {
          id: "usage-1",
          type: "usage",
          kind: "cache_warm",
          provider: "anthropic",
          model: "claude-sonnet",
          usage: PI_USAGE,
        },
      }),
    );

    expect(state).toBe(visible);
    expect(state.blocks).toMatchObject([
      {
        id: "custom-message-1",
        type: "custom_message",
        data: { content: "visible", details: { retained: true } },
      },
      {
        id: "compaction-1",
        type: "compaction",
        data: {
          summary: "fresh start",
          firstKeptEntryId: "compaction-1",
          systemMessage: {
            role: "system",
            content: "new prompt",
            timestamp: 1_700_000_000_000,
          },
        },
      },
    ]);
  });

  it("does not expose transcript-backed system messages as chat bubbles", () => {
    const system = { role: "system", content: "private model context" };
    let state = applyPiEvent(
      createTranscriptState(),
      e({ type: "message_start", message: system }),
    );
    state = applyPiEvent(state, e({ type: "message_end", message: system }));
    expect(state.blocks).toEqual([]);
  });

  it("custom message_start without display renders nothing (matches pi's TUI)", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: { role: "custom", customType: "x", content: { foo: 1 } },
      }),
    );
    expect(state.blocks).toHaveLength(0);

    // A boolean `content: true` must not be JSON-stringified into "true".
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: { role: "custom", customType: "x", content: true },
      }),
    );
    expect(state.blocks).toHaveLength(0);
  });

  it("message_end with role: 'user' is a no-op (does not close assistant)", () => {
    let state = createTranscriptState();
    state = addUserBlock(state, "hello", undefined, true);
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    const activeId = state.activeAssistantId;
    expect(activeId).toBeTruthy();
    // Now pi sends user message_end (echo close) followed by an
    // assistant turn. The user end must not clear activeAssistantId.
    state = applyPiEvent(state, e({ type: "message_end", message: USER_MSG }));
    expect(state.activeAssistantId).toBe(activeId);
  });

  it("multiple pending echoes are consumed FIFO across turns", () => {
    let state = createTranscriptState();
    state = addUserBlock(state, "first", undefined, true, "intent-first");
    state = addUserBlock(state, "second", undefined, true, "intent-second");
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: { role: "user", content: "transformed first" },
        queueIntentId: "intent-first",
      }),
    );
    expect(state.pendingEchoes).toEqual([
      expect.objectContaining({ intentId: "intent-second", content: "second" }),
    ]);
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: { role: "user", content: "transformed second" },
        queueIntentId: "intent-second",
      }),
    );
    expect(state.pendingEchoes).toEqual([]);
  });
});

describe("transcript reducer — provider errors", () => {
  const ERR_MSG = {
    ...ASST_MSG,
    stopReason: "error" as const,
    errorMessage: "Provider returned error",
  };

  it("surfaces an empty failed turn as an error block (no blank bubble)", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ERR_MSG }));
    state = applyPiEvent(state, e({ type: "message_end", message: ERR_MSG }));

    expect(state.activeAssistantId).toBeNull();
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("error");
    if (state.blocks[0]?.type === "error") {
      expect(state.blocks[0].data.message).toBe("Provider returned error");
    }
  });

  it("falls back to a generic message when errorMessage is absent", () => {
    const noMsg = { ...ASST_MSG, stopReason: "error" as const };
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: noMsg }));
    state = applyPiEvent(state, e({ type: "message_end", message: noMsg }));

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("error");
    if (state.blocks[0]?.type === "error") {
      expect(state.blocks[0].data.message).toBe("The model response ended with an error.");
    }
  });

  it("keeps partial output and appends an error block when a turn fails mid-stream", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      }),
    );
    state = applyPiEvent(state, e({ type: "message_end", message: ERR_MSG }));

    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]?.type).toBe("assistant");
    if (state.blocks[0]?.type === "assistant") {
      expect(state.blocks[0].data.segments.map((s) => s.content).join("")).toBe("partial");
      expect(state.blocks[0].data.isStreaming).toBe(false);
    }
    expect(state.blocks[1]?.type).toBe("error");
  });

  it("inserts the error block right after the assistant block, before later tool blocks", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      }),
    );
    state = applyPiEvent(
      state,
      e({ type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: {} }),
    );
    state = applyPiEvent(state, e({ type: "message_end", message: ERR_MSG }));

    // Order must match what history-loader reconstructs on reload:
    // assistant → error → tool_call (not assistant → tool_call → error).
    expect(state.blocks.map((b) => b.type)).toEqual(["assistant", "error", "tool_call"]);
  });

  it("surfaces an error even if message_start was missed (no active block)", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_end", message: ERR_MSG }));
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("error");
  });

  it("marks an automatically retried provider error as retryable", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ERR_MSG }));
    state = applyPiEvent(state, e({ type: "message_end", message: ERR_MSG }));
    state = applyPiEvent(state, e({ type: "agent_end", willRetry: true }));

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("error");
    if (state.blocks[0]?.type === "error") {
      expect(state.blocks[0].data.retryable).toBe(true);
    }
  });

  it("does not relabel an older final error when a retry event has no current error", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ERR_MSG }));
    state = applyPiEvent(state, e({ type: "message_end", message: ERR_MSG }));
    state = applyPiEvent(state, e({ type: "agent_end", willRetry: false }));
    state = applyPiEvent(state, e({ type: "agent_end", willRetry: true }));

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("error");
    if (state.blocks[0]?.type === "error") {
      expect(state.blocks[0].data.retryable).toBeUndefined();
    }
  });

  it("a normal stop does not produce an error block", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "ok" },
      }),
    );
    state = applyPiEvent(state, e({ type: "message_end", message: ASST_MSG }));
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("assistant");
  });
});

// ── Performance: streaming must reconcile in O(1) per token ──────────────
// The reducer used to `.map` the whole `blocks` array on every text_delta /
// thinking_delta / tool_execution_update — a per-element callback that made
// streaming O(n²) over a long session (the freeze). It now copies only the
// array spine and replaces the one streamed slot, so every *element* ref
// except the streamed block stays stable — which is what lets the memo'd
// block renderers skip. The array ref itself changes each delta (preserving
// referential integrity for any ref-equality consumer); only the per-element
// copy is avoided.
describe("transcript reducer — streaming perf invariants", () => {
  it("a text_delta preserves every untouched element reference", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    const refBefore = state.blocks;
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "x" },
      }),
    );
    // Fresh array (ref-equality consumers see the change) but no per-element
    // copy: the spine is cloned, the streamed slot replaced.
    expect(state.blocks).not.toBe(refBefore);
    expect(state.blocks).toHaveLength(refBefore.length);
  });

  it("a text_delta only changes the streamed block's `data` reference", () => {
    let state = createTranscriptState();
    // An earlier assistant block (unchanged by the next delta).
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "first" },
      }),
    );
    state = applyPiEvent(state, e({ type: "message_end", message: ASST_MSG }));
    const earlierData = state.blocks[0]?.data;

    // A second assistant turn whose text streams in.
    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASST_MSG,
        assistantMessageEvent: { type: "text_delta", delta: "second" },
      }),
    );

    // The earlier, untouched block keeps its exact `data` reference, so a
    // React.memo'd renderer skips it. Only the streaming block changed.
    expect(state.blocks[0]?.data).toBe(earlierData);
    expect(
      (state.blocks[1]?.data as { segments: Array<{ content: string }> }).segments
        .map((s) => s.content)
        .join(""),
    ).toBe("second");
  });

  it("streaming after compaction never copies the archived scrollback chunk", () => {
    let state = createTranscriptState();
    for (let index = 0; index < 1_000; index += 1) {
      state = addUserBlock(state, `archived-${index}`);
    }
    const preCompactionArray = state.blocks;
    state = applyPiEvent(
      state,
      e({
        type: "compaction_end",
        result: { summary: "summary", firstKeptEntryId: "kept-entry", tokensBefore: 500 },
      }),
    );
    expect(state.archivedBlockChunks[0]).toBe(preCompactionArray);
    const archivedChunk = state.archivedBlockChunks[0];
    const firstArchivedBlock = archivedChunk?.[0];

    state = applyPiEvent(state, e({ type: "message_start", message: ASST_MSG }));
    for (let index = 0; index < 100; index += 1) {
      state = applyPiEvent(
        state,
        e({
          type: "message_update",
          message: ASST_MSG,
          assistantMessageEvent: { type: "text_delta", delta: "x" },
        }),
      );
    }

    expect(state.archivedBlockChunks[0]).toBe(archivedChunk);
    expect(state.archivedBlockChunks[0]?.[0]).toBe(firstArchivedBlock);
    expect(state.blocks).toHaveLength(2); // compaction marker + live assistant
  });

  it("keeps count and complete scrollback across many tiny archive chunks", () => {
    let state = createTranscriptState();
    for (let index = 0; index < 500; index += 1) {
      state = applyPiEvent(
        state,
        e({
          type: "compaction_end",
          result: {
            summary: `summary-${index}`,
            firstKeptEntryId: `kept-${index}`,
            tokensBefore: 500,
          },
        }),
      );
    }

    expect(state.archivedBlockChunks).toHaveLength(499);
    expect(state.archivedBlockCount).toBe(499);
    expect(transcriptBlockCount(state)).toBe(500);
    expect(allTranscriptBlocks(state)).toHaveLength(500);
    expect(allTranscriptBlocks(state).at(-1)).toBe(state.blocks.at(-1));
  });

  it("a tool_execution_update preserves untouched element references", () => {
    let state = createTranscriptState();
    // An earlier block the tool update must not touch.
    state = addUserBlock(state, "earlier");
    const earlierData = state.blocks[0]?.data;
    state = applyPiEvent(
      state,
      e({ type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: {} }),
    );
    const refBefore = state.blocks;
    state = applyPiEvent(
      state,
      e({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "read_file",
        partialResult: "chunk",
      }),
    );
    // Fresh array, but the earlier block keeps its exact `data` ref so a
    // memo'd renderer skips it.
    expect(state.blocks).not.toBe(refBefore);
    expect(state.blocks[0]?.data).toBe(earlierData);
  });
});

// ── Interleaved content blocks: order is preserved ─────────────────────
// A single model message can interleave thinking and text content blocks.
// The reducer must preserve the model's true output order so that later
// thinking renders *below* earlier text, matching pi's TUI.
describe("transcript reducer — interleaved thinking/text", () => {
  function startAssistant() {
    return applyPiEvent(createTranscriptState(), {
      type: "message_start",
      message: { role: "assistant" },
    });
  }

  it("preserves thinking→text→thinking order with contentIndex", () => {
    let state = startAssistant();
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "Hmm", contentIndex: 0 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Hmm" },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Answer", contentIndex: 1 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Answer" },
    });
    // resumed thinking block (new contentIndex) — the regression case
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_start", contentIndex: 2 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "more", contentIndex: 2 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_end", contentIndex: 2, content: "more" },
    });
    state = applyPiEvent(state, { type: "message_end", message: { role: "assistant" } });

    const block = state.blocks[0];
    if (block?.type !== "assistant") throw new Error("expected assistant block");
    expect(block.data.segments).toEqual([
      { kind: "thinking", content: "Hmm", contentIndex: 0 },
      { kind: "text", content: "Answer", contentIndex: 1 },
      { kind: "thinking", content: "more", contentIndex: 2 },
    ]);
  });

  it("preserves order without contentIndex (positional fallback)", () => {
    // Providers/events that omit contentIndex still interleave correctly via
    // the positional fallback: deltas append to the last same-kind segment,
    // and a kind change opens a new segment.
    let state = startAssistant();
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "Hmm" },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Answer" },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "more" },
    });
    state = applyPiEvent(state, { type: "message_end", message: { role: "assistant" } });

    const block = state.blocks[0];
    if (block?.type !== "assistant") throw new Error("expected assistant block");
    expect(block.data.segments).toEqual([
      { kind: "thinking", content: "Hmm", contentIndex: undefined },
      { kind: "text", content: "Answer", contentIndex: undefined },
      { kind: "thinking", content: "more", contentIndex: undefined },
    ]);
  });

  it("*_end backfills snapshot only when streaming missed content", () => {
    // No deltas — the end snapshot provides the content.
    let state = startAssistant();
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "from-snapshot" },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "answer" },
    });
    state = applyPiEvent(state, { type: "message_end", message: { role: "assistant" } });

    const block = state.blocks[0];
    if (block?.type !== "assistant") throw new Error("expected assistant block");
    expect(block.data.segments).toEqual([
      { kind: "thinking", content: "from-snapshot", contentIndex: 0 },
      { kind: "text", content: "answer", contentIndex: 1 },
    ]);
  });

  it("*_end does not overwrite content already received via deltas", () => {
    let state = startAssistant();
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "streamed", contentIndex: 0 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "DIFFERENT" },
    });
    state = applyPiEvent(state, { type: "message_end", message: { role: "assistant" } });

    const block = state.blocks[0];
    if (block?.type !== "assistant") throw new Error("expected assistant block");
    expect(block.data.segments).toEqual([{ kind: "text", content: "streamed", contentIndex: 0 }]);
  });

  it("duplicate *_start with same contentIndex does not create a phantom segment", () => {
    let state = startAssistant();
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "x", contentIndex: 0 },
    });
    state = applyPiEvent(state, { type: "message_end", message: { role: "assistant" } });

    const block = state.blocks[0];
    if (block?.type !== "assistant") throw new Error("expected assistant block");
    expect(block.data.segments).toEqual([{ kind: "text", content: "x", contentIndex: 0 }]);
  });

  it("a reused contentIndex across kinds does not cross-wire deltas", () => {
    // If a provider reuses a contentIndex across a thinking and a text block
    // (a quirk, not the wire contract), a text_delta must NOT land in the
    // thinking segment. The old flat-field design was immune; the segment
    // router must be too.
    let state = startAssistant();
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "Hmm", contentIndex: 0 },
    });
    // text block reuses index 0
    state = applyPiEvent(state, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0 },
    });
    state = applyPiEvent(state, { type: "message_end", message: { role: "assistant" } });

    const block = state.blocks[0];
    if (block?.type !== "assistant") throw new Error("expected assistant block");
    expect(block.data.segments).toEqual([
      { kind: "thinking", content: "Hmm", contentIndex: 0 },
      { kind: "text", content: "hi", contentIndex: 0 },
    ]);
  });
});

// ── Compaction changes model context, never GUI scrollback ──────────────
describe("transcript reducer — compaction preserves scrollback", () => {
  function withUserBlocks(n: number) {
    let state = createTranscriptState();
    for (let i = 0; i < n; i++) state = addUserBlock(state, `m${i}`);
    return state;
  }

  it("keeps every pre-compaction block and appends the marker", () => {
    let state = withUserBlocks(250);
    const originalIds = state.blocks.map((block) => block.id);

    state = applyPiEvent(
      state,
      e({
        type: "compaction_end",
        result: { summary: "s1", firstKeptEntryId: "kept-1", tokensBefore: 500 },
      }),
    );

    const allBlocks = allTranscriptBlocks(state);
    expect(allBlocks.slice(0, -1).map((block) => block.id)).toEqual(originalIds);
    expect(allBlocks).toHaveLength(251);
    expect(allBlocks[250]?.type).toBe("compaction");
    expect(state.archivedBlockChunks[0]).toHaveLength(250);
    expect(state.blocks).toHaveLength(1);
  });

  it("preserves scrollback across repeated compactions", () => {
    let state = withUserBlocks(250);
    state = applyPiEvent(
      state,
      e({
        type: "compaction_end",
        result: { summary: "s1", firstKeptEntryId: "kept-1", tokensBefore: 500 },
      }),
    );
    for (let i = 0; i < 50; i++) state = addUserBlock(state, `post${i}`);
    const beforeSecondCompaction = allTranscriptBlocks(state);
    const firstArchive = state.archivedBlockChunks[0];

    state = applyPiEvent(
      state,
      e({
        type: "compaction_end",
        result: { summary: "s2", firstKeptEntryId: "kept-2", tokensBefore: 500 },
      }),
    );

    const allBlocks = allTranscriptBlocks(state);
    expect(allBlocks.slice(0, -1)).toEqual(beforeSecondCompaction);
    expect(allBlocks).toHaveLength(302);
    expect(allBlocks[250]?.type).toBe("compaction");
    expect(allBlocks[301]?.type).toBe("compaction");
    expect(state.archivedBlockChunks[0]).toBe(firstArchive);
    expect(state.blocks).toHaveLength(1);
  });

  it("compaction on an empty transcript still produces just the marker", () => {
    const state = applyPiEvent(
      createTranscriptState(),
      e({
        type: "compaction_end",
        result: { summary: "s", firstKeptEntryId: "kept-entry", tokensBefore: 500 },
      }),
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("compaction");
  });
});
