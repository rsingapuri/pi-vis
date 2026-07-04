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

// Test/preview hooks (NOT part of the real IPC contract). Render tests use
// these to drive deterministic streaming + observe panel input without a
// real pi. They are attached to window.__pivisPreview and are a no-op for
// real Electron builds (preview-stub only loads in dev:renderer).
const previewHooks = {
  /** Count of `abort` commands dispatched to the stub. */
  abortCalls: 0,
  /** Log of every panel input string sent to `session.panelInput`. */
  panelInputLog: [] as string[],
  /** Begin a fake turn (agent_start) on the active session. */
  startStreaming(): void {
    const activeId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
    emit("session.event", { sessionId: activeId, event: { type: "agent_start" } });
  },
  /** End a fake turn (final agent_end) on the active session. */
  stopStreaming(): void {
    const activeId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
    emit("session.event", { sessionId: activeId, event: { type: "agent_end" } });
  },
};
// Attach to window for render-test access (guarded for type safety).
(window as unknown as { __pivisPreview?: typeof previewHooks }).__pivisPreview = previewHooks;
// Expose the store for render-test introspection (NOT part of the real
// IPC contract).
(window as unknown as { __pivisStore?: typeof useSessionsStore }).__pivisStore = useSessionsStore;

function emit(channel: string, payload: unknown): void {
  const subs = listeners.get(channel);
  if (!subs) return;
  for (const cb of subs) cb(payload);
}

// Faithful mimic of the real host's fullRender(true)-on-resize: the host
// re-lays-out and re-emits its frame (clearing scrollback) whenever the grid
// changes, so content never gets stranded in scrollback. The stub records each
// panel's latest frame and re-emits it on session.panelResize, so the
// content-tracking sizer (createPanelSizer) converges deterministically here
// too. Without this the stub bottom-anchors a too-tall write into xterm
// scrollback and never recovers — a stub-only artifact that cannot happen
// against a real host (which clears scrollback every resize).
const panelFrames = new Map<number, { sessionId: unknown; frame: string }>();
function registerPanelFrame(sessionId: unknown, panelId: number, frame: string): void {
  panelFrames.set(panelId, { sessionId, frame });
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
      type: "compaction",
      data: {
        summary:
          "Summarized the earlier config-loader investigation, the path resolution bug, and the planned validation steps so the active context can stay focused on the implementation.",
        reason: "threshold",
        tokensBefore: 12840,
      },
    },
    {
      id: "demo-8",
      type: "custom_message",
      data: {
        content:
          "**Session Info**\n\nName: Config loader fix\nFile: ~/.pi/agent/sessions/demo.jsonl\nID: demo-session",
      },
    },
    {
      id: "demo-9",
      type: "assistant",
      data: {
        content: [
          "Fixed. The loader was using `path.join`, which keeps relative roots relative — `path.resolve` anchors them to the process cwd.",
          "",
          "### 1. `src/renderer/src/components/transcript/TranscriptView.tsx` — long path",
          "",
          "The change lives in `src/renderer/src/components/transcript/TranscriptView.tsx` near `MAX_PRE_COMPACTION_KEEP`, an intentionally long unbreakable identifier used to test wrapping.",
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
      id: "demo-10",
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
      previewHooks.abortCalls++;
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
    case "get_tree": {
      // Demo tree mirroring the real bridge's getTree() output. Deliberately
      // realistic so design iteration exercises the things that bit the first
      // implementation:
      //   • Settings entries (model_change / thinking_level_change /
      //     session_info) at the ROOT — the default filter hides them, and the
      //     messages beneath them must still appear (no subtree pruning).
      //   • A long single-child (linear) chain — must render FLAT, no staircase.
      //   • One genuine branch point (u1 has two assistant children) — only the
      //     branch indents.
      // There is no `tool_call` entry type in pi; tool calls live in assistant
      // content and tool results are `message` entries with role "toolResult".
      const node = (id: string, type: string, extra: object, children: unknown[] = []) => ({
        entry: { id, type, timestamp: "2026-06-26T12:00:00.000Z", ...extra },
        children,
      });
      const msg = (id: string, message: object, children: unknown[] = [], label?: string) => {
        const n = node(id, "message", { message }, children);
        return label ? { ...n, label } : n;
      };
      const tree = [
        node("m1", "model_change", { modelId: "anthropic/claude-opus-4-8" }, [
          node("tl1", "thinking_level_change", { thinkingLevel: "medium" }, [
            node("si1", "session_info", { name: "Auth refactor" }, [
              msg("u1", { role: "user", content: "Fix the config loader." }, [
                // Active branch first is what the real bridge/getBranch order
                // produces; the stub lists both — the flattener sorts the
                // active-leaf branch ahead regardless.
                msg(
                  "a1",
                  {
                    role: "assistant",
                    content: [
                      { type: "text", text: "Looking at the loader now." },
                      {
                        type: "toolCall",
                        id: "tc1",
                        name: "read",
                        arguments: { path: "src/config.ts" },
                      },
                    ],
                  },
                  [
                    msg("tr1", { role: "toolResult", toolCallId: "tc1", content: "…config.ts…" }, [
                      msg("a1d", {
                        role: "assistant",
                        content: [{ type: "text", text: "Fixed it with absolute paths." }],
                      }),
                    ]),
                  ],
                ),
                msg(
                  "a2",
                  {
                    role: "assistant",
                    content: [
                      { type: "text", text: "Let me try relative paths instead." },
                      {
                        type: "toolCall",
                        id: "tc2",
                        name: "read",
                        arguments: { path: "src/paths.ts" },
                      },
                    ],
                  },
                  [
                    msg("tr2", { role: "toolResult", toolCallId: "tc2", content: "…paths.ts…" }, [
                      msg(
                        "a2d",
                        {
                          role: "assistant",
                          content: [{ type: "text", text: "Switching to relative-path strategy." }],
                        },
                        [],
                        "alt-approach",
                      ),
                    ]),
                  ],
                ),
              ]),
            ]),
          ]),
        ]),
      ];
      // Flatten the nested demo tree into the flat wire shape (parentId-
      // keyed) that the real bridge now sends — see FlatTreeNode / the
      // contextBridge nesting-limit fix. The renderer re-nests via
      // buildNestedTree, so this must stay flat here to exercise the real
      // round-trip during standalone browser dev.
      const flat: unknown[] = [];
      const stack: { node: Record<string, unknown>; parentId: string | undefined }[] = [];
      for (let i = tree.length - 1; i >= 0; i--) {
        stack.push({ node: tree[i] as Record<string, unknown>, parentId: undefined });
      }
      while (stack.length > 0) {
        const { node: n, parentId } = stack.pop()!;
        const entry = n["entry"] as { id: string };
        flat.push({
          entry: n["entry"],
          parentId,
          label: n["label"],
          labelTimestamp: n["labelTimestamp"],
        });
        const kids = (n["children"] as Record<string, unknown>[]) ?? [];
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ node: kids[i]!, parentId: entry.id });
        }
      }
      return response("get_tree", { nodes: flat, leafId: "a2d" });
    }
    case "navigate_tree":
      // The preview stub navigates in-place: leaf becomes the target,
      // branch is just the single target entry. The TreeViewer will show
      // a toast and re-render; this is enough for design iteration.
      return response("navigate_tree", {
        cancelled: false,
        editorText: `You picked ${String(command.targetId ?? "")}`,
        leafId:
          command.targetId === undefined || command.targetId === null
            ? null
            : String(command.targetId),
        branch: [],
      });
    case "set_label":
      return response("set_label");
    default:
      return response(type);
  }
}

const settingsState = {
  piBinaryPath: null as string | null,
  piEnv: {} as Record<string, string>,
  fonts: {
    display: { sizePx: 14 },
    code: { family: "monospace", sizePx: 13 },
  },
  workspaceOrder: [DEMO_WORKSPACE],
  expandedWorkspaces: [DEMO_WORKSPACE],
  lastActiveWorkspace: DEMO_WORKSPACE,
  lastUsedModel: null,
  lastUsedThinkingLevel: null,
  colorScheme: "mocha" as const,
  diffMaxFileSizeMiB: 5,
  statusBarVisible: true,
  updateCheckEnabled: true,
  lastDismissedPiVersion: null,
  sidebarWidth: 220,
  sidebarCollapsed: false,
  pinnedSessions: [] as string[],
  archivedSessions: [] as string[],
  worktrees: {},
  diffViewMode: "unified" as "unified" | "split",
  diffIncludeRemoteBranches: false,
  diffRailWidth: 280,
  diffRailVisible: true,
  customPanelHeightFraction: null,
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
      case "themes.listUser":
        return []; // preview has no user-droppable themes; bundled themes apply
      case "themes.userDir":
        return "~/Library/Application Support/pi-vis/themes";

      case "workspace.list":
        return [DEMO_WORKSPACE];
      case "workspace.remove": {
        const { workspacePath } = req as { workspacePath: string };
        settingsState.workspaceOrder = settingsState.workspaceOrder.filter(
          (w) => w !== workspacePath,
        );
        settingsState.expandedWorkspaces = settingsState.expandedWorkspaces.filter(
          (w) => w !== workspacePath,
        );
        return settingsState.workspaceOrder;
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
      case "session.transcriptForEntries":
        // Render a tiny representative transcript so designers can iterate on
        // the TreeViewer UI without writing fixtures. Reuses demo block ids.
        return [
          {
            id: "demo-1",
            type: "user",
            data: {
              role: "user",
              content: "Can you fix the config loader so relative roots resolve correctly?",
            },
          },
          {
            id: "demo-2",
            type: "assistant",
            data: {
              role: "assistant",
              segments: [{ kind: "text", content: "Sure — let me look at the loader first." }],
            },
          },
        ];
      case "session.createWorktree":
        return {
          ok: true,
          worktreePath: "/tmp/stub-worktree/swift-otter",
          branch: "pi-vis-swift-otter",
          name: "swift-otter",
          base: "main",
        };
      case "session.attachWorktree": {
        // Stub: pretend any non-empty pasted path is a valid existing
        // worktree on the same repo, mirroring the real handler's success
        // shape (`base === branch` is the "attached, not cut from anything"
        // sentinel — see the IPC contract doc). The preview renderer's
        // segmented control + path input only need a success path to
        // exercise the UI; the IPC contract is the load-bearing thing.
        const args = req as { path?: string };
        const last = (args.path ?? "").replace(/^.*\//, "") || "swift-otter";
        return {
          ok: true,
          worktreePath: args.path ?? "/tmp/stub-attached/swift-otter",
          branch: last,
          name: last,
          base: last,
        };
      }
      case "worktree.validate":
        return { ok: true, branch: "main", name: "swift-otter" };
      case "worktree.pickDirectory":
        // Stub: pretend the user picked a sibling worktree.
        return "/Users/me/code/my-repo-worktrees/swift-otter";
      case "session.sendCommand":
        return handleSendCommand(req);
      // Unified-TUI panel I/O (UnifiedTuiHost calls these). No-op in the stub —
      // the panel is driven by emitted panel_events, not round-tripped.
      case "session.panelInput":
        previewHooks.panelInputLog.push(String((req as { data?: unknown }).data ?? ""));
        return undefined;
      case "session.panelResize": {
        // Mirror the host's fullRender-on-resize: re-emit the panel's frame so
        // the content re-lays-out top-anchored into the new grid (see
        // registerPanelFrame). Async (next tick) to match the host's frame and
        // avoid re-entering the sizer mid-pass.
        const { panelId } = req as { panelId?: number };
        const rec = panelId !== undefined ? panelFrames.get(panelId) : undefined;
        if (rec) {
          setTimeout(() => {
            emit("session.panelEvent", {
              sessionId: rec.sessionId,
              event: { type: "panel_data", panelId, data: rec.frame },
            });
          }, 0);
        }
        return undefined;
      }
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
          fingerprint: "stub-fingerprint",
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
      case "git.changesCount":
        return { kind: "ok", fileCount: 2 };
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

function seedToolOutputPreview(): void {
  setTimeout(() => {
    const output = Array.from({ length: 180 }, (_, i) => {
      const n = String(i + 1).padStart(3, "0");
      return `preview-line-${n}  ${"0123456789abcdef ".repeat((i % 7) + 1)}done`;
    }).join("\n");
    const longCommand = `node scripts/generate-report.mjs --workspace ${DEMO_WORKSPACE} --include-transcript --format=json --very-long-option=${"value-".repeat(18)}tail`;
    const store = useSessionsStore.getState();
    const sessionId = store.activeSessionId ?? DEMO_SESSION_ID;
    store.applyEvent(sessionId, {
      type: "tool_execution_start",
      toolCallId: "preview-long-tool",
      toolName: "bash",
      args: { command: longCommand },
    });
    store.applyEvent(sessionId, {
      type: "tool_execution_end",
      toolCallId: "preview-long-tool",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: output }],
        details: {
          truncation: {
            truncated: true,
            outputLines: 180,
            totalLines: 4200,
            truncatedBy: "lines",
          },
          fullOutputPath: "/tmp/pi-bash-preview-full-output.log",
        },
      },
      isError: false,
    });
  }, 600);
}

if (new URLSearchParams(window.location.search).get("toolOutput") === "1") {
  seedToolOutputPreview();
}

// ── Unified-TUI panel preview (factory setWidget) ────────────────────────
// Enable with ?unified=1 on the preview URL. Emits the panel_open{unified}
// + panel_data events an extension's factory setWidget produces, so the real
// UnifiedTuiHost → xterm.js pipeline can be render-tested in a headless
// browser (see tests/render/unified-panel.spec.ts). Delayed so the App's
// session.panelEvent subscription is mounted before the first emit.
function startUnifiedPanelPreview(): void {
  const PANEL_ID = 2;
  // `?unified=tall` emits a roster taller than the display cap so the overflow
  // path (card scrolls, top stays reachable) can be exercised; `?unified=1`
  // keeps the short roster the render tests assert on. Use \r\n so each line
  // carriage-returns (xterm's default convertEol is off) — mirrors the real
  // host's cursor-positioned ANSI rather than the bare-\n preview artifact.
  const unifiedParam = new URLSearchParams(window.location.search).get("unified");
  const tall = unifiedParam === "tall";
  // `?unified=overlay` simulates an extension showing a pi-tui overlay (the
  // pi-subagents "inspect" box): after the panel opens, the host sends
  // panel_mode:viewport + a SMALL box frame. The renderer must pin a fixed grid
  // (the display cap), not hug the box — that pin is the wiggle fix.
  const overlay = unifiedParam === "overlay";
  const lines = tall
    ? [
        "▸ Fleet (40 agents)       ↓/↑ navigate · Enter open",
        ...Array.from(
          { length: 40 },
          (_, i) => `  ● agent-${String(i + 1).padStart(2, "0")}   running   ${i + 1} turns`,
        ),
        "",
        "  (unified TUI · type a prompt + Enter)",
      ]
    : [
        "▸ Fleet (2 agents)        ↓/↑ navigate · Enter open",
        "  ● swift-otter    running   3 turns",
        "  ○ brave-falcon   queued    —",
        "",
        "  (unified TUI · type a prompt + Enter)",
      ];
  const roster = `\x1b[2J\x1b[H${lines.join("\r\n")}\r\n`;
  setTimeout(() => {
    // Target whichever session is actually active at emit time. The Sidebar's
    // one-shot boot effect opens a fresh session tab on load (displacing the
    // seeded demo-session-1), so the active id is NOT DEMO_SESSION_ID — emitting
    // for the seeded id would hit a non-active session and the panel would
    // never render (hasUnifiedPanel reads the active session).
    const activeId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
    emit("session.panelEvent", {
      sessionId: activeId,
      event: { type: "panel_open", panelId: PANEL_ID, overlay: false, unified: true },
    });
    emit("session.panelEvent", {
      sessionId: activeId,
      event: { type: "panel_data", panelId: PANEL_ID, data: roster },
    });
    registerPanelFrame(activeId, PANEL_ID, roster);
    if (overlay) {
      // Show a pi-tui overlay: switch to viewport mode, then paint a small box.
      const box = `\x1b[2J\x1b[H${["┌─ inspect ─┐", "│ agent-01  │", "└───────────┘"].join("\r\n")}\r\n`;
      emit("session.panelEvent", {
        sessionId: activeId,
        event: { type: "panel_mode", panelId: PANEL_ID, mode: "viewport" },
      });
      emit("session.panelEvent", {
        sessionId: activeId,
        event: { type: "panel_data", panelId: PANEL_ID, data: box },
      });
      registerPanelFrame(activeId, PANEL_ID, box);
    }
  }, 600);
}

if (
  ["1", "tall", "overlay"].includes(
    new URLSearchParams(window.location.search).get("unified") ?? "",
  )
) {
  startUnifiedPanelPreview();
}

// ── Custom() panel preview (transient overlay) ───────────────────────────
// Enable with ?panel=1. Emits the panel_open (NON-unified) + panel_data a
// `custom()` overlay produces. A custom() panel is a full-frame pi-tui overlay
// (like /rtk's centered config modal), so CustomPanelHost pins it to a STABLE
// viewport box (~half the transcript column) and the overlay self-scrolls inside
// — it does NOT content-hug. This short box exercises exactly that: the panel is
// far taller than the box and does not scroll at the card level. Use \r\n so
// each line carriage-returns.
function startCustomPanelPreview(): void {
  const PANEL_ID = 3;
  const box = [
    "╭─ Pi RTK Optimizer ──────────────────────────╮",
    "│ [ General ]  Compaction   Read & Source     │",
    "│ > ▊                                          │",
    "│ → RTK integration enabled     on            │",
    "│   Rewrite mode                rewrite        │",
    "│   Show rewrite notifications  off            │",
    "╰──── ←/→ tabs · Enter change · Esc close ─────╯",
  ];
  const data = `\x1b[2J\x1b[H${box.join("\r\n")}\r\n`;
  setTimeout(() => {
    const activeId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
    emit("session.panelEvent", {
      sessionId: activeId,
      event: { type: "panel_open", panelId: PANEL_ID, overlay: true, unified: false },
    });
    emit("session.panelEvent", {
      sessionId: activeId,
      event: { type: "panel_data", panelId: PANEL_ID, data },
    });
    registerPanelFrame(activeId, PANEL_ID, data);
  }, 600);
}

if (new URLSearchParams(window.location.search).get("panel") === "1") {
  startCustomPanelPreview();
}
