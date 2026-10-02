import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CodemodeSandbox } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-codemode/dist/index.js";
import { createInMemoryTransportPair } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp/dist/testing/index.js";
import { createPiBuiltinExtensions, createTrustResolver } from "./bootstrap.mjs";

const MCP_TOOL_NAME = "mcp__project_loopback__echo";

const MCP_SERVER_SOURCE = String.raw`
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const eventsPath = process.argv[2];
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
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
lines.on("close", () => finish("stdin-closed"));
process.on("SIGTERM", () => finish("sigterm"));
`;

function makeProductionLoaderFixture(settings = {}) {
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
          args: [serverPath, eventsPath],
          exposure: "direct",
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

async function startProductionRuntime(fixture, trusted) {
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
      modelRuntimeSignal: AbortSignal.timeout(5_000),
      resourceLoaderOptions: { extensionFactories: createPiBuiltinExtensions(pi) },
      resourceLoaderReloadOptions: { resolveProjectTrust: resolveTrust },
    });
    const created = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const sessionManager = pi.SessionManager.inMemory(fixture.cwd);
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
  return { runtime, extensionErrors, trustPrompts };
}

function extensionPaths(runtime) {
  return runtime.services.resourceLoader
    .getExtensions()
    .extensions.map((extension) => extension.path);
}

describe("Pi 0.99 built-in runtimes", () => {
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
