import { describe, expect, it } from "vitest";
import {
  BashExecutionEndEventSchema,
  BashTerminalDataEventSchema,
  CompactionEndEventSchema,
  PiEventSchema,
} from "./events.js";

const usage = {
  input: 100,
  output: 20,
  cacheRead: 5,
  cacheWrite: 2,
  totalTokens: 127,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
};

describe("PiEventSchema", () => {
  it.each(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error"])(
    "accepts the %s assistant stream subevent as a known message update",
    (type) => {
      const parsed = PiEventSchema.parse({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type, contentIndex: 1, delta: "{" },
      });

      expect(parsed.type).toBe("message_update");
      expect(parsed).not.toHaveProperty("__unknown");
    },
  );

  it("retains the forward-compatible marker for a genuinely unknown top-level event", () => {
    expect(PiEventSchema.parse({ type: "future_session_event" })).toMatchObject({
      type: "future_session_event",
      __unknown: true,
    });
  });

  it("retains Pi's estimated post-compaction token count", () => {
    expect(
      PiEventSchema.parse({
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "summary",
          firstKeptEntryId: "kept-entry",
          tokensBefore: 12_000,
          estimatedTokensAfter: 3_250,
        },
      }),
    ).toMatchObject({ result: { estimatedTokensAfter: 3_250 } });
  });

  it("accepts Pi 0.81 summarization retries and preserves compaction usage", () => {
    expect(
      PiEventSchema.parse({
        type: "summarization_retry_attempt_start",
        source: "compaction",
        reason: "overflow",
      }),
    ).not.toHaveProperty("__unknown");
    expect(
      PiEventSchema.parse({
        type: "compaction_end",
        result: {
          summary: "summary",
          firstKeptEntryId: "kept-entry",
          tokensBefore: 12_000,
          usage,
        },
      }),
    ).toMatchObject({ result: { usage } });
  });

  it("accepts pinned-Pi direct bash execution updates as known events", () => {
    expect(
      PiEventSchema.parse({
        type: "bash_execution_update",
        id: "bash-1",
        delta: "streamed output",
      }),
    ).toEqual({
      type: "bash_execution_update",
      id: "bash-1",
      delta: "streamed output",
    });
  });

  it("preserves pinned-Pi provider thinking, endTurn, and tool-call namespace metadata", () => {
    const message = {
      role: "assistant",
      providerThinkingLevel: "high",
      endTurn: true,
      content: [
        {
          type: "toolCall",
          id: "call-namespace",
          name: "search",
          namespace: "provider.tools",
          arguments: { query: "pi-vis" },
        },
      ],
    };
    expect(
      PiEventSchema.parse({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "toolcall_end", contentIndex: 0 },
      }),
    ).toMatchObject({ message });
  });

  it.each(["tool_execution_start", "tool_execution_update", "tool_execution_end"])(
    "preserves parentToolCallId on nested %s events",
    (type) => {
      const common = {
        type,
        toolCallId: "child-call",
        toolName: "read",
        parentToolCallId: "parent-call",
        args: { path: "README.md" },
      };
      const event =
        type === "tool_execution_update"
          ? { ...common, partialResult: { content: [{ type: "text", text: "partial" }] } }
          : type === "tool_execution_end"
            ? { ...common, result: { content: [{ type: "text", text: "done" }] }, isError: false }
            : common;

      expect(PiEventSchema.parse(event)).toMatchObject({
        type,
        parentToolCallId: "parent-call",
      });
    },
  );

  it("requires the persisted string boundary on a successful compaction result", () => {
    const event = {
      type: "compaction_end" as const,
      result: {
        summary: "fresh start",
        firstKeptEntryId: "compaction-entry-id",
        tokensBefore: 500,
        details: { source: "hook" },
      },
    };

    expect(CompactionEndEventSchema.parse(event)).toMatchObject(event);
    expect(
      CompactionEndEventSchema.safeParse({
        ...event,
        result: { ...event.result, firstKeptEntryId: null },
      }).success,
    ).toBe(false);
  });

  it("accepts Pi 0.99 cache-warming projections as known events", () => {
    expect(
      PiEventSchema.parse({
        type: "cache_warming_notice",
        noticeId: "cache-warm:warm-1",
        usage,
        provider: "anthropic",
        model: "claude-sonnet",
        note: "extension override",
        afterEntryId: "assistant-1",
      }),
    ).toEqual({
      type: "cache_warming_notice",
      noticeId: "cache-warm:warm-1",
      usage,
      provider: "anthropic",
      model: "claude-sonnet",
      note: "extension override",
      afterEntryId: "assistant-1",
    });
  });

  it("accepts the complete PTY Shell Turn lifecycle without treating raw bytes as unknown", () => {
    expect(
      PiEventSchema.parse({
        type: "bash_execution_start",
        id: "shell-1",
        command: "vim package.json",
        excludeFromContext: true,
        pty: true,
        startedAt: 1_700_000_000_000,
        cwd: "/workspace",
        cols: 80,
        rows: 24,
      }),
    ).not.toHaveProperty("__unknown");

    expect(
      PiEventSchema.parse({
        type: "bash_terminal_data",
        id: "shell-1",
        data: "\u001b[?1049h",
        sequence: 1,
        mode: "fullscreen",
      }),
    ).toEqual({
      type: "bash_terminal_data",
      id: "shell-1",
      data: "\u001b[?1049h",
      sequence: 1,
      mode: "fullscreen",
    });

    expect(
      PiEventSchema.parse({
        type: "bash_execution_end",
        id: "shell-1",
        command: "vim package.json",
        output: "[alternate screen final frame 80x24]\npackage.json",
        exitCode: 0,
        cancelled: false,
        excludeFromContext: true,
        pty: true,
        durationMs: 321,
        signal: "SIGINT",
        normalization: "alternate_screen_final",
      }),
    ).not.toHaveProperty("__unknown");
  });

  it("rejects invalid PTY sequence and normalization metadata", () => {
    expect(
      BashTerminalDataEventSchema.safeParse({
        type: "bash_terminal_data",
        id: "shell-1",
        data: "output",
        sequence: 0,
      }).success,
    ).toBe(false);
    expect(
      BashExecutionEndEventSchema.safeParse({
        type: "bash_execution_end",
        id: "shell-1",
        command: "true",
        output: "",
        normalization: "raw_ansi",
      }).success,
    ).toBe(false);
  });
});
