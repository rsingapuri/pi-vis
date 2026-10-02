import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";
import { InMemoryCredentialStore } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { CodemodeSandbox } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-codemode/dist/index.js";
import { createInMemoryTransportPair } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp/dist/testing/index.js";
import {
  createPiBuiltinExtensions,
  createTranscriptToolRestorationExtension,
  createTrustResolver,
} from "./bootstrap.mjs";

const MCP_TOOL_NAME = "mcp__project_loopback__echo";
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const MCP_SERVER_SOURCE = String.raw`
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const eventsPath = process.argv[2];
const toolsListDelayMs = Number(process.argv[3] ?? 0);
const record = (event) => appendFileSync(eventsPath, event + "\n", "utf8");
let finished = false;
const finish = (event) => {
  if (finished) return;
  finished = true;
  record(event);
  process.exit(0);
};

record("spawn");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;

  let result;
  switch (message.method) {
    case "initialize":
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "project-loopback", version: "1.0.0" },
        instructions: "Echo values for the production-loader integration test.",
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo one value",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
            outputSchema: {
              type: "object",
              properties: { echoed: { type: "string" } },
              required: ["echoed"],
            },
            annotations: { readOnlyHint: true },
          },
        ],
      };
      break;
    case "tools/call": {
      const value = message.params?.arguments?.value;
      record("call:" + value);
      result = {
        content: [{ type: "text", text: "echo:" + value }],
        structuredContent: { echoed: value },
        isError: false,
      };
      break;
    }
    case "ping":
      result = {};
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unknown method: " + message.method },
        }) + "\n",
      );
      return;
  }
  const respond = () =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  if (message.method === "tools/list" && toolsListDelayMs > 0) setTimeout(respond, toolsListDelayMs);
  else respond();
});
lines.on("close", () => finish("stdin-closed"));
process.on("SIGTERM", () => finish("sigterm"));
`;

function makeProductionLoaderFixture(
  settings = {},
  { exposure = "direct", toolsListDelayMs = 0 } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pivis-pi099-loader-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const projectConfigDir = path.join(cwd, ".pi");
  const serverPath = path.join(root, "mcp-server.mjs");
  const eventsPath = path.join(root, "mcp-events.log");
  mkdirSync(projectConfigDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(serverPath, MCP_SERVER_SOURCE, "utf8");
  writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
  writeFileSync(
    path.join(projectConfigDir, "mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        "project-loopback": {
          command: process.execPath,
          args: [serverPath, eventsPath, String(toolsListDelayMs)],
          exposure,
        },
      },
    })}\n`,
    "utf8",
  );
  return { root, cwd, agentDir, eventsPath };
}

function readMcpEvents(eventsPath) {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
}

async function withPiAgentDir(agentDir, action) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

async function startProductionRuntime(
  fixture,
  trusted,
  existingSessionManager,
  { modelRuntime, model } = {},
) {
  const trustPrompts = [];
  const { resolveTrust } = createTrustResolver(
    pi,
    fixture.agentDir,
    fixture.cwd,
    async (labels) => {
      trustPrompts.push(labels);
      return trusted ? "Trust for this session only" : "Do not trust (this session only)";
    },
  );
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir,
      ...(modelRuntime ? { modelRuntime } : {}),
      modelRuntimeSignal: AbortSignal.timeout(5_000),
      resourceLoaderOptions: {
        extensionFactories: [
          ...createPiBuiltinExtensions(pi),
          {
            name: "pi-vis-transcript-tool-restoration",
            factory: createTranscriptToolRestorationExtension(sessionManager),
            hidden: true,
          },
        ],
      },
      resourceLoaderReloadOptions: { resolveProjectTrust: resolveTrust },
    });
    const created = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      ...(model ? { model } : {}),
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const sessionManager = existingSessionManager ?? pi.SessionManager.inMemory(fixture.cwd);
  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    sessionManager,
  });
  const extensionErrors = [];
  await runtime.session.bindExtensions({
    mode: "rpc",
    shutdownHandler: () => {},
    onError: (error) => extensionErrors.push(error),
  });
  return { runtime, sessionManager, extensionErrors, trustPrompts };
}

function extensionPaths(runtime) {
  return runtime.services.resourceLoader
    .getExtensions()
    .extensions.map((extension) => extension.path);
}

describe("Pi 1.0 built-in runtimes", () => {
  it("runs real codemode JavaScript through the packaged QuickJS WASM worker", async () => {
    const sandbox = new CodemodeSandbox({
      timeoutMs: 5_000,
      tools: [
        {
          name: "double-value",
          description: "Double a number",
          inputSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
          outputSchema: { type: "number" },
          execute: ({ value }) => value * 2,
        },
      ],
    });
    try {
      const result = await sandbox.execute(`
        const doubled = await tools.double_value({ value: 21 });
        text("computed " + doubled);
        store("answer", doubled);
        return { doubled, tools: ALL_TOOLS.map((tool) => tool.name) };
      `);

      expect(result).toMatchObject({
        ok: true,
        value: { doubled: 42, tools: ["double_value"] },
        output: [{ type: "text", text: "computed 42" }],
        calls: [{ name: "double-value", status: "ok" }],
        storeWrites: { set: { answer: 42 }, delete: [] },
      });
    } finally {
      await sandbox.close();
    }
  });

  it("runs image generation through the real codemode tool and session model registry", async () => {
    const fixture = makeProductionLoaderFixture({ defaultTools: ["codemode"] });
    await withPiAgentDir(fixture.agentDir, async () => {
      let runtime;
      try {
        ({ runtime } = await startProductionRuntime(fixture, false));
        const requests = [];
        const imageModel = {
          type: "image",
          id: "painter",
          name: "Fixture Painter",
          api: "pivis-test-images",
          provider: "pivis-test",
          baseUrl: "https://images.fixture.invalid/v1",
          input: ["text", "image"],
          output: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        runtime.session.modelRuntime.registerProvider("pivis-test", {
          apiKey: "fixture-secret",
          models: [imageModel],
          images: {
            "pivis-test-images": {
              generateImages: async (model, context, options) => {
                requests.push({ model, context, options });
                return {
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  output: [
                    { type: "text", text: "painted a fox" },
                    { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
                  ],
                  usage: {
                    input: 3,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 4,
                    cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 },
                  },
                  stopReason: "stop",
                  timestamp: 0,
                };
              },
            },
          },
        });

        const signal = new AbortController().signal;
        const codemode = runtime.session.getToolDefinition("codemode");
        const result = await codemode.execute(
          "codemode-image-call",
          {
            code: `
              const [model] = await models.getAvailableOfType("image", "pivis-test");
              const reference = { type: "image", data: "${TINY_PNG_BASE64}", mimeType: "image/png" };
              const generated = await models.generateImages(
                { ...model, baseUrl: "https://attacker.invalid" },
                { input: [{ type: "text", text: "a fox" }, reference] },
              );
              for (const block of generated.output) {
                if (block.type === "image") image(block);
                else text(block.text);
              }
              return { id: model.id, stopReason: generated.stopReason, cost: generated.usage.cost.total };
            `,
          },
          signal,
          undefined,
          runtime.session.extensionRunner.createToolContext("codemode-image-call", signal),
        );

        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual([
          {
            type: "text",
            text: expect.stringMatching(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n$/),
          },
          { type: "text", text: "painted a fox" },
          { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
          {
            type: "text",
            text: '{"id":"painter","stopReason":"stop","cost":0.04}',
          },
        ]);
        expect(result.usage?.cost.total).toBeCloseTo(0.04, 10);
        expect(result.details?.calls).toEqual([
          expect.objectContaining({
            name: "models.generateImages",
            args: "pivis-test/painter",
            status: "ok",
            cost: 0.04,
          }),
        ]);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          model: { baseUrl: "https://images.fixture.invalid/v1" },
          context: {
            input: [
              { type: "text", text: "a fox" },
              { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
            ],
          },
          options: { apiKey: "fixture-secret", signal: expect.any(AbortSignal) },
        });
      } finally {
        await runtime?.dispose();
      }
    });
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("connects the public MCP built-in, discovers a namespaced tool, and preserves structured results", async () => {
    const { client, server } = createInMemoryTransportPair();
    await server.start();
    server.onMessage((message) => {
      if (!("id" in message)) return;
      let result;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "loopback", version: "1.0.0" },
            instructions: "Echo values for the integration test.",
          };
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: "echo",
                description: "Echo one value",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
                outputSchema: {
                  type: "object",
                  properties: { echoed: { type: "string" } },
                  required: ["echoed"],
                },
                annotations: { readOnlyHint: true },
              },
            ],
          };
          break;
        case "tools/call": {
          const value = message.params?.arguments?.value;
          result = {
            content: [{ type: "text", text: `echo:${value}` }],
            structuredContent: { echoed: value },
            isError: false,
            _meta: { serverOnly: true },
          };
          break;
        }
        default:
          throw new Error(`Unexpected MCP request: ${message.method}`);
      }
      void server.send({ jsonrpc: "2.0", id: message.id, result });
    });

    const tools = new Map();
    const handlers = new Map();
    const commands = new Map();
    let activeTools = ["read", "bash", "edit", "write"];
    const extensionApi = {
      appendEntry: vi.fn(),
      getSettings: () => ({}),
      getAllTools: () => [...tools.values()],
      getActiveTools: () => [...activeTools],
      setActiveTools: (names) => {
        activeTools = [...names];
      },
      getMcpServers: () => [],
      registerTool: (definition) => {
        tools.set(definition.name, definition);
      },
      registerCommand: (name, command) => {
        commands.set(name, command);
      },
      on: (event, handler) => {
        const listeners = handlers.get(event) ?? [];
        listeners.push(handler);
        handlers.set(event, listeners);
        return () => {};
      },
    };

    pi.createCodemodeExtension()(extensionApi);
    pi.createToolSearchExtension()(extensionApi);
    pi.createMcpExtension({
      credentials: {},
      logPath: path.join(os.tmpdir(), `pivis-mcp-${process.pid}.log`),
      loadConfig: () => ({
        servers: [
          {
            name: "loopback",
            config: {
              command: "unused-in-memory-transport",
              exposure: "codemode",
              description: "Local integration server",
            },
            source: "integration-test",
            scope: "global",
          },
        ],
        autoEnableCodemode: true,
        errors: [],
      }),
      createTransport: () => client,
    })(extensionApi);

    const notifications = [];
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      mode: "rpc",
      modelRegistry: { getApiKeyForProvider: async () => undefined },
      signal: new AbortController().signal,
      isProjectTrusted: () => true,
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
        input: async () => undefined,
        select: async () => undefined,
      },
    };
    const emit = async (event, value = {}) => {
      await Promise.all((handlers.get(event) ?? []).map((handler) => handler(value, context)));
    };

    await emit("session_start");
    expect(commands.has("mcp")).toBe(true);
    expect(activeTools).toContain("codemode");

    await vi.waitFor(() => {
      expect(tools.has("mcp__loopback__echo")).toBe(true);
    });
    const echo = tools.get("mcp__loopback__echo");
    expect(echo).toMatchObject({
      exposure: "deferred",
      annotations: { readOnlyHint: true },
      namespace: {
        name: "mcp__loopback",
        description: "Local integration server",
        instructions: "Echo values for the integration test.",
      },
    });
    const result = await echo.execute("call-1", { value: "hello" }, new AbortController().signal);
    expect(result).toEqual({
      content: [{ type: "text", text: "echo:hello" }],
      details: { server: "loopback", tool: "echo" },
      structuredContent: {
        content: [{ type: "text", text: "echo:hello" }],
        structuredContent: { echoed: "hello" },
        isError: false,
      },
    });
    expect(notifications).toEqual([]);

    await emit("session_shutdown");
  });

  it("keeps an untrusted project MCP config behind the production trust gate", async () => {
    const fixture = makeProductionLoaderFixture();
    await withPiAgentDir(fixture.agentDir, async () => {
      let runtime;
      try {
        const started = await startProductionRuntime(fixture, false);
        runtime = started.runtime;

        expect(started.trustPrompts).toHaveLength(1);
        expect(runtime.services.settingsManager.isProjectTrusted()).toBe(false);
        expect(extensionPaths(runtime)).toContain("builtin:mcp");
        expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain(MCP_TOOL_NAME);
        expect(readMcpEvents(fixture.eventsPath)).toEqual([]);
        expect(started.extensionErrors).toEqual([]);
      } finally {
        await runtime?.dispose();
      }
      expect(readMcpEvents(fixture.eventsPath)).toEqual([]);
    });
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("loads one trusted project MCP server through production services and reaps it on shutdown", async () => {
    const fixture = makeProductionLoaderFixture();
    await withPiAgentDir(fixture.agentDir, async () => {
      let runtime;
      try {
        const started = await startProductionRuntime(fixture, true);
        runtime = started.runtime;

        expect(started.trustPrompts).toHaveLength(1);
        expect(runtime.services.settingsManager.isProjectTrusted()).toBe(true);
        await vi.waitFor(
          () => {
            expect(
              readMcpEvents(fixture.eventsPath).filter((event) => event === "spawn"),
            ).toHaveLength(1);
            expect(
              runtime.session.getAllTools().filter((tool) => tool.name === MCP_TOOL_NAME),
            ).toHaveLength(1);
          },
          { timeout: 5_000, interval: 20 },
        );

        const echo = runtime.session.getToolDefinition(MCP_TOOL_NAME);
        const result = await echo.execute(
          "call-1",
          { value: "trusted" },
          new AbortController().signal,
          undefined,
          runtime.session.extensionRunner.createToolContext("call-1", new AbortController().signal),
        );
        expect(result).toMatchObject({
          content: [{ type: "text", text: "echo:trusted" }],
          structuredContent: {
            content: [{ type: "text", text: "echo:trusted" }],
            structuredContent: { echoed: "trusted" },
            isError: false,
          },
        });
        expect(readMcpEvents(fixture.eventsPath)).toEqual(["spawn", "call:trusted"]);
        expect(started.extensionErrors).toEqual([]);
      } finally {
        await runtime?.dispose();
      }

      await vi.waitFor(
        () => {
          expect(readMcpEvents(fixture.eventsPath)).toEqual([
            "spawn",
            "call:trusted",
            "stdin-closed",
          ]);
        },
        { timeout: 5_000, interval: 20 },
      );
    });
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("restores a tool_search-loaded deferred MCP tool on resume and reload after reconnect", async () => {
    const fixture = makeProductionLoaderFixture(
      {},
      { exposure: "deferred", toolsListDelayMs: 250 },
    );
    const faux = registerFauxProvider();
    try {
      const model = faux.getModel();
      const modelRuntime = await pi.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerProvider(model.provider, {
        api: faux.api,
        apiKey: "faux-key",
        baseUrl: model.baseUrl,
        models: [
          {
            id: model.id,
            name: model.name,
            api: model.api,
            reasoning: model.reasoning,
            input: model.input,
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            baseUrl: model.baseUrl,
          },
        ],
      });
      const runtimeOptions = { modelRuntime, model };
      await withPiAgentDir(fixture.agentDir, async () => {
        let runtime;
        try {
          const sessionDir = path.join(fixture.root, "sessions");
          const initialSessionManager = pi.SessionManager.create(fixture.cwd, sessionDir);
          const first = await startProductionRuntime(
            fixture,
            true,
            initialSessionManager,
            runtimeOptions,
          );
          runtime = first.runtime;
          await vi.waitFor(
            () => {
              expect(runtime.session.getAllTools().map((tool) => tool.name)).toContain(
                MCP_TOOL_NAME,
              );
            },
            { timeout: 5_000, interval: 20 },
          );
          runtime.session.setActiveToolsByName([
            ...runtime.session.getActiveToolNames(),
            "tool_search",
          ]);

          faux.setResponses([
            fauxAssistantMessage(
              [fauxToolCall("tool_search", { query: "Echo one value", limit: 1 })],
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("loaded"),
          ]);
          await runtime.session.prompt("load the echo tool");
          expect(runtime.session.getActiveToolNames()).toContain(MCP_TOOL_NAME);
          expect(
            runtime.session.messages.some(
              (message) =>
                message.role === "system" &&
                message.toolsAdded?.some((tool) => tool.name === MCP_TOOL_NAME),
            ),
          ).toBe(true);
          expect(
            runtime.session.messages.find(
              (message) => message.role === "toolResult" && message.toolName === "tool_search",
            ),
          ).toMatchObject({
            content: [
              {
                type: "text",
                text: expect.stringContaining(`- ${MCP_TOOL_NAME}: Echo one value`),
              },
            ],
            details: { loaded: [MCP_TOOL_NAME] },
          });

          const sessionFile = first.sessionManager.getSessionFile();
          expect(sessionFile).toEqual(expect.any(String));
          await runtime.dispose();
          runtime = undefined;

          const sessionManager = pi.SessionManager.open(sessionFile, sessionDir);

          const resumed = await startProductionRuntime(
            fixture,
            true,
            sessionManager,
            runtimeOptions,
          );
          runtime = resumed.runtime;
          // The MCP extension deliberately connects in the background. A slow
          // tools/list response proves the constructor adapter records this
          // declaration as pending during session_start, rather than restoring
          // it only because the definition happened to reconnect immediately.
          expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain(
            MCP_TOOL_NAME,
          );
          await vi.waitFor(
            () => {
              expect(runtime.session.getAllTools().map((tool) => tool.name)).toContain(
                MCP_TOOL_NAME,
              );
            },
            { timeout: 5_000, interval: 20 },
          );
          expect(runtime.session.getActiveToolNames()).not.toContain(MCP_TOOL_NAME);
          faux.setResponses([
            (context) => {
              expect(context.tools?.map((tool) => tool.name)).toContain(MCP_TOOL_NAME);
              return fauxAssistantMessage("resumed");
            },
          ]);
          await runtime.session.prompt("continue after resume");
          expect(runtime.session.getActiveToolNames()).toContain(MCP_TOOL_NAME);

          const executeEcho = async (callId, value) => {
            const signal = new AbortController().signal;
            const definition = runtime.session.getToolDefinition(MCP_TOOL_NAME);
            return definition.execute(
              callId,
              { value },
              signal,
              undefined,
              runtime.session.extensionRunner.createToolContext(callId, signal),
            );
          };
          await expect(executeEcho("resume-call", "resumed")).resolves.toMatchObject({
            content: [{ type: "text", text: "echo:resumed" }],
          });

          await runtime.session.reload();
          await vi.waitFor(
            () => {
              expect(
                readMcpEvents(fixture.eventsPath).filter((event) => event === "spawn"),
              ).toHaveLength(3);
              expect(runtime.session.getAllTools().map((tool) => tool.name)).toContain(
                MCP_TOOL_NAME,
              );
            },
            { timeout: 5_000, interval: 20 },
          );
          faux.setResponses([
            (context) => {
              expect(context.tools?.map((tool) => tool.name)).toContain(MCP_TOOL_NAME);
              return fauxAssistantMessage("reloaded");
            },
          ]);
          await runtime.session.prompt("continue after reload");
          expect(runtime.session.getActiveToolNames()).toContain(MCP_TOOL_NAME);
          await expect(executeEcho("reload-call", "reloaded")).resolves.toMatchObject({
            content: [{ type: "text", text: "echo:reloaded" }],
          });
          expect(
            runtime.session.messages.filter(
              (message) =>
                message.role === "system" &&
                message.toolsRemoved?.some((tool) => tool.name === MCP_TOOL_NAME),
            ),
          ).toEqual([]);
          expect(resumed.extensionErrors).toEqual([]);
        } finally {
          await runtime?.dispose();
        }
      });
    } finally {
      faux.unregister();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  it("honors a disabled MCP built-in and applies newly configured default tools on reload", async () => {
    const initialSettings = { extensions: ["-builtin:mcp"] };
    const fixture = makeProductionLoaderFixture(initialSettings);
    await withPiAgentDir(fixture.agentDir, async () => {
      let runtime;
      try {
        const started = await startProductionRuntime(fixture, true);
        runtime = started.runtime;

        expect(extensionPaths(runtime)).not.toContain("builtin:mcp");
        expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain(MCP_TOOL_NAME);
        expect(runtime.session.getActiveToolNames()).not.toContain("codemode");
        expect(runtime.session.getActiveToolNames()).not.toContain("tool_search");
        expect(readMcpEvents(fixture.eventsPath)).toEqual([]);

        writeFileSync(
          path.join(fixture.agentDir, "settings.json"),
          `${JSON.stringify({
            ...initialSettings,
            defaultTools: ["+codemode", "+tool_search"],
          })}\n`,
          "utf8",
        );
        await runtime.session.reload();

        expect(runtime.session.getActiveToolNames()).toEqual(
          expect.arrayContaining(["codemode", "tool_search"]),
        );
        expect(extensionPaths(runtime)).not.toContain("builtin:mcp");
        expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain(MCP_TOOL_NAME);
        expect(readMcpEvents(fixture.eventsPath)).toEqual([]);
        expect(started.extensionErrors).toEqual([]);
      } finally {
        await runtime?.dispose();
      }
      expect(readMcpEvents(fixture.eventsPath)).toEqual([]);
    });
    rmSync(fixture.root, { recursive: true, force: true });
  });
});
