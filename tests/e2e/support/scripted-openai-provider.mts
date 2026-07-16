import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface CapturedOpenAIRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: string;
  readonly parsedBody: unknown;
}

export interface CompactionExpectation {
  /** Require these terms somewhere in the summarization request. */
  readonly includes?: string | readonly string[];
}

export interface OpenAIRequestExpectation {
  readonly model?: string;
  /** Every substring must occur in the concatenated message text. */
  readonly promptIncludes?: string | readonly string[];
  /** Aliases useful when an expectation has one prompt fragment. */
  readonly promptSubstring?: string;
  readonly messageRoles?: readonly string[];
  /** Tool names that must be advertised; additional tools are permitted. */
  readonly toolNames?: readonly string[];
  /**
   * Match Pi's compaction request by its purpose, not its version-specific
   * system prompt. A compaction has a summary-oriented system message and a
   * summary-oriented user message.
   */
  readonly compaction?: boolean | CompactionExpectation;
}

export type ScriptedOpenAILatencyRange = number | readonly [minimumMs: number, maximumMs: number];

/**
 * Deterministic response timing. A fixed number or an inclusive [min, max]
 * range is accepted for each delay. Ranges use a seeded PRNG, never Math.random.
 */
export interface ScriptedOpenAILatency {
  /** Delay before response headers and the first response body byte. */
  readonly firstByteMs?: ScriptedOpenAILatencyRange;
  /** Delay before each following streamed SSE chunk. */
  readonly perChunkMs?: ScriptedOpenAILatencyRange;
  readonly seed?: number;
}

interface ScriptedOpenAIResponseBase {
  /** Overrides provider- or step-level latency for this response. */
  readonly latency?: ScriptedOpenAILatency;
}

export type ScriptedOpenAIResponse =
  | (ScriptedOpenAIResponseBase & {
      readonly type: "text";
      readonly chunks: readonly string[];
      /** Blocks before any response bytes are written. */
      readonly gate?: string;
      /** Blocks after the first text delta and before all remaining deltas. */
      readonly afterFirstChunkGate?: string;
    })
  | (ScriptedOpenAIResponseBase & {
      readonly type: "tool_call";
      readonly name: string;
      /** JSON argument fragments, in wire order. */
      readonly argumentChunks: readonly string[];
      readonly id?: string;
      readonly gate?: string;
      /** Joined before the first wire chunk so Pi receives a valid function name. */
      readonly nameFragments?: readonly string[];
    })
  | (ScriptedOpenAIResponseBase & {
      readonly type: "error";
      readonly status: number;
      readonly message?: string;
      readonly errorType?: string;
      readonly code?: string;
      readonly body?: unknown;
      readonly gate?: string;
    })
  | (ScriptedOpenAIResponseBase & {
      readonly type: "disconnect";
      /** Text chunks written before the connection is deliberately destroyed. */
      readonly chunks?: readonly string[];
      /** Blocks before any response bytes are written. */
      readonly gate?: string;
      /** Blocks after partial SSE bytes are written but before the socket is destroyed. */
      readonly disconnectGate?: string;
    });

export interface ScriptedOpenAIStep {
  readonly expect?: OpenAIRequestExpectation;
  /** Overrides provider-level latency for this ordered script step. */
  readonly latency?: ScriptedOpenAILatency;
  readonly response: ScriptedOpenAIResponse;
}

export interface ScriptedOpenAIProviderOptions {
  /** Default latency for all script steps; absent by default for fast unit tests. */
  readonly latency?: ScriptedOpenAILatency;
}

export interface UnexpectedOpenAIRequest {
  readonly request: CapturedOpenAIRequest;
  readonly reason: string;
}

export interface ScriptedOpenAIProvider {
  /** OpenAI-compatible base URL, including /v1. */
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: readonly CapturedOpenAIRequest[];
  readonly unexpectedRequests: readonly UnexpectedOpenAIRequest[];
  waitForRequestCount(count: number): Promise<void>;
  releaseGate(name: string): void;
  assertExhausted(): void;
  close(timeoutMs?: number): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asStrings = (value: string | readonly string[] | undefined): readonly string[] => {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
};

const messageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
};

const messagesFrom = (body: JsonRecord): readonly JsonRecord[] =>
  Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];

const advertisedToolNames = (body: JsonRecord): readonly string[] => {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") {
      return [];
    }
    return [tool.function.name];
  });
};

const isCompactionRequest = (messages: readonly JsonRecord[]): boolean => {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => messageText(message.content).toLowerCase())
    .join("\n");
  const user = messages
    .filter((message) => message.role === "user")
    .map((message) => messageText(message.content).toLowerCase())
    .join("\n");
  return (
    /summari[sz]|summary/.test(system) &&
    /context|conversation|messages/.test(system) &&
    /summari[sz]|summary/.test(user)
  );
};

const expectationFailure = (
  expectation: OpenAIRequestExpectation,
  request: CapturedOpenAIRequest,
): string | undefined => {
  if (!isRecord(request.parsedBody)) return "request body is not a JSON object";
  const body = request.parsedBody;
  if (expectation.model !== undefined && body.model !== expectation.model) {
    return `expected model ${JSON.stringify(expectation.model)}, received ${JSON.stringify(body.model)}`;
  }
  const messages = messagesFrom(body);
  const prompt = messages.map((message) => messageText(message.content)).join("\n");
  const requiredPrompt = [
    ...asStrings(expectation.promptIncludes),
    ...asStrings(expectation.promptSubstring),
  ];
  const absentPrompt = requiredPrompt.find((fragment) => !prompt.includes(fragment));
  if (absentPrompt !== undefined) return `prompt did not include ${JSON.stringify(absentPrompt)}`;

  if (expectation.messageRoles !== undefined) {
    const roles = messages.map((message) => message.role);
    if (JSON.stringify(roles) !== JSON.stringify(expectation.messageRoles)) {
      return `expected message roles ${JSON.stringify(expectation.messageRoles)}, received ${JSON.stringify(roles)}`;
    }
  }
  const names = advertisedToolNames(body);
  const absentTool = expectation.toolNames?.find((name) => !names.includes(name));
  if (absentTool !== undefined)
    return `advertised tools did not include ${JSON.stringify(absentTool)}`;

  if (expectation.compaction !== undefined) {
    const expectedCompaction = expectation.compaction !== false;
    const actualCompaction = isCompactionRequest(messages);
    if (actualCompaction !== expectedCompaction) {
      return `expected compaction=${expectedCompaction}, received ${actualCompaction}`;
    }
    if (typeof expectation.compaction === "object") {
      const absent = asStrings(expectation.compaction.includes).find(
        (fragment) => !prompt.includes(fragment),
      );
      if (absent !== undefined)
        return `compaction prompt did not include ${JSON.stringify(absent)}`;
    }
  }
  return undefined;
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const chunk of request)
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
};

const parseBody = (rawBody: string): unknown => {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
};

const writeJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const writeSse = (response: ServerResponse, value: unknown): void => {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
};

const completionChunk = (
  model: string,
  delta: JsonRecord,
  finishReason: "stop" | "tool_calls" | null,
): JsonRecord => ({
  id: "chatcmpl-scripted",
  object: "chat.completion.chunk",
  created: 0,
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
};

const latencyFor = (
  defaults: ScriptedOpenAILatency | undefined,
  step: ScriptedOpenAILatency | undefined,
  response: ScriptedOpenAILatency | undefined,
): ScriptedOpenAILatency => ({
  firstByteMs: response?.firstByteMs ?? step?.firstByteMs ?? defaults?.firstByteMs,
  perChunkMs: response?.perChunkMs ?? step?.perChunkMs ?? defaults?.perChunkMs,
  seed: response?.seed ?? step?.seed ?? defaults?.seed,
});

const latencyDelay = (
  range: ScriptedOpenAILatencyRange | undefined,
  random: () => number,
): number => {
  if (range === undefined) return 0;
  const [minimum, maximum] = typeof range === "number" ? [range, range] : range;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum) {
    throw new Error(`invalid scripted OpenAI latency range: ${JSON.stringify(range)}`);
  }
  return Math.floor(minimum + random() * (maximum - minimum + 1));
};

const waitForLatency = async (milliseconds: number): Promise<void> => {
  if (milliseconds > 0) await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

/**
 * Starts a loopback-only OpenAI Chat Completions server with an ordered script.
 * It is intentionally small and deterministic: script progress, rather than
 * elapsed time, controls every response unless optional seeded latency is set.
 */
export const createScriptedOpenAIProvider = async (
  script: readonly ScriptedOpenAIStep[],
  options: ScriptedOpenAIProviderOptions = {},
): Promise<ScriptedOpenAIProvider> => {
  const remaining = [...script];
  const requests: CapturedOpenAIRequest[] = [];
  const unexpectedRequests: UnexpectedOpenAIRequest[] = [];
  const sockets = new Set<Socket>();
  const releasedGates = new Set<string>();
  const gateWaiters = new Map<string, Set<() => void>>();
  const requestWaiters = new Set<{
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  let closed = false;
  let listening = true;

  const releaseGate = (name: string): void => {
    releasedGates.add(name);
    const waiters = gateWaiters.get(name);
    gateWaiters.delete(name);
    for (const resolve of waiters ?? []) resolve();
  };

  const waitForGate = (name: string | undefined): Promise<void> => {
    if (name === undefined || releasedGates.has(name) || closed) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = gateWaiters.get(name) ?? new Set<() => void>();
      waiters.add(resolve);
      gateWaiters.set(name, waiters);
    });
  };

  const notifyRequestWaiters = (): void => {
    for (const waiter of [...requestWaiters]) {
      if (requests.length >= waiter.count) {
        requestWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const rawBody = await readBody(request);
      const captured: CapturedOpenAIRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        rawBody,
        parsedBody: parseBody(rawBody),
      };
      requests.push(captured);
      notifyRequestWaiters();

      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        const reason = `unexpected route: ${request.method ?? "<none>"} ${request.url ?? "<none>"}`;
        unexpectedRequests.push({ request: captured, reason });
        writeJson(response, 404, { error: { message: reason, type: "invalid_request_error" } });
        return;
      }

      const step = remaining[0];
      if (step === undefined) {
        const reason = "unexpected request: script is exhausted";
        unexpectedRequests.push({ request: captured, reason });
        writeJson(response, 409, { error: { message: reason, type: "invalid_request_error" } });
        return;
      }
      const mismatch =
        step.expect === undefined ? undefined : expectationFailure(step.expect, captured);
      if (mismatch !== undefined) {
        const reason = `unexpected request at script step ${script.length - remaining.length + 1}: ${mismatch}`;
        unexpectedRequests.push({ request: captured, reason });
        writeJson(response, 400, { error: { message: reason, type: "invalid_request_error" } });
        return;
      }
      const stepIndex = script.length - remaining.length;
      remaining.shift();
      await waitForGate(step.response.gate);
      if (closed || response.destroyed) return;

      const latency = latencyFor(options.latency, step.latency, step.response.latency);
      const random = seededRandom((latency.seed ?? 0) + stepIndex);
      await waitForLatency(latencyDelay(latency.firstByteMs, random));
      if (closed || response.destroyed) return;

      if (step.response.type === "error") {
        writeJson(
          response,
          step.response.status,
          step.response.body ?? {
            error: {
              message: step.response.message ?? "scripted provider error",
              type: step.response.errorType ?? "api_error",
              code: step.response.code ?? null,
            },
          },
        );
        return;
      }

      const body = isRecord(captured.parsedBody) ? captured.parsedBody : {};
      const model = typeof body.model === "string" ? body.model : "scripted";
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      let wroteSseChunk = false;
      const writeDelayedSse = async (value: unknown): Promise<void> => {
        if (wroteSseChunk) await waitForLatency(latencyDelay(latency.perChunkMs, random));
        if (closed || response.destroyed) return;
        writeSse(response, value);
        wroteSseChunk = true;
      };

      if (step.response.type === "text" || step.response.type === "disconnect") {
        const chunks =
          step.response.type === "text"
            ? step.response.chunks
            : (step.response.chunks ?? ["partial"]);
        for (const [index, content] of chunks.entries()) {
          await writeDelayedSse(
            completionChunk(
              model,
              index === 0 ? { role: "assistant", content } : { content },
              null,
            ),
          );
          if (index === 0 && step.response.type === "text") {
            await waitForGate(step.response.afterFirstChunkGate);
            if (closed || response.destroyed) return;
          }
        }
        if (step.response.type === "disconnect") {
          // Keep the stream open behind an optional second gate so tests can
          // deterministically observe the partial UI before inducing the
          // transport failure. Immediate socket destruction can discard bytes
          // still buffered by Node and turns "mid-stream" into a startup error.
          await waitForGate(step.response.disconnectGate);
          response.socket?.destroy();
          return;
        }
        await writeDelayedSse(completionChunk(model, {}, "stop"));
      } else {
        const name = step.response.nameFragments?.join("") ?? step.response.name;
        const args = step.response.argumentChunks;
        const id = step.response.id ?? "call_scripted_0";
        await writeDelayedSse(
          completionChunk(
            model,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: { name, arguments: args[0] ?? "" },
                },
              ],
            },
            null,
          ),
        );
        for (const fragment of args.slice(1)) {
          await writeDelayedSse(
            completionChunk(
              model,
              { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
              null,
            ),
          );
        }
        await writeDelayedSse(completionChunk(model, {}, "tool_calls"));
      }
      response.write("data: [DONE]\n\n");
      response.end();
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "api_error",
          },
        });
      } else {
        response.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests,
    unexpectedRequests,
    waitForRequestCount: (count) => {
      if (count <= requests.length) return Promise.resolve();
      if (closed) return Promise.reject(new Error("scripted OpenAI provider is closed"));
      return new Promise<void>((resolve, reject) => requestWaiters.add({ count, resolve, reject }));
    },
    releaseGate,
    assertExhausted: () => {
      if (remaining.length > 0 || unexpectedRequests.length > 0) {
        const details = [
          remaining.length > 0 ? `${remaining.length} scripted response(s) remaining` : undefined,
          ...unexpectedRequests.map((entry) => entry.reason),
        ]
          .filter((detail): detail is string => detail !== undefined)
          .join("; ");
        throw new Error(`scripted OpenAI provider was not exhausted cleanly: ${details}`);
      }
    },
    close: async (timeoutMs = 1_000) => {
      if (closed) return;
      closed = true;
      for (const name of [...gateWaiters.keys()]) releaseGate(name);
      for (const waiter of requestWaiters)
        waiter.reject(new Error("scripted OpenAI provider is closed"));
      requestWaiters.clear();
      for (const socket of sockets) socket.destroy();
      if (!listening) return;
      listening = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
};
