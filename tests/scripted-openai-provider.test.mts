import { afterEach, describe, expect, it } from "vitest";
import {
  type ScriptedOpenAIProvider,
  createScriptedOpenAIProvider,
} from "./e2e/support/scripted-openai-provider.mts";

let provider: ScriptedOpenAIProvider | undefined;

const completion = (body: Record<string, unknown> = {}): Promise<Response> =>
  fetch(`${provider!.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "scripted-model",
      messages: [{ role: "user", content: "hello" }],
      ...body,
    }),
  });

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

describe("scripted OpenAI provider", () => {
  it("emits deterministic chunked text SSE and captures raw and parsed requests", async () => {
    provider = await createScriptedOpenAIProvider([
      {
        expect: {
          model: "scripted-model",
          promptIncludes: ["hello"],
          messageRoles: ["user"],
          toolNames: ["read_file"],
        },
        response: { type: "text", chunks: ["hel", "lo"] },
      },
    ]);

    const response = await completion({
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    const sse = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(sse).toContain('"content":"hel"');
    expect(sse).toContain('"content":"lo"');
    expect(sse).toContain('"finish_reason":"stop"');
    expect(sse).toContain("data: [DONE]");
    expect(provider.requests[0]?.rawBody).toContain('"model":"scripted-model"');
    expect(provider.requests[0]?.parsedBody).toMatchObject({ model: "scripted-model" });
    provider.assertExhausted();
  });

  it("applies seeded latency and lets steps and responses override the default profile", async () => {
    provider = await createScriptedOpenAIProvider(
      [
        {
          latency: { firstByteMs: 90, perChunkMs: 90 },
          response: {
            type: "text",
            chunks: ["first", "second"],
            latency: { firstByteMs: [20, 20], perChunkMs: [20, 20], seed: 7 },
          },
        },
        {
          latency: { firstByteMs: 0, perChunkMs: 0, seed: 7 },
          response: { type: "text", chunks: ["step-override"] },
        },
      ],
      { latency: { firstByteMs: 90, perChunkMs: 90, seed: 99 } },
    );

    const started = performance.now();
    const response = await completion();
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    const reader = response.body!.getReader();
    await reader.read();
    const beforeSecond = performance.now();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("second");
    expect(performance.now() - beforeSecond).toBeGreaterThanOrEqual(15);
    await reader.cancel();

    const stepStarted = performance.now();
    await (await completion()).text();
    expect(performance.now() - stepStarted).toBeLessThan(75);
    provider.assertExhausted();
  });

  it("blocks on a named gate until a test releases it", async () => {
    provider = await createScriptedOpenAIProvider([
      { response: { type: "text", chunks: ["released"], gate: "allow-response" } },
    ]);

    const pending = completion();
    await provider.waitForRequestCount(1);
    provider.releaseGate("allow-response");

    expect(await (await pending).text()).toContain("released");
    provider.assertExhausted();
  });

  it("can gate the tail after exposing the first text delta", async () => {
    provider = await createScriptedOpenAIProvider([
      {
        response: {
          type: "text",
          chunks: ["visible-first", "released-tail"],
          afterFirstChunkGate: "release-tail",
        },
      },
    ]);

    const response = await completion();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("visible-first");

    provider.releaseGate("release-tail");
    let tail = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      tail += new TextDecoder().decode(chunk.value);
    }
    expect(tail).toContain("released-tail");
    expect(tail).toContain("data: [DONE]");
    provider.assertExhausted();
  });

  it("streams OpenAI-compatible tool-call argument fragments", async () => {
    provider = await createScriptedOpenAIProvider([
      {
        response: {
          type: "tool_call",
          id: "call_1",
          name: "read_file",
          nameFragments: ["read_", "file"],
          argumentChunks: ['{"path":"', "README.md", '"}'],
        },
      },
    ]);

    const sse = await (await completion()).text();

    expect(sse).toContain('"name":"read_file"');
    expect(sse).toContain('"arguments":"{\\"path\\":\\""');
    expect(sse).toContain('"arguments":"README.md"');
    expect(sse).toContain('"finish_reason":"tool_calls"');
    expect(sse).toContain("data: [DONE]");
    provider.assertExhausted();
  });

  it("can terminate a stream after deterministic partial content", async () => {
    provider = await createScriptedOpenAIProvider([
      {
        response: {
          type: "disconnect",
          chunks: ["partial-before-close"],
          disconnectGate: "close-stream",
        },
      },
    ]);

    const response = await completion();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("partial-before-close");

    provider.releaseGate("close-stream");
    await expect(reader.read()).rejects.toThrow();
    expect(provider.requests).toHaveLength(1);
    provider.assertExhausted();
  });

  it("returns scripted HTTP JSON errors", async () => {
    provider = await createScriptedOpenAIProvider([
      {
        response: {
          type: "error",
          status: 429,
          message: "rate limited",
          errorType: "rate_limit_error",
          code: "slow_down",
        },
      },
    ]);

    const response = await completion();

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "rate limited", type: "rate_limit_error", code: "slow_down" },
    });
    provider.assertExhausted();
  });

  it("records useful diagnostics for unexpected routes and request mismatches", async () => {
    provider = await createScriptedOpenAIProvider([
      { expect: { model: "expected" }, response: { type: "text", chunks: ["unused"] } },
    ]);

    const wrongRoute = await fetch(`${provider!.baseUrl}/models`, { method: "GET" });
    const wrongModel = await completion({ model: "actual" });

    expect(wrongRoute.status).toBe(404);
    expect(wrongModel.status).toBe(400);
    expect(provider!.unexpectedRequests.map((entry) => entry.reason)).toEqual([
      "unexpected route: GET /v1/models",
      'unexpected request at script step 1: expected model "expected", received "actual"',
    ]);
    expect(() => provider!.assertExhausted()).toThrow("1 scripted response(s) remaining");
  });

  it("asserts when the ordered script is not exhausted", async () => {
    provider = await createScriptedOpenAIProvider([
      { response: { type: "text", chunks: ["first"] } },
      { response: { type: "text", chunks: ["second"] } },
    ]);

    await completion();

    expect(() => provider.assertExhausted()).toThrow("1 scripted response(s) remaining");
  });

  it("closes boundedly, destroys sockets, and releases gate and request waits", async () => {
    provider = await createScriptedOpenAIProvider([
      { response: { type: "text", chunks: ["never"], gate: "never-release" } },
    ]);

    const requestFailure = completion().then(
      () => undefined,
      (error: unknown) => error,
    );
    const countFailure = provider.waitForRequestCount(2).then(
      () => undefined,
      (error: unknown) => error,
    );
    await provider.waitForRequestCount(1);
    await provider.close(100);

    expect(await requestFailure).toBeInstanceOf(Error);
    expect(await countFailure).toMatchObject({ message: "scripted OpenAI provider is closed" });
  });
});
