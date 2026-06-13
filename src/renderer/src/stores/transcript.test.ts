import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import { describe, expect, it } from "vitest";
import { addUserBlock, applyPiEvent, createTranscriptState } from "./transcript.js";

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
      expect(block.data.textContent).toBe("Hello world");
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
      expect(block.data.thinkingContent).toBe("Hmm");
      expect(block.data.textContent).toBe("Answer");
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
        result: { content: [{ type: "text", text: '{\n  "name": "pi-vis"\n}' }] },
        isError: false,
      }),
    );

    const block = state.blocks[0];
    expect(block?.type).toBe("tool_call");
    if (block?.type === "tool_call") {
      expect(block.data.outputText).toBe('{\n  "name": "pi-vis"\n}');
      expect(block.data.isStreaming).toBe(false);
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
        partialResult: "working...\n",
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
          details: { diff: "-old\n+new" },
        },
        isError: false,
      }),
    );

    const block = state.blocks[0];
    if (block?.type === "tool_call") {
      expect(block.data.outputText).toBe("Edited a.ts");
      expect(block.data.diff).toBe("-old\n+new");
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
      e({ type: "compaction_end", result: { summary: "Compacted 500 tokens" } }),
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("compaction");
    if (state.blocks[0]?.type === "compaction") {
      expect(state.blocks[0].data.summary).toBe("Compacted 500 tokens");
    }
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
    state = addUserBlock(state, "hello", undefined, true);
    expect(state.blocks).toHaveLength(1);
    expect(state.pendingEchoes).toEqual(["hello"]);

    state = applyPiEvent(state, e({ type: "message_start", message: USER_MSG }));
    // No new block — the optimistic user bubble stands.
    expect(state.blocks).toHaveLength(1);
    expect(state.pendingEchoes).toEqual([]);
  });

  it("user message_start with non-matching text appends a fresh user block", () => {
    let state = createTranscriptState();
    state = addUserBlock(state, "what I typed", undefined, true);
    // pi echoes back an expanded text (e.g. a /skill template).
    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "user", content: "expanded prompt" } }),
    );
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[1]?.type).toBe("user");
    if (state.blocks[1]?.type === "user") {
      expect(state.blocks[1].data.content).toBe("expanded prompt");
    }
    // Echo head was NOT consumed (it didn't match); it remains for the
    // next echo to dedupe against.
    expect(state.pendingEchoes).toEqual(["what I typed"]);
  });

  it("custom message_start appends a custom_message block", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: {
          role: "custom",
          customType: "skill",
          display: "[skill] brave-search",
          content: { query: "abc" },
        },
      }),
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("custom_message");
    if (state.blocks[0]?.type === "custom_message") {
      expect(state.blocks[0].data.content).toBe("[skill] brave-search");
    }
  });

  it("custom message_start without display falls back to JSON of content", () => {
    let state = createTranscriptState();
    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: { role: "custom", customType: "x", content: { foo: 1 } },
      }),
    );
    if (state.blocks[0]?.type === "custom_message") {
      expect(state.blocks[0].data.content).toBe('{"foo":1}');
    }
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
    state = addUserBlock(state, "first", undefined, true);
    state = addUserBlock(state, "second", undefined, true);
    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "user", content: "first" } }),
    );
    expect(state.pendingEchoes).toEqual(["second"]);
    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "user", content: "second" } }),
    );
    expect(state.pendingEchoes).toEqual([]);
  });
});
