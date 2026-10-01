import { describe, expect, it } from "vitest";
import { SessionEntrySchema } from "./entries.js";

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
      estimatedTokensAfter: 125,
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
    const usage = {
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 2,
      totalTokens: 127,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
    };
    const entry =
      type === "compaction"
        ? { type, id: "summary", summary: "summary", usage }
        : { type, id: "summary", summary: "summary", fromId: "old-leaf", usage };

    expect(SessionEntrySchema.parse(entry)).toMatchObject({ usage });
  });

  it("preserves Pi 0.85.1 provider thinking, endTurn, and namespaced tool calls in persisted messages", () => {
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
});
