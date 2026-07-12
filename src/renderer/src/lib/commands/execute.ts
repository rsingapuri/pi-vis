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
import type { SessionSubmission, SubmissionResult } from "@shared/pi-protocol/runtime-state.js";
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
  submit?: (sessionId: SessionId, submission: SessionSubmission) => Promise<SubmissionResult>;
  getSubmissionContext?: (sessionId: SessionId) =>
    | {
        hostInstanceId: string;
        sessionEpoch: number;
        editorRevision: number;
        userMessageSequence: number;
        intentId?: string | undefined;
      }
    | undefined;
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
    opts?: {
      registerEcho?: boolean;
      clearDraft?: boolean;
      afterUserMessageSequence?: number;
    },
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
    expectedRuntime?: { hostInstanceId: string; sessionEpoch: number },
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
  /** Whether runtime is authoritatively streaming (used only by /reload's UI guard). */
  isWorking: (sessionId: SessionId) => boolean;
  /** Look up the active session's workspace path (for /resume). */
  getSessionWorkspacePath: (sessionId: SessionId) => string | undefined;
  /** List sessions in a workspace (for /resume). */
  listSessions: (workspacePath: string) => Promise<SessionSummary[]>;
}

export class InputNotConsumedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputNotConsumedError";
  }
}

export interface CommandCompletion {
  completionRuntime: { hostInstanceId: string; sessionEpoch: number };
}

export type PickerRequest = (
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
    }
) & {
  /** Runtime that opened the picker; continuations must never rebind after replacement. */
  expectedHostInstanceId?: string;
  expectedSessionEpoch?: number;
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
): Promise<SubmissionResult | CommandCompletion | undefined> {
  switch (action.kind) {
    case "send-prompt":
      return executeSendPrompt(sessionId, action, deps);
    case "bash":
      await executeBash(sessionId, action, deps);
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
      return executeNewSession(sessionId, deps);
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
      return executeClone(sessionId, deps);
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
      return executeReload(sessionId, deps);
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
): Promise<SubmissionResult> {
  const context = deps.getSubmissionContext?.(sessionId);
  if (!deps.submit || !context) {
    const message = "Runtime snapshot is unavailable; input was not submitted.";
    deps.addToast(sessionId, message, "warning");
    throw new InputNotConsumedError(message);
  }
  const submission: SessionSubmission = {
    intentId: context.intentId ?? crypto.randomUUID(),
    expectedHostId: context.hostInstanceId,
    expectedEpoch: context.sessionEpoch,
    editorRevision: context.editorRevision,
    text: action.text,
    images: (action.images ?? []).map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    })),
    // This is a user preference only. The host reads fresh public session
    // state and Pi chooses prompt/steer/follow-up at execution time.
    requestedMode: "steer",
    surface: deps.uiSurface ?? "composer",
  };
  let result: SubmissionResult;
  try {
    result = await deps.submit(sessionId, submission);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.addToast(sessionId, message, "error");
    throw new InputNotConsumedError(message);
  }
  const consumed = ["in_custody", "consumed", "completed", "extension_error"].includes(
    result.disposition,
  );
  if (!consumed) {
    const message = result.message ?? `Submission ${result.disposition.replaceAll("_", " ")}`;
    deps.addToast(
      sessionId,
      message,
      result.disposition === "outcome_unknown" ? "warning" : "error",
    );
    throw new InputNotConsumedError(message);
  }
  // Canonical immediate-prompt transcript state remains event-derived because
  // message_start may arrive before this response. Only prompts accepted into
  // Pi's active-turn queue need an optimistic block while they await delivery.
  if (
    result.queued === true &&
    action.commandSource === undefined &&
    !action.text.startsWith("/")
  ) {
    const currentContext = deps.getSubmissionContext?.(sessionId);
    if (
      currentContext?.hostInstanceId === context.hostInstanceId &&
      currentContext.sessionEpoch === context.sessionEpoch
    ) {
      // Queued prompts do not receive their authoritative message_start until
      // Pi delivers them after the active turn. Immediate prompts remain
      // entirely event-derived: their echo may legally precede this response.
      deps.addUserMessage(
        sessionId,
        action.text,
        action.images?.map((image) => image.dataUrl),
        {
          registerEcho: true,
          afterUserMessageSequence: context.userMessageSequence,
        },
      );
    }
  }
  if (result.disposition === "extension_error") {
    deps.addToast(sessionId, result.message ?? "Extension command failed.", "error");
  }
  return result;
}

// ── bash ────────────────────────────────────────────────────────────────

async function executeBash(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "bash" }>,
  deps: ExecuteDeps,
): Promise<void> {
  deps.addBashCommand(sessionId, action.command);
  try {
    const res = await deps.invoke<{ output?: string; exitCode?: number }>("session.sendCommand", {
      sessionId,
      command: {
        type: "bash",
        command: action.command,
        excludeFromContext: action.excludeFromContext,
      },
    });
    if (res.success) {
      deps.finishBashCommand(sessionId, res.data?.output ?? "", res.data?.exitCode ?? 0);
    } else {
      deps.finishBashCommand(sessionId, res.error ?? "Command failed", res.data?.exitCode ?? 1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.finishBashCommand(sessionId, message, 1);
    throw new InputNotConsumedError(message);
  }
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
      const context = deps.getSubmissionContext?.(sessionId);
      const expectedRuntime = context
        ? { hostInstanceId: context.hostInstanceId, sessionEpoch: context.sessionEpoch }
        : undefined;
      const res = await deps.applyModelChange(sessionId, model, expectedRuntime);
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
    const message = `Failed to set session name: ${err instanceof Error ? err.message : String(err)}`;
    deps.addToast(sessionId, message, "error");
    throw new InputNotConsumedError(message);
  }
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to set session name", "error");
    return;
  }
  // Pi also emits session_info_changed; this optimistic write keeps the GUI
  // responsive when the event arrives after the command response.
  deps.setSessionName(sessionId, action.name);
  deps.addToast(sessionId, `Session name set: ${action.name}`);
}

// ── /session ───────────────────────────────────────────────────────────

async function executeSessionInfo(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  // TUI parity: render in the chat as a custom_message block, not a toast.
  let statsRes: InvokeEnvelope<Record<string, unknown>>;
  let stateRes: InvokeEnvelope<{
    sessionName?: string;
    sessionFile?: string;
    sessionId?: string;
  }>;
  try {
    [statsRes, stateRes] = await Promise.all([
      deps.invoke<Record<string, unknown>>("session.sendCommand", {
        sessionId,
        command: { type: "get_session_stats" },
      }),
      deps.invoke<{ sessionName?: string; sessionFile?: string; sessionId?: string }>(
        "session.sendCommand",
        { sessionId, command: { type: "get_state" } },
      ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.addToast(sessionId, message, "error");
    throw new InputNotConsumedError(message);
  }
  if (!statsRes.success || !stateRes.success) {
    deps.addToast(
      sessionId,
      statsRes.error ?? stateRes.error ?? "Failed to read session information",
      "error",
    );
    return;
  }
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

async function executeNewSession(
  sessionId: SessionId,
  deps: ExecuteDeps,
): Promise<CommandCompletion | undefined> {
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
  if (res.data?.cancelled) return;
  deps.addToast(sessionId, "Started a fresh session");
  return replacementCompletion(sessionId, res, deps);
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

async function executeClone(
  sessionId: SessionId,
  deps: ExecuteDeps,
): Promise<CommandCompletion | undefined> {
  const res = await deps.invoke<CancellationData>("session.sendCommand", {
    sessionId,
    command: { type: "clone" },
  });
  if (!res.success) {
    deps.addToast(sessionId, res.error ?? "Failed to clone session", "error");
    return;
  }
  if (res.data?.cancelled) return;
  deps.addToast(sessionId, "Cloned to new session");
  return replacementCompletion(sessionId, res, deps);
}

function replacementCompletion(
  sessionId: SessionId,
  response: InvokeEnvelope<unknown>,
  deps: ExecuteDeps,
): CommandCompletion {
  const successor = (
    response as InvokeEnvelope<unknown> & {
      successorIdentity?: { hostInstanceId?: unknown; sessionEpoch?: unknown };
    }
  ).successorIdentity;
  if (typeof successor?.hostInstanceId !== "string" || typeof successor.sessionEpoch !== "number") {
    const message = "Replacement completed without a correlated successor runtime";
    deps.addToast(sessionId, message, "error");
    throw new InputNotConsumedError(message);
  }
  return {
    completionRuntime: {
      hostInstanceId: successor.hostInstanceId,
      sessionEpoch: successor.sessionEpoch,
    },
  };
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

async function executeReload(
  sessionId: SessionId,
  deps: ExecuteDeps,
): Promise<CommandCompletion | undefined> {
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
  const successor = (
    res as typeof res & {
      successorIdentity?: { hostInstanceId?: unknown; sessionEpoch?: unknown };
    }
  ).successorIdentity;
  if (typeof successor?.hostInstanceId !== "string" || typeof successor.sessionEpoch !== "number") {
    const message = "Reload completed without a correlated successor runtime";
    deps.addToast(sessionId, message, "error");
    throw new InputNotConsumedError(message);
  }
  return {
    completionRuntime: {
      hostInstanceId: successor.hostInstanceId,
      sessionEpoch: successor.sessionEpoch,
    },
  };
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
