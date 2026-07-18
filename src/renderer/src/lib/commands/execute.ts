import type { SessionId } from "@shared/ids.js";
import type { SessionSummary } from "@shared/ipc-contract.js";
import type { ProjectTrustOption } from "@shared/pi-protocol/commands.js";
import { LoginProvidersDataSchema } from "@shared/pi-protocol/responses.js";
import type {
  ForkMessagesData,
  LastAssistantTextData,
  LoginProvidersData,
  LogoutProvidersData,
  ModelInfo,
  ScopedModelsData,
  TrustStateData,
} from "@shared/pi-protocol/responses.js";
import type {
  IntentOutcome,
  IntentReceipt,
  RuntimeIdentity,
  SessionIntent,
  SessionQuery,
  SessionQueryResult,
} from "@shared/pi-protocol/runtime-state.js";
import { describeIpcError } from "../ipc-errors.js";
import { modelDisplayName } from "../model-utils.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";
import type { ComposerAction } from "./types.js";

export interface IntentObservation {
  owner: RuntimeIdentity;
  cursor?: {
    hostInstanceId: string;
    sessionEpoch: number;
    transportSequence: number;
    snapshotSequence: number;
  };
  editorRevision: number;
  userMessageSequence: number;
}

export interface ExecuteDeps {
  /** Dispatch only admits an intent. Its receipt is never a terminal result. */
  dispatch?: (
    sessionId: SessionId,
    intent: SessionIntent,
    intentId?: string,
  ) => Promise<IntentReceipt>;
  /** Read-only host operations are owner-bound queries. */
  query?: (sessionId: SessionId, query: SessionQuery) => Promise<SessionQueryResult>;
  /** Resolves only after an authority-frame projection publishes a terminal outcome. */
  awaitIntentOutcome?: (
    sessionId: SessionId,
    intentId: string,
    owner: RuntimeIdentity,
  ) => Promise<IntentOutcome>;
  getIntentObservation?: (sessionId: SessionId) => IntentObservation | undefined;
  /** Exact Composer editor command eligible for child-owned reload consumption. */
  getReloadEditorCommand?: (
    sessionId: SessionId,
  ) => { editorRevision: number; editorText: string } | undefined;
  /** Called after a child has admitted an intent, before its terminal outcome. */
  onAdmitted?: (sessionId: SessionId, intent: SessionIntent, intentId: string) => void;
  /** Unified-TUI ingress supplies its main-assigned stable intent ID here. */
  createIntentId?: (() => string) | undefined;
  uiSurface?: "composer" | "unified" | undefined;
  invoke: <T = unknown>(
    channel: string,
    payload: unknown,
  ) => Promise<{ success: boolean; data?: T; error?: string }>;
  addToast: (
    sessionId: SessionId,
    message: string,
    type?: "info" | "error" | "warning" | "success",
  ) => void;
  addUserMessage: (
    sessionId: SessionId,
    content: string,
    images?: string[],
    opts?: { registerEcho?: boolean; afterUserMessageSequence?: number; intentId?: string },
  ) => void;
  addCustomMessage: (sessionId: SessionId, content: string) => void;
  openChangelog: (markdown: string) => void;
  openPicker: (sessionId: SessionId, picker: PickerRequest) => void;
  closeSessionTab: (sessionId: SessionId) => Promise<void>;
  openAppSettings: () => void;
  openLogin: () => void;
  openDiffViewer: (sessionId: SessionId) => void;
  openTreeViewer: (sessionId: SessionId) => void;
  copyToClipboard: (text: string) => Promise<void>;
  getAvailableModels: (sessionId: SessionId) => ModelInfo[];
  getSessionWorkspacePath: (sessionId: SessionId) => string | undefined;
  listSessions: (workspacePath: string) => Promise<SessionSummary[]>;
}

export class InputNotConsumedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputNotConsumedError";
  }
}

export interface IntentCompletion {
  intentId: string;
  outcome: IntentOutcome;
  /** Compatibility shape for callers still checking legacy submission results. */
  disposition: string;
  message?: string | undefined;
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
      kind: "login";
      providers: LoginProvidersData["providers"];
    }
  | {
      kind: "trust";
      cwd: string;
      savedDecision: boolean | null;
      projectTrusted: boolean;
      options: ProjectTrustOption[];
    }
) & { expectedHostInstanceId?: string; expectedSessionEpoch?: number };

function queryData<T>(result: SessionQueryResult): T {
  if (result.status !== "ok")
    throw new InputNotConsumedError("Session is synchronizing; please try again.");
  if (!result.response.success)
    throw new InputNotConsumedError(result.response.error ?? "Query failed");
  return result.response.data as T;
}

async function dispatchAndAwait(
  sessionId: SessionId,
  intent: SessionIntent,
  deps: ExecuteDeps,
): Promise<IntentCompletion> {
  const observation = deps.getIntentObservation?.(sessionId);
  if (!observation) {
    const message = "Runtime snapshot is unavailable; input was not submitted.";
    deps.addToast(sessionId, message, "warning");
    throw new InputNotConsumedError(message);
  }
  const intentId = deps.createIntentId?.() ?? crypto.randomUUID();
  let receipt: IntentReceipt;
  try {
    if (!deps.dispatch || !deps.awaitIntentOutcome)
      throw new Error("Intent transport is unavailable");
    receipt = await deps.dispatch(sessionId, intent, intentId);
  } catch (error) {
    const description = describeIpcError(error);
    const message = description ?? "Session is synchronizing; input was not submitted.";
    if (description) deps.addToast(sessionId, message, "error");
    throw new InputNotConsumedError(message);
  }
  if (receipt.status === "not_admitted") {
    const message = `Intent was not admitted: ${receipt.reason.replaceAll("_", " ")}`;
    deps.addToast(sessionId, message, "warning");
    throw new InputNotConsumedError(message);
  }
  if (receipt.status === "delivery_unknown") {
    const message = "Intent delivery is unknown; input was preserved for review.";
    deps.addToast(sessionId, message, "warning");
    throw new InputNotConsumedError(message);
  }
  // Admission proves this intent is now child-owned. Composer may clear only
  // intent-shaped commands here; prompt/editor acknowledgement remains fenced
  // by the terminal outcome.
  deps.onAdmitted?.(sessionId, intent, intentId);
  const outcome = await deps.awaitIntentOutcome!(sessionId, intentId, observation.owner);
  if (outcome.state === "outcome_unknown") {
    const message = outcome.error ?? "Intent outcome is unknown; input was preserved for review.";
    deps.addToast(sessionId, message, "warning");
    throw new InputNotConsumedError(message);
  }
  return {
    intentId,
    outcome,
    disposition:
      outcome.kind === "submit" ? (outcome.result?.disposition ?? "completed") : "completed",
    ...(outcome.error ? { message: outcome.error } : {}),
  };
}

function outcomeError(completion: IntentCompletion): string | undefined {
  return completion.outcome.state === "completed" ? undefined : completion.outcome.error;
}

export async function executeAction(
  sessionId: SessionId,
  action: ComposerAction,
  deps: ExecuteDeps,
): Promise<IntentCompletion | undefined> {
  switch (action.kind) {
    case "send-prompt":
      return executePrompt(sessionId, action, deps);
    case "bash":
      return dispatchAndAwait(
        sessionId,
        { kind: "runBash", command: action.command, excludeFromContext: action.excludeFromContext },
        deps,
      );
    case "model":
      return executeModel(sessionId, action, deps);
    case "name":
      return executeName(sessionId, action, deps);
    case "session-info":
      await executeSessionInfo(sessionId, deps);
      return;
    case "new-session":
      return executeSlashIntent(sessionId, "/new", deps, "Started a fresh session");
    case "compact":
      return executeCompact(sessionId, action, deps);
    case "export":
      return executeExport(sessionId, action.outputPath, deps);
    case "fork":
      await executeFork(sessionId, deps);
      return;
    case "clone":
      return executeSlashIntent(sessionId, "/clone", deps, "Cloned to new session");
    case "resume":
      await executeResume(sessionId, deps);
      return;
    case "copy":
      await executeCopy(sessionId, deps);
      return;
    case "quit":
      await deps.closeSessionTab(sessionId);
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
      await executeLogin(sessionId, deps);
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
  }
}

async function executePrompt(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "send-prompt" }>,
  deps: ExecuteDeps,
): Promise<IntentCompletion> {
  const observation = deps.getIntentObservation?.(sessionId);
  const deliveryMode = action.deliveryMode ?? "steer";
  if (!observation)
    return dispatchAndAwait(
      sessionId,
      {
        kind: "submit",
        editorRevision: 0,
        text: action.text,
        images: [],
        requestedMode: deliveryMode,
        surface: deps.uiSurface ?? "composer",
      },
      deps,
    );
  const intent: SessionIntent = action.commandSource
    ? { kind: "invokeCommand", text: action.text, editorRevision: observation.editorRevision }
    : {
        kind: "submit",
        editorRevision: observation.editorRevision,
        text: action.text,
        images: (action.images ?? []).map(({ data, mimeType }) => ({
          type: "image" as const,
          data,
          mimeType,
        })),
        requestedMode: deliveryMode,
        surface: deps.uiSurface ?? "composer",
      };
  const completion = await dispatchAndAwait(sessionId, intent, deps);
  if (action.commandSource && completion.outcome.state !== "completed") {
    const sourceLabel =
      action.commandSource === "extension"
        ? "Extension"
        : action.commandSource === "prompt"
          ? "Prompt template"
          : "Skill";
    deps.addToast(sessionId, completion.outcome.error ?? `${sourceLabel} command failed.`, "error");
  }
  // A queued prompt belongs exclusively to the Composer queue manager until
  // Pi emits its authoritative user message. Do not create an optimistic
  // transcript bubble here: it would make a not-yet-delivered instruction
  // look like chat history and duplicate the pending queue item.
  return completion;
}

async function executeModel(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "model" }>,
  deps: ExecuteDeps,
): Promise<IntentCompletion | undefined> {
  if (action.search) {
    const exact = findExactModelReferenceMatch(
      action.search,
      deps
        .getAvailableModels(sessionId)
        .map((m) =>
          m.name
            ? { id: m.id, provider: m.provider, name: m.name }
            : { id: m.id, provider: m.provider },
        ),
    );
    if (exact?.provider) {
      const completion = await dispatchAndAwait(
        sessionId,
        { kind: "setModel", provider: exact.provider, modelId: exact.id },
        deps,
      );
      if (constError(completion, deps, sessionId, "Failed to set model")) return completion;
      deps.addToast(sessionId, `Model: ${modelDisplayName(exact)}`);
      return completion;
    }
  }
  deps.openPicker(
    sessionId,
    action.search === undefined ? { kind: "model" } : { kind: "model", search: action.search },
  );
  return;
}

function constError(
  completion: IntentCompletion,
  deps: ExecuteDeps,
  sessionId: SessionId,
  prefix: string,
): boolean {
  const error = outcomeError(completion);
  if (!error) return false;
  deps.addToast(sessionId, `${prefix}: ${error}`, "error");
  return true;
}

async function executeName(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "name" }>,
  deps: ExecuteDeps,
): Promise<IntentCompletion | undefined> {
  if (!action.name) {
    try {
      if (!deps.query) throw new Error("Query transport is unavailable");
      const state = queryData<{ sessionName?: string }>(
        await deps.query!(sessionId, { type: "get_state" }),
      );
      deps.addToast(
        sessionId,
        state.sessionName ? `Session name: ${state.sessionName}` : "Usage: /name <name>",
        state.sessionName ? undefined : "warning",
      );
    } catch (error) {
      deps.addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }
  const completion = await dispatchAndAwait(sessionId, { kind: "rename", name: action.name }, deps);
  if (!constError(completion, deps, sessionId, "Failed to set session name"))
    deps.addToast(sessionId, `Session name set: ${action.name}`);
  return completion;
}

async function executeSessionInfo(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  try {
    const [stats, state] = await Promise.all([
      deps.query!(sessionId, { type: "get_session_stats" }).then(
        queryData<Record<string, unknown>>,
      ),
      deps.query!(sessionId, { type: "get_state" }).then(
        queryData<{ sessionName?: string; sessionFile?: string; sessionId?: string }>,
      ),
    ]);
    const sessionFile = state.sessionFile ?? (stats.sessionFile as string | undefined);
    deps.addCustomMessage(
      sessionId,
      formatSessionInfo({
        ...(state.sessionName ? { sessionName: state.sessionName } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        sessionId: state.sessionId ?? sessionId,
        stats,
      }),
    );
  } catch (error) {
    deps.addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
  }
}

async function executeSlashIntent(
  sessionId: SessionId,
  text: string,
  deps: ExecuteDeps,
  successToast?: string,
): Promise<IntentCompletion> {
  const observation = deps.getIntentObservation?.(sessionId);
  const completion = await dispatchAndAwait(
    sessionId,
    { kind: "invokeCommand", text, editorRevision: observation?.editorRevision ?? 0 },
    deps,
  );
  const error = outcomeError(completion);
  if (error) deps.addToast(sessionId, error, "error");
  else if (successToast) deps.addToast(sessionId, successToast);
  return completion;
}

async function executeCompact(
  sessionId: SessionId,
  action: Extract<ComposerAction, { kind: "compact" }>,
  deps: ExecuteDeps,
): Promise<IntentCompletion> {
  const completion = await dispatchAndAwait(
    sessionId,
    action.customInstructions === undefined
      ? { kind: "compact" }
      : { kind: "compact", instructions: action.customInstructions },
    deps,
  );
  const error = outcomeError(completion);
  if (error) deps.addToast(sessionId, error, "error");
  return completion;
}

async function executeReload(
  sessionId: SessionId,
  deps: ExecuteDeps,
): Promise<IntentCompletion | undefined> {
  const editorCommand = deps.getReloadEditorCommand?.(sessionId);
  const completion = await dispatchAndAwait(
    sessionId,
    {
      kind: "reload",
      ...(editorCommand ?? {}),
    },
    deps,
  );
  if (!constError(completion, deps, sessionId, "Failed to reload session"))
    deps.addToast(
      sessionId,
      "Reloaded settings, extensions, skills, prompts, and themes.",
      "success",
    );
  return completion;
}

async function executeFork(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  try {
    const messages =
      queryData<ForkMessagesData>(await deps.query!(sessionId, { type: "get_fork_messages" }))
        .messages ?? [];
    messages.length
      ? deps.openPicker(sessionId, { kind: "fork", messages })
      : deps.addToast(sessionId, "No messages to fork from", "warning");
  } catch (error) {
    deps.addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
  }
}
async function executeResume(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const path = deps.getSessionWorkspacePath(sessionId);
  if (!path) return deps.addToast(sessionId, "No active workspace for resume", "error");
  const sessions = await deps.listSessions(path);
  sessions.length
    ? deps.openPicker(sessionId, { kind: "resume", sessions })
    : deps.addToast(sessionId, "No sessions to resume", "warning");
}
async function executeCopy(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  try {
    const text = queryData<LastAssistantTextData>(
      await deps.query!(sessionId, { type: "get_last_assistant_text" }),
    ).text;
    if (!text) return deps.addToast(sessionId, "No agent messages to copy yet.", "warning");
    await deps.copyToClipboard(text);
    deps.addToast(sessionId, "Copied last agent message to clipboard");
  } catch (error) {
    deps.addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
  }
}
async function executeScopedModels(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  try {
    const data = queryData<ScopedModelsData>(
      await deps.query!(sessionId, { type: "get_scoped_models" }),
    );
    const models = data.models ?? [];
    models.length
      ? deps.openPicker(sessionId, {
          kind: "scoped-models",
          models,
          enabledIds: data.enabledIds ?? null,
        })
      : deps.addToast(sessionId, "No models available", "warning");
  } catch (error) {
    deps.addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
  }
}
async function executeLogin(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  try {
    const catalog = LoginProvidersDataSchema.parse(
      queryData<unknown>(await deps.query!(sessionId, { type: "get_login_providers" })),
    );
    if (!catalog.native) {
      deps.openLogin();
      return;
    }
    if (catalog.providers.length === 0) {
      deps.addToast(sessionId, "No providers offer interactive sign-in.", "warning");
      return;
    }
    deps.openPicker(sessionId, { kind: "login", providers: catalog.providers });
  } catch (error) {
    deps.addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
  }
}

async function executeLogout(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  try {
    const providers =
      queryData<LogoutProvidersData>(await deps.query!(sessionId, { type: "get_logout_providers" }))
        .providers ?? [];
    providers.length
      ? deps.openPicker(sessionId, { kind: "logout", providers })
      : deps.addToast(
          sessionId,
          "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
          "warning",
        );
  } catch (error) {
    deps.addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
  }
}
async function executeTrust(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  try {
    const state = queryData<TrustStateData>(
      await deps.query!(sessionId, { type: "get_trust_state" }),
    );
    if (!state.hasTrustRequiringResources)
      return deps.addToast(
        sessionId,
        "This workspace has no project-local pi resources that require trust.",
        "info",
      );
    deps.openPicker(sessionId, {
      kind: "trust",
      cwd: state.cwd,
      savedDecision: state.savedDecision,
      projectTrusted: state.projectTrusted,
      options: state.currentOptions,
    });
  } catch (error) {
    deps.addToast(sessionId, error instanceof Error ? error.message : String(error), "error");
  }
}
async function executeExport(
  sessionId: SessionId,
  outputPath: string | undefined,
  deps: ExecuteDeps,
): Promise<IntentCompletion> {
  const completion = await dispatchAndAwait(
    sessionId,
    outputPath === undefined ? { kind: "export" } : { kind: "export", outputPath },
    deps,
  );
  const error = outcomeError(completion);
  if (error) deps.addToast(sessionId, `Failed to export session: ${error}`, "error");
  else if (completion.outcome.kind === "export" && completion.outcome.result?.path)
    deps.addToast(sessionId, `Exported session: ${completion.outcome.result.path}`, "success");
  else deps.addToast(sessionId, "Export completed without an output path", "error");
  return completion;
}

async function executeShare(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  // Export is a child-owned effect. Never ask main to invoke Pi or infer a
  // path: wait for the owner-bound authority outcome first.
  const completion = await executeExport(sessionId, undefined, deps);
  if (completion.outcome.state !== "completed") return;
  const exportedPath =
    completion.outcome.kind === "export" ? completion.outcome.result?.path : undefined;
  if (!exportedPath) {
    deps.addToast(sessionId, "Export completed without an output path", "error");
    return;
  }
  const owner = completion.outcome.owner;
  const result = (await deps.invoke("session.share", {
    sessionId,
    expectedHostInstanceId: owner.hostInstanceId,
    expectedSessionEpoch: owner.sessionEpoch,
    exportIntentId: completion.intentId,
    exportedPath,
  })) as unknown as { ok: boolean; url?: string; gistUrl?: string; error?: string };
  if (!result.ok)
    return deps.addToast(sessionId, result.error ?? "Failed to share session", "error");
  if (result.url) await deps.copyToClipboard(result.url);
  deps.addToast(
    sessionId,
    result.gistUrl
      ? `Share URL: ${result.url ?? ""}\nGist: ${result.gistUrl}`
      : `Share URL: ${result.url ?? ""}`,
    "success",
  );
}
async function executeChangelog(sessionId: SessionId, deps: ExecuteDeps): Promise<void> {
  const result = (await deps.invoke("pi.changelog", undefined)) as unknown as {
    ok: boolean;
    markdown?: string;
    error?: string;
  };
  result.ok
    ? deps.openChangelog(result.markdown ?? "")
    : deps.addToast(sessionId, result.error ?? "Failed to load changelog", "error");
}

function formatSessionInfo(args: {
  sessionName?: string;
  sessionFile?: string;
  sessionId: string;
  stats: Record<string, unknown>;
}): string {
  const lines = [
    "**Session Info**\n",
    ...(args.sessionName ? [`Name: ${args.sessionName}`] : []),
    `File: ${args.sessionFile ?? "In-memory"}`,
    `ID: ${args.sessionId}\n`,
    "**Messages",
  ];
  for (const [key, label] of [
    ["userMessages", "User"],
    ["assistantMessages", "Assistant"],
    ["toolCalls", "Tool Calls"],
    ["toolResults", "Tool Results"],
    ["totalMessages", "Total"],
  ] as const)
    if (typeof args.stats[key] === "number") lines.push(`${label}: ${args.stats[key]}`);
  return lines.join("\n");
}
