import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import installedPiPackage from "../node_modules/@earendil-works/pi-coding-agent/package.json";
import projectPackage from "../package.json";

const PINNED_PI_VERSION = "1.0.0";
const piPackageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const piDependenciesRoot = join(piPackageRoot, "node_modules", "@earendil-works");
const PINNED_PI_PACKAGES = [
  "chord",
  "pi-agent-core",
  "pi-ai",
  "pi-codemode",
  "pi-mcp",
  "pi-telemetry",
  "pi-tui",
] as const;

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
    expect(projectPackage.dependencies).not.toHaveProperty("@earendil-works/pi-durable");
    expect(installedPiPackage.version).toBe(PINNED_PI_VERSION);
    expect(installedPiPackage.engines).toEqual({ node: ">=22.19.0" });
    expect(fs.existsSync(join(piPackageRoot, "dist", "cli.js"))).toBe(true);
    expect(fs.existsSync(join(piPackageRoot, "dist", "bundle", "cli.js"))).toBe(true);
    expect(installedPiPackage.bin).toEqual({ pi: "dist/bundle/cli.js" });
    expect(installedPiPackage.dependencies).toMatchObject({
      "@earendil-works/chord": "^1.0.0",
      "@earendil-works/pi-agent-core": "^1.0.0",
      "@earendil-works/pi-ai": "^1.0.0",
      "@earendil-works/pi-codemode": "^1.0.0",
      "@earendil-works/pi-mcp": "^1.0.0",
      "@earendil-works/pi-tui": "^1.0.0",
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
    const piAgentCorePackage = JSON.parse(
      fs.readFileSync(join(piDependenciesRoot, "pi-agent-core", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    expect(piAgentCorePackage.dependencies).toEqual({
      "@earendil-works/pi-ai": "^1.0.0",
      typebox: "1.3.27",
    });
    expect(piAgentCorePackage.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./package.json": "./package.json",
    });
    for (const removedSubpath of [
      "node.js",
      "node.d.ts",
      "harness",
      join("experimental", "pico3"),
    ]) {
      expect(fs.existsSync(join(piDependenciesRoot, "pi-agent-core", "dist", removedSubpath))).toBe(
        false,
      );
    }
    for (const removedPackage of ["pi-client", "pi-protocol"]) {
      expect(fs.existsSync(join(piDependenciesRoot, removedPackage, "package.json"))).toBe(false);
    }
    const typeboxPackage = JSON.parse(
      fs.readFileSync(join(piPackageRoot, "node_modules", "typebox", "package.json"), "utf8"),
    ) as { version: string };
    expect(typeboxPackage.version).toBe("1.3.27");
    const undiciPackage = JSON.parse(
      fs.readFileSync(join(piPackageRoot, "node_modules", "undici", "package.json"), "utf8"),
    ) as { version: string };
    expect(undiciPackage.version).toBe("8.10.2");
    const piAiPackage = JSON.parse(
      fs.readFileSync(
        join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai", "package.json"),
        "utf8",
      ),
    ) as { version: string; engines?: { node?: string }; dependencies?: Record<string, string> };
    expect(piAiPackage).toMatchObject({
      version: PINNED_PI_VERSION,
      engines: { node: ">=22.19.0" },
      dependencies: { openai: "7.19.0", typebox: "1.3.27" },
    });
    expect(piAiPackage.dependencies).not.toHaveProperty("@mistralai/mistralai");
    expect(piAiPackage.dependencies).not.toHaveProperty("zod");
  });

  it("ships the audited 0.86–1.0 public SDK surfaces used by Pi-Vis", async () => {
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
    const piAgentCoreIndexTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-agent-core", "dist", "index.d.ts"),
      "utf8",
    );
    const modelRuntimeTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "model-runtime.d.ts"),
      "utf8",
    );
    const modelRegistryTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "model-registry.d.ts"),
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
    const virtualModelTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "virtual-models.d.ts"),
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
    const piAiModelsTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-ai", "dist", "models.d.ts"),
      "utf8",
    );
    const piAiAuthTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-ai", "dist", "auth", "types.d.ts"),
      "utf8",
    );
    const piAiProviderTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-ai", "dist", "providers", "all.d.ts"),
      "utf8",
    );
    const codemodeTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-codemode", "dist", "types.d.ts"),
      "utf8",
    );
    const codemodeIndexTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-codemode", "dist", "index.d.ts"),
      "utf8",
    );
    const codingAgentCodemodeTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "extensions", "codemode", "tool.d.ts"),
      "utf8",
    );
    const mcpIndexTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-mcp", "dist", "index.d.ts"),
      "utf8",
    );
    const mcpClientTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-mcp", "dist", "client.d.ts"),
      "utf8",
    );
    const mcpOAuthFlowTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-mcp", "dist", "oauth", "flow.d.ts"),
      "utf8",
    );
    const codingAgentMcpOAuthTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "extensions", "mcp", "oauth.d.ts"),
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
    const tuiAltScreenTypes = fs.readFileSync(
      join(piDependenciesRoot, "pi-tui", "dist", "tui-alt-screen.d.ts"),
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
    const compactionEntryTypes = sessionManagerTypes.slice(
      sessionManagerTypes.indexOf("export interface CompactionEntry"),
      sessionManagerTypes.indexOf("export interface BranchSummaryEntry"),
    );
    const routedModelTypes = agentSessionTypes.slice(
      agentSessionTypes.indexOf("get routedModel():"),
      agentSessionTypes.indexOf("/** Whether the session is currently processing"),
    );
    const contextEditTypes = sessionManagerTypes.slice(
      sessionManagerTypes.indexOf("export type ContextEditableContent"),
      sessionManagerTypes.indexOf("/** Session entry"),
    );
    const compactionDraftTypes = extensionTypes.slice(
      extensionTypes.indexOf("export interface CompactionEntryDraft"),
      extensionTypes.indexOf("export type SessionBoundaryDraft"),
    );
    const compactionResultTypes = compactionTypes.slice(
      compactionTypes.indexOf("export interface CompactionResult"),
      compactionTypes.indexOf("export interface CompactionSettings"),
    );
    const systemMessageTypes = piAiTypes.slice(
      piAiTypes.indexOf("export interface SystemMessage"),
      piAiTypes.indexOf("export interface UserMessage"),
    );
    const usageTypes = piAiTypes.slice(
      piAiTypes.indexOf("export interface Usage"),
      piAiTypes.indexOf("export type StopReason"),
    );
    const nestedCallTypes = piAiTypes.slice(
      piAiTypes.indexOf("export interface NestedToolCallRecord"),
      piAiTypes.indexOf("export type ToolResultMessage"),
    );
    const toolResultMessageTypes = piAiTypes.slice(
      piAiTypes.indexOf("export type ToolResultMessage"),
      piAiTypes.indexOf("export type Message"),
    );
    const agentToolResultTypes = piAgentCoreTypes.slice(
      piAgentCoreTypes.indexOf("export interface AgentToolResult"),
      piAgentCoreTypes.indexOf("/** Final outcome of a tool call"),
    );
    const rpcSessionStateTypes = rpcTypes.slice(
      rpcTypes.indexOf("export interface RpcSessionState"),
      rpcTypes.indexOf("export type RpcResponse"),
    );
    const piTui = await import(
      "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js"
    );
    const piAgentCore = await import(
      "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js"
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
    expect(agentSessionTypes).toContain(
      "AgentSessionEvent = WithParentToolCallId<Exclude<AgentEvent",
    );
    expect(agentSessionTypes).toContain("parentToolCallId?: string");
    expect(agentSessionTypes).toContain(
      'export type QueuedInputDisposition = "handled" | "queued"',
    );
    expect(agentSessionTypes).toContain(
      'export type PromptDisposition = QueuedInputDisposition | "started"',
    );
    expect(agentSessionTypes).toContain(
      "preflightResult?: (disposition: PromptDisposition) => void",
    );
    expect(agentSessionTypes).toContain("source?: InputSource");
    expect(agentSessionTypes).toContain("): Promise<QueuedInputDisposition>");
    expect(agentSessionTypes.match(/Promise<QueuedInputDisposition>/g)).toHaveLength(2);
    expect(routedModelTypes).toContain("model: Model<any>");
    expect(routedModelTypes).toContain("thinkingLevel?: ThinkingLevel");
    expect(routedModelTypes).toContain("} | undefined");
    expect(piAgentCoreTypes).toContain('type: "message_update"');
    expect(piAgentCoreTypes).toContain("message: AgentMessage");
    expect(piAgentCoreTypes).toContain("finishTurn?: FinishTurn");
    expect(piAgentCoreTypes).toContain('action: "continue"');
    expect(piAgentCoreTypes).toContain('action: "end"');
    expect(piAgentCoreTypes).toContain("context: TranscriptContext");
    expect(piAgentCoreTypes).not.toContain("shouldStopAfterTurn");
    expect(piAgentCoreTypes).not.toContain("addedToolNames");
    expect(piAgentCoreIndexTypes).toContain('export * from "./agent.ts"');
    expect(piAgentCoreIndexTypes).toContain('export * from "./agent-loop.ts"');
    expect(piAgentCoreIndexTypes).toContain('export * from "./proxy.ts"');
    expect(piAgentCoreIndexTypes).toContain('export { setDefaultStreamFn } from "./stream-fn.ts"');
    for (const removedExport of [
      "AgentHarness",
      "DurableRuntime",
      "PromptTemplate",
      "SearchService",
      "SessionStorage",
      "uuidv7",
    ]) {
      expect(piAgentCoreIndexTypes).not.toContain(removedExport);
      expect(piAgentCore).not.toHaveProperty(removedExport);
    }
    expect(Object.keys(piAgentCore).sort()).toEqual([
      "Agent",
      "agentLoop",
      "agentLoopContinue",
      "runAgentLoop",
      "runAgentLoopContinue",
      "runToolCall",
      "setDefaultStreamFn",
      "streamProxy",
    ]);
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
    expect(extensionTypes).toContain('type: "provider_stream_event"');
    expect(extensionTypes).toContain("registerMcpServer(name: string, config: McpServerConfig)");
    expect(extensionTypes).toContain("registerVirtualModel<TState = unknown>");
    expect(extensionTypes).toContain(
      'export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden"',
    );
    expect(extensionTypes).toContain("outputSchema?: TSchema");
    expect(extensionTypes).toContain("executeTool(name: string, args: unknown");
    expect(extensionTypes).toContain(
      'export type InputSource = "interactive" | "rpc" | "extension"',
    );
    expect(extensionTypes.match(/parentToolCallId\?: string/g)?.length).toBeGreaterThanOrEqual(4);
    expect(extensionTypes).toContain("nestedCalls");
    expect(extensionTypes).toContain('type: "context_edit"');
    expect(compactionDraftTypes).toContain("firstKeptEntryId: string | null");
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
    expect(systemMessageTypes).toContain('role: "system"');
    expect(systemMessageTypes).toContain("content: string | TextContent[]");
    expect(systemMessageTypes).toContain("sections?: Record<string, string | null>");
    expect(systemMessageTypes).toContain("toolsAdded?: Tool[]");
    expect(systemMessageTypes).toContain("toolsRemoved?: ToolReference[]");
    expect(systemMessageTypes).toContain("timestamp: number");
    expect(usageTypes).toContain("cacheWrite1h?: number");
    expect(usageTypes).toContain("reasoning?: number");
    expect(nestedCallTypes).toContain("id: string");
    expect(nestedCallTypes).toContain("name: string");
    expect(nestedCallTypes).toContain("arguments?: JsonObject");
    expect(nestedCallTypes).toContain("argumentsBytes?: number");
    expect(nestedCallTypes).toContain('status: "ok" | "error" | "unfinished"');
    expect(nestedCallTypes).toContain("complete: boolean");
    expect(toolResultMessageTypes).toContain("nestedCalls?: NestedToolCalls");
    expect(toolResultMessageTypes).not.toContain("structuredContent");
    expect(agentToolResultTypes).toContain("structuredContent?: JsonValue");
    expect(piAiTypes).toContain('type: "image"');
    expect(piAiTypes).toContain('type: "classifier"');
    expect(piAiTypes).toContain("export type TranscriptContext = {");
    expect(piAiTypes).not.toContain("addedToolNames");
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
    expect(piAiModelsTypes).toContain("getModelsOfType<TType extends ModelType>");
    expect(piAiModelsTypes).toContain("generateImages(model: ImageModel<ImageApi>");
    expect(piAiModelsTypes).toContain("classify(model: ClassifierModel<ClassifierApi>");
    expect(piAiModelsTypes).toContain("options?: LoginOptions");
    expect(piAiAuthTypes).toContain("export interface LoginOptions");
    expect(piAiAuthTypes).toContain("getDeviceId?: () => string");
    expect(piAiProviderTypes).toContain("getBuiltinImageModel");
    expect(piAiProviderTypes).toContain("getBuiltinClassifierModel");
    expect(piAiProviderTypes).not.toContain("builtinImagesModels");
    expect(piAiProviderTypes).not.toContain("builtinImagesProviders");
    expect(modelRuntimeTypes).toContain("Promise<ModelsRefreshResult>");
    expect(modelRuntimeTypes).toContain("CredentialSynchronizationError");
    expect(modelRuntimeTypes).toContain("refreshOnCreate?: boolean");
    expect(modelRuntimeTypes).toContain(
      "generateImages(model: ImageModel<ImageApi>, context: ImagesContext",
    );
    expect(modelRegistryTypes).toContain(
      "generateImages(model: ImageModel<ImageApi>, context: ImagesContext",
    );
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
    expect(rpcTypes).toContain("disposition: PromptDisposition");
    expect(rpcTypes).toContain("disposition: QueuedInputDisposition");
    expect(rpcSessionStateTypes).not.toContain("routedModel");
    expect(compactionTypes.match(/sessionId\?: string/g)).toHaveLength(3);
    expect(compactionTypes).toContain(
      "Optional routing session ID forwarded without enabling prompt caching",
    );
    expect(settingsManagerTypes).toContain("defaultTools?: string[]");
    expect(settingsManagerTypes).toContain("getDefaultTools(): string[] | undefined");
    expect(settingsManagerTypes).toContain("getTerminalCapabilityOverrides()");
    expect(settingsManagerTypes).toContain("getShowHardwareCursor(): boolean");
    expect(settingsManagerTypes).toContain("getClearOnShrink(): boolean");
    expect(settingsManagerTypes).toContain('export type QuietStartup = boolean | "header"');
    expect(settingsManagerTypes).toContain("quietStartup?: QuietStartup");
    expect(settingsManagerTypes).toContain("tuiMode?: TuiMode");
    expect(sessionManagerTypes).toContain(
      "static inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[])",
    );
    expect(sessionManagerTypes).toContain('type: "usage"');
    expect(sessionManagerTypes).toContain('type: "context_edit"');
    expect(sessionManagerTypes).toContain("systemMessage?: SystemMessage");
    expect(sessionManagerTypes).toContain("appendUsage(kind: string");
    expect(sessionManagerTypes).toContain(
      'appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"])',
    );
    expect(compactionEntryTypes).toContain("summary: string");
    expect(compactionEntryTypes).toContain("firstKeptEntryId: string");
    expect(compactionEntryTypes).not.toContain("firstKeptEntryId: string | null");
    expect(compactionEntryTypes).toContain("tokensBefore: number");
    expect(compactionEntryTypes).toContain("systemMessage?: SystemMessage");
    expect(compactionEntryTypes).not.toContain("estimatedTokensAfter");
    expect(compactionEntryTypes).not.toContain("reason:");
    expect(sessionManagerTypes).toContain(
      "appendCompaction<T = unknown>(summary: string, firstKeptEntryId: string | null",
    );
    expect(compactionResultTypes).toContain("firstKeptEntryId: string");
    expect(compactionResultTypes).toContain("tokensBefore: number");
    expect(compactionResultTypes).toContain("estimatedTokensAfter?: number");
    expect(compactionResultTypes).toContain("details?: T");
    expect(compactionResultTypes).not.toContain("systemMessage");
    expect(compactionResultTypes).not.toContain("fromHook");
    expect(contextEditTypes).toContain(
      'UserMessage["content"] | AssistantMessage["content"] | ToolResultMessage["content"] | CustomMessage["content"]',
    );
    expect(contextEditTypes).toContain("content: ContextEditableContent");
    expect(virtualModelTypes).toContain('export declare const VIRTUAL_MODEL_API = "pi-virtual"');
    expect(virtualModelTypes).toContain(
      "export interface VirtualModelDefinition<TState = unknown>",
    );
    expect(virtualModelTypes).toContain("route(request: ModelRouteRequest<TState>)");
    expect(sdkTypes).toContain("uses the resolved `defaultTools` setting");
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
    expect(tuiTypes).toContain("queryTerminalColors(options:");
    expect(tuiAltScreenTypes).toContain("getScreenLines(): string[]");
    expect(tuiTypes).not.toContain("queryTerminalColorScheme");
    expect(tuiTypes).not.toContain("queryTerminalBackgroundColor");
    expect(tuiIndexTypes).not.toContain("parseOsc11BackgroundColor");
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
    expect(
      piProviders.getBuiltinImageModel("openrouter", "black-forest-labs/flux.2-flex"),
    ).toMatchObject({
      type: "image",
      api: "openrouter-images",
      provider: "openrouter",
    });
    expect(piProviders.getBuiltinClassifierModel("typesafe", "jev-latest")).toMatchObject({
      type: "classifier",
      api: "typesafe-system-one",
      provider: "typesafe",
    });
    expect(piProviders.getBuiltinImageModels("openrouter")).toHaveLength(57);
    expect(
      piProviders
        .getBuiltinProviders()
        .reduce(
          (count: number, provider: Parameters<typeof piProviders.getBuiltinClassifierModels>[0]) =>
            count + piProviders.getBuiltinClassifierModels(provider).length,
          0,
        ),
    ).toBe(15);

    const pi = await import("@earendil-works/pi-coding-agent");
    expect(pi.VERSION).toBe(PINNED_PI_VERSION);
    expect(typeof pi.resolveModelScopeWithDiagnostics).toBe("function");
    expect(typeof pi.detectSupportedImageMimeTypeFromFile).toBe("function");
    expect(typeof pi.createPowerShellTool).toBe("function");
    expect(typeof pi.createPowerShellToolDefinition).toBe("function");
    expect(typeof pi.createLocalPowerShellOperations).toBe("function");
    expect(typeof pi.isPowerShellToolResult).toBe("function");
    expect(typeof pi.createCodemodeExtension).toBe("function");
    expect(typeof pi.createToolSearchExtension).toBe("function");
    expect(typeof pi.createMcpExtension).toBe("function");
    expect(publicIndexTypes).toContain("createCodemodeExtension");
    expect(publicIndexTypes).toContain("createToolSearchExtension");
    expect(publicIndexTypes).toContain("createMcpExtension");

    const privateBuiltins = (await import(
      pathToFileURL(join(piPackageRoot, "dist", "extensions", "index.js")).href
    )) as {
      builtInExtensions: Array<{
        name: string;
        factory: unknown;
        builtin?: boolean;
        replaceable?: boolean;
      }>;
    };
    expect(privateBuiltins.builtInExtensions).toEqual([
      expect.objectContaining({ name: "llama.cpp", builtin: true }),
      expect.objectContaining({ name: "codemode", builtin: true, replaceable: true }),
      expect.objectContaining({ name: "tool-search", builtin: true, replaceable: true }),
      expect.objectContaining({ name: "mcp", builtin: true, replaceable: true }),
    ]);
    for (const builtin of privateBuiltins.builtInExtensions) {
      expect(typeof builtin.factory).toBe("function");
    }

    expect(codemodeTypes).toContain("export interface CodemodeSandboxOptions");
    expect(codemodeTypes).toContain("workerUrl?: string | URL");
    expect(codemodeTypes).toContain("outputSchema?: CodemodeJsonSchema");
    expect(codemodeIndexTypes).toContain("CodemodeSandbox");
    expect(codemodeIndexTypes).toContain("loadQuickJSWasm");
    expect(codemodeIndexTypes).toContain("renderToolOutputType");
    expect(codingAgentCodemodeTypes).toContain(
      'Pick<ModelRegistry, "getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages">',
    );
    expect(mcpIndexTypes).toContain("McpClient");
    expect(mcpIndexTypes).toContain("StdioTransport");
    expect(mcpIndexTypes).toContain("StreamableHttpTransport");
    expect(mcpIndexTypes).toContain("LATEST_PROTOCOL_VERSION");
    expect(mcpClientTypes).toContain("onProgress?: (progress: ProgressNotification) => void");
    expect(mcpClientTypes).toContain("roots?: readonly Root[]");
    expect(mcpOAuthFlowTypes).toContain("iss?: string");
    expect(mcpOAuthFlowTypes).toContain("authorizationServerMetadataUrl?: URL");
    expect(mcpOAuthFlowTypes).toContain(
      "stepUpScope(granted: string | undefined, challenged: string | undefined)",
    );
    expect(codingAgentMcpOAuthTypes).toContain("authServerMetadataUrl?: URL");

    // Removed 0.85 surfaces must stay gone so compatibility code cannot drift back to them.
    expect(fs.existsSync(join(piDependenciesRoot, "pi-ai", "dist", "images-models.d.ts"))).toBe(
      false,
    );
    expect(
      fs.existsSync(
        join(piDependenciesRoot, "pi-ai", "dist", "providers", "openrouter-images.d.ts"),
      ),
    ).toBe(false);
    expect(piAiModelsTypes).not.toContain("createImagesModels");
    expect(piAiModelsTypes).not.toContain("createImagesProvider");
    expect(piAiModelsTypes).not.toContain("ImagesModels");
    expect(piAiModelsTypes).not.toContain("ImagesProvider");
    expect(piAiIndexTypes).not.toContain("createImagesModels");
    expect(piAiIndexTypes).not.toContain("createImagesProvider");
    expect(piAiIndexTypes).not.toContain("ImagesModels");
    expect(piAiIndexTypes).not.toContain("ImagesProvider");
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

  it("uses strict-prefer schemas for every built-in mutation and shell tool", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const factories = [
      pi.createReadToolDefinition,
      pi.createBashToolDefinition,
      pi.createPowerShellToolDefinition,
      pi.createEditToolDefinition,
      pi.createWriteToolDefinition,
    ];
    for (const factory of factories) {
      expect(factory(process.cwd()).constrainedSampling).toEqual({
        type: "json_schema",
        strict: "prefer",
      });
    }
  });

  it("returns handled and queued dispositions while preserving the input source", async () => {
    const { AgentSession } = await import("@earendil-works/pi-coding-agent");
    const runInputHandlers = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ text: "transformed follow-up", images: undefined });
    const queueSteer = vi.fn();
    const queueFollowUp = vi.fn();
    const sessionLike = Object.assign(Object.create(AgentSession.prototype), {
      _isAgentRunActive: true,
      _resourceLoader: { getPrompts: () => ({ prompts: [] }) },
      _runInputHandlers: runInputHandlers,
      _expandSkillCommand: (text: string) => text,
      _queueSteer: queueSteer,
      _queueFollowUp: queueFollowUp,
    });

    await expect(
      Reflect.apply(AgentSession.prototype.steer, sessionLike, [
        "extension handled this",
        undefined,
        { source: "rpc" },
      ]),
    ).resolves.toBe("handled");
    await expect(
      Reflect.apply(AgentSession.prototype.followUp, sessionLike, [
        "queue this",
        undefined,
        { source: "extension" },
      ]),
    ).resolves.toBe("queued");

    expect(runInputHandlers).toHaveBeenNthCalledWith(
      1,
      "extension handled this",
      undefined,
      "rpc",
      "steer",
    );
    expect(runInputHandlers).toHaveBeenNthCalledWith(
      2,
      "queue this",
      undefined,
      "extension",
      "followUp",
    );
    expect(queueSteer).not.toHaveBeenCalled();
    expect(queueFollowUp).toHaveBeenCalledWith("transformed follow-up", undefined);
  });

  it("honors finishTurn end before preparing another assistant turn", async () => {
    const [{ Agent }, { createAssistantMessageEventStream }] = await Promise.all([
      import(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js"
      ),
      import(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js"
      ),
    ]);
    const prepareNextTurn = vi.fn();
    const finishTurn = vi.fn(() => ({ action: "end" as const }));
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
      finishTurn,
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

    expect(finishTurn).toHaveBeenCalledTimes(1);
    expect(finishTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: assistantMessage, toolResults: [] }),
      expect.any(AbortSignal),
    );
    expect(prepareNextTurn).not.toHaveBeenCalled();
  });

  it("projects system messages, context edits, usage, and nested calls without losing data", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const session = SessionManager.inMemory(process.cwd());
    const timestamp = Date.now();
    const systemEntryId = session.appendMessage({
      role: "system",
      content: "base prompt",
      sections: { policy: "stay safe" },
      toolsAdded: [],
      toolsRemoved: [],
      timestamp,
    });
    const userEntryId = session.appendMessage({
      role: "user",
      content: "before edit",
      timestamp: timestamp + 1,
    });
    const usage = session.appendUsage(
      "cache_warm",
      "openai",
      "gpt-6-astra",
      {
        input: 3,
        output: 0,
        cacheRead: 2,
        cacheWrite: 1,
        cacheWrite1h: 1,
        reasoning: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      "proactive warm",
    );
    session.appendContextEdit(userEntryId, { content: "after edit" });
    const toolResultEntryId = session.appendMessage({
      role: "toolResult",
      toolCallId: "outer-call",
      toolName: "codemode",
      content: [{ type: "text", text: "done" }],
      nestedCalls: {
        calls: [{ id: "nested-call", name: "read", status: "ok", durationMs: 2 }],
        complete: true,
      },
      isError: false,
      timestamp: timestamp + 2,
    });
    session.appendContextEdit(toolResultEntryId, { content: "normalized tool result" });
    expect(() => session.appendContextEdit(systemEntryId, null)).toThrow(
      /does not contribute editable model content/,
    );

    const entries = session.getEntries();
    const projection = session.buildSessionProjection();
    expect(entries.map((entry) => entry.type)).toEqual([
      "message",
      "message",
      "usage",
      "context_edit",
      "message",
      "context_edit",
    ]);
    expect(usage).toMatchObject({
      type: "usage",
      kind: "cache_warm",
      provider: "openai",
      model: "gpt-6-astra",
      note: "proactive warm",
      usage: expect.objectContaining({ cacheWrite1h: 1, reasoning: 0 }),
    });
    expect(projection.messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: "base prompt",
        sections: { policy: "stay safe" },
      }),
      expect.objectContaining({ role: "user", content: "after edit" }),
      expect.objectContaining({
        role: "toolResult",
        content: [{ type: "text", text: "normalized tool result" }],
        nestedCalls: {
          calls: [expect.objectContaining({ id: "nested-call", name: "read", status: "ok" })],
          complete: true,
        },
      }),
    ]);
    expect(
      projection.entries.find((entry) => entry.sourceEntry.type === "usage")?.messages,
    ).toEqual([]);

    const compacted = SessionManager.inMemory(process.cwd());
    compacted.appendMessage({
      role: "system",
      content: "compaction system prompt",
      sections: { policy: "current" },
      toolsAdded: [],
      toolsRemoved: [],
      timestamp,
    });
    compacted.appendMessage({ role: "user", content: "discard me", timestamp });
    const compactionId = compacted.appendCompaction("retained summary", null, 1);
    expect(compacted.getEntry(compactionId)).toMatchObject({
      type: "compaction",
      firstKeptEntryId: compactionId,
      systemMessage: {
        role: "system",
        content: "compaction system prompt",
        sections: { policy: "current" },
        timestamp: expect.any(Number),
      },
    });
    expect(compacted.buildSessionProjection().messages).toEqual([
      expect.objectContaining({ role: "system", content: "compaction system prompt" }),
      expect.objectContaining({ role: "compactionSummary", summary: "retained summary" }),
    ]);
  });

  it("loads and executes the new codemode package and exposes the MCP client surface", async () => {
    const [codemode, mcp, mcpOauth] = await Promise.all([
      import(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-codemode/dist/index.js"
      ),
      import(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp/dist/index.js"
      ),
      import(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp/dist/oauth/index.js"
      ),
    ]);

    expect(typeof codemode.CodemodeSandbox).toBe("function");
    expect(typeof codemode.loadQuickJSWasm).toBe("function");
    expect(typeof codemode.parseCodemodeSource).toBe("function");
    expect(codemode.renderToolOutputType).toBeTypeOf("function");
    expect(
      codemode.renderToolOutputType({
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      }),
    ).toBe("{ ok: boolean; }");
    const sandbox = new codemode.CodemodeSandbox();
    try {
      await expect(sandbox.execute("return 6 * 7")).resolves.toMatchObject({
        ok: true,
        value: 42,
      });
    } finally {
      await sandbox.close();
    }

    const recoverySandbox = new codemode.CodemodeSandbox({
      tools: [{ name: "bash", execute: () => "ok" }],
    });
    try {
      await expect(recoverySandbox.execute("return tools.Bash({})")).resolves.toMatchObject({
        ok: false,
        error: {
          kind: "script",
          message: expect.stringContaining("Did you mean tools.bash?"),
        },
      });
      await expect(recoverySandbox.execute('return "bash" in tools')).resolves.toMatchObject({
        ok: true,
        value: true,
      });
    } finally {
      await recoverySandbox.close();
    }

    expect(typeof mcp.McpClient).toBe("function");
    expect(typeof mcp.StdioTransport).toBe("function");
    expect(typeof mcp.StreamableHttpTransport).toBe("function");
    expect(mcp.SUPPORTED_PROTOCOL_VERSIONS).toContain(mcp.LATEST_PROTOCOL_VERSION);
    const client = new mcp.McpClient({ name: "pi-vis-test", version: "1" });
    expect(client.connectionState).toBe("idle");
    await client.close();
    expect(client.connectionState).toBe("closed");
    expect(mcpOauth.stepUpScope("read write", "admin write")).toBe("read write admin");
    expect(mcpOauth.stepUpScope(undefined, "read")).toBe("read");
    expect(mcpOauth.stepUpScope("read", undefined)).toBeUndefined();
  });

  it("keeps the app-owned Radius MCP endpoint aligned with Pi's public default gateway", async () => {
    const [radiusConfig, radiusMcp] = await Promise.all([
      import(
        "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/radius-config.js"
      ),
      import("../resources/pi-session-host/radius-mcp.mjs"),
    ]);

    expect(radiusConfig.DEFAULT_RADIUS_GATEWAY).toBe("https://radius.pi.dev");
    const gateway = radiusConfig.normalizeRadiusGatewayUrl(radiusConfig.DEFAULT_RADIUS_GATEWAY);
    expect(`${gateway}/mcp`).toBe(radiusMcp.RADIUS_MCP_URL);
  });

  it("exports configured credentials through the pinned 1.0.0 CLI", () => {
    const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-pi-auth-export-"));
    const cli = join(piPackageRoot, "dist", "bundle", "cli.js");
    const sentinel = "pivis-credential-export-test";
    try {
      const output = execFileSync(
        process.execPath,
        [cli, "auth", "print-api-key", "--provider", "openai", "--model", "gpt-6-astra"],
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
