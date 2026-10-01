import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createStreamingMessageCheckpoint,
  materializeStreamingMessageCheckpoint,
  updateStreamingMessageCheckpoint,
} from "./streaming-message-checkpoint.mjs";

function capturedEvents(name) {
  const url = new URL(`../../tests/fixtures/captures/${name}`, import.meta.url);
  return readFileSync(url, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("streaming assistant attach checkpoint", () => {
  it.each(["prompt_stream.jsonl", "tool_call.jsonl"])(
    "materializes every pinned-Pi cumulative boundary exactly from %s",
    (capture) => {
      let checkpoint;
      let assistantUpdates = 0;
      for (const event of capturedEvents(capture)) {
        if (event.type === "message_start" && event.message?.role === "assistant") {
          checkpoint = createStreamingMessageCheckpoint(event.message);
          expect(materializeStreamingMessageCheckpoint(checkpoint)).toEqual(event.message);
        } else if (event.type === "message_update" && event.message?.role === "assistant") {
          checkpoint = updateStreamingMessageCheckpoint(
            checkpoint,
            event.message,
            event.assistantMessageEvent,
          );
          expect(materializeStreamingMessageCheckpoint(checkpoint)).toEqual(event.message);
          assistantUpdates++;
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          checkpoint = undefined;
        }
      }
      expect(assistantUpdates).toBeGreaterThan(10);
    },
  );

  it("retains a long text stream as linear delta chunks and materializes only on demand", () => {
    let checkpoint = createStreamingMessageCheckpoint({
      role: "assistant",
      content: [],
      usage: { output: 0 },
    });
    let cumulative = "x";
    checkpoint = updateStreamingMessageCheckpoint(
      checkpoint,
      {
        role: "assistant",
        content: [{ type: "text", text: cumulative, textSignature: "signature" }],
        usage: { output: 0 },
      },
      { type: "text_start", contentIndex: 0 },
    );
    checkpoint = updateStreamingMessageCheckpoint(
      checkpoint,
      {
        role: "assistant",
        content: [{ type: "text", text: cumulative, textSignature: "signature" }],
        usage: { output: 1 },
      },
      { type: "text_delta", contentIndex: 0, delta: "x" },
    );

    for (let index = 1; index < 4_096; index++) {
      cumulative += "x";
      checkpoint = updateStreamingMessageCheckpoint(
        checkpoint,
        {
          role: "assistant",
          content: [{ type: "text", text: cumulative, textSignature: "signature" }],
          usage: { output: index + 1 },
        },
        { type: "text_delta", contentIndex: 0, delta: "x" },
      );
    }

    const textPart = checkpoint.content[0];
    expect(textPart.kind).toBe("text");
    expect(textPart.chunks).toHaveLength(4_096);
    expect(textPart.chunks.every((chunk) => chunk === "x")).toBe(true);
    expect(textPart.chunks.reduce((size, chunk) => size + chunk.length, 0)).toBe(cumulative.length);
    expect(materializeStreamingMessageCheckpoint(checkpoint)).toEqual({
      role: "assistant",
      content: [{ type: "text", textSignature: "signature", text: cumulative }],
      usage: { output: 4_096 },
    });
  });

  it.each([
    ["text", "text", "text_delta"],
    ["thinking", "thinking", "thinking_delta"],
  ])(
    "uses the exact cumulative %s source when a provider repairs a prefix",
    (kind, field, type) => {
      let checkpoint = createStreamingMessageCheckpoint({
        role: "assistant",
        content: [{ type: kind, [field]: "abc" }],
      });
      checkpoint = updateStreamingMessageCheckpoint(
        checkpoint,
        { role: "assistant", content: [{ type: kind, [field]: "xbcd" }] },
        { type, contentIndex: 0, delta: "d" },
      );

      expect(materializeStreamingMessageCheckpoint(checkpoint)).toEqual({
        role: "assistant",
        content: [{ type: kind, [field]: "xbcd" }],
      });
    },
  );

  it.each(["partialArgs", "partialJson", "customInput"])(
    "retains a long %s tool stream as linear chunks without mutable argument aliases",
    (scratchKind) => {
      const toolPart = (value) => ({
        type: "toolCall",
        id: "call-1",
        name: "write",
        arguments: { nested: { value } },
        ...(scratchKind === "partialArgs"
          ? { partialArgs: value }
          : scratchKind === "partialJson"
            ? { partialJson: value }
            : {
                // Exact pinned OpenAI grammar-tool shape: the ordinary scratch
                // key remains present but undefined beside customInput.
                partialArgs: undefined,
                customInput: {
                  property: "input",
                  jsonBuffer: { input: value, started: true, closed: false },
                },
              }),
      });
      let cumulative = "";
      let latestPart = toolPart(cumulative);
      let checkpoint = createStreamingMessageCheckpoint({
        role: "assistant",
        content: [latestPart],
      });
      for (let index = 0; index < 4_096; index++) {
        cumulative += "x";
        latestPart = toolPart(cumulative);
        checkpoint = updateStreamingMessageCheckpoint(
          checkpoint,
          { role: "assistant", content: [latestPart] },
          { type: "toolcall_delta", contentIndex: 0, delta: "x" },
        );
      }

      const checkpointPart = checkpoint.content[0];
      expect(checkpointPart.kind).toBe("toolCall");
      expect(checkpointPart.scratchKind).toBe(scratchKind);
      expect(checkpointPart.chunks).toHaveLength(4_096);
      expect(checkpointPart.chunks.reduce((size, chunk) => size + chunk.length, 0)).toBe(
        cumulative.length,
      );
      latestPart.arguments.nested.value = "mutated";
      if (scratchKind === "partialArgs") latestPart.partialArgs = "mutated";
      else if (scratchKind === "partialJson") latestPart.partialJson = "mutated";
      else {
        latestPart.partialArgs = "mutated";
        latestPart.customInput.jsonBuffer.input = "mutated";
      }

      expect(materializeStreamingMessageCheckpoint(checkpoint)).toEqual({
        role: "assistant",
        content: [toolPart(cumulative)],
      });
    },
  );

  it("uses the exact cumulative tool scratch source when a provider repairs a prefix", () => {
    let checkpoint = createStreamingMessageCheckpoint({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: {}, partialArgs: "abc" },
      ],
    });
    checkpoint = updateStreamingMessageCheckpoint(
      checkpoint,
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "xbcd" },
            partialArgs: "xbcd",
          },
        ],
      },
      { type: "toolcall_delta", contentIndex: 0, delta: "d" },
    );

    expect(materializeStreamingMessageCheckpoint(checkpoint)).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "xbcd" },
          partialArgs: "xbcd",
        },
      ],
    });
  });

  it("owns cumulative text and bounded metadata independently of later source mutation", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private" }],
      usage: { output: 1 },
    };
    const checkpoint = updateStreamingMessageCheckpoint(undefined, message, {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "private",
    });

    message.content[0].thinking = "mutated";
    message.usage.output = 99;
    expect(materializeStreamingMessageCheckpoint(checkpoint)).toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "private" }],
      usage: { output: 1 },
    });
  });

  it("retains Pi 0.85.1 provider thinking, endTurn, and tool-call namespace metadata", () => {
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
          partialArgs: '{"query":"pi-vis"}',
        },
      ],
    };
    const checkpoint = updateStreamingMessageCheckpoint(
      createStreamingMessageCheckpoint({ role: "assistant", content: [] }),
      message,
      { type: "toolcall_end", contentIndex: 0 },
    );

    expect(materializeStreamingMessageCheckpoint(checkpoint)).toEqual(message);
  });
});
