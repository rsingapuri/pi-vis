import type { SessionId } from "@shared/ids.js";
import { type PiRpcCommand, commandPolicy } from "@shared/pi-protocol/commands.js";
import type { AgentSessionSnapshot } from "@shared/pi-protocol/runtime-state.js";
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
let currentThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" = "off";
let customEntryRendererAvailable = true;
let customEntryRendererVersion = 1;

const PREVIEW_HOST_ID = "00000000-0000-4000-8000-000000000001";
const previewRuntime = new Map<
  SessionId,
  { isStreaming: boolean; sessionEpoch: number; snapshotSequence: number }
>();

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

// Test/preview hooks (NOT part of the real IPC contract). Render tests use
// these to drive deterministic streaming + observe panel input without a
// real pi. They are attached to window.__pivisPreview and are a no-op for
// real Electron builds (preview-stub only loads in dev:renderer).
const previewHooks = {
  /** Count of session interrupt requests dispatched to the stub. */
  abortCalls: 0,
  /** Log of every panel input string sent to `session.panelInput`. */
  panelInputLog: [] as string[],
  /** Grid reports from panel sizing, used by overflow convergence tests. */
  panelResizeLog: [] as Array<{
    panelId: number | undefined;
    cols: number | undefined;
    rows: number | undefined;
  }>,
  /** Open a unified panel on demand for focus-ownership regression tests. */
  openUnifiedPanel(): void {
    const activeId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
    emit("session.panelEvent", {
      sessionId: activeId,
      event: { type: "panel_open", panelId: 2, overlay: false, unified: true },
    });
    emit("session.panelEvent", {
      sessionId: activeId,
      event: {
        type: "panel_data",
        panelId: 2,
        data: "\x1b[2J\x1b[H▸ Focus-safe panel\r\n  ready",
      },
    });
  },
  /** Emit a differential update without replacing the current unified frame. */
  emitUnifiedPanelUpdate(): void {
    const rec = panelFrames.get(2);
    if (!rec) return;
    emit("session.panelEvent", {
      sessionId: rec.sessionId,
      event: {
        type: "panel_data",
        panelId: 2,
        data: "\x1b[?2026h\x1b[s\x1b[H\x1b[2K▸ panel update\x1b[u\x1b[?2026l",
      },
    });
  },
  /** Begin a fake turn on the active session. */
  startStreaming(): void {
    const activeId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
    emitRuntimeState(activeId, true);
    emit("session.events", { sessionId: activeId, events: [{ type: "agent_start" }] });
  },
  /** End a fake turn on the active session. */
  stopStreaming(): void {
    const activeId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
    emit("session.events", { sessionId: activeId, events: [{ type: "agent_end" }] });
    emitRuntimeState(activeId, false);
  },
  /** Replace the fake runtime so render tests can exercise `/reload` semantics. */
  replaceCustomEntryRuntime(available: boolean, version = customEntryRendererVersion): void {
    customEntryRendererAvailable = available;
    customEntryRendererVersion = version;
    const activeId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
    const runtime = previewRuntime.get(activeId) ?? {
      isStreaming: false,
      sessionEpoch: 0,
      snapshotSequence: 0,
    };
    runtime.sessionEpoch++;
    runtime.snapshotSequence = 0;
    previewRuntime.set(activeId, runtime);
    useSessionsStore.getState().setSessionStatus(activeId, "starting");
    emitRuntimeState(activeId, runtime.isStreaming);
    useSessionsStore.getState().setSessionStatus(activeId, "ready");
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
type PanelFrame = string | ((rows: number) => string);
const panelFrames = new Map<number, { sessionId: unknown; frame: PanelFrame }>();
function registerPanelFrame(sessionId: unknown, panelId: number, frame: PanelFrame): void {
  panelFrames.set(panelId, { sessionId, frame });
}

// The kitty keyboard handshake the real host writes in HostTerminal.start()
// AND re-writes on a force resize (renegotiate — see keyboard-protocol.mjs):
// bracketed paste + push flags 7 + query + DA sentinel. xterm 6.1 (with
// vtExtensions.kittyKeyboard) answers it over onData → session.panelInput.
// Emitted on unified panel open, and RE-emitted on a force:true panelResize —
// without the re-emit a remounted xterm never sees the push, because the
// unified replay buffer trims everything before the frame's `\x1b[2J`.
const KITTY_HANDSHAKE = "\x1b[?2004h\x1b[>7u\x1b[?u\x1b[c";

function emitEvent(event: Record<string, unknown>): void {
  const sessionId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
  emit("session.events", { sessionId, events: [event] });
}

function emitRuntimeState(sessionId: SessionId, isStreaming: boolean): void {
  const runtime = previewRuntime.get(sessionId) ?? {
    isStreaming: false,
    sessionEpoch: 0,
    snapshotSequence: 0,
  };
  runtime.isStreaming = isStreaming;
  runtime.snapshotSequence++;
  previewRuntime.set(sessionId, runtime);
  const snapshot: AgentSessionSnapshot = {
    hostInstanceId: PREVIEW_HOST_ID,
    sessionEpoch: runtime.sessionEpoch,
    snapshotSequence: runtime.snapshotSequence,
    capturedAt: Date.now(),
    isStreaming,
    isIdle: !isStreaming,
    isCompacting: false,
    isRetrying: false,
    retryAttempt: 0,
    isBashRunning: false,
    model: { id: currentModelId, provider: "openrouter" },
    thinkingLevel: currentThinkingLevel,
    sessionId,
    pendingMessageCount: 0,
    steering: [],
    followUp: [],
    hostFacts: {
      submitting: false,
      actualCompaction: false,
      navigation: false,
      pendingDialogs: 0,
      custodyCount: 0,
    },
    catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
    editor: { revision: 0, text: "", attachments: [] },
  };
  const state = {
    availability: "available" as const,
    hostInstanceId: PREVIEW_HOST_ID,
    sessionEpoch: runtime.sessionEpoch,
    receivedAt: Date.now(),
    snapshot,
  };
  // Preview installs before React subscribes to IPC events. Apply directly as
  // well as emitting so first-render command surfaces have an identity.
  useSessionsStore.getState().applyRuntimeState(sessionId, state);
  emit("session.runtimeState", { sessionId, state });
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
  emitRuntimeState(DEMO_SESSION_ID, false);

  store.seedHistory(DEMO_SESSION_ID, {
    blocks: [
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
    ],
    startIndex: 0,
    total: 10,
  });

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

let streamGeneration = 0;

function cancelPreviewStream(): void {
  streamGeneration++;
}

async function streamPromptResponse(message: string): Promise<void> {
  const generation = ++streamGeneration;
  const cancelled = () => generation !== streamGeneration;
  const sessionId = useSessionsStore.getState().activeSessionId ?? DEMO_SESSION_ID;
  emitRuntimeState(sessionId, true);
  // Simulate the latency before pi's agent_start arrives
  await sleep(600);
  if (cancelled()) return;
  emitEvent({ type: "agent_start" });
  emitEvent({ type: "turn_start" });
  emitEvent({ type: "message_start", message: { role: "assistant" } });

  const thinking = `The user said "${message}". I'll think about that for a moment before answering, long enough that the italic thinking style is visible while streaming.`;
  for (const delta of chunk(thinking, 18)) {
    if (cancelled()) return;
    emitEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta },
    });
    await sleep(40);
  }
  if (cancelled()) return;

  const text = `You said: **${message}**\n\nThis is a streamed preview response with enough text to scroll the transcript and demonstrate that the view stays pinned to the bottom while content flows in — unless you scroll up, in which case it stays put.\n\nHere is a list to take up vertical space:\n\n${Array.from({ length: 8 }, (_, i) => `- streamed list item ${i + 1}`).join("\n")}`;
  for (const delta of chunk(text, 14)) {
    if (cancelled()) return;
    emitEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta },
    });
    await sleep(30);
  }
  if (cancelled()) return;
  emitEvent({ type: "message_end", message: { role: "assistant" } });

  // A tool call so the running spinner + live tail are visible
  if (cancelled()) return;
  emitEvent({
    type: "tool_execution_start",
    toolCallId: "live-1",
    toolName: "bash",
    args: { command: "npm run build" },
  });
  for (let i = 1; i <= 8; i++) {
    if (cancelled()) return;
    emitEvent({
      type: "tool_execution_update",
      toolCallId: "live-1",
      toolName: "bash",
      args: { command: "npm run build" },
      partialResult: `[build] step ${i} of 8 complete\n`,
    });
    await sleep(150);
  }
  if (cancelled()) return;
  emitEvent({
    type: "tool_execution_end",
    toolCallId: "live-1",
    toolName: "bash",
    result: null,
    isError: false,
  });

  if (cancelled()) return;
  emitEvent({ type: "message_start", message: { role: "assistant" } });
  for (const delta of chunk("Done — that was the whole demo turn.", 12)) {
    if (cancelled()) return;
    emitEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta },
    });
    await sleep(40);
  }
  if (cancelled()) return;
  emitEvent({ type: "message_end", message: { role: "assistant" } });
  emitEvent({ type: "turn_end" });
  emitEvent({ type: "agent_end" });
  emitRuntimeState(sessionId, false);
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
            thinkingLevelMap: { xhigh: "xhigh", max: "max" },
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
    case "get_cache_miss_notices":
      return response("get_cache_miss_notices", { notices: [] });
    case "render_entry": {
      if (!customEntryRendererAvailable) {
        return { type: "response", command: "render_entry", success: false, error: "Unsupported" };
      }
      const expanded = command.expanded === true;
      const cols = Number(command.cols ?? 80);
      const detail = expanded ? `\n\u001b[2mRendered responsively at ${cols} columns\u001b[0m` : "";
      return response("render_entry", {
        rendered: true,
        ansi: `\u001b[1;35mIndexed files\u001b[0m: 17 (renderer v${customEntryRendererVersion})${detail}`,
      });
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
  lightColorScheme: "latte",
  darkColorScheme: "mocha",
  themeMode: "system" as "light" | "dark" | "system",
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
        return {
          status: "loaded",
          historyGeneration: (req as { historyGeneration: number }).historyGeneration,
          page: { blocks: [], startIndex: 0, total: 0 },
        };
      case "session.open":
        return {
          outcome: "opened",
          sessionId: `demo-${Date.now()}` as SessionId,
          name: null,
          preview: null,
          sessionStatus: "cold",
        };
      case "session.activate": {
        const { sessionId } = req as { sessionId: SessionId };
        setTimeout(() => {
          emit("session.statusChanged", { sessionId, status: "ready" });
          emitRuntimeState(sessionId, false);
        }, 50);
        return undefined;
      }
      case "session.claimUnifiedSubmit":
        return {
          claimed: true,
          claimId: `preview-claim-${Date.now()}`,
          expiresAt: Date.now() + 60_000,
        };
      case "session.runtimeResync":
      case "session.rendererAttach": {
        const { sessionId } = req as { sessionId: SessionId };
        const session = useSessionsStore.getState().sessions.get(sessionId);
        return {
          availability: session?.runtimeSnapshot ? "available" : "unavailable",
          hostInstanceId: session?.hostInstanceId,
          sessionEpoch: session?.sessionEpoch,
          receivedAt: Date.now(),
          snapshot: session?.runtimeSnapshot,
        };
      }
      case "session.prepareClose":
        return { reviewToken: `preview-close-${Date.now()}`, checkpoint: {} };
      case "session.cancelClose":
        return { cancelled: true };
      case "session.confirmClose":
        return { closed: true };
      case "session.acknowledgeRestoration":
        return { acknowledged: true };
      case "session.editorPatch": {
        const patch = req as {
          revision: number;
          text: string;
          attachments: unknown[];
        };
        return {
          accepted: true,
          revision: patch.revision,
          text: patch.text,
          attachments: patch.attachments,
        };
      }
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
      case "session.sendCommand": {
        const request = req as {
          requestId: string;
          intentId?: string;
          command: PiRpcCommand;
          expectedHostInstanceId: string;
          expectedSessionEpoch: number;
        };
        const raw = (await handleSendCommand(req)) as Record<string, unknown>;
        return {
          ...raw,
          requestId: request.requestId,
          ...(request.intentId ? { intentId: request.intentId } : {}),
          commandType: request.command.type,
          commandClass: commandPolicy(request.command).class,
          hostInstanceId: request.expectedHostInstanceId,
          sessionEpoch: request.expectedSessionEpoch,
          disposition: "completed",
        };
      }
      case "session.escape": {
        const { sessionId, requestId } = req as { sessionId: SessionId; requestId: string };
        previewHooks.abortCalls++;
        cancelPreviewStream();
        emit("session.events", { sessionId, events: [{ type: "agent_end" }] });
        emitRuntimeState(sessionId, false);
        return {
          requestId,
          hostInstanceId: PREVIEW_HOST_ID,
          sessionEpoch: 0,
          disposition: "abort_requested",
          target: "streaming",
        };
      }
      // Unified-TUI panel I/O (UnifiedTuiHost calls these). No-op in the stub —
      // the panel is driven by emitted panel_events, not round-tripped.
      case "session.panelInput": {
        const input = req as { data?: unknown; sequence?: number };
        previewHooks.panelInputLog.push(String(input.data ?? ""));
        return { acknowledgedThrough: input.sequence ?? 0 };
      }
      case "session.panelResize": {
        // Mirror the host's fullRender-on-resize: re-emit the panel's frame so
        // the content re-lays-out top-anchored into the new grid (see
        // registerPanelFrame). Async (next tick) to match the host's frame and
        // avoid re-entering the sizer mid-pass.
        const { panelId, force, rows } = req as {
          panelId?: number;
          force?: boolean;
          rows?: number;
        };
        previewHooks.panelResizeLog.push({ panelId, cols: (req as { cols?: number }).cols, rows });
        const rec = panelId !== undefined ? panelFrames.get(panelId) : undefined;
        if (rec) {
          setTimeout(() => {
            // A force resize = a freshly-(re)mounted xterm with no negotiated
            // modes. Mirror the real host's renegotiate(): re-push the kitty
            // handshake BEFORE the frame so xterm answers it (the replay buffer
            // trimmed the open-time push at the frame's hard clear).
            if (force === true) {
              emit("session.panelEvent", {
                sessionId: rec.sessionId,
                event: { type: "panel_data", panelId, data: KITTY_HANDSHAKE },
              });
            }
            const frame =
              typeof rec.frame === "function" ? rec.frame(Math.max(1, rows ?? 24)) : rec.frame;
            emit("session.panelEvent", {
              sessionId: rec.sessionId,
              event: { type: "panel_data", panelId, data: frame },
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
        return { kind: "ok", fileCount: 2, truncated: false };
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

function seedCustomEntryPreview(): void {
  setTimeout(() => {
    const store = useSessionsStore.getState();
    store.applyEvent(store.activeSessionId ?? DEMO_SESSION_ID, {
      type: "entry_appended",
      entry: {
        id: "preview-custom-entry",
        type: "custom",
        customType: "status-card",
        data: { title: "Indexed files", count: 17 },
      },
    });
  }, 600);
}

if (new URLSearchParams(window.location.search).get("customEntry") === "1") {
  seedCustomEntryPreview();
}

// ── Unified-TUI panel preview (factory setWidget) ────────────────────────
// Enable with ?unified=1 on the preview URL. Emits the panel_open{unified}
// + panel_data events an extension's factory setWidget produces, so the real
// UnifiedTuiHost → xterm.js pipeline can be render-tested in a headless
// browser (see tests/render/unified-panel.spec.ts). Delayed so the App's
// session.panelEvent subscription is mounted before the first emit.
function startUnifiedPanelPreview(): void {
  const PANEL_ID = 2;
  // `?unified=tall` emits a roster taller than the display cap;
  // `?unified=oversized` exceeds the old viewport-sized grid ceiling;
  // `?unified=scrollback-alignment`, `?unified=boundary`, and
  // `?unified=above-boundary` exercise 1,025, 2,048, and 2,050 intrinsic rows;
  // `?unified=expanding` mimics a widget whose render height follows the rows
  // reported by the terminal; `?unified=expanding-transition` then changes that
  // widget to tall intrinsic content. `?unified=1` keeps the short roster. Use \r\n so
  // each line carriage-returns (xterm's default convertEol is off) — mirrors the
  // real host's cursor-positioned ANSI rather than the bare-\n preview artifact.
  const unifiedParam = new URLSearchParams(window.location.search).get("unified");
  const tall = unifiedParam === "tall";
  const transitioning = unifiedParam === "expanding-transition";
  const boundaryRows =
    unifiedParam === "scrollback-alignment"
      ? 1025
      : unifiedParam === "boundary"
        ? 2048
        : unifiedParam === "above-boundary"
          ? 2050
          : null;
  const oversized = unifiedParam === "oversized" || transitioning;
  const expandingOffset =
    unifiedParam === "expanding-offset" || unifiedParam === "expanding-offset-blank";
  const expandingBlank =
    unifiedParam === "expanding-blank" || unifiedParam === "expanding-offset-blank";
  const expanding =
    unifiedParam === "expanding" || expandingOffset || expandingBlank || transitioning;
  // `?unified=overlay` simulates an extension showing a pi-tui overlay (the
  // pi-subagents "inspect" box): after the panel opens, the host sends
  // panel_mode:viewport + a SMALL box frame. The renderer must pin a fixed grid
  // (the display cap), not hug the box — that pin is the wiggle fix.
  const overlay = unifiedParam === "overlay";
  const lines = boundaryRows
    ? [
        `▸ Boundary roster (${boundaryRows} rows)`,
        ...Array.from(
          { length: boundaryRows - 2 },
          (_, i) => `  boundary row ${String(i + 2).padStart(4, "0")}`,
        ),
        `  END OF ${boundaryRows}-ROW ROSTER`,
      ]
    : oversized
      ? [
          "▸ Fleet (160 agents)      ↓/↑ navigate · Enter open",
          ...Array.from(
            { length: 160 },
            (_, i) => `  ● agent-${String(i + 1).padStart(3, "0")}   running   ${i + 1} turns`,
          ),
          "  END OF OVERSIZED ROSTER",
        ]
      : tall
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
  const fullFrame = (frameLines: string[]): string =>
    `\x1b[2J\x1b[H\x1b[3J${frameLines.join("\r\n")}`;
  const roster = fullFrame(lines);
  const expandingFrame = (rows: number, extraRows = 0, trailingBlank = false): string =>
    fullFrame([
      "▸ Adaptive viewport",
      ...Array.from(
        { length: Math.max(0, rows + extraRows - 2) },
        (_, i) => `  viewport row ${String(i + 2).padStart(3, "0")}`,
      ),
      trailingBlank ? "" : "  END OF ADAPTIVE VIEWPORT",
    ]);
  const activeExpandingFrame = (rows: number): string =>
    expandingFrame(rows, expandingOffset ? 1 : 0, expandingBlank);
  const initialFrame = expanding ? activeExpandingFrame(24) : roster;
  let transitionRepaints = 0;
  const transitionFrame = (rows: number): string => {
    transitionRepaints++;
    return transitionRepaints === 1 ? activeExpandingFrame(rows) : roster;
  };
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
    // Push the Kitty keyboard handshake the way the real host does in
    // HostTerminal.start(). xterm 6.1 — served here with
    // vtExtensions.kittyKeyboard — ANSWERS it over panelInput, and encodes
    // modified keys as CSI-u. This lets the render suite prove the xterm-6.1
    // behavior in isolation from host logic. (Re-pushed on force resize in the
    // session.panelResize case above, mirroring the host's renegotiate().)
    emit("session.panelEvent", {
      sessionId: activeId,
      event: { type: "panel_data", panelId: PANEL_ID, data: KITTY_HANDSHAKE },
    });
    emit("session.panelEvent", {
      sessionId: activeId,
      event: { type: "panel_data", panelId: PANEL_ID, data: initialFrame },
    });
    registerPanelFrame(
      activeId,
      PANEL_ID,
      transitioning ? transitionFrame : expanding ? activeExpandingFrame : roster,
    );
    if (overlay) {
      // Show a pi-tui overlay: switch to viewport mode, then paint a small box.
      const box = fullFrame(["┌─ inspect ─┐", "│ agent-01  │", "└───────────┘"]);
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
  [
    "1",
    "tall",
    "oversized",
    "scrollback-alignment",
    "boundary",
    "above-boundary",
    "expanding",
    "expanding-offset",
    "expanding-blank",
    "expanding-offset-blank",
    "expanding-transition",
    "overlay",
  ].includes(new URLSearchParams(window.location.search).get("unified") ?? "")
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
