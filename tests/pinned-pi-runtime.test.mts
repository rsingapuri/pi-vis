import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import installedPiPackage from "../node_modules/@earendil-works/pi-coding-agent/package.json";
import projectPackage from "../package.json";

const PINNED_PI_VERSION = "0.85.1";
const piPackageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const piDependenciesRoot = join(piPackageRoot, "node_modules", "@earendil-works");
const PINNED_PI_PACKAGES = ["chord", "pi-agent-core", "pi-ai", "pi-telemetry", "pi-tui"] as const;

function isolatedPiCliEnv(agentDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return { ...env, ...overrides };
}

describe("pinned Pi runtime", () => {
  it("keeps the manifest, installed package, and executable layout pinned exactly", () => {
    // Production dependency: the app ships this exact pi and runs nothing else.
    expect(projectPackage.dependencies["@earendil-works/pi-coding-agent"]).toBe(PINNED_PI_VERSION);
    expect(installedPiPackage.version).toBe(PINNED_PI_VERSION);
    expect(installedPiPackage.engines).toEqual({ node: ">=22.19.0" });
    expect(fs.existsSync(join(piPackageRoot, "dist", "cli.js"))).toBe(true);
    expect(fs.existsSync(join(piPackageRoot, "dist", "bundle", "cli.js"))).toBe(true);
    expect(installedPiPackage.bin).toEqual({ pi: "dist/bundle/cli.js" });
    expect(installedPiPackage.dependencies).toMatchObject({
      "@earendil-works/chord": "^0.85.1",
      "@earendil-works/pi-agent-core": "^0.85.1",
      "@earendil-works/pi-ai": "^0.85.1",
      "@earendil-works/pi-tui": "^0.85.1",
    });
    expect(installedPiPackage.dependencies).not.toHaveProperty("@earendil-works/pi-client");
    expect(installedPiPackage.dependencies).not.toHaveProperty("@earendil-works/pi-protocol");
    expect(installedPiPackage.exports).toMatchObject({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
      "./client": { source: "./src/client/index.ts" },
      "./experimental/plugin": { source: "./src/experimental/plugin.ts" },
    });
    for (const packageName of PINNED_PI_PACKAGES) {
      const dependencyPackage = JSON.parse(
        fs.readFileSync(join(piDependenciesRoot, packageName, "package.json"), "utf8"),
      ) as { version: string };
      expect(dependencyPackage.version).toBe(PINNED_PI_VERSION);
    }
    for (const removedPackage of ["pi-client", "pi-protocol"]) {
      expect(fs.existsSync(join(piDependenciesRoot, removedPackage, "package.json"))).toBe(false);
    }
    const typeboxPackage = JSON.parse(
      fs.readFileSync(join(piPackageRoot, "node_modules", "typebox", "package.json"), "utf8"),
    ) as { version: string };
    expect(typeboxPackage.version).toBe("1.3.7");
    const undiciPackage = JSON.parse(
      fs.readFileSync(join(piPackageRoot, "node_modules", "undici", "package.json"), "utf8"),
    ) as { version: string };
    expect(undiciPackage.version).toBe("8.9.0");
    const piAiPackage = JSON.parse(
      fs.readFileSync(
        join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai", "package.json"),
        "utf8",
      ),
    ) as { version: string; engines?: { node?: string }; dependencies?: Record<string, string> };
    expect(piAiPackage).toMatchObject({
      version: PINNED_PI_VERSION,
      engines: { node: ">=22.19.0" },
      dependencies: { openai: "6.40.0", typebox: "1.3.7" },
    });
    expect(piAiPackage.dependencies).not.toHaveProperty("@mistralai/mistralai");
    expect(piAiPackage.dependencies).not.toHaveProperty("zod");
  });

  it("ships the audited 0.81–0.85 public SDK surfaces used by Pi-Vis", async () => {
    const agentSessionTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "agent-session.d.ts"),
      "utf8",
    );
    const extensionTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "extensions", "types.d.ts"),
      "utf8",
    );
    const extensionRunnerTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "extensions", "runner.d.ts"),
      "utf8",
    );
    const publicIndexTypes = fs.readFileSync(join(piPackageRoot, "dist", "index.d.ts"), "utf8");
    const resourceLoaderTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "resource-loader.d.ts"),
      "utf8",
    );
    const piAiTypes = fs.readFileSync(
      join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "types.d.ts"),
      "utf8",
    );
    const piAgentCoreTypes = fs.readFileSync(
      join(piPackageRoot, "node_modules", "@earendil-works", "pi-agent-core", "dist", "types.d.ts"),
      "utf8",
    );
    const modelRuntimeTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "model-runtime.d.ts"),
      "utf8",
    );
    const modelConfigTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "model-config.d.ts"),
      "utf8",
    );
    const sessionServicesTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "agent-session-services.d.ts"),
      "utf8",
    );
    const jsonEventTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "modes", "json-event.d.ts"),
      "utf8",
    );
    const rpcTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "modes", "rpc", "rpc-types.d.ts"),
      "utf8",
    );
    const compactionTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "compaction", "compaction.d.ts"),
      "utf8",
    );
    const settingsManagerTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "settings-manager.d.ts"),
      "utf8",
    );
    const sessionManagerTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "session-manager.d.ts"),
      "utf8",
    );
    const sdkTypes = fs.readFileSync(join(piPackageRoot, "dist", "core", "sdk.d.ts"), "utf8");
    const piAiIndexTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-ai", "dist", "index.d.ts"),
      "utf8",
    );
    const cloudflareAiBindingTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-ai", "dist", "api", "cloudflare-ai-binding.d.ts"),
      "utf8",
    );
    const googleSharedTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-ai", "dist", "api", "google-shared.d.ts"),
      "utf8",
    );
    const assistantFrameTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-ai", "dist", "utils", "assistant-message-frame.d.ts"),
      "utf8",
    );
    const tuiTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-tui", "dist", "tui.d.ts"),
      "utf8",
    );
    const tuiIndexTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-tui", "dist", "index.d.ts"),
      "utf8",
    );
    const themeTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "modes", "interactive", "theme", "theme.d.ts"),
      "utf8",
    );
    const constrainedSamplingTypes = fs.readFileSync(
      join(
        piPackageRoot,
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "dist",
        "api",
        "constrained-sampling.d.ts",
      ),
      "utf8",
    );
    const piTui = await import(
      "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js"
    );
    const piProviders = await import(
      "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js"
    );

    expect(agentSessionTypes).toContain('type: "summarization_retry_scheduled"');
    expect(agentSessionTypes).toContain('type: "bash_execution_update"');
    // Coding-agent retains its higher-level retry completion event even though
    // the lower-level agent-core AgentEvent union does not contain it.
    expect(agentSessionTypes).toContain('type: "auto_retry_end"');
    expect(piAgentCoreTypes).not.toContain('type: "auto_retry_end"');
    // Pi-Vis consumes direct SDK events, whose cumulative checkpoint remains
    // intentional even though 0.84's JSON/RPC stdout projection is delta-only.
    expect(agentSessionTypes).toContain("AgentSessionEvent = Exclude<AgentEvent");
    expect(piAgentCoreTypes).toContain('type: "message_update"');
    expect(piAgentCoreTypes).toContain("message: AgentMessage");
    expect(agentSessionTypes).toContain("getAvailableThinkingLevels(): ThinkingLevel[]");
    expect(agentSessionTypes).toContain("id?: string");
    expect(agentSessionTypes).toContain("expandPromptTemplates?: boolean");
    expect(agentSessionTypes).toContain("themeName?: string");
    expect(agentSessionTypes).toContain("export interface ModelMutationOptions");
    expect(agentSessionTypes).toContain("persist?: boolean");
    expect(agentSessionTypes).toContain("options?: ModelMutationOptions");
    expect(extensionTypes).toContain("constrainedSampling?: false | ConstrainedSamplingConfig");
    expect(extensionTypes).toContain("outputPad: number");
    expect(extensionTypes).toContain("scopedModels: readonly ScopedModel[]");
    expect(extensionTypes).toContain("terminate?: boolean");
    expect(extensionTypes).toContain(
      "registerMarkdownTransformer(transformer: MarkdownTransformer)",
    );
    expect(extensionRunnerTypes).toContain("emitInput(text: string");
    expect(extensionRunnerTypes).toContain("Promise<InputEventResult>");
    expect(extensionRunnerTypes).toContain("emitUserBash(event: UserBashEvent)");
    expect(extensionTypes).toContain('type: "session_compact_failed"');
    expect(extensionTypes).toContain('type: "ui_prompt_start"');
    expect(extensionTypes).toContain('type: "ui_prompt_end"');
    expect(extensionTypes).toContain("PowerShellToolCallEvent");
    expect(publicIndexTypes).toContain("resolveModelScopeWithDiagnostics");
    expect(publicIndexTypes).toContain("detectSupportedImageMimeTypeFromFile");
    expect(publicIndexTypes).toContain("createPowerShellTool");
    expect(publicIndexTypes).toContain("createPowerShellToolDefinition");
    expect(publicIndexTypes).toContain("createLocalPowerShellOperations");
    expect(publicIndexTypes).toContain("isPowerShellToolResult");
    expect(resourceLoaderTypes).toContain("getSystemPromptSource()");
    expect(resourceLoaderTypes).toContain("getAppendSystemPromptSources()");
    expect(piAiTypes).toContain("fetch?: FetchFunction");
    expect(piAiTypes).toContain(
      'StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"',
    );
    expect(piAiTypes).toContain("export interface DeferredHandle");
    expect(piAiTypes).toContain("deferred?: DeferredHandle");
    expect(piAiTypes).toContain("rawStopReason?: string");
    expect(piAiTypes).toContain("endTurn?: boolean");
    expect(piAiTypes).toContain("namespace?: string");
    expect(piAiTypes).toContain("ProviderHeaders = Record<string, string | null>");
    expect(piAiTypes).toContain("samplingParams?: Record<string, unknown>");
    expect(piAiTypes).toContain("supportsThinkingTokenBudget?: boolean");
    expect(piAiTypes).toContain("supportsAdditionalTools?: boolean");
    expect(piAiTypes).toContain("providerThinkingLevel?: string");
    expect(piAiTypes).toContain("vllmPriority?: number");
    expect(piAiTypes).toContain("supportsMaxOutputTokens?: boolean");
    expect(piAiTypes).toContain("supportsMidConvoEffort?: boolean");
    expect(piAiIndexTypes).toContain("GoogleApiThinkingLevel");
    expect(piAiIndexTypes).toContain("ResolvedGoogleThinkingLevel");
    expect(piAiIndexTypes).not.toMatch(/\bGoogleThinkingLevel\b/);
    expect(googleSharedTypes).toContain("export type GoogleApiThinkingLevel");
    expect(googleSharedTypes).toContain("export type ResolvedGoogleThinkingLevel");
    expect(googleSharedTypes).not.toMatch(/export type GoogleThinkingLevel\b/);
    expect(cloudflareAiBindingTypes).toContain("createAiBindingFetch");
    expect(cloudflareAiBindingTypes).not.toContain("createGatewayBindingFetch");
    expect(assistantFrameTypes).toContain("export type AssistantMessageFrame");
    expect(assistantFrameTypes).toContain("export declare class AssistantMessageFrameEncoder");
    expect(assistantFrameTypes).toContain("reduceAssistantMessageFrames");
    expect(modelRuntimeTypes).toContain("Promise<ModelsRefreshResult>");
    expect(modelRuntimeTypes).toContain("CredentialSynchronizationError");
    expect(modelRuntimeTypes).toContain("refreshOnCreate?: boolean");
    expect(modelConfigTypes).toContain("supportsFinishReason: Type.TOptional<Type.TBoolean>");
    expect(sessionServicesTypes).toContain("modelRuntimeSignal?: AbortSignal");
    expect(jsonEventTypes).toContain("ToJsonAssistantMessageEvent");
    expect(jsonEventTypes).toContain('type: "message_update"');
    expect(jsonEventTypes).toContain("usage: Usage");
    expect(jsonEventTypes).not.toContain("message: AgentMessage");
    expect(rpcTypes).toContain('type: "clear_queue"');
    expect(rpcTypes).toContain('command: "clear_queue"');
    expect(rpcTypes).toContain("steering: string[]");
    expect(rpcTypes).toContain("followUp: string[]");
    expect(compactionTypes.match(/sessionId\?: string/g)).toHaveLength(3);
    expect(compactionTypes).toContain(
      "Optional routing session ID forwarded without enabling prompt caching",
    );
    expect(settingsManagerTypes).toContain("defaultTools?: string[]");
    expect(settingsManagerTypes).toContain("getDefaultTools(): string[] | undefined");
    expect(settingsManagerTypes).toContain("getTerminalCapabilityOverrides()");
    expect(settingsManagerTypes).toContain("getShowHardwareCursor(): boolean");
    expect(settingsManagerTypes).toContain("getClearOnShrink(): boolean");
    expect(sessionManagerTypes).toContain(
      "static inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[])",
    );
    expect(sdkTypes).toContain("uses the `defaultTools` setting");
    expect(sdkTypes).toContain("createPowerShellTool");
    expect(constrainedSamplingTypes).toContain("makeStrictJsonSchema");
    expect(constrainedSamplingTypes).toContain("getJsonSchemaToolParameters");
    expect(typeof piTui.TuiMainScreen).toBe("function");
    expect(typeof piTui.setCapabilityOverrides).toBe("function");
    expect(tuiIndexTypes).toContain("setCapabilityOverrides");
    expect(tuiTypes).toContain(
      "constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string)",
    );
    expect(tuiTypes).toContain("setClearOnShrink(enabled: boolean): void");
    const themeColorUnion = themeTypes.match(/export type ThemeColor = ([^;]+);/)?.[1];
    const themeBgUnion = themeTypes.match(/export type ThemeBg = ([^;]+);/)?.[1];
    expect(themeColorUnion).toContain('"scrollbarThumb"');
    expect(themeBgUnion).not.toContain('"scrollbarThumb"');
    expect(piTui.TUI).toBeUndefined();
    expect(piProviders.getBuiltinProviders()).toEqual(
      expect.arrayContaining(["baseten", "qwen-token-plan-individual"]),
    );
    expect(piProviders.getBuiltinModel("openai", "gpt-6-astra")).toMatchObject({
      id: "gpt-6-astra",
      provider: "openai",
    });
    expect(piProviders.getBuiltinModel("openai-codex", "gpt-6-astra")).toMatchObject({
      id: "gpt-6-astra",
      provider: "openai-codex",
    });

    const pi = await import("@earendil-works/pi-coding-agent");
    expect(pi.VERSION).toBe(PINNED_PI_VERSION);
    expect(typeof pi.resolveModelScopeWithDiagnostics).toBe("function");
    expect(typeof pi.detectSupportedImageMimeTypeFromFile).toBe("function");
    expect(typeof pi.createPowerShellTool).toBe("function");
    expect(typeof pi.createPowerShellToolDefinition).toBe("function");
    expect(typeof pi.createLocalPowerShellOperations).toBe("function");
    expect(typeof pi.isPowerShellToolResult).toBe("function");
  });

  it("executes the manifest-declared bundled CLI and reports the exact pin", () => {
    const cli = join(piPackageRoot, "dist", "bundle", "cli.js");
    const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-pi-version-"));
    try {
      expect(
        execFileSync(process.execPath, [cli, "--version"], {
          encoding: "utf8",
          env: isolatedPiCliEnv(agentDir),
        }).trim(),
      ).toBe(PINNED_PI_VERSION);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("gates strict built-in tool schemas behind PI_EXPERIMENTAL exactly", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const factories = [
      pi.createReadToolDefinition,
      pi.createBashToolDefinition,
      pi.createEditToolDefinition,
      pi.createWriteToolDefinition,
    ];
    const previous = process.env.PI_EXPERIMENTAL;
    try {
      delete process.env.PI_EXPERIMENTAL;
      for (const factory of factories) {
        expect(factory(process.cwd()).constrainedSampling).toBeUndefined();
      }
      process.env.PI_EXPERIMENTAL = "1";
      for (const factory of factories) {
        expect(factory(process.cwd()).constrainedSampling).toEqual({
          type: "json_schema",
          strict: "prefer",
        });
      }
    } finally {
      if (previous === undefined) delete process.env.PI_EXPERIMENTAL;
      else process.env.PI_EXPERIMENTAL = previous;
    }
  });

  it("prepares a next turn only after Pi determines another assistant turn will start", async () => {
    const [{ Agent }, { createAssistantMessageEventStream }] = await Promise.all([
      import(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js"
      ),
      import(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js"
      ),
    ]);
    const prepareNextTurn = vi.fn();
    const shouldStopAfterTurn = vi.fn(() => true);
    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "done" }],
      api: "pivis-test" as never,
      provider: "pivis-test",
      model: "pivis-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    const agent = new Agent({
      prepareNextTurn,
      shouldStopAfterTurn,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: assistantMessage });
          stream.push({ type: "done", reason: "stop", message: assistantMessage });
        });
        return stream;
      },
    });

    await agent.prompt("stop after this turn");

    expect(shouldStopAfterTurn).toHaveBeenCalledTimes(1);
    expect(prepareNextTurn).not.toHaveBeenCalled();
  });

  it("exports configured credentials through the pinned 0.85 CLI", () => {
    const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-pi-auth-export-"));
    const cli = join(piPackageRoot, "dist", "bundle", "cli.js");
    const sentinel = "pivis-credential-export-test";
    try {
      const output = execFileSync(
        process.execPath,
        [cli, "auth", "print-api-key", "--provider", "openai", "--model", "gpt-5.4"],
        {
          encoding: "utf8",
          env: isolatedPiCliEnv(agentDir, { OPENAI_API_KEY: sentinel }),
        },
      );
      expect(output).toBe(`${sentinel}\n`);

      const help = execFileSync(process.execPath, [cli, "auth"], {
        encoding: "utf8",
        env: isolatedPiCliEnv(agentDir),
      });
      expect(help).toContain("auth print-api-key");
      expect(help).toContain("auth print-bearer-token");
      expect(help).toContain("auth check");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("checks credential readiness without exposing the configured credential", () => {
    const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-pi-auth-check-"));
    const cli = join(piPackageRoot, "dist", "bundle", "cli.js");
    const sentinel = "pivis-auth-check-sentinel";
    const runCheck = (args: string[], env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [cli, "auth", "check", ...args], {
        encoding: "utf8",
        env,
      });

    try {
      const ready = runCheck(
        ["--provider", "openai", "--no-refresh"],
        isolatedPiCliEnv(agentDir, { OPENAI_API_KEY: sentinel }),
      );
      expect(ready.error).toBeUndefined();
      expect(ready.status).toBe(0);
      expect(ready.stdout).toBe("ready\n");
      expect(ready.stderr).toBe("");
      expect(`${ready.stdout}${ready.stderr}`).not.toContain(sentinel);

      const readyJson = runCheck(
        ["--provider", "openai", "--json", "--no-refresh"],
        isolatedPiCliEnv(agentDir, { OPENAI_API_KEY: sentinel }),
      );
      expect(readyJson.error).toBeUndefined();
      expect(readyJson.status).toBe(0);
      expect(JSON.parse(readyJson.stdout)).toEqual({
        status: "ready",
        provider: "openai",
        authType: "api_key",
      });
      expect(readyJson.stderr).toBe("");
      expect(`${readyJson.stdout}${readyJson.stderr}`).not.toContain(sentinel);

      const notReady = runCheck(
        ["--provider", "openai", "--json", "--no-refresh"],
        isolatedPiCliEnv(agentDir),
      );
      expect(notReady.error).toBeUndefined();
      expect(notReady.status).toBe(1);
      expect(JSON.parse(notReady.stdout)).toEqual({
        status: "not_ready",
        provider: "openai",
        reason: "credentials_not_configured",
      });
      expect(notReady.stderr).toBe("");

      const invalidUsage = runCheck(["--no-refresh"], isolatedPiCliEnv(agentDir));
      expect(invalidUsage.error).toBeUndefined();
      expect(invalidUsage.status).toBe(2);
      expect(invalidUsage.stdout).toBe("");
      expect(invalidUsage.stderr).toBe(
        "Error: Auth checks require --provider <provider> or --model <model>\n",
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
