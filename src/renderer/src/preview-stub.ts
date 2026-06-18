import type { ProviderAuthStatus } from "@shared/auth.js";
import type { SessionId } from "@shared/ids.js";
/**
 * Stubs window.pivis for standalone browser preview (not running in Electron).
 *
 * Acts as a miniature fake-pi: seeds a demo session at boot and answers
 * session.sendCommand with canned responses, including a streamed agent
 * response for prompts so transcript/composer/status behavior can be
 * exercised in a plain browser via `npm run dev:renderer`.
 */
import { useSessionsStore } from "./stores/sessions-store.js";

const DEMO_SESSION_ID = "demo-session-1" as SessionId;
const DEMO_WORKSPACE = "/Users/demo/src/pi-vis";
const DEMO_MODEL = "deepseek/deepseek-v4-flash";
const DEMO_NON_REASONING_MODEL = "claude-fable-5";

// Per-session mutable state so the dropdown actually reflects the user's picks
// in the browser-only preview. Mirrors what the real `pi` binary does in
// memory between `set_thinking_level` / `get_state` calls.
let currentModelId = DEMO_MODEL;
let currentThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" = "off";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(channel: string, payload: unknown): void {
  const subs = listeners.get(channel);
  if (!subs) return;
  for (const cb of subs) cb(payload);
}

function emitEvent(event: Record<string, unknown>): void {
  emit("session.event", { sessionId: DEMO_SESSION_ID, event });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function response(command: string, data?: unknown): Record<string, unknown> {
  return { type: "response", command, success: true, data };
}

// ── Demo transcript ──────────────────────────────────────────────────────

const READ_OUTPUT = [
  'import path from "node:path";',
  'import { z } from "zod";',
  "",
  "const ConfigSchema = z.object({",
  "  rootDir: z.string(),",
  "  cacheDir: z.string().optional(),",
  "});",
  "",
  "export function loadConfig(root: string): Config {",
  '  const file = path.join(root, "config.json");',
  '  const raw = fs.readFileSync(file, "utf8");',
  "  return ConfigSchema.parse(JSON.parse(raw));",
  "}",
].join("\n");

const EDIT_DIFF = [
  "--- a/src/config/loader.ts",
  "+++ b/src/config/loader.ts",
  "@@ -9,7 +9,7 @@ export function loadConfig(root: string): Config {",
  '-  const file = path.join(root, "config.json");',
  '+  const file = path.resolve(root, "config.json");',
  '   const raw = fs.readFileSync(file, "utf8");',
  "   return ConfigSchema.parse(JSON.parse(raw));",
  " }",
].join("\n");

const TEST_OUTPUT = [
  "> pi-vis@0.1.0 test",
  "> vitest run",
  "",
  " ✓ src/config/loader.test.ts (6 tests) 12ms",
  " ✓ src/config/schema.test.ts (4 tests) 8ms",
  "",
  " Test Files  2 passed (2)",
  "      Tests  10 passed (10)",
  "   Duration  310ms",
].join("\n");

function seedDemoSession(): void {
  const store = useSessionsStore.getState();
  store.addWorkspace(DEMO_WORKSPACE);
  store.setActiveWorkspace(DEMO_WORKSPACE);
  store.createSession(DEMO_SESSION_ID, DEMO_WORKSPACE);
  store.setSessionStatus(DEMO_SESSION_ID, "ready");
  store.setActiveSession(DEMO_SESSION_ID);

  store.seedHistory(DEMO_SESSION_ID, [
    {
      id: "demo-1",
      type: "user",
      data: { content: "Can you fix the config loader so relative roots resolve correctly?" },
    },
    {
      id: "demo-2",
      type: "assistant",
      data: {
        thinking:
          "The user is hitting the classic path.join vs path.resolve issue. I should read the loader first to confirm, then make the edit and run the tests.",
        content: "Sure — let me look at the loader first.",
      },
    },
    {
      id: "demo-3",
      type: "tool_call",
      data: {
        toolCallId: "t1",
        toolName: "read",
        input: { file_path: "src/config/loader.ts" },
        outputText: READ_OUTPUT,
        isError: false,
        isStreaming: false,
      },
    },
    {
      id: "demo-4",
      type: "tool_call",
      data: {
        toolCallId: "t2",
        toolName: "edit",
        input: { file_path: "src/config/loader.ts" },
        outputText: "",
        diff: EDIT_DIFF,
        isError: false,
        isStreaming: false,
      },
    },
    {
      id: "demo-5",
      type: "tool_call",
      data: {
        toolCallId: "t3",
        toolName: "bash",
        input: { command: "npm test" },
        outputText: TEST_OUTPUT,
        isError: false,
        isStreaming: false,
      },
    },
    {
      id: "demo-6",
      type: "tool_call",
      data: {
        toolCallId: "t4",
        toolName: "read",
        input: { file_path: "src/config/legacy-loader.ts" },
        outputText: "ENOENT: no such file or directory, open 'src/config/legacy-loader.ts'",
        isError: true,
        isStreaming: false,
      },
    },
    {
      id: "demo-7",
      type: "assistant",
      data: {
        content: [
          "Fixed. The loader was using `path.join`, which keeps relative roots relative — `path.resolve` anchors them to the process cwd.",
          "",
          "- `loadConfig` now resolves the config path before reading",
          "- all 10 tests pass",
          "",
          "```ts",
          'const file = path.resolve(root, "config.json");',
          "```",
          "",
          "And an un-annotated fence (no language):",
          "",
          "```",
          'import { DiffBlock } from "./DiffBlock.js";',
          'import { htmlToMarkdown } from "../../lib/turndown.js";',
          'import "./TranscriptView.css";',
          "```",
        ].join("\n"),
      },
    },
    {
      id: "demo-8",
      type: "bash",
      data: {
        command: "git status --short",
        outputText: " M src/config/loader.ts\n?? src/config/loader.test.ts",
        isStreaming: false,
        exitCode: 0,
      },
    },
  ]);

  // Real pi only sends extension statuses over RPC (its own workspace/usage
  // footer lines are TUI rendering); statusText carries raw ANSI colors.
  store.addUiRequest(DEMO_SESSION_ID, {
    type: "extension_ui_request",
    id: "status-headroom",
    method: "setStatus",
    statusKey: "pi-headroom",
    statusText:
      "\x1b[38;2;181;189;104m✓ \x1b[39m\x1b[38;2;102;102;102m Headroom -25% (1,111 saved)\x1b[39m",
  });
}

// ── Streamed prompt response ─────────────────────────────────────────────

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function streamPromptResponse(message: string): Promise<void> {
  // Simulate the latency before pi's agent_start arrives
  await sleep(600);
  emitEvent({ type: "agent_start" });
  emitEvent({ type: "turn_start" });
  emitEvent({ type: "message_start", message: { role: "assistant" } });

  const thinking = `The user said "${message}". I'll think about that for a moment before answering, long enough that the italic thinking style is visible while streaming.`;
  for (const delta of chunk(thinking, 18)) {
    emitEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta },
    });
    await sleep(40);
  }

  const text = `You said: **${message}**\n\nThis is a streamed preview response with enough text to scroll the transcript and demonstrate that the view stays pinned to the bottom while content flows in — unless you scroll up, in which case it stays put.\n\nHere is a list to take up vertical space:\n\n${Array.from({ length: 8 }, (_, i) => `- streamed list item ${i + 1}`).join("\n")}`;
  for (const delta of chunk(text, 14)) {
    emitEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta },
    });
    await sleep(30);
  }
  emitEvent({ type: "message_end", message: { role: "assistant" } });

  // A tool call so the running spinner + live tail are visible
  emitEvent({
    type: "tool_execution_start",
    toolCallId: "live-1",
    toolName: "bash",
    args: { command: "npm run build" },
  });
  for (let i = 1; i <= 8; i++) {
    emitEvent({
      type: "tool_execution_update",
      toolCallId: "live-1",
      toolName: "bash",
      args: { command: "npm run build" },
      partialResult: `[build] step ${i} of 8 complete\n`,
    });
    await sleep(150);
  }
  emitEvent({
    type: "tool_execution_end",
    toolCallId: "live-1",
    toolName: "bash",
    result: null,
    isError: false,
  });

  emitEvent({ type: "message_start", message: { role: "assistant" } });
  for (const delta of chunk("Done — that was the whole demo turn.", 12)) {
    emitEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta },
    });
    await sleep(40);
  }
  emitEvent({ type: "message_end", message: { role: "assistant" } });
  emitEvent({ type: "turn_end" });
  emitEvent({ type: "agent_end" });
}

// ── Command handling ─────────────────────────────────────────────────────

async function handleSendCommand(req: unknown): Promise<unknown> {
  const { command } = req as { sessionId: SessionId; command: Record<string, unknown> };
  const type = command.type as string;

  switch (type) {
    case "prompt": {
      await streamPromptResponse(String(command.message ?? ""));
      return response("prompt");
    }
    case "bash": {
      await sleep(700);
      const cmd = String(command.command ?? "");
      if (cmd.includes("fail")) {
        return {
          type: "response",
          command: "bash",
          success: true,
          data: { output: `sh: ${cmd}: command not found`, exitCode: 127 },
        };
      }
      return response("bash", {
        output: `$ ${cmd}\nfile-one.ts\nfile-two.ts\nfile-three.ts\nfile-four.ts\nfile-five.ts\nfile-six.ts`,
        exitCode: 0,
      });
    }
    case "abort":
      emitEvent({ type: "agent_end" });
      return response("abort");
    case "get_commands":
      return response("get_commands", {
        commands: [
          { name: "compact", description: "Compact context" },
          { name: "export", description: "Export session" },
          { name: "headroom", description: "Toggle headroom" },
        ],
      });
    case "get_available_models":
      return response("get_available_models", {
        models: [
          {
            id: DEMO_MODEL,
            name: "DeepSeek V4 Flash",
            provider: "deepseek",
            reasoning: true,
            input: ["text"],
          },
          {
            id: DEMO_NON_REASONING_MODEL,
            name: "Fable 5",
            provider: "anthropic",
            input: ["text", "image"],
          },
        ],
        currentModelId,
      });
    case "get_state":
      return response("get_state", {
        model: { id: currentModelId, name: currentModelId, provider: "openrouter" },
        thinkingLevel: currentThinkingLevel,
        isStreaming: false,
        isCompacting: false,
        sessionId: DEMO_SESSION_ID,
      });
    case "set_thinking_level": {
      const requested = String(command.level) as typeof currentThinkingLevel;
      // Mirror real pi: non-reasoning models only accept "off"; everything
      // else is accepted verbatim (the real binary clamps via
      // thinkingLevelMap, but the wire shape is identical).
      const nonReasoning = currentModelId === DEMO_NON_REASONING_MODEL;
      const effective = nonReasoning && requested !== "off" ? "off" : requested;
      currentThinkingLevel = effective;
      // Emit the change so the dropdown re-syncs (and a coercion toast fires
      // when the requested level didn't match the effective one).
      emitEvent({ type: "thinking_level_changed", level: effective });
      return response("set_thinking_level");
    }
    case "set_model": {
      const modelId = String(command.modelId);
      currentModelId = modelId;
      // Switching to a non-reasoning model coerces the thinking level to "off"
      // the same way the real binary does.
      if (modelId === DEMO_NON_REASONING_MODEL && currentThinkingLevel !== "off") {
        currentThinkingLevel = "off";
        emitEvent({ type: "thinking_level_changed", level: "off" });
      }
      return response("set_model");
    }
    case "get_session_stats":
      return response("get_session_stats", {
        sessionId: DEMO_SESSION_ID,
        tokens: { input: 3200, output: 290, cacheRead: 2200, cacheWrite: 0, total: 5690 },
        cost: 0.0004,
        contextUsage: { tokens: 5400, contextWindow: 1_000_000, percent: 0.5 },
      });
    default:
      return response(type);
  }
}

const settingsState = {
  piBinaryPath: null as string | null,
  fonts: {
    display: { family: "system-ui", sizePx: 14 },
    code: { family: "monospace", sizePx: 13 },
  },
  recentWorkspaces: [DEMO_WORKSPACE],
  lastUsedModel: null,
  colorScheme: "mocha" as const,
  window: undefined,
};

const stub = {
  invoke: async (channel: string, req?: unknown) => {
    switch (channel) {
      case "pi.locate":
        return { path: "/usr/local/bin/pi", version: "1.0.0-stub" };
      case "settings.get":
        return settingsState;
      case "settings.set":
        Object.assign(settingsState, req as Record<string, unknown>);
        return settingsState;
      case "workspace.recents":
        return [DEMO_WORKSPACE];
      case "workspace.remove": {
        const { workspacePath } = req as { workspacePath: string };
        settingsState.recentWorkspaces = settingsState.recentWorkspaces.filter(
          (w) => w !== workspacePath,
        );
        return settingsState.recentWorkspaces;
      }
      case "workspace.listSessions":
        return [];
      case "session.loadHistory":
        return [];
      case "session.open":
        return { sessionId: `demo-${Date.now()}` as SessionId, name: null };
      case "session.activate": {
        const { sessionId } = req as { sessionId: SessionId };
        setTimeout(() => emit("session.statusChanged", { sessionId, status: "ready" }), 50);
        return undefined;
      }
      case "session.close":
        return undefined;
      case "session.sendCommand":
        return handleSendCommand(req);
      case "app.versions":
        return { app: "0.1.0-preview", electron: "stub", node: "stub" };

      // ── Auth stubs ──────────────────────────────────────────────
      case "auth.status":
        return [
          {
            key: "openrouter",
            displayName: "OpenRouter",
            source: "none",
            envVar: "OPENROUTER_API_KEY",
          },
          {
            key: "anthropic",
            displayName: "Anthropic",
            source: "none",
            envVar: "ANTHROPIC_API_KEY",
            supportsOAuth: true,
          },
          {
            key: "openai",
            displayName: "OpenAI",
            source: "environment",
            envVar: "OPENAI_API_KEY",
            supportsOAuth: true,
          },
          {
            key: "deepseek",
            displayName: "DeepSeek",
            source: "api_key",
            envVar: "DEEPSEEK_API_KEY",
          },
          { key: "google", displayName: "Google", source: "none", envVar: "GEMINI_API_KEY" },
        ];
      case "auth.saveApiKey":
        return { ok: true };
      case "auth.remove":
        return { ok: true };

      // ── PTY stubs (no-op) ──────────────────────────────────────
      case "pty.start":
        return { ptyId: "stub-pty" };
      case "pty.write":
        return undefined;
      case "pty.resize":
        return undefined;
      case "pty.kill":
        return undefined;

      // ── Git stubs ───────────────────────────────────────────────
      case "git.changes":
        return {
          kind: "ok",
          repoRoot: "/Users/dev/pi-vis",
          truncated: false,
          files: [
            {
              path: "src/app/config-loader.ts",
              status: "M",
              untracked: false,
              insertions: 12,
              deletions: 3,
              binary: false,
            },
            {
              path: "src/app/new-module.ts",
              status: "A",
              untracked: true,
              insertions: 8,
              deletions: 0,
              binary: false,
            },
          ],
        };
      case "git.fileDiff":
        return {
          kind: "ok",
          oldText: "export const config = {\n  retries: 1,\n};\n",
          newText: "export const config = {\n  retries: 3,\n  timeout: 5000,\n};\n",
          binary: false,
          tooLarge: false,
          oldMissingNewline: false,
          newMissingNewline: false,
        };
      case "git.branches":
        return {
          kind: "ok",
          current: "main",
          branches: [
            { name: "main", remote: false, current: true },
            { name: "feature/config-loader", remote: false, current: false },
            { name: "feature/auth-redesign", remote: false, current: false },
            { name: "chore/deps", remote: false, current: false },
            { name: "origin/main", remote: true, current: false },
            { name: "origin/develop", remote: true, current: false },
          ],
        };

      // ── Update stubs ────────────────────────────────────────────
      case "update.check":
        return {
          pi: { current: "0.79.3", latest: "0.80.0", updateAvailable: true },
          extensions: [
            {
              source: "npm:@pi/mcp",
              name: "@pi/mcp",
              current: "1.2.0",
              latest: "1.3.0",
              updateAvailable: true,
              kind: "npm",
            },
            {
              source: "npm:@pi/fs",
              name: "@pi/fs",
              current: "0.5.1",
              latest: "0.5.1",
              updateAvailable: false,
              kind: "npm",
            },
            {
              source: "local:../../src/pi-architect",
              name: "pi-architect",
              current: "0.2.0",
              latest: undefined,
              updateAvailable: false,
              kind: "local",
            },
            {
              source: "git:github.com/user/mcp-extra",
              name: "mcp-extra",
              current: undefined,
              latest: undefined,
              updateAvailable: false,
              kind: "git",
            },
          ],
          checkedAt: Date.now(),
        };
      case "update.run":
        return { runId: "stub-run" };

      default:
        return undefined;
    }
  },
  on: (channel: string, cb: Listener) => {
    let subs = listeners.get(channel);
    if (!subs) {
      subs = new Set();
      listeners.set(channel, subs);
    }
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  },
};

(window as unknown as { pivis: typeof stub }).pivis = stub;

seedDemoSession();
