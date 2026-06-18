/**
 * executeAction — runs a parsed ComposerAction against injected deps.
 *
 * The split between parser and executor is intentional: parsing is a pure
 * string → union function (trivially unit-testable), execution is a
 * collection of side effects keyed on the action's `kind`. The executor's
 * deps are injected so unit tests can pass a fake invoke/store/clipboard
 * without standing up React or a real `window.pivis`.
 *
 * Action matrix (see WP1 parity table in the PR description):
 *   - "send-prompt"     → invoke prompt RPC; the store handles the optimistic
 *                         user bubble + working spinner.
 *   - "bash"            → addBashCommand → invoke bash → finishBashCommand
 *                         (no transcript echo for the prompt text — TUI
 *                         doesn't add a user bubble for bash either).
 *   - "model"           → exact match → set_model; else open picker (model).
 *   - "name"            → set_session_name; the `session_info_changed`
 *                         event updates the store (TUI parity). For the
 *                         no-arg case we show a usage toast.
 *   - "session-info"    → get_session_stats + get_state → custom_message
 *                         block in the transcript (TUI renders in chat).
 *   - "new-session"     → new_session RPC; the main process emits
 *                         `session.fileChanged` → renderer adopts the file.
 *   - "compact"         → compact RPC (no timeout; pi emits events).
 *   - "export"          → export_html RPC; toast with the path.
 *   - "fork"            → get_fork_messages → open picker (fork).
 *   - "clone"           → clone RPC; fileChanged flow handles adoption.
 *                         pi errors on an empty session — surface as toast,
 *                         no fileChanged on failure.
 *   - "resume"          → workspace.listSessions → open picker (resume).
 *   - "copy"            → get_last_assistant_text → clipboard → toast.
 *                         `text: null` → warning toast.
 *   - "quit"            → closeSessionTab (the renderer-side closeSessionTab
 *                         dispatches `session.close` to main; no RPC needed).
 *   - "open-app-settings" → showSettings(true).
 *   - "unsupported"     → toast "not supported in pi-vis"; the text stays
 *                         in the composer for the user to correct.
 */

import type { SessionId } from "@shared/ids.js";
import type { SessionSummary } from "@shared/ipc-contract.js";
import type {
  CancellationData,
  ExportHtmlData,
  ForkMessagesData,
  LastAssistantTextData,
  ModelInfo,
} from "@shared/pi-protocol/responses.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";
import type { ComposerAction } from "./types.js";

export interface ExecuteDeps {
  /** Send an RPC and return the response shape. */
  invoke: <T = unknown>(
    channel: string,
    payload: unknown,
  ) => Promise<{ success: boolean; data?: T; error?: string }>;
  /** Add a working "..." indicator while a prompt is in flight. */
  setStreaming: (sessionId: SessionId, isStreaming: boolean) => void;
  /** Add a transient toast notification in the active session. */
  addToast: (
    sessionId: SessionId,
    message: string,
    type?: "info" | "error" | "warning" | "success",
  ) => void;
  /** Optimistically insert a user bubble for plain prompts. */
  addUserMessage: (sessionId: SessionId, content: string, images?: string[]) => void;
  /** Bash lifecycle: start block, finish with output. */
  addBashCommand: (sessionId: SessionId, command: string) => void;
  finishBashCommand: (sessionId: SessionId, output: string, exitCode?: number) => void;
  /** Set the active model id in the store (mirrors SessionHeader.handleModelChange). */
  setCurrentModel: (sessionId: SessionId, modelId: string) => void;
  /** Persist last-used model so the next session picks it up. */
  updateLastUsedModel: (provider: string, modelId: string) => Promise<void>;
  /** Persist a custom_message block (TUI parity for /session). */
  addCustomMessage: (sessionId: SessionId, content: string) => void;
  /** Drop a picker request (model/fork/resume). The App renders the host. */
  openPicker: (sessionId: SessionId, picker: PickerRequest) => void;
  /** Adopt a new sessionFile (overrides the only-if-unset guard) and reseed. */
  adoptSessionFile: (
    sessionId: SessionId,
    sessionFile?: string,
    sessionName?: string,
  ) => Promise<void>;
  /** Renderer-side tab close. */
  closeSessionTab: (sessionId: SessionId) => Promise<void>;
  /** Open the app settings panel. */
  openAppSettings: () => void;
  /** Open the login terminal (called via /login command). */
  openLogin: () => void;
  /** Open the diff viewer for the active session. */
  openDiffViewer: (sessionId: SessionId) => void;
  /** Put text on the system clipboard. */
  copyToClipboard: (text: string) => Promise<void>;
  /** Look up the session's available models (for the /model picker / exact match). */
  getAvailableModels: (sessionId: SessionId) => ModelInfo[];
  /** Look up the session's name (for /name no-arg). */
  getSessionName: (sessionId: SessionId) => string | undefined;
  /** Look up the session's current model id (for last-used model echo). */
  getCurrentModel: (sessionId: SessionId) => string | undefined;
  /** Whether the session is mid-turn (agent running). Used to send a
   *  `steer` instead of queuing a new `prompt` while the model works. */
  isStreaming: (sessionId: SessionId) => boolean;
  /** Look up the active session's workspace path (for /resume). */
  getSessionWorkspacePath: (sessionId: SessionId) => string | undefined;
  /** List sessions in a workspace (for /resume). */
  listSessions: (workspacePath: string) => Promise<SessionSummary[]>;
}

export type PickerRequest =
  | { kind: "model"; search?: string }
  | { kind: "fork"; messages: Array<{ entryId: string; text: string }> }
  | { kind: "resume"; sessions: SessionSummary[] };

export async function executeAction(
  sessionId: SessionId,
  action: ComposerAction,
  deps: ExecuteDeps,
): Promise<void> {
  switch (action.kind) {
    case "send-prompt":
      await executeSendPrompt(sessionId, action, deps);
      return;
    case "bash":
      executeBash(sessionId, action, deps);
      return;
    case "model":
      await executeModel(sessionId, action, deps);
      return;
    case "name":
      await executeName(sessionId, action, deps);
      return;
    case "session-info":
      await executeSessionInfo(sessionId, deps);
      return;
    case "new-session":
      await executeNewSession(sessionId, deps);
      return;
    case "compact":
      await executeCompact(sessionId, action, deps);
      return;
    case "export":
      await executeExport(sessionId, action, deps);
      return;
    case "fork":
      await executeFork(sessionId, deps);
      return;
    case "clone":
      await executeClone(sessionId, deps);
      return;
    case "resume":
      await executeResume(sessionId, deps);
      return;
    case "copy":
      await executeCopy(sessionId, deps);
      return;
    case "quit":
      await executeQuit(sessionId, deps);
      return;
    case "open-app-settings":
      deps.openAppSettings();
      return;
    case "open-login":
      deps.openLogin();
      return;
    case "git-diff":
      deps.openDiffViewer(sessionId);
      return;
    case "unsupported":
      deps.addToast(
        sessionId,
        `/${action.name} is not supported in pi-vis — use a terminal session.`,
        "warning",
      );
      return;
    default: {
      // Exhaustiveness: every ComposerAction has a case above. If a new
      // variant is added and forgotten here, the cast surfaces a TS error.
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// ── send-prompt ─────────────────────────────────────────────────────────

async function executeSendPrompt(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "send-prompt" }>,
  deps: ExecuteDeps,
): Promise<void> {
  // Extensions may complete without ever emitting agent_start; skipping the
  // spinner avoids a stuck "Working…" indicator.
  if (action.commandSource === "extension") {
    const extensionCommand: {
      type: "prompt";
      message: string;
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
    } = {
      type: "prompt",
      message: action.text,
    };
    if (action.images && action.images.length > 0) {
      extensionCommand.images = action.images.map((i) => ({
        type: "image" as const,
        data: i.data,
        mimeType: i.mimeType,
      }));
    }
    await deps.invoke("session.sendCommand", {
      sessionId,
      command: extensionCommand,
    });
    return;
  }

  // Plain text + prompt-template / skill / unknown /foo: pi will deliver a
  // user message via the wire (role: "user" message_start) which renders
  // the authoritative text — we still seed the bubble optimistically so
  // the user sees their text instantly.
  if (action.commandSource === undefined) {
    deps.addUserMessage(
      sessionId,
      action.text,
      action.images?.map((i) => i.dataUrl),
    );
  }

  // If the model is mid-turn, send a `steer` instead of a new `prompt`.
  // A `prompt` sent while busy is queued by pi and only runs after the
  // current turn finishes; `steer` injects the message into the running
  // turn so the user's course correction takes effect immediately.
  if (deps.isStreaming(sessionId)) {
    const steerCommand: {
      type: "steer";
      message: string;
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
    } = {
      type: "steer",
      message: action.text,
    };
    if (action.images && action.images.length > 0) {
      steerCommand.images = action.images.map((i) => ({
        type: "image" as const,
        data: i.data,
        mimeType: i.mimeType,
      }));
    }
    await deps.invoke("session.sendCommand", {
      sessionId,
      command: steerCommand,
    });
    return;
  }

  deps.setStreaming(sessionId, true);
  const promptCommand: {
    type: "prompt";
    message: string;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
  } = {
    type: "prompt",
    message: action.text,
  };
  if (action.images && action.images.length > 0) {
    promptCommand.images = action.images.map((i) => ({
      type: "image" as const,
      data: i.data,
      mimeType: i.mimeType,
    }));
  }
  await deps.invoke("session.sendCommand", {
    sessionId,
    command: promptCommand,
  });
  // Streaming cleared by agent_end event (or by the next agent_start);
  // we don't unset here on purpose.
}

// ── bash ────────────────────────────────────────────────────────────────

function executeBash(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "bash" }>,
  deps: ExecuteDeps,
): void {
  deps.addBashCommand(sessionId, action.command);
  void deps
    .invoke<{ output?: string; exitCode?: number }>("session.sendCommand", {
      sessionId,
      command: {
        type: "bash",
        command: action.command,
        excludeFromContext: action.excludeFromContext,
      },
    })
    .then((res) => {
      if (res.success) {
        deps.finishBashCommand(sessionId, res.data?.output ?? "", res.data?.exitCode ?? 0);
      } else {
        deps.finishBashCommand(sessionId, res.error ?? "Command failed", res.data?.exitCode ?? 1);
      }
    })
    .catch((err) => {
      deps.finishBashCommand(sessionId, String(err), 1);
    });
}

// ── /model ──────────────────────────────────────────────────────────────

async function executeModel(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "model" }>,
  deps: ExecuteDeps,
): Promise<void> {
  // TUI parity: a search term is matched exactly (provider/id, id, or unique
  // name); on a hit, set the model directly. On a miss, open the picker
  // with the search prefilled.
  if (action.search) {
    const models = deps.getAvailableModels(sessionId);
    // ModelInfo records can omit `provider` for some legacy shapes; the
    // resolver needs a defined provider. Skip records that lack one.
    const candidates = models
      .filter((m): m is ModelInfo & { provider: string } => typeof m.provider === "string")
      .map((m) =>
        m.name !== undefined
          ? { id: m.id, provider: m.provider, name: m.name }
          : { id: m.id, provider: m.provider },
      );
    const exact = findExactModelReferenceMatch(action.search, candidates);
    if (exact) {
      await deps.invoke("session.sendCommand", {
        sessionId,
        command: { type: "set_model", provider: exact.provider, modelId: exact.id },
      });
      deps.setCurrentModel(sessionId, exact.id);
      await deps.updateLastUsedModel(exact.provider, exact.id);
      deps.addToast(sessionId, `Model: ${exact.id}`);
      return;
    }
  }
  const picker: PickerRequest =
    action.search !== undefined ? { kind: "model", search: action.search } : { kind: "model" };
  deps.openPicker(sessionId, picker);
}

// ── /name ──────────────────────────────────────────────────────────────

async function executeName(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "name" }>,
  deps: ExecuteDeps,
): Promise<void> {
  if (!action.name) {
    const current = deps.getSessionName(sessionId);
    if (current) {
      deps.addToast(sessionId, `Session name: ${current}`);
    } else {
      deps.addToast(sessionId, "Usage: /name <name>", "warning");
    }
    return;
  }
  await deps.invoke("session.sendCommand", {
    sessionId,
    command: { type: "set_session_name", name: action.name },
  });
  // Store updates via session_info_changed event (SessionHeader subscribes).
  deps.addToast(sessionId, `Session name set: ${action.name}`);
}

// ── /session ───────────────────────────────────────────────────────────

async function executeSessionInfo(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  // TUI parity: render in the chat as a custom_message block, not a toast.
  const [statsRes, stateRes] = await Promise.all([
    deps.invoke<Record<string, unknown>>("session.sendCommand", {
      sessionId,
      command: { type: "get_session_stats" },
    }),
    deps.invoke<{ sessionName?: string; sessionFile?: string; sessionId?: string }>(
      "session.sendCommand",
      { sessionId, command: { type: "get_state" } },
    ),
  ]);
  const stats = statsRes.data ?? {};
  const state = stateRes.data ?? {};
  const sessionName = (state.sessionName as string | undefined) ?? deps.getSessionName(sessionId);
  const sessionFile =
    (state.sessionFile as string | undefined) ?? (stats["sessionFile"] as string | undefined);
  const sessionIdStr = (state.sessionId as string | undefined) ?? sessionId;

  const text = formatSessionInfo({ sessionName, sessionFile, sessionId: sessionIdStr, stats });
  deps.addCustomMessage(sessionId, text);
}

// ── /new ───────────────────────────────────────────────────────────────

async function executeNewSession(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const res = await deps.invoke<CancellationData>("session.sendCommand", {
    sessionId,
    command: { type: "new_session" },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to start new session", "error");
    return;
  }
  // Successful new_session → main process re-runs the fileChanged flow
  // (get_state + safeSend("session.fileChanged")). The renderer's
  // adoptSessionFile handles transcript reset + tab re-pointing.
  if (!res.data?.cancelled) {
    deps.addToast(sessionId, "Started a fresh session");
  }
}

// ── /compact ───────────────────────────────────────────────────────────

async function executeCompact(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "compact" }>,
  deps: ExecuteDeps,
): Promise<void> {
  const res = await deps.invoke("session.sendCommand", {
    sessionId,
    command: { type: "compact", customInstructions: action.customInstructions },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to compact", "error");
  }
  // Compaction events (compaction_end) render a block via the transcript
  // reducer; no toast on success — it's noisy if successful.
}

// ── /export ────────────────────────────────────────────────────────────

async function executeExport(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "export" }>,
  deps: ExecuteDeps,
): Promise<void> {
  const res = await deps.invoke<ExportHtmlData>("session.sendCommand", {
    sessionId,
    command: { type: "export_html", outputPath: action.outputPath },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to export session", "error");
    return;
  }
  const path = res.data?.path;
  deps.addToast(sessionId, path ? `Session exported to: ${path}` : "Session exported");
}

// ── /fork ──────────────────────────────────────────────────────────────

async function executeFork(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const res = await deps.invoke<ForkMessagesData>("session.sendCommand", {
    sessionId,
    command: { type: "get_fork_messages" },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to list forkable messages", "error");
    return;
  }
  const messages = res.data?.messages ?? [];
  if (messages.length === 0) {
    deps.addToast(sessionId, "No messages to fork from", "warning");
    return;
  }
  deps.openPicker(sessionId, { kind: "fork", messages });
}

// ── /clone ─────────────────────────────────────────────────────────────

async function executeClone(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const res = await deps.invoke<CancellationData>("session.sendCommand", {
    sessionId,
    command: { type: "clone" },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to clone session", "error");
    return;
  }
  if (!res.data?.cancelled) {
    deps.addToast(sessionId, "Cloned to new session");
  }
}

// ── /resume ────────────────────────────────────────────────────────────

async function executeResume(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const workspacePath = deps.getSessionWorkspacePath(sessionId);
  if (!workspacePath) {
    deps.addToast(sessionId, "No active workspace for resume", "error");
    return;
  }
  const sessions = await deps.listSessions(workspacePath);
  if (sessions.length === 0) {
    deps.addToast(sessionId, "No sessions to resume", "warning");
    return;
  }
  deps.openPicker(sessionId, { kind: "resume", sessions });
}

// ── /copy ──────────────────────────────────────────────────────────────

async function executeCopy(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const res = await deps.invoke<LastAssistantTextData>("session.sendCommand", {
    sessionId,
    command: { type: "get_last_assistant_text" },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to read last assistant text", "error");
    return;
  }
  const text = res.data?.text;
  if (!text) {
    deps.addToast(sessionId, "No agent messages to copy yet.", "warning");
    return;
  }
  try {
    await deps.copyToClipboard(text);
    deps.addToast(sessionId, "Copied last agent message to clipboard");
  } catch (err) {
    deps.addToast(sessionId, err instanceof Error ? err.message : String(err), "error");
  }
}

// ── /quit ──────────────────────────────────────────────────────────────

async function executeQuit(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  await deps.closeSessionTab(sessionId);
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatSessionInfo(args: {
  sessionName: string | undefined;
  sessionFile: string | undefined;
  sessionId: string;
  stats: Record<string, unknown>;
}): string {
  const lines: string[] = ["**Session Info**\n"];
  if (args.sessionName) lines.push(`Name: ${args.sessionName}`);
  lines.push(`File: ${args.sessionFile ?? "In-memory"}`);
  lines.push(`ID: ${args.sessionId}\n`);

  lines.push("**Messages**");
  const statKeys = [
    ["userMessages", "User"],
    ["assistantMessages", "Assistant"],
    ["toolCalls", "Tool Calls"],
    ["toolResults", "Tool Results"],
    ["totalMessages", "Total"],
  ] as const;
  for (const [key, label] of statKeys) {
    if (typeof args.stats[key] === "number") {
      lines.push(`${label}: ${args.stats[key]}`);
    }
  }
  lines.push("");

  const tokens = args.stats["tokens"] as Record<string, number> | undefined;
  if (tokens) {
    lines.push("**Tokens**");
    if (typeof tokens.input === "number") lines.push(`Input: ${tokens.input.toLocaleString()}`);
    if (typeof tokens.output === "number") lines.push(`Output: ${tokens.output.toLocaleString()}`);
    const cacheRead = tokens.cacheRead ?? 0;
    const cacheWrite = tokens.cacheWrite ?? 0;
    if (cacheRead > 0) lines.push(`Cache Read: ${cacheRead.toLocaleString()}`);
    if (cacheWrite > 0) lines.push(`Cache Write: ${cacheWrite.toLocaleString()}`);
    if (typeof tokens.total === "number") lines.push(`Total: ${tokens.total.toLocaleString()}`);
    lines.push("");
  }
  if (typeof args.stats["cost"] === "number" && (args.stats["cost"] as number) > 0) {
    lines.push("**Cost**");
    lines.push(`Total: ${(args.stats["cost"] as number).toFixed(4)}`);
  }
  return lines.join("\n");
}
