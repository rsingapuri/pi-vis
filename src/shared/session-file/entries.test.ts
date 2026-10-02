import { describe, expect, it } from "vitest";
import { CompactionEntrySchema, ContextEditEntrySchema, SessionEntrySchema } from "./entries.js";

const usage = {
  input: 100,
  output: 20,
  cacheRead: 5,
  cacheWrite: 2,
  totalTokens: 127,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
};

describe("SessionEntrySchema pinned-Pi public payloads", () => {
  it.each([
    {
      role: "bashExecution",
      command: "npm test",
      output: "ok",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    },
    {
      role: "custom",
      customType: "artifact",
      content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
      display: true,
      details: null,
      timestamp: 2,
    },
  ])("accepts message role $role without requiring text content", (message) => {
    const parsed = SessionEntrySchema.parse({
      type: "message",
      id: `message-${message.role}`,
      parentId: null,
      timestamp: 0,
      message,
    });

    expect(parsed).toMatchObject({ type: "message", message });
  });

  it.each([
    {
      type: "compaction",
      id: "compaction",
      summary: "summary",
      tokensBefore: 500,
      firstKeptEntryId: "kept-entry",
      details: ["opaque"],
      fromHook: true,
    },
    {
      type: "branch_summary",
      id: "branch",
      summary: "recap",
      fromId: "old-leaf",
      details: null,
      fromHook: false,
    },
    {
      type: "custom",
      id: "custom",
      customType: "state",
      data: 42,
    },
    {
      type: "custom_message",
      id: "custom-message",
      customType: "notice",
      content: [
        { type: "text", text: "shown", textSignature: "signed" },
        { type: "image", data: "eA==", mimeType: "image/png", extensionField: 1 },
      ],
      details: { retained: true },
      display: true,
    },
  ])("preserves arbitrary public payload fields for $type", (entry) => {
    expect(SessionEntrySchema.parse(entry)).toMatchObject(entry);
  });

  it.each(["compaction", "branch_summary"])("preserves %s summarization usage", (type) => {
    const entry =
      type === "compaction"
        ? {
            type,
            id: "summary",
            summary: "summary",
            tokensBefore: 500,
            firstKeptEntryId: "kept-entry",
            usage,
          }
        : { type, id: "summary", summary: "summary", fromId: "old-leaf", usage };

    expect(SessionEntrySchema.parse(entry)).toMatchObject({ usage });
  });

  it("preserves pinned-Pi provider thinking, endTurn, and namespaced tool calls in persisted messages", () => {
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
      SessionEntrySchema.parse({
        type: "message",
        id: "assistant-metadata",
        parentId: null,
        message,
      }),
    ).toMatchObject({ message });
  });

  it("accepts transcript-backed system messages", () => {
    const message = {
      role: "system",
      content: "Updated system prompt",
      sections: { policy: "Stay safe", retired: null },
      toolsAdded: [],
      toolsRemoved: [{ name: "old-tool" }],
      timestamp: 1_700_000_000_000,
    };
    expect(
      SessionEntrySchema.parse({
        type: "message",
        id: "system-message",
        parentId: null,
        message,
      }),
    ).toMatchObject({ type: "message", message });
  });

  it.each([
    {
      type: "context_edit",
      id: "replace-context",
      targetId: "user-message",
      replacement: {
        content: [{ type: "text", text: "Replacement context" }],
      },
    },
    {
      type: "context_edit",
      id: "delete-context",
      targetId: "old-tool-result",
      replacement: null,
    },
    {
      type: "usage",
      id: "cache-warm",
      kind: "cache_warm",
      provider: "anthropic",
      model: "claude-sonnet",
      note: "extension override",
      usage,
    },
  ])("preserves Pi 0.99 $type entries", (entry) => {
    expect(SessionEntrySchema.parse(entry)).toMatchObject(entry);
  });

  it("preserves the normalized retain-none boundary and transcript-backed system state", () => {
    const entry = {
      type: "compaction",
      id: "retain-none",
      summary: "fresh start",
      tokensBefore: 500,
      firstKeptEntryId: "retain-none",
      systemMessage: {
        role: "system",
        content: "Updated prompt",
        sections: { policy: "Current policy" },
        toolsAdded: [],
        toolsRemoved: [],
        timestamp: 1_700_000_000_000,
      },
    };

    expect(SessionEntrySchema.parse(entry)).toMatchObject(entry);
    expect(CompactionEntrySchema.safeParse({ ...entry, firstKeptEntryId: null }).success).toBe(
      false,
    );
  });

  it("accepts only the public context-edit content union", () => {
    const base = {
      type: "context_edit" as const,
      id: "context-edit",
      targetId: "assistant-message",
    };
    expect(
      ContextEditEntrySchema.safeParse({
        ...base,
        replacement: {
          content: [
            { type: "thinking", thinking: "analysis", redacted: false },
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "README.md" },
              namespace: "builtin",
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      ContextEditEntrySchema.safeParse({
        ...base,
        replacement: { role: "system", content: "not an exact replacement" },
      }).success,
    ).toBe(false);
    expect(
      ContextEditEntrySchema.safeParse({ ...base, replacement: { content: 42 } }).success,
    ).toBe(false);
    expect(
      ContextEditEntrySchema.safeParse({
        ...base,
        replacement: {
          content: [
            { type: "thinking", thinking: "assistant-only" },
            { type: "image", data: "eA==", mimeType: "image/png" },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("preserves the bounded persisted nested-call record", () => {
    const nestedCalls = {
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
    };
    expect(
      SessionEntrySchema.parse({
        type: "message",
        id: "tool-result",
        message: {
          role: "toolResult",
          toolCallId: "parent-call",
          toolName: "codemode",
          content: [{ type: "text", text: "done" }],
          nestedCalls,
          isError: false,
          timestamp: 1_700_000_000_001,
        },
      }),
    ).toMatchObject({ message: { nestedCalls } });
  });
});
