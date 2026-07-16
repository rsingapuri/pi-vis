import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import { describe, expect, it } from "vitest";
import {
  type TranscriptState,
  addBashBlock,
  addUserBlock,
  allTranscriptBlocks,
  applyPiEvent,
  createTranscriptState,
  finalizeActiveBlocks,
  finishBashBlock,
  mapHistoryBlocks,
  seedFromHistory,
} from "./transcript.js";

function e<T extends KnownPiEvent>(event: T): T {
  return event;
}

const ASSISTANT = { role: "assistant" as const };

function liveStreams(): TranscriptState {
  let state = createTranscriptState();
  state = addUserBlock(state, "queued", undefined, true, "intent-queued");
  state = applyPiEvent(state, e({ type: "message_start", message: ASSISTANT }));
  state = applyPiEvent(
    state,
    e({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} }),
  );
  state = addBashBlock(state, "echo one");
  return { ...state, pendingRetryErrorBlockId: "old-error" };
}

describe("transcript lifecycle invariants", () => {
  it("seeds history as a full baseline while retaining only monotonic user sequence", () => {
    let state = liveStreams();
    state = applyPiEvent(
      state,
      e({ type: "message_start", message: { role: "user", content: "authoritative" } }),
    );
    const sequence = state.userMessageSequence;

    state = seedFromHistory(state, [
      { id: "history-user", type: "user", data: { content: "history" } },
    ]);

    expect(state.blocks).toEqual([]);
    expect(allTranscriptBlocks(state).map((block) => block.id)).toEqual(["history-user"]);
    expect(state.activeAssistantId).toBeNull();
    expect(state.activeToolCallIds).toEqual(new Map());
    expect(state.activeBashId).toBeNull();
    expect(state.pendingRetryErrorBlockId).toBeNull();
    expect(state.pendingEchoes).toEqual([]);
    expect(state.authoritativeUserEchoes).toEqual([]);
    expect(state.userMessageSequence).toBe(sequence);
  });

  it.each([
    ["aborted", { aborted: true }],
    ["retrying", { willRetry: true }],
    ["failed", { errorMessage: "no context" }],
  ] as const)("keeps live streams active when compaction is %s", (_name, event) => {
    const before = liveStreams();
    const state = applyPiEvent(before, e({ type: "compaction_end", ...event }));

    expect(state.activeAssistantId).toBe(before.activeAssistantId);
    expect(state.activeToolCallIds).toBe(before.activeToolCallIds);
    expect(state.activeBashId).toBe(before.activeBashId);
    expect(state.pendingRetryErrorBlockId).toBe("old-error");
    expect(state.archivedBlockChunks).toEqual([]);
    expect(state.blocks.slice(0, -1)).toEqual(before.blocks);
    expect(state.blocks.slice(0, -1).every((block, index) => block === before.blocks[index])).toBe(
      true,
    );
    expect(state.blocks.at(-1)?.type).toBe("compaction");
  });

  it("marks only active streaming tool and bash blocks interrupted when requested", () => {
    const state = finalizeActiveBlocks(liveStreams(), { markInterrupted: true });

    for (const block of state.blocks) {
      if (block.type === "tool_call" || block.type === "bash") {
        expect(block.data).toMatchObject({ isStreaming: false, interrupted: true });
      }
      if (block.type === "assistant") {
        expect(block.data).toMatchObject({ isStreaming: false });
        expect(block.data).not.toHaveProperty("interrupted");
      }
    }
  });

  it("archives finalized active blocks once, clears active lifecycle ids, and preserves echo custody", () => {
    const before = liveStreams();
    const state = applyPiEvent(before, e({ type: "compaction_end", result: { summary: "done" } }));

    expect(state.activeAssistantId).toBeNull();
    expect(state.activeToolCallIds).toEqual(new Map());
    expect(state.activeToolCallIds).not.toBe(before.activeToolCallIds);
    expect(state.activeBashId).toBeNull();
    expect(state.pendingRetryErrorBlockId).toBeNull();
    expect(state.pendingEchoes).toEqual(before.pendingEchoes);
    expect(state.archivedBlockChunks).toHaveLength(1);
    expect(state.archivedBlockChunks[0]).toHaveLength(before.blocks.length);
    for (const block of state.archivedBlockChunks[0] ?? []) {
      if (block.type === "assistant" || block.type === "tool_call" || block.type === "bash") {
        expect(block.data.isStreaming).toBe(false);
      }
      if (block.type === "tool_call" || block.type === "bash") {
        expect(block.data.interrupted).toBeUndefined();
      }
    }
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.type).toBe("compaction");
    expect(allTranscriptBlocks(state).filter((block) => block.type === "compaction")).toHaveLength(
      1,
    );
  });

  it("makes duplicate assistant and tool starts idempotent", () => {
    let state = createTranscriptState();
    state = applyPiEvent(state, e({ type: "message_start", message: ASSISTANT }));
    const assistantId = state.activeAssistantId;
    const afterAssistantStart = state;
    state = applyPiEvent(state, e({ type: "message_start", message: ASSISTANT }));
    expect(state).toBe(afterAssistantStart);
    expect(state.activeAssistantId).toBe(assistantId);
    expect(state.blocks).toHaveLength(1);

    state = applyPiEvent(
      state,
      e({ type: "tool_execution_start", toolCallId: "same-tool", toolName: "read", args: {} }),
    );
    const toolId = state.activeToolCallIds.get("same-tool");
    const afterToolStart = state;
    state = applyPiEvent(
      state,
      e({ type: "tool_execution_start", toolCallId: "same-tool", toolName: "read", args: {} }),
    );
    expect(state).toBe(afterToolStart);
    expect(state.activeToolCallIds.get("same-tool")).toBe(toolId);
    expect(state.blocks.filter((block) => block.type === "tool_call")).toHaveLength(1);
  });

  it("deduplicates immediate unindexed segment starts without merging later content blocks", () => {
    let state = applyPiEvent(
      createTranscriptState(),
      e({ type: "message_start", message: ASSISTANT }),
    );
    const start = e({
      type: "message_update" as const,
      message: ASSISTANT,
      assistantMessageEvent: { type: "text_start" as const },
    });
    state = applyPiEvent(state, start);
    state = applyPiEvent(state, start);
    state = applyPiEvent(
      state,
      e({
        type: "message_update",
        message: ASSISTANT,
        assistantMessageEvent: { type: "text_delta", delta: "first" },
      }),
    );
    state = applyPiEvent(state, start);

    const block = state.blocks[0];
    expect(block?.type).toBe("assistant");
    if (block?.type === "assistant") {
      expect(block.data.segments).toEqual([
        { kind: "text", content: "first", contentIndex: undefined },
        { kind: "text", content: "", contentIndex: undefined },
      ]);
    }
  });

  it("finishes bash normally, ignores a duplicate finish, and finalizes an old bash before another starts", () => {
    let state = addBashBlock(createTranscriptState(), "echo one");
    const firstId = state.activeBashId;
    state = finishBashBlock(state, "one\n", 0);
    expect(state.activeBashId).toBeNull();
    expect(state.blocks[0]).toMatchObject({
      id: firstId,
      type: "bash",
      data: { outputText: "one\n", exitCode: 0, isStreaming: false },
    });
    const finished = state;
    expect(finishBashBlock(state, "ignored")).toBe(finished);

    state = addBashBlock(state, "echo two");
    state = addBashBlock(state, "echo three");
    const bashBlocks = state.blocks.filter((block) => block.type === "bash");
    expect(bashBlocks).toHaveLength(3);
    expect(bashBlocks[1]?.data.isStreaming).toBe(false);
    expect(bashBlocks[2]?.data.isStreaming).toBe(true);
    expect(state.activeBashId).toBe(bashBlocks[2]?.id);
  });

  it("renders and records an authoritative echo when its optimistic block was already removed", () => {
    let state = addUserBlock(createTranscriptState(), "optimistic", undefined, true, "intent-lost");
    state = { ...state, blocks: [] };

    state = applyPiEvent(
      state,
      e({
        type: "message_start",
        message: { role: "user", content: "authoritative rewrite" },
        queueIntentId: "intent-lost",
      }),
    );

    expect(state.pendingEchoes).toEqual([]);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      type: "user",
      data: { content: "authoritative rewrite" },
    });
    expect(state.authoritativeUserEchoes).toEqual([
      expect.objectContaining({ intentId: "intent-lost", content: "authoritative rewrite" }),
    ]);
  });

  it("maps malformed history data and primitive/null assistant segments without throwing", () => {
    const blocks = mapHistoryBlocks([
      { id: "u", type: "user", data: null },
      {
        id: "a",
        type: "assistant",
        data: { segments: [null, 1, "bad", {}, { kind: "text", content: "ok" }] },
      },
      { id: "t", type: "tool_call", data: 1 },
      { id: "b", type: "bash", data: undefined },
    ] as never);

    expect(blocks.map((block) => block.type)).toEqual(["user", "assistant", "tool_call", "bash"]);
    expect(blocks[1]).toMatchObject({
      type: "assistant",
      data: { segments: [{ kind: "text", content: "ok" }] },
    });
  });
});
