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
import type { ProjectTrustOption } from "@shared/pi-protocol/commands.js";
import type {
  CancellationData,
  ExportHtmlData,
  ForkMessagesData,
  LastAssistantTextData,
  LogoutProvidersData,
  ModelInfo,
  ScopedModelsData,
  TrustStateData,
} from "@shared/pi-protocol/responses.js";
import { modelDisplayName } from "../model-utils.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";
import type { ComposerAction } from "./types.js";

export interface ExecuteDeps {
  /** Send an RPC and return the response shape. */
  invoke: <T = unknown>(
    channel: string,
    payload: unknown,
  ) => Promise<{ success: boolean; data?: T; error?: string }>;
  /** Surface that submitted this command; host-side extension UI follows it. */
  uiSurface?: "composer" | "unified" | undefined;
  beginPromptInFlight: (sessionId: SessionId) => void;
  endPromptInFlight: (sessionId: SessionId) => void;
  enqueueOptimisticSteer: (sessionId: SessionId, text: string) => string;
  removeOptimisticQueuedMessage: (sessionId: SessionId, id: string) => void;
  /** Add a transient toast notification in the active session. */
  addToast: (
    sessionId: SessionId,
    message: string,
    type?: "info" | "error" | "warning" | "success",
  ) => void;
  /** Optimistically insert a user bubble for plain prompts. */
  addUserMessage: (
    sessionId: SessionId,
    content: string,
    images?: string[],
    opts?: { registerEcho?: boolean },
  ) => void;
  /** Clear an optimistic echo registration when the send failed before pi could echo it. */
  clearPendingUserEcho: (sessionId: SessionId, content: string) => void;
  /** Bash lifecycle: start block, finish with output. */
  addBashCommand: (sessionId: SessionId, command: string) => void;
  finishBashCommand: (sessionId: SessionId, output: string, exitCode?: number) => void;
  /** Apply a model switch end-to-end: optimistic store update, set_model RPC,
   *  get_state reconciliation, and supersession-safe last-used persist. The
   *  single mutation path for the model dropdown — used by /model <search> so
   *  it shares the same reconcile/supersession semantics as the picker. */
  applyModelChange: (
    sessionId: SessionId,
    model: ModelInfo,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Persist a custom_message block (TUI parity for /session). */
  addCustomMessage: (sessionId: SessionId, content: string) => void;
  /** Open the changelog in a modal overlay (for /changelog). */
  openChangelog: (markdown: string) => void;
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
  /** Open the conversation-tree viewer for the active session. */
  openTreeViewer: (sessionId: SessionId) => void;
  /** Put text on the system clipboard. */
  copyToClipboard: (text: string) => Promise<void>;
  /** Look up the session's available models (for the /model picker / exact match). */
  getAvailableModels: (sessionId: SessionId) => ModelInfo[];
  /** Look up/update the session's name (for /name). */
  getSessionName: (sessionId: SessionId) => string | undefined;
  setSessionName: (sessionId: SessionId, name: string) => void;
  /** Look up the session's current model id (for last-used model echo). */
  getCurrentModel: (sessionId: SessionId) => string | undefined;
  /** Whether the session is mid-turn (agent running). Used to send a
   *  `steer` instead of queuing a new `prompt` while the model works. */
  isWorking: (sessionId: SessionId) => boolean;
  /** Look up the active session's workspace path (for /resume). */
  getSessionWorkspacePath: (sessionId: SessionId) => string | undefined;
  /** List sessions in a workspace (for /resume). */
  listSessions: (workspacePath: string) => Promise<SessionSummary[]>;
  /** Called once a fire-and-forget extension prompt eventually reports success. */
  onPromptAccepted?: (sessionId: SessionId) => void;
}

export class InputNotConsumedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputNotConsumedError";
  }
}

export type PickerRequest =
  | { kind: "model"; search?: string }
  | { kind: "fork"; messages: Array<{ entryId: string; text: string }> }
  | { kind: "resume"; sessions: SessionSummary[] }
  | { kind: "scoped-models"; models: ModelInfo[]; enabledIds: string[] | null }
  | {
      kind: "logout";
      providers: Array<{ id: string; name: string; authType: "oauth" | "api_key" }>;
    }
  | {
      kind: "trust";
      cwd: string;
      savedDecision: boolean | null;
      projectTrusted: boolean;
      options: ProjectTrustOption[];
    };

type InvokeEnvelope<T> = { success: boolean; data?: T; error?: string };

function normalizeInvokeResult<T>(raw: unknown): InvokeEnvelope<T> {
  if (
    raw &&
    typeof raw === "object" &&
    typeof (raw as { success?: unknown }).success === "boolean"
  ) {
    return raw as InvokeEnvelope<T>;
  }
  return { success: true, data: raw as T };
}

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
    case "reload":
      await executeReload(sessionId, deps);
      return;
    case "scoped-models":
      await executeScopedModels(sessionId, deps);
      return;
    case "logout":
      await executeLogout(sessionId, deps);
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
    case "trust":
      await executeTrust(sessionId, deps);
      return;
    case "share":
      await executeShare(sessionId, deps);
      return;
    case "changelog":
      await executeChangelog(sessionId, deps);
      return;
    case "open-tree":
      deps.openTreeViewer(sessionId);
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
    // Fire-and-forget: do NOT await the invoke.
    // The composer must not block on a command whose `prompt` response
    // only resolves when its custom panel closes (ctx.ui.custom awaits done()).
    // Events stream back through the session subscription independently.
    // The .catch() is required: without awaiting, a rejected invoke (e.g. the
    // session process died) would otherwise be an unhandled promise rejection.
    deps
      .invoke("session.sendCommand", {
        sessionId,
        command: extensionCommand,
        uiSurface: deps.uiSurface,
      })
      .then((res) => {
        if (res.success) {
          deps.onPromptAccepted?.(sessionId);
        } else {
          deps.addToast(
            sessionId,
            `Extension command failed: ${res.error ?? "Command failed"}`,
            "error",
          );
        }
      })
      .catch((err) => {
        console.error("[execute] extension command failed:", err);
        // P2-a: a dead session / failed send would otherwise vanish silently
        // — the composer swallowed the input (fire-and-forget), so the user
        // gets no feedback that their /mcp / extension invocation did nothing.
        // Surface it as an error toast.
        deps.addToast(
          sessionId,
          `Extension command failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      });
    return;
  }

  // Unknown slash passthrough is intentionally conservative. If the renderer's
  // discovered-command list is stale, an extension/custom UI command can arrive
  // here with `commandSource === undefined` even though pi will handle it as a
  // slash command and may only open UI (no agent_start / user echo). Do NOT add
  // an optimistic text bubble or optimistic streaming for those slash-shaped
  // prompts; let pi's authoritative events decide whether real agent work began.
  const isUnknownSlashPassthrough =
    action.commandSource === undefined && action.text.startsWith("/");

  // If the model is mid-turn, send a `steer` instead of a new `prompt`.
  // A `prompt` sent while busy is queued by pi and only runs after the
  // current turn finishes; `steer` injects the message into the running
  // turn so the user's course correction takes effect immediately. Unknown
  // slash passthrough is excluded for the same reason as above: a stale
  // extension command should not be converted into a steer message.
  const isSteer = !isUnknownSlashPassthrough && deps.isWorking(sessionId);

  // Plain prompts: pi will deliver a user message via the wire (role: "user"
  // message_start) which renders the authoritative text — we still seed the
  // bubble optimistically so the user sees their text instantly. Steers are
  // different: they render as pending queued bubbles until pi's queue_update
  // removes the pending entry and the subsequent user echo appends the single
  // delivered transcript block. Prompt-template / skill / unknown slash sends
  // rely on the wire echo (if any) instead of optimistic transcript text.
  const registeredOptimisticEcho = action.commandSource === undefined && !isUnknownSlashPassthrough;
  if (registeredOptimisticEcho && !isSteer) {
    deps.addUserMessage(
      sessionId,
      action.text,
      action.images?.map((i) => i.dataUrl),
      { registerEcho: !isSteer },
    );
  }

  if (isSteer) {
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
    const optimisticId = deps.enqueueOptimisticSteer(sessionId, action.text);
    let res: { success: boolean; data?: unknown; error?: string };
    try {
      res = await deps.invoke("session.sendCommand", {
        sessionId,
        command: steerCommand,
        uiSurface: deps.uiSurface,
      });
    } catch (err) {
      deps.removeOptimisticQueuedMessage(sessionId, optimisticId);
      const message =
        err instanceof Error ? err.message : `Failed to steer current turn: ${String(err)}`;
      deps.addToast(sessionId, message, "error");
      throw new InputNotConsumedError(message);
    }
    if (!res.success) {
      deps.removeOptimisticQueuedMessage(sessionId, optimisticId);
      const message = res.error ?? "Failed to steer current turn";
      deps.addToast(sessionId, message, "error");
      throw new InputNotConsumedError(message);
    }
    return;
  }

  const trackPromptInFlight = !isUnknownSlashPassthrough;
  if (trackPromptInFlight) deps.beginPromptInFlight(sessionId);
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
  // S1/S2: a rejected prompt (pi guard -> success:false) or a thrown invoke
  // (dead session / closed IPC channel) will never emit agent_start/
  // agent_end, so clear streaming here — otherwise isStreaming sticks true
  // and the working indicator / ESC handler lie. (Success path is still
  // cleared by agent_end in applyEvent.)
  let res: { success: boolean; data?: unknown; error?: string };
  try {
    res = await deps.invoke("session.sendCommand", {
      sessionId,
      command: promptCommand,
      uiSurface: deps.uiSurface,
    });
  } catch (err) {
    if (registeredOptimisticEcho) deps.clearPendingUserEcho(sessionId, action.text);
    const message = err instanceof Error ? err.message : `Failed to send prompt: ${String(err)}`;
    deps.addToast(sessionId, message, "error");
    throw new InputNotConsumedError(message);
  } finally {
    if (trackPromptInFlight) deps.endPromptInFlight(sessionId);
  }
  if (!res.success) {
    if (registeredOptimisticEcho) deps.clearPendingUserEcho(sessionId, action.text);
    const message = res.error ?? "Failed to send prompt";
    deps.addToast(sessionId, message, "error");
    throw new InputNotConsumedError(message);
  }
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
    const candidates = models.map((m) =>
      m.name !== undefined
        ? { id: m.id, provider: m.provider, name: m.name }
        : { id: m.id, provider: m.provider },
    );
    const exact = findExactModelReferenceMatch(action.search, candidates);
    if (exact) {
      // Route through the same mutation path as the picker/dropdown so the
      // slash path gets get_state provider reconciliation and a
      // supersession-safe last-used persist too (mirrors applyModelChange).
      const model: ModelInfo = {
        id: exact.id,
        ...(exact.provider !== undefined ? { provider: exact.provider } : {}),
        ...(exact.name !== undefined ? { name: exact.name } : {}),
      };
      const res = await deps.applyModelChange(sessionId, model);
      if (!res.ok) {
        deps.addToast(sessionId, `Failed to set model: ${res.error ?? "unknown error"}`, "error");
        return;
      }
      deps.addToast(sessionId, `Model: ${modelDisplayName(model)}`);
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
  let res: Awaited<ReturnType<ExecuteDeps["invoke"]>>;
  try {
    res = await deps.invoke("session.sendCommand", {
      sessionId,
      command: { type: "set_session_name", name: action.name },
    });
  } catch (err) {
    deps.addToast(
      sessionId,
      `Failed to set session name: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to set session name", "error");
    return;
  }
  // Pi also emits session_info_changed; this optimistic write keeps the GUI
  // responsive and covers RPC fallback timing where the event can arrive after
  // the response.
  deps.setSessionName(sessionId, action.name);
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

async function executeReload(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  if (deps.isWorking(sessionId)) {
    deps.addToast(
      sessionId,
      "Wait for the current response to finish before reloading.",
      "warning",
    );
    return;
  }
  const res = await deps.invoke("session.reload", { sessionId });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to reload session", "error");
    return;
  }
  deps.addToast(
    sessionId,
    "Reloaded settings, extensions, skills, prompts, and themes.",
    "success",
  );
}

// ── /trust ─────────────────────────────────────────────────────────────
// Mirrors pi's TUI showTrustSelector: fetch the project-trust choice set
// for the session's cwd and open a single-select picker. On selection,
// persist the chosen option's updates via the host's set_trust bridge
// command and reload the session so the new decision takes effect (pi's
// TUI also tells the user "Restart pi for this to take effect.").
//
// /trust only makes sense when the cwd has trust-requiring project-local
// pi resources; otherwise toast and skip (no picker).

async function executeTrust(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const res = await deps.invoke<TrustStateData>("session.sendCommand", {
    sessionId,
    command: { type: "get_trust_state" },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to load trust state", "error");
    return;
  }
  const state = res.data;
  if (!state) {
    deps.addToast(sessionId, "Failed to load trust state", "error");
    return;
  }
  if (!state.hasTrustRequiringResources) {
    deps.addToast(
      sessionId,
      "This workspace has no project-local pi resources that require trust.",
      "info",
    );
    return;
  }
  deps.openPicker(sessionId, {
    kind: "trust",
    cwd: state.cwd,
    savedDecision: state.savedDecision,
    projectTrusted: state.projectTrusted,
    options: state.currentOptions,
  });
}

// ── /share ─────────────────────────────────────────────────────────────
// Mirrors pi's TUI handleShareCommand: export the session to a secret
// GitHub gist (via `gh`) and surface the pi.dev share viewer URL. The gh
// spawn + temp file live in the main process (see share.ts); the renderer
// toasts the URL and copies it to the clipboard. The two gh error cases
// (missing / not logged in) surface with pi's EXACT messages, returned
// verbatim from main.

async function executeShare(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  type ShareResult = {
    ok: boolean;
    url?: string;
    gistUrl?: string;
    error?: string;
  };
  const raw = (await deps.invoke<ShareResult>("session.share", { sessionId })) as unknown;
  // session.share is a non-RPC IPC channel and returns {ok,...} directly from
  // window.pivis.invoke; unit tests may still pass an envelope-shaped fake.
  // Accept both so the command works in the real app and remains easy to test.
  const res = normalizeInvokeResult<ShareResult>(raw);
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to share session", "error");
    return;
  }
  const result = res.data ?? { ok: false };
  if (!result.ok) {
    deps.addToast(sessionId, result.error ?? "Failed to share session", "error");
    return;
  }
  const url = result.url ?? "";
  let clipboardError: string | null = null;
  if (url) {
    try {
      await deps.copyToClipboard(url);
    } catch (err) {
      clipboardError = err instanceof Error ? err.message : String(err);
    }
  }
  // Mirror pi's TUI, which surfaces both the viewer URL and the raw gist
  // URL (so the user has the gist itself for inspection/deletion). Show the
  // URL even when clipboard write fails — sharing already succeeded.
  const gistUrl = result.gistUrl ?? "";
  const message = gistUrl ? `Share URL: ${url}\nGist: ${gistUrl}` : `Share URL: ${url}`;
  deps.addToast(
    sessionId,
    clipboardError ? `${message}\nClipboard copy failed: ${clipboardError}` : message,
    "success",
  );
}

// ── /changelog ─────────────────────────────────────────────────────────
// Mirrors pi's TUI handleChangelogCommand: read pi's shipped CHANGELOG.md
// and render it in a closeable modal overlay (the closest analog to pi's
// in-TUI changelog rendering). The markdown read happens in main
// (pi.changelog IPC) since it reads from the located pi package dir; the
// renderer renders the raw markdown via the existing markdown renderer.

async function executeChangelog(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  type ChangelogResult = { ok: boolean; markdown?: string; error?: string };
  const raw = (await deps.invoke<ChangelogResult>("pi.changelog", undefined)) as unknown;
  // pi.changelog is a non-RPC IPC channel and returns {ok,...} directly from
  // window.pivis.invoke; unit tests may still pass an envelope-shaped fake.
  const res = normalizeInvokeResult<ChangelogResult>(raw);
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to load changelog", "error");
    return;
  }
  const result = res.data ?? { ok: false };
  if (!result.ok) {
    deps.addToast(sessionId, result.error ?? "Failed to load changelog", "error");
    return;
  }
  const markdown = result.markdown ?? "";
  deps.openChangelog(markdown);
}

// ── /scoped-models ─────────────────────────────────────────────────────

async function executeScopedModels(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const res = await deps.invoke<ScopedModelsData>("session.sendCommand", {
    sessionId,
    command: { type: "get_scoped_models" },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to load scoped models", "error");
    return;
  }
  const models = res.data?.models ?? [];
  if (models.length === 0) {
    deps.addToast(sessionId, "No models available", "warning");
    return;
  }
  deps.openPicker(sessionId, {
    kind: "scoped-models",
    models,
    enabledIds: res.data?.enabledIds ?? null,
  });
}

// ── /logout ────────────────────────────────────────────────────────────

async function executeLogout(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const res = await deps.invoke<LogoutProvidersData>("session.sendCommand", {
    sessionId,
    command: { type: "get_logout_providers" },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to list providers", "error");
    return;
  }
  const providers = res.data?.providers ?? [];
  if (providers.length === 0) {
    deps.addToast(
      sessionId,
      "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
      "warning",
    );
    return;
  }
  deps.openPicker(sessionId, { kind: "logout", providers });
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
