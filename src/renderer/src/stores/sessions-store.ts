import type { SessionId } from "@shared/ids.js";
import type { HistoryPage, SessionStatus, SessionSummary } from "@shared/ipc-contract.js";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import { type PiRpcCommand, commandNeedsIntent } from "@shared/pi-protocol/commands.js";
import {
  CacheMissNoticeEventSchema,
  type KnownPiEvent,
  type PiEvent,
} from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import type { ModelInfo, SessionStats, SlashCommandInfo } from "@shared/pi-protocol/responses.js";
import { ModelInfoSchema, SessionStatsSchema } from "@shared/pi-protocol/responses.js";
import type {
  AgentSessionSnapshot,
  RuntimeRecord,
  RuntimeStateUpdate,
  SubmissionResult,
} from "@shared/pi-protocol/runtime-state.js";
import type { ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import { ThinkingLevelSchema } from "@shared/pi-protocol/thinking.js";
import { detectTurnError } from "@shared/pi-protocol/turn-error.js";
import { type StateCreator, create } from "zustand";
import type { PickerRequest } from "../lib/commands/execute.js";
import { InputNotConsumedError, executeAction } from "../lib/commands/execute.js";
import { parseComposerInput } from "../lib/commands/parse.js";
import {
  parseReplicatedAttachments,
  runtimeImagesFromAttachments,
  textWithAppendedFilePaths,
  textWithPrependedFilePaths,
} from "../lib/composer-attachments.js";
import {
  type CodeComment,
  codeCommentKey,
  createCodeCommentId,
  loadPersistedCodeComments,
  persistCodeComments,
  prependCodeCommentsToPrompt,
} from "../lib/diff-comments.js";
import type { DiffModel } from "../lib/diff/diff-model.js";
import { reanchorCommentsForEdit } from "../lib/diff/edit-anchor.js";
import { findCurrentModel } from "../lib/model-utils.js";
import { forgetPanelInputSequence } from "../lib/panel-input-sequence.js";
import { RENDERER_GENERATION } from "../lib/renderer-generation.js";
import { invokeSessionCommand } from "../lib/session-command.js";
import { useChangelogStore } from "./changelog-store.js";
import { openDiffForSession } from "./diff-store.js";
import { useSettingsStore } from "./settings-store.js";
import {
  type TranscriptState,
  addBashBlock,
  addCustomMessageBlock,
  addUserBlock,
  applyPiEvent,
  clearPendingUserEcho,
  createTranscriptState,
  finalizeActiveBlocks,
  finishBashBlock,
  prependHistory,
  retirePendingUserEchoesByIntent,
  seedFromHistory,
  transcriptBlockCount,
  transcriptHasBlocks,
} from "./transcript.js";

let nextThinkingRequestId = 1;
const pendingThinkingRequests = new Map<SessionId, number>();
const LOCAL_THEME_FALLBACK_DIAGNOSTIC =
  "Pi public API cannot install the pi-vis palette globally; extension panels use a local semantic theme.";

export interface QueuedMessage {
  id: string;
  text: string;
  intentId?: string | undefined;
  source: "optimistic" | "authoritative";
}

export interface SessionViewState {
  sessionId: SessionId;
  workspacePath: string;
  sessionFile?: string | undefined;
  status: SessionStatus;
  error?: string | undefined;
  transcript: TranscriptState;
  /** Runtime booleans are valid only while availability is available. */
  availability: RuntimeStateUpdate["availability"];
  runtimeSnapshot?: AgentSessionSnapshot | undefined;
  hostInstanceId?: string | undefined;
  sessionEpoch: number;
  editorRevision: number;
  editorAttachments: unknown[];
  editorAttachmentReads: number;
  editorPatchPending: number;
  /** Cold→live activation owned by the current view-only visit, if any. */
  activationVisitId?: string | undefined;
  editorConflict?:
    | {
        authoritativeText: string;
        authoritativeAttachments: unknown[];
        localText: string;
        localAttachments: unknown[];
        alternateText?: string | undefined;
        alternateAttachments?: unknown[] | undefined;
        additionalCandidates?: Array<{ text: string; attachments: unknown[] }> | undefined;
      }
    | undefined;
  queuedMessages?: { steering: QueuedMessage[]; followUp: QueuedMessage[] } | undefined;
  queueRestorations?:
    | Array<{
        restorationId: string;
        steering: string[];
        followUp: string[];
        originalAttachments: Array<{ intentId: string; images: unknown[] }>;
        clearedIntentIds?: string[] | undefined;
        commandDescription?: string | undefined;
      }>
    | undefined;
  /** Start time derived from the last authoritative streaming snapshot. */
  runningSince?: number | undefined;
  /**
   * Unread turn-result marker for the sidebar status dot. Set to "done" or
   * "error" when a turn finishes. It
   * acts as a notification for background sessions: it persists until the
   * user views the session and moves on (setActiveSession clears the
   * previously-active session) or starts a new turn there (agent_start).
   */
  unreadStatus?: "done" | "error" | undefined;
  /** Transient: did the current agent attempt produce a provider/model error?
   *  Reset on agent_start and on a willRetry agent_end (each auto-retry attempt
   *  starts clean), set on an erroring assistant message_end, and consumed at
   *  the applicable terminal boundary to decide unreadStatus. */
  turnErrored: boolean;
  pendingDialogs: ExtensionUiRequest[];
  statusSegments: Map<string, string>; // statusKey → statusText
  widgets: Map<string, string[]>; // widgetKey → lines
  toasts: Array<{ id: string; message: string; type?: string | undefined; createdAt: number }>;
  notificationPanelOpen?: boolean | undefined;
  stats?: SessionStats | undefined;
  availableModels: ModelInfo[];
  currentModel?: string | undefined;
  /** Provider of the active model (when known). Paired with `currentModel` so the
   *  dropdown can disambiguate same-id models offered by different providers
   *  (e.g. the same model via two subscriptions) and highlight only the
   *  actually-selected one. `undefined` for legacy pi shapes that omit it —
   *  the UI then falls back to id-only matching. */
  currentProvider?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  sessionTitle?: string | undefined;
  sessionName?: string | undefined;
  commands: SlashCommandInfo[];
  editorInjection?: { text: string; nonce: number; revision?: number } | undefined;
  pendingPicker?: PickerRequest | undefined;
  /**
   * Pre-send worktree intent mode (drives the WorktreeBar segmented
   * control). These are only set for a brand-new session (no transcript
   * yet) and are cleared after the first send.
   *
   * - `"none"` (default ≙ the bar's "In Workspace" segment): run the
   *   session in the workspace cwd, no worktree.
   * - `"create"` ("New Worktree" segment): create a fresh worktree on
   *   submit (mirrors the original `worktreeCreate: true` flow).
   * - `"attach"` ("Existing Worktree" segment): attach to an existing worktree on
   *   disk at `worktreeAttachPath`; the authoritative validation happens
   *   server-side in the `session.attachWorktree` IPC.
   */
  worktreeMode?: "none" | "create" | "attach" | undefined;
  /** The user-supplied path for the "Existing" (attach) mode. */
  worktreeAttachPath?: string | undefined;
  /** The base branch the user selected in the WorktreeBar. */
  worktreeBase?: string | null | undefined;
  /** True while the worktree creation IPC is in flight. */
  worktreeCreating?: boolean | undefined;
  /**
   * The reason the last worktree creation attempt failed, surfaced inline in
   * the WorktreeBar so it persists (unlike a toast) until the user retries or
   * changes the inputs. Cleared on a new attempt and on success.
   */
  worktreeError?: string | undefined;
  /**
   * Post-creation identity — set after a worktree is successfully
   * created and the pi process is re-spawned into it.
   */
  worktreePath?: string | undefined;
  /** Full branch name, e.g. "pi-vis-swift-otter". */
  worktreeBranch?: string | undefined;
  /** The friendly name, e.g. "swift-otter". */
  worktreeName?: string | undefined;
  /** The base branch the worktree was cut from (for the chip tooltip). */
  worktreeFromBase?: string | undefined;

  /** Inline custom panel from extension ctx.ui.custom() — rendered via xterm.js overlay.
   *  `mode` selects the renderer's sizing model, same contract as `unifiedPanel.mode`:
   *  `"content"` (default) tracks the intrinsic content height; `"viewport"` pins a
   *  fixed grid for a grid-coupled overlay. Custom panels default to content-tracking
   *  (the sizer's resize-storm breaker damps any unsignaled grid coupling); a host
   *  `panel_mode` event is honored if one is sent. */
  panel?:
    | {
        id: number;
        overlay: boolean;
        hostInstanceId: string;
        sessionEpoch: number;
        buffer: string[];
        mode?: "content" | "viewport";
      }
    | undefined;
  /** Persistent unified-TUI panel from a factory `setWidget` — rendered via
   *  `UnifiedTuiHost` (a real pi-tui Editor + widget components). Distinct
   *  from `panel` (transient custom() overlays) so the two never collide and
   *  so `extensionUiActive` doesn't treat the unified panel as a blocking
   *  dialog. The buffer is a bounded current replay segment: on a hard full-
   *  screen clear, stale data before the clear is dropped so remounts don't
   *  replay old frames as scrollback. `mode` selects the renderer's sizing model:
   *  `"content"` (default) tracks the intrinsic content height; `"viewport"` pins
   *  a fixed grid while a pi-tui overlay is up, whose geometry would otherwise
   *  feed a resize loop. Set by the `panel_mode` event from the host (overlay
   *  show/hide). */
  unifiedPanel?:
    | {
        id: number;
        hostInstanceId: string;
        sessionEpoch: number;
        buffer: string[];
        mode?: "content" | "viewport";
      }
    | undefined;
  /** When a `unifiedPanel` is live, the user can toggle between the
   *  extension's TUI surface and the native Composer (both stay mounted-
   *  ready, only the visible one renders). `false` (default) shows the
   *  unified TUI — the parity-correct surface when a factory widget is
   *  live; `true` shows the Composer instead. Reset to `false` whenever a
   *  panel opens/closes/resets so a fresh panel always starts visible. */
  unifiedPanelHidden?: boolean | undefined;
  /** pi version reported by the SDK host on ready.
   *  Surfaced in the SessionHeader tooltip. See P1-c. */
  piVersion?: string | undefined;
  /** True once we know the session has conversation-tree history outside the
   *  currently-visible branch. `/tree` can navigate to the root before any
   *  messages, which legitimately leaves `transcript.blocks` empty; sidebar /
   *  first-send affordances must still treat that session as non-empty. */
  hasTreeHistory?: boolean | undefined;
  historyCursor?: { startIndex: number; total: number } | undefined;
  /** Renderer-local transcript ownership generation. Delayed history reads may
   *  apply only while this generation, file, and runtime identity still match. */
  historyGeneration: number;
  historyLoadingEarlier?: boolean | undefined;
  /** True for a brand-new session (created without a session file) that
   *  has not yet sent its first message. Such sessions are hidden from
   *  the sidebar (the "+ New session" button shows as selected instead)
   *  and their unsent composer text is kept as a per-workspace draft so
   *  it survives switching away and back. Cleared on the first
   *  user/bash/custom message so the session becomes a normal, visible
   *  tab — and so a later `/new` (which resets the transcript) does NOT
   *  re-hide it. See `isNewSessionPending`. */
  isNewPending?: boolean | undefined;
  /**
   * Recency key for sidebar ordering. Set when a session is *created fresh*
   * (no file yet) and bumped only when the user submits a prompt — NOT on
   * mere open/activate. Resumed sessions leave this undefined so the sidebar
   * falls back to the session file's mtime, keeping them in place when clicked.
   */
  lastActivityAt?: number | undefined;
  /** True for sessions resumed from a file on disk (had a `sessionFile` at
   *  open time). False for brand-new sessions. Gates the "remember last
   *  selected model/thinking level" preference: it applies only to new
   *  sessions; resumed sessions keep the model/thinking level they had when
   *  last active (restored by pi from the session file). */
  resumed: boolean;
  /**
   * True once the one-time model + thinking-level bootstrap has run for this
   * session (see `bootstrapModelState`). It seeds pi's authoritative
   * model/level into the store and — for brand-new sessions only — applies
   * the global last-used preference.
   *
   * This flag is the structural guard for invariant #2 ("a session's model /
   * thinking level NEVER changes unless the user changes it in THAT session").
   * It lives in the store, not in the `SessionHeader` component, precisely so
   * it survives the header's unmount/remount on every tab switch — a
   * component-local guard would reset and let a remount re-apply the global
   * preference, silently changing this session's model to whatever another
   * session last picked.
   */
  modelInitialized: boolean;
}

interface WorkspaceState {
  path: string;
  sessions: SessionSummary[];
  activeSessions: SessionId[];
}

interface PendingNewSessionSetup {
  worktreeMode?: "none" | "create" | "attach" | undefined;
  worktreeAttachPath?: string | undefined;
  worktreeBase?: string | null | undefined;
}

/**
 * A brand-new session that the user has not yet sent a message in. It is
 * hidden from the sidebar (the "+ New session" button is shown as selected
 * instead) and its unsent composer text is backed by a per-workspace draft
 * (see `newSessionDrafts`). Once the first message lands the session becomes
 * a normal, visible tab.
 *
 * Defined as `isNewPending && no known history` so it self-clears the moment
 * content arrives or tree/history metadata proves the session is real — but
 * `isNewPending` is also flipped to false on the first content block so a
 * subsequent `/new` (which resets the transcript) does not re-hide a session
 * that was once real.
 */
export function sessionHasHistory(s: SessionViewState | undefined | null): boolean {
  return (
    !!s &&
    (transcriptHasBlocks(s.transcript) ||
      !!s.hasTreeHistory ||
      (s.queueRestorations?.length ?? 0) > 0)
  );
}

export function isNewSessionPending(s: SessionViewState | undefined | null): boolean {
  return !!s?.isNewPending && !sessionHasHistory(s);
}

/**
 * Whether the active session is a still-pending new session for
 * `workspacePath` — i.e. the workspace's "+ New session" button should render
 * as selected and a repeat click should be a no-op. Pure over the two store
 * fields it reads, so it works against both a live render snapshot and
 * `getState()`.
 */
export function isPendingNewSessionActiveFor(
  state: Pick<SessionsStore, "sessions" | "activeSessionId">,
  workspacePath: string,
): boolean {
  const active = state.activeSessionId ? state.sessions.get(state.activeSessionId) : undefined;
  return isNewSessionPending(active) && active?.workspacePath === workspacePath;
}

function shouldReapPendingNewSession(s: SessionViewState | undefined | null): boolean {
  if (!s || !isNewSessionPending(s)) return false;
  return (
    !isSessionWorking(s) &&
    !hasActiveBash(s) &&
    s.pendingDialogs.length === 0 &&
    !s.pendingPicker &&
    !s.worktreeCreating &&
    !s.panel &&
    !s.unifiedPanel &&
    s.editorAttachments.length === 0 &&
    s.editorAttachmentReads === 0
  );
}

/**
 * Returns a `newSessionDrafts` map with the given workspace's draft removed
 * when `shouldClear` is set and a draft exists — otherwise the same reference
 * (so callers can detect a no-op and skip a redundant state-field write).
 * Centralizes the clear performed when a pending new session becomes real.
 */
function clearNewSessionDraftFor(
  drafts: Map<string, string>,
  workspacePath: string,
  shouldClear: boolean,
): Map<string, string> {
  if (!shouldClear || !drafts.has(workspacePath)) return drafts;
  const next = new Map(drafts);
  next.delete(workspacePath);
  return next;
}

/**
 * Returns a `sessionDrafts` map with `sessionId` removed when it exists —
 * otherwise the same reference (so callers can detect a no-op and skip a
 * redundant state-field write). The per-session (non-pending) counterpart of
 * `clearNewSessionDraftFor`.
 */
function clearSessionDraftFor(
  drafts: Map<SessionId, string>,
  sessionId: SessionId,
): Map<SessionId, string> {
  if (!drafts.has(sessionId)) return drafts;
  const next = new Map(drafts);
  next.delete(sessionId);
  return next;
}

function setNewSessionDraftFor(
  drafts: Map<string, string>,
  workspacePath: string,
  text: string,
): Map<string, string> {
  const next = new Map(drafts);
  next.set(workspacePath, text);
  return next;
}

function setSessionDraftFor(
  drafts: Map<SessionId, string>,
  sessionId: SessionId,
  text: string,
): Map<SessionId, string> {
  const next = new Map(drafts);
  next.set(sessionId, text);
  return next;
}

function newSideLineText(model: DiffModel): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of model.lines) {
    if (line.type === "del") continue;
    if (line.newNo !== null) lines.set(line.newNo, line.text);
  }
  return lines;
}

function findUniqueLineByText(lines: Map<number, string>, text: string): number | null {
  let found: number | null = null;
  for (const [lineNumber, lineText] of lines) {
    if (lineText !== text) continue;
    if (found !== null) return null;
    found = lineNumber;
  }
  return found;
}

function sameCommentRevision(a: CodeComment, b: CodeComment): boolean {
  return a.id === b.id && a.revision === b.revision;
}

function diffCommentsStorageSessionKey(sessionFile: string): SessionId {
  return `file:${sessionFile}` as SessionId;
}

function clearNewSessionSetupFor(
  setups: Map<string, PendingNewSessionSetup>,
  workspacePath: string,
  shouldClear: boolean,
): Map<string, PendingNewSessionSetup> {
  if (!shouldClear || !setups.has(workspacePath)) return setups;
  const next = new Map(setups);
  next.delete(workspacePath);
  return next;
}

function capturePendingNewSessionSetup(s: SessionViewState): PendingNewSessionSetup {
  return {
    worktreeMode: s.worktreeMode,
    worktreeAttachPath: s.worktreeAttachPath,
    worktreeBase: s.worktreeBase,
  };
}

function hasActiveAgentWork(session: SessionViewState | undefined): boolean {
  const transcript = session?.transcript;
  return !!(transcript?.activeAssistantId || (transcript?.activeToolCallIds.size ?? 0) > 0);
}

/**
 * Whether the "Running for …" working indicator should be shown.
 *
 * Most turns show the timer directly from `isStreaming`. Extension UI surfaces
 * are the exception: opening a dialog/custom panel is often a prompt-backed
 * command waiting on the user, not model/tool work, so suppress that idle wait
 * until the transcript proves actual assistant/tool work is active.
 */
export function isSessionWorking(session: SessionViewState | undefined): boolean {
  return (
    !!session &&
    session.availability === "available" &&
    session.runtimeSnapshot?.isStreaming === true
  );
}

export function sessionMatchesRuntime(
  session: SessionViewState | undefined,
  runtime: { hostInstanceId: string; sessionEpoch: number },
): session is SessionViewState {
  return (
    session?.availability === "available" &&
    session.status === "ready" &&
    session.hostInstanceId === runtime.hostInstanceId &&
    session.sessionEpoch === runtime.sessionEpoch
  );
}

interface HistoryReadCapture {
  sessionFile: string;
  historyGeneration: number;
  expectedRuntime?: { hostInstanceId: string; sessionEpoch: number } | undefined;
}

function captureHistoryRead(
  session: SessionViewState | undefined,
  expectedRuntime?: { hostInstanceId: string; sessionEpoch: number },
): HistoryReadCapture | undefined {
  if (!session?.sessionFile) return undefined;
  const runtime =
    expectedRuntime ??
    (session.availability === "available" && session.status === "ready" && session.hostInstanceId
      ? { hostInstanceId: session.hostInstanceId, sessionEpoch: session.sessionEpoch }
      : undefined);
  return {
    sessionFile: session.sessionFile,
    historyGeneration: session.historyGeneration,
    ...(runtime ? { expectedRuntime: runtime } : {}),
  };
}

function historyCaptureMatches(
  session: SessionViewState | undefined,
  capture: HistoryReadCapture,
): boolean {
  return (
    !!session &&
    session.sessionFile === capture.sessionFile &&
    session.historyGeneration === capture.historyGeneration &&
    (!capture.expectedRuntime || sessionMatchesRuntime(session, capture.expectedRuntime))
  );
}

async function waitForHistoryOwnershipChange(
  sessionId: SessionId,
  prior: HistoryReadCapture,
  timeoutMs = 120_000,
): Promise<HistoryReadCapture | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (capture: HistoryReadCapture | undefined) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(capture);
    };
    const inspect = () => {
      const session = useSessionsStore.getState().sessions.get(sessionId);
      if (!session || session.status === "failed" || session.status === "exited") {
        finish(undefined);
        return;
      }
      const next = captureHistoryRead(session);
      if (!next) return;
      const ownershipChanged =
        next.sessionFile !== prior.sessionFile ||
        next.historyGeneration !== prior.historyGeneration ||
        next.expectedRuntime?.hostInstanceId !== prior.expectedRuntime?.hostInstanceId ||
        next.expectedRuntime?.sessionEpoch !== prior.expectedRuntime?.sessionEpoch;
      if (!ownershipChanged) return;
      // A retry is valid only against a concrete live runtime, or against a
      // genuinely new cold/file generation. Never retry the unchanged
      // identity-less request merely because an arbitrary timer elapsed.
      if (
        next.expectedRuntime ||
        (session.status === "cold" && session.availability === "unavailable")
      ) {
        finish(next);
      }
    };
    const timer = window.setTimeout(() => finish(undefined), timeoutMs);
    unsubscribe = useSessionsStore.subscribe(inspect);
    inspect();
  });
}

async function waitForHistoryHydrationIdle(
  sessionId: SessionId,
  capture: HistoryReadCapture,
  timeoutMs = 120_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const inspect = () => {
      const session = useSessionsStore.getState().sessions.get(sessionId);
      if (!historyCaptureMatches(session, capture)) {
        finish(false);
        return;
      }
      if (!isSessionWorking(session)) finish(true);
    };
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
    unsubscribe = useSessionsStore.subscribe(inspect);
    inspect();
  });
}

async function requestBoundHistoryPage(
  sessionId: SessionId,
  capture: HistoryReadCapture,
  opts: { limit?: number | undefined; before?: number | undefined } = {},
): Promise<HistoryPage | undefined> {
  const result = await window.pivis.invoke("session.loadHistory", {
    sessionId,
    expectedSessionFile: capture.sessionFile,
    historyGeneration: capture.historyGeneration,
    expectedHostInstanceId: capture.expectedRuntime?.hostInstanceId ?? null,
    expectedSessionEpoch: capture.expectedRuntime?.sessionEpoch ?? null,
    ...opts,
  });
  if (result.status !== "loaded" || result.historyGeneration !== capture.historyGeneration) {
    return undefined;
  }
  if (!historyCaptureMatches(useSessionsStore.getState().sessions.get(sessionId), capture)) {
    return undefined;
  }
  return result.page;
}

export function shouldShowWorkingIndicator(session: SessionViewState | undefined): boolean {
  if (!session || !isSessionWorking(session)) return false;
  const extensionUiActive = session.pendingDialogs.length > 0 || session.panel != null;
  return !extensionUiActive || hasActiveAgentWork(session);
}

function hasActiveBash(session: SessionViewState | undefined): boolean {
  return session?.transcript.activeBashId != null;
}

function queuedFromSnapshot(
  kind: "steering" | "followUp",
  texts: string[],
  intentIds: Array<string | null> | undefined,
): QueuedMessage[] {
  return texts.map((text, index) => {
    const intentId = intentIds?.[index] ?? undefined;
    return {
      id: intentId ? `intent-${intentId}` : `auth-${kind}-${index}-${text}`,
      text,
      ...(intentId ? { intentId } : {}),
      source: "authoritative" as const,
    };
  });
}

function closeCheckpointPreview(
  checkpoint: unknown,
  localDraft: string,
  localEditor: { attachments: unknown[]; pendingAttachmentReads: number },
): string {
  const truncate = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.length > 400 ? `${value.slice(0, 400)}… (${value.length} chars)` : value;
    }
    if (Array.isArray(value)) return value.slice(0, 12).map(truncate);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !["data", "bytes"].includes(key))
          .slice(0, 20)
          .map(([key, entry]) => [key, truncate(entry)]),
      );
    }
    return value;
  };
  const details = truncate({
    ...(localDraft.trim() ? { rendererDraft: localDraft } : {}),
    ...(localEditor.attachments.length > 0 || localEditor.pendingAttachmentReads > 0
      ? { rendererEditor: localEditor }
      : {}),
    checkpoint,
  });
  const rendered = JSON.stringify(details, null, 2);
  return rendered.length > 8_000 ? `${rendered.slice(0, 8_000)}\n… checkpoint truncated` : rendered;
}

interface EditorCandidate {
  text: string;
  attachments: unknown[];
}

function sameEditorCandidate(a: EditorCandidate, b: EditorCandidate): boolean {
  return a.text === b.text && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);
}

function editorConflictFromCandidates(
  editor: AgentSessionSnapshot["editor"],
  rendererCandidate?: EditorCandidate,
): SessionViewState["editorConflict"] {
  const candidates: EditorCandidate[] = [];
  const add = (candidate: EditorCandidate | undefined) => {
    if (!candidate || candidates.some((existing) => sameEditorCandidate(existing, candidate))) {
      return;
    }
    candidates.push(candidate);
  };
  add({ text: editor.text, attachments: editor.attachments });
  add(rendererCandidate);
  if (editor.conflictText !== undefined) {
    add({ text: editor.conflictText, attachments: editor.conflictAttachments ?? [] });
  }
  if (editor.alternateConflictText !== undefined) {
    add({
      text: editor.alternateConflictText,
      attachments: editor.alternateConflictAttachments ?? [],
    });
  }
  for (const candidate of editor.additionalConflictCandidates ?? []) add(candidate);
  if (candidates.length < 2) return undefined;
  const authoritative = candidates[0]!;
  const local = candidates[1]!;
  const alternate = candidates[2];
  const additional = candidates.slice(3);
  return {
    authoritativeText: authoritative.text,
    authoritativeAttachments: authoritative.attachments,
    localText: local.text,
    localAttachments: local.attachments,
    ...(alternate
      ? { alternateText: alternate.text, alternateAttachments: alternate.attachments }
      : {}),
    ...(additional.length > 0 ? { additionalCandidates: additional } : {}),
  };
}

function removeQueuedMessageByIntent(
  queuedMessages: SessionViewState["queuedMessages"],
  intentId: string,
): SessionViewState["queuedMessages"] {
  if (!queuedMessages) return undefined;
  const steeringIndex = queuedMessages.steering.findIndex(
    (message) => message.intentId === intentId,
  );
  const followUpIndex =
    steeringIndex < 0
      ? queuedMessages.followUp.findIndex((message) => message.intentId === intentId)
      : -1;
  if (steeringIndex < 0 && followUpIndex < 0) return queuedMessages;
  const steering =
    steeringIndex < 0
      ? queuedMessages.steering
      : [
          ...queuedMessages.steering.slice(0, steeringIndex),
          ...queuedMessages.steering.slice(steeringIndex + 1),
        ];
  const followUp =
    followUpIndex < 0
      ? queuedMessages.followUp
      : [
          ...queuedMessages.followUp.slice(0, followUpIndex),
          ...queuedMessages.followUp.slice(followUpIndex + 1),
        ];
  return steering.length === 0 && followUp.length === 0 ? undefined : { steering, followUp };
}

/**
 * Enforce one visible owner per queued prompt. A normal optimistic transcript
 * bubble owns every pending echo, so the corresponding authoritative queue
 * item must not also be projected as a queued bubble. Matching is FIFO and
 * one-for-one so repeated identical prompts remain distinct.
 */
function queuedMessagesFromSnapshot(
  steering: string[],
  followUp: string[],
  steeringIntentIds: Array<string | null> | undefined,
  followUpIntentIds: Array<string | null> | undefined,
  pendingEchoes: TranscriptState["pendingEchoes"],
): SessionViewState["queuedMessages"] {
  let queuedMessages: SessionViewState["queuedMessages"] =
    steering.length === 0 && followUp.length === 0
      ? undefined
      : {
          steering: queuedFromSnapshot("steering", steering, steeringIntentIds),
          followUp: queuedFromSnapshot("followUp", followUp, followUpIntentIds),
        };
  for (const pendingEcho of pendingEchoes) {
    queuedMessages = removeQueuedMessageByIntent(queuedMessages, pendingEcho.intentId);
  }
  return queuedMessages;
}

function resetRuntimeState(session: SessionViewState): SessionViewState {
  return {
    ...session,
    availability: "unavailable",
    runtimeSnapshot: undefined,
    runningSince: undefined,
    queuedMessages: undefined,
  };
}

export function isSessionAbortable(session: SessionViewState | undefined): boolean {
  return !!session && session.status !== "exited" && session.status !== "failed";
}

interface SessionsStore {
  workspaces: Map<string, WorkspaceState>;
  sessions: Map<SessionId, SessionViewState>;
  activeSessionId: SessionId | null;
  activeWorkspacePath: string | null;
  /** Workspace paths whose session lists are expanded in the sidebar.
   * Multiple may be expanded at once; independent of activeWorkspacePath. */
  expandedWorkspaces: string[];
  /** Whether the session header is in compact mode (controls in sub-bar). */
  headerCompact: boolean;

  /** Per-workspace unsent composer text for the current pending new session.
   *  Lives only in memory — never persisted to settings — and is scoped to the
   *  workspace's "+ New session" placeholder. Switching to another session
   *  reaps that still-empty placeholder but preserves this draft, so the next
   *  "+ New session" in the workspace starts clean at the session layer while
   *  restoring the user's unsent text. The Composer writes on every keystroke
   *  while the active session is pending (`isNewSessionPending`) and the slot
   *  is cleared the moment a message is actually sent. */
  newSessionDrafts: Map<string, string>;
  /** Update (replace) the per-workspace draft for a pending new session. */
  setNewSessionDraft: (workspacePath: string, text: string) => void;
  /** Clear the per-workspace draft (called when the pending session sends). */
  clearNewSessionDraft: (workspacePath: string) => void;
  /** Per-workspace setup selected in the WorktreeBar for a reaped pending
   *  new-session placeholder. This is separate from the text draft so the
   *  placeholder can be closed without losing pre-send setup state. */
  newSessionSetupDrafts: Map<string, PendingNewSessionSetup>;

  /** Per-session unsent composer text for *non-pending* sessions — the
   *  generalization of `newSessionDrafts` to every session. The pending-new
   *  case still uses `newSessionDrafts` (keyed by workspace, not session)
   *  because a pending session is hidden from the sidebar: once the user
   *  switches away the only way back is clicking "+ New session" again, which
   *  creates a fresh session that must re-seed from the workspace slot.
   *
   *  Lets the user switch away from any real session and come back without
   *  losing what they typed. Lives only in memory — never persisted — and is
   *  read via `getState()` in the Composer's seeding effect so per-keystroke
   *  writes don't trigger re-renders. Pending new sessions deliberately do
   *  not use this map: switching away from "+ New session" closes that empty
   *  placeholder, while the workspace-scoped draft remains available for the
   *  next pending placeholder. Cleared the moment a message is actually sent. */
  sessionDrafts: Map<SessionId, string>;
  /** Update (replace) the per-session draft. Empty text deletes the entry. */
  setSessionDraft: (sessionId: SessionId, text: string) => void;

  /** Diff-viewer comments keyed per session, then by file+new-side line. */
  diffComments: Map<SessionId, Map<string, CodeComment>>;
  setDiffComment: (
    sessionId: SessionId,
    comment: { filePath: string; lineNumber: number; lineText: string; text: string },
  ) => void;
  deleteDiffComment: (sessionId: SessionId, filePath: string, lineNumber: number) => void;
  clearDiffComments: (sessionId: SessionId) => void;
  clearSubmittedDiffComments: (sessionId: SessionId, submitted: readonly CodeComment[]) => void;
  reconcileDiffCommentsForFile: (sessionId: SessionId, filePath: string, model: DiffModel) => void;
  /** Edit-aware deterministic re-anchor run BEFORE the new model becomes
   *  visible, so the generic reconcileDiffCommentsForFile sees consistent
   *  anchors and no-ops. Wraps the pure `reanchorCommentsForEdit` with Map
   *  re-keying + persistence. */
  applyDiffEditReanchor: (
    sessionId: SessionId,
    filePath: string,
    edit: {
      startNewNo: number;
      endNewNo: number;
      replacementLines: string[];
      newLineCount: number;
    },
  ) => void;
  markDiffCommentsStaleForMissingFiles: (
    sessionId: SessionId,
    currentFilePaths: ReadonlySet<string>,
  ) => void;
  getDiffCommentsForPrompt: (sessionId: SessionId) => CodeComment[];
  prependDiffCommentsToPrompt: (sessionId: SessionId, prompt: string) => string;

  addWorkspace: (path: string) => void;
  removeWorkspace: (path: string) => void;
  setWorkspaceSessions: (path: string, sessions: SessionSummary[]) => void;
  /** Toggle a workspace's session-list expansion (chevron). Does not change
   *  the active workspace. */
  toggleWorkspaceExpanded: (path: string) => void;
  /** Idempotently expand a workspace (no-op if already expanded). Used by the
   *  boot/add flows where toggling would be wrong if it's already open. */
  expandWorkspace: (path: string) => void;
  /** Set the expanded set wholesale (e.g. when syncing from settings). */
  setExpandedWorkspaces: (paths: string[]) => void;
  /** Reorder workspaces: move `from` index to `to` index in workspaceOrder. */
  reorderWorkspaces: (from: number, to: number) => void;

  createSession: (
    sessionId: SessionId,
    workspacePath: string,
    sessionFile?: string,
    name?: string,
    title?: string,
    status?: SessionStatus,
  ) => void;
  openSessionTab: (
    workspacePath: string,
    sessionFile?: string,
    opts?: { focus?: boolean },
  ) => Promise<SessionId | null>;
  closeSessionTab: (
    sessionId: SessionId,
    opts?: { preservePendingDraft?: boolean },
  ) => Promise<void>;
  removeSession: (sessionId: SessionId, opts?: { preservePendingDraft?: boolean }) => void;
  /** Archive a session: add its file path to archivedSessions in settings,
   *  close its live tab if one exists, and refresh the workspace list. */
  archiveSession: (
    sessionId: SessionId | undefined,
    filePath: string,
    workspacePath: string,
  ) => Promise<void>;
  setSessionFile: (sessionId: SessionId, sessionFile: string) => void;
  setSessionStatus: (
    sessionId: SessionId,
    status: SessionStatus,
    error?: string,
    piVersion?: string,
  ) => void;
  applyEvent: (sessionId: SessionId, event: PiEvent) => void;
  applyEvents: (sessionId: SessionId, events: PiEvent[]) => void;
  seedHistory: (sessionId: SessionId, history: HistoryPage | TranscriptBlock[]) => void;
  /** Returns true only when an older page was accepted and prepended. */
  loadEarlierHistory: (sessionId: SessionId) => Promise<boolean>;
  refreshHistoricalCacheMissNotices: (sessionId: SessionId) => Promise<void>;
  addUserMessage: (
    sessionId: SessionId,
    content: string,
    images?: string[],
    opts?: {
      registerEcho?: boolean;
      clearDraft?: boolean;
      afterUserMessageSequence?: number;
      intentId?: string;
    },
  ) => void;
  clearPendingUserEcho: (sessionId: SessionId, content: string) => void;
  addBashCommand: (sessionId: SessionId, command: string) => void;
  finishBashCommand: (sessionId: SessionId, output: string, exitCode?: number) => void;
  applyRuntimeState: (sessionId: SessionId, state: RuntimeStateUpdate) => void;
  applyTransitionBatch: (
    sessionId: SessionId,
    records: RuntimeRecord[],
    state: RuntimeStateUpdate,
  ) => void;
  applySubmissionDisposition: (sessionId: SessionId, result: SubmissionResult) => void;
  applyQueueRestoration: (
    sessionId: SessionId,
    restoration: {
      restorationId: string;
      steering: string[];
      followUp: string[];
      originalAttachments: Array<{ intentId: string; images: unknown[] }>;
      clearedIntentIds?: string[] | undefined;
      commandDescription?: string | undefined;
    },
  ) => void;
  dismissQueueRestoration: (sessionId: SessionId, restorationId: string) => Promise<void>;
  restoreQueueRestorationText: (sessionId: SessionId, restorationId: string) => void;
  /** Request that the host escape the active runtime operation. The host
   *  chooses the concrete action and returns its authoritative disposition. */
  abortSession: (sessionId: SessionId) => void;
  addUiRequest: (sessionId: SessionId, request: ExtensionUiRequest) => void;
  handlePanelEvent: (sessionId: SessionId, event: PanelEvent) => void;
  /** Run the unified-TUI editor's submitted text through the shared submit
   *  pipeline (parseComposerInput + executeAction), then reply to the host
   *  via `session.unifiedSubmitResponse` so it can restore the editor text on
   *  a guard bail (e.g. no model). Deps mirror the React Composer's exactly —
   *  including `adoptSessionFileAndHydrate` (adopt + load history + refresh the
   *  sidebar), so /fork, /clone, /switch_session, /resume work identically to
   *  the native Composer. Main assigns one stable submission intent to the
   *  unified request and reuses it across renderer reattachment, so replay can
   *  join the original admission but cannot submit the text a second time. */
  handleUnifiedSubmitRequest: (
    sessionId: SessionId,
    id: string,
    text: string,
    editorRevision: number,
    submissionIntentId: string,
    hostInstanceId: string,
    sessionEpoch: number,
  ) => Promise<void>;
  dismissUiRequest: (sessionId: SessionId, requestId: string) => void;
  addToast: (sessionId: SessionId, message: string, type?: string) => void;
  dismissToast: (sessionId: SessionId, toastId: string) => void;
  clearToasts: (sessionId: SessionId) => void;
  setNotificationPanelOpen: (sessionId: SessionId, open: boolean) => void;
  setHeaderCompact: (v: boolean) => void;

  // Worktree bar state (pre-send)
  /** Set the WorktreeBar segmented-control mode. Clears any prior
   *  `worktreeError` so a fresh mode starts with a clean status line. */
  setWorktreeMode: (sessionId: SessionId, mode: "none" | "create" | "attach") => void;
  /** Set the path input value for the "Existing" (attach) mode. Clears
   *  any prior `worktreeError`. */
  setWorktreeAttachPath: (sessionId: SessionId, path: string) => void;
  setWorktreeBase: (sessionId: SessionId, base: string | null) => void;
  setWorktreeCreating: (sessionId: SessionId, v: boolean) => void;
  /** Set (or clear, with null) the inline worktree-creation error. */
  setWorktreeError: (sessionId: SessionId, message: string | null) => void;
  /** Apply post-creation identity after a successful worktree creation. */
  applyWorktree: (
    sessionId: SessionId,
    result: {
      worktreePath: string;
      branch: string;
      name: string;
      base: string;
    },
  ) => void;
  /** Clear pre-send worktree state — called after first send. */
  clearWorktreeIntent: (sessionId: SessionId) => void;
  /** Toggle whether the live unified-TUI panel or the native Composer is
   *  shown in the flex slot. Only meaningful while a `unifiedPanel` is
   *  live; the non-visible surface is simply unrendered (its state — TUI
   *  editor contents, composer draft — is owned by its own process/store
   *  and survives the toggle). */
  setUnifiedPanelHidden: (sessionId: SessionId, hidden: boolean) => void;
  setStats: (sessionId: SessionId, stats: SessionStats) => void;
  setTreeHistoryPresent: (sessionId: SessionId, present: boolean) => void;
  setAvailableModels: (sessionId: SessionId, models: ModelInfo[]) => void;
  /** Re-fetch the session's effective available-models list from pi and
   *  update the store. This is the refresh path used after actions that
   *  change the effective scope (`set_scoped_models`, `save_scoped_models`)
   *  so the `/model` dropdown reflects the scoped subset live, mirroring
   *  pi's `getAvailableModels` which returns scoped models when scope is
   *  non-empty. Same fetch + parse dance `bootstrapModelState` runs in
   *  step 1; factored out so both callers stay in sync. Returns the parsed
   *  models so the bootstrap caller can reuse them for its last-used match
   *  without a second fetch. Best-effort: swallows fetch errors (the
   *  dropdown keeps whatever it had) and returns []. */
  refreshAvailableModels: (
    sessionId: SessionId,
    expectedRuntime?: { hostInstanceId: string; sessionEpoch: number },
  ) => Promise<ModelInfo[]>;
  setCurrentModel: (sessionId: SessionId, model: string, provider?: string) => void;
  setThinkingLevel: (sessionId: SessionId, level: ThinkingLevel) => void;
  /**
   * One-time, idempotent model/thinking-level bootstrap for a session. Seeds
   * the store with pi's authoritative model + level (from `get_available_models`
   * / `get_state`) and, for brand-new (non-resumed) sessions ONLY, applies the
   * global last-used preference. Guarded by `modelInitialized` so it runs at
   * most once per session no matter how many times the caller fires it (header
   * remounts, StrictMode double-invoke, concurrent callers). This is the sole
   * place the global preference is ever applied to a session — see the
   * model/thinking invariants on `modelInitialized`.
   */
  bootstrapModelState: (sessionId: SessionId) => Promise<void>;
  /**
   * Switch a session's model: optimistically update the store (so the dropdown
   * reflects the requested model immediately — the "queued change about to be
   * sent" half of invariant #1), send `set_model`, and **revert** to the prior
   * model if the command fails (so the dropdown never lingers on a model pi
   * didn't accept). The global last-used preference is persisted ONLY on
   * success. The single mutation path for the model dropdown / `/model`.
   */
  applyModelChange: (
    sessionId: SessionId,
    model: ModelInfo,
    expectedRuntime?: { hostInstanceId: string; sessionEpoch: number },
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Switch a session's thinking level: optimistic update, send
   * `set_thinking_level`, reconcile with pi's actually-applied level (a model
   * may clamp it), and **revert** on failure. Persists last-used only on
   * success. Returns `clampedTo` when pi applied a different level than asked.
   */
  applyThinkingLevel: (
    sessionId: SessionId,
    level: ThinkingLevel,
  ) => Promise<{ ok: boolean; error?: string; clampedTo?: ThinkingLevel }>;
  setSessionName: (sessionId: SessionId, name: string) => void;
  /** Re-point the session to a new file (overrides the only-if-unset guard). */
  adoptSessionFile: (
    sessionId: SessionId,
    sessionFile?: string,
    sessionName?: string,
  ) => Promise<void>;
  /** Adopt a new session file AND hydrate its transcript + refresh the sidebar.
   *  The single source of truth for the post-`/fork`|`/clone`|`/switch_session`|
   *  `/resume` steps, shared by the React Composer and the unified-TUI submit
   *  path so they can't drift (a bare `adoptSessionFile` alone leaves the
   *  transcript blank and the session list stale — see handleUnifiedSubmitRequest). */
  adoptSessionFileAndHydrate: (
    sessionId: SessionId,
    sessionFile?: string,
    sessionName?: string,
    expectedRuntime?: { hostInstanceId: string; sessionEpoch: number },
    continuationGuard?: () => boolean,
  ) => Promise<void>;
  /** Refresh the discovered command list (extension/prompt/skill) from pi. */
  refreshCommands: (sessionId: SessionId) => Promise<void>;
  /** Drop a fresh nonce on editorInjection so the Composer re-picks it up. */
  injectEditorText: (sessionId: SessionId, text: string) => void;
  /** Fence pending-session reaping while asynchronous image reads are in progress. */
  beginEditorAttachmentRead: (sessionId: SessionId) => void;
  endEditorAttachmentRead: (sessionId: SessionId) => void;
  /** Retain locally selected attachments while their revisioned host patch is in flight. */
  stageEditorAttachments: (sessionId: SessionId, attachments: unknown[]) => void;
  beginEditorPatch: (sessionId: SessionId) => void;
  endEditorPatch: (sessionId: SessionId) => void;
  clearEditorConflict: (sessionId: SessionId) => void;
  /** Record a host-accepted local editor patch and retire any older snapshot injection. */
  acknowledgeEditorPatch: (sessionId: SessionId, revision: number) => void;
  /** Clear a stale editorInjection so it won't re-fire on Composer remount.
   *  Called when the user takes over the textarea (types / picks a suggestion)
   *  or when content is sent — the injection is "consumed" and must not
   *  clobber the restored draft on the next switch-back. */
  clearEditorInjection: (sessionId: SessionId) => void;
  /** Open a built-in picker (model / fork / resume). Single slot. */
  openPicker: (sessionId: SessionId, picker: PickerRequest) => void;
  /** Drop any active picker. */
  closePicker: (sessionId: SessionId) => void;
  /** Append a custom_message block to the transcript (TUI parity for /session). */
  addCustomMessage: (sessionId: SessionId, content: string) => void;

  refreshWorkspaceSessions: (path: string) => Promise<void>;

  setActiveSession: (sessionId: SessionId | null) => void;
  setActiveWorkspace: (path: string | null) => void;
}

let toastCounter = 0;
let editorInjectionNonce = 0;

/** Upper bound on a session's retained panel replay buffer (chars).
 *  See the panel_data case in handlePanelEvent for the rationale. */
const PANEL_BUFFER_MAX_BYTES = 512 * 1024;

/** Keep the bounded tail used to seed a remounted panel xterm. */
function appendBoundedPanelBuffer(buffer: string[], data: string): string[] {
  const next = [...buffer, data];
  let total = 0;
  for (const chunk of next) total += chunk.length;
  while (next.length > 1 && total > PANEL_BUFFER_MAX_BYTES) {
    total -= (next.shift() as string).length;
  }
  return next;
}

/**
 * Unified pi-tui output is differential most of the time, but a forced/full
 * repaint contains a hard terminal reset (`CSI 2 J`, followed by home and
 * usually `CSI 3 J`). Anything before the LAST such reset is stale history and
 * must not be replayed into a freshly-mounted xterm after a session/view switch:
 * xterm would treat it as scrollback and the content-tracking sizer would then
 * measure a corrupted buffer. Keep only the current repaint segment (the latest
 * hard clear plus subsequent diffs), bounded as a safety net.
 */
function appendUnifiedReplayBuffer(buffer: string[], data: string): string[] {
  const hardClearAt = data.lastIndexOf("\x1b[2J");
  if (hardClearAt >= 0) {
    return appendBoundedPanelBuffer([], data.slice(hardClearAt));
  }
  return appendBoundedPanelBuffer(buffer, data);
}

type SessionsSet = Parameters<StateCreator<SessionsStore>>[0];
type SessionsGet = Parameters<StateCreator<SessionsStore>>[1];

const buildSessionsStore = (
  set: SessionsSet,
  get: SessionsGet,
  runAtomically: (operation: () => void) => void,
): SessionsStore => ({
  workspaces: new Map(),
  sessions: new Map(),
  activeSessionId: null,
  activeWorkspacePath: null,
  expandedWorkspaces: [],
  headerCompact: false,
  newSessionDrafts: new Map(),
  newSessionSetupDrafts: new Map(),
  sessionDrafts: new Map(),
  diffComments: loadPersistedCodeComments(),

  addWorkspace: (path) => {
    set((state) => {
      const workspaces = new Map(state.workspaces);
      if (!workspaces.has(path)) {
        workspaces.set(path, { path, sessions: [], activeSessions: [] });
      }
      return { workspaces };
    });
  },

  removeWorkspace: (path) => {
    set((state) => {
      const workspaces = new Map(state.workspaces);
      workspaces.delete(path);
      const drafts = new Map(state.newSessionDrafts);
      drafts.delete(path);
      const setupDrafts = new Map(state.newSessionSetupDrafts);
      setupDrafts.delete(path);
      return {
        workspaces,
        activeWorkspacePath: state.activeWorkspacePath === path ? null : state.activeWorkspacePath,
        expandedWorkspaces: state.expandedWorkspaces.filter((p) => p !== path),
        newSessionDrafts: drafts,
        newSessionSetupDrafts: setupDrafts,
      };
    });
  },

  setWorkspaceSessions: (path, sessions) => {
    set((state) => {
      const workspaces = new Map(state.workspaces);
      const ws = workspaces.get(path);
      if (ws) {
        workspaces.set(path, { ...ws, sessions });
      }
      return { workspaces };
    });
  },

  toggleWorkspaceExpanded: (path) => {
    set((state) => ({
      expandedWorkspaces: state.expandedWorkspaces.includes(path)
        ? state.expandedWorkspaces.filter((p) => p !== path)
        : [...state.expandedWorkspaces, path],
    }));
  },

  expandWorkspace: (path) => {
    set((state) =>
      state.expandedWorkspaces.includes(path)
        ? {}
        : { expandedWorkspaces: [...state.expandedWorkspaces, path] },
    );
  },

  setExpandedWorkspaces: (paths) => set({ expandedWorkspaces: paths }),

  reorderWorkspaces: (from, to) => {
    set((state) => {
      const order = Array.from(state.workspaces.keys());
      if (from < 0 || from >= order.length || to < 0 || to >= order.length || from === to) {
        return {};
      }
      const [moved] = order.splice(from, 1);
      if (moved) order.splice(to, 0, moved);
      const workspaces = new Map<string, WorkspaceState>();
      for (const p of order) {
        const ws = state.workspaces.get(p);
        if (ws) workspaces.set(p, ws);
      }
      return { workspaces };
    });
  },

  createSession: (sessionId, workspacePath, sessionFile, name, title, status) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const pendingSetup = sessionFile ? undefined : state.newSessionSetupDrafts.get(workspacePath);
      sessions.set(sessionId, {
        sessionId,
        workspacePath,
        sessionFile,
        status: status ?? "cold",
        sessionTitle: title,
        sessionName: name,
        transcript: createTranscriptState(),
        availability: "unavailable",
        runtimeSnapshot: undefined,
        hostInstanceId: undefined,
        sessionEpoch: 0,
        editorRevision: 0,
        editorAttachments: [],
        editorAttachmentReads: 0,
        editorPatchPending: 0,
        queuedMessages: undefined,
        unreadStatus: undefined,
        turnErrored: false,
        pendingDialogs: [],
        commands: [],
        statusSegments: new Map(),
        widgets: new Map(),
        toasts: [],
        notificationPanelOpen: false,
        availableModels: [],
        // Pending-new WorktreeBar setup is workspace-scoped so a switch-away
        // reap can close the unused session while the next placeholder restores
        // the user's selected mode/base/path.
        worktreeMode: pendingSetup?.worktreeMode,
        worktreeAttachPath: pendingSetup?.worktreeAttachPath,
        worktreeBase: pendingSetup?.worktreeBase,
        worktreeCreating: undefined,
        worktreeError: undefined,
        worktreePath: undefined,
        worktreeBranch: undefined,
        worktreeName: undefined,
        worktreeFromBase: undefined,
        // Fresh sessions (no file yet) sort to the top; resumed sessions
        // leave this undefined and fall back to their file mtime.
        lastActivityAt: sessionFile ? undefined : Date.now(),
        // Brand-new sessions are hidden from the sidebar until their first
        // message lands; the "+ New session" button shows as selected
        // instead. Resumed sessions always show normally.
        isNewPending: !sessionFile,
        // Resumed sessions had a file at open time; new sessions did not.
        // Gates last-used model/thinking-level preference (new sessions only).
        resumed: !!sessionFile,
        // No tree has been loaded yet; this becomes true when history is
        // discovered via loadHistory or the native `/tree` viewer.
        hasTreeHistory: false,
        historyGeneration: 0,
        // Bootstrap hasn't run yet — it fires once when the session goes live.
        modelInitialized: false,
      });
      const workspaces = new Map(state.workspaces);
      const ws = workspaces.get(workspacePath);
      if (ws) {
        workspaces.set(workspacePath, {
          ...ws,
          activeSessions: [...ws.activeSessions, sessionId],
        });
      }
      return { sessions, workspaces };
    });
  },

  removeSession: (sessionId, opts) => {
    pendingThinkingRequests.delete(sessionId);
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.delete(sessionId);
      const workspaces = new Map(state.workspaces);
      const ws = workspaces.get(s.workspacePath);
      if (ws) {
        workspaces.set(s.workspacePath, {
          ...ws,
          activeSessions: ws.activeSessions.filter((id) => id !== sessionId),
        });
      }
      const wasPending = isNewSessionPending(s);
      // Dropping a still-pending new session normally clears its per-workspace
      // draft/setup (explicit close/workspace removal). The automatic
      // switch-away reap is the exception: it closes only the unused session
      // record/process and keeps the draft + WorktreeBar setup so the next
      // "+ New session" in that workspace restores the user's unsent state
      // without accumulating hidden sessions.
      const drafts = opts?.preservePendingDraft
        ? state.newSessionDrafts
        : clearNewSessionDraftFor(state.newSessionDrafts, s.workspacePath, wasPending);
      const setupDrafts =
        opts?.preservePendingDraft && wasPending
          ? new Map(state.newSessionSetupDrafts).set(
              s.workspacePath,
              capturePendingNewSessionSetup(s),
            )
          : clearNewSessionSetupFor(state.newSessionSetupDrafts, s.workspacePath, wasPending);
      // Drop this session's per-session draft too — it should never resurface
      // on some other session. No-op if nothing was stored.
      const sessionDrafts = clearSessionDraftFor(state.sessionDrafts, sessionId);
      const existingComments = state.diffComments.get(sessionId);
      const diffComments =
        s.sessionFile && existingComments ? new Map(state.diffComments) : state.diffComments;
      if (s.sessionFile && existingComments && diffComments !== state.diffComments) {
        diffComments.delete(sessionId);
        diffComments.set(diffCommentsStorageSessionKey(s.sessionFile), existingComments);
        persistCodeComments(diffComments);
      }
      return {
        sessions,
        workspaces,
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
        newSessionDrafts: drafts,
        newSessionSetupDrafts: setupDrafts,
        sessionDrafts,
        ...(diffComments !== state.diffComments ? { diffComments } : {}),
      };
    });
  },

  setSessionFile: (sessionId, sessionFile) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      if (s.sessionFile) return {};
      sessions.set(sessionId, { ...s, sessionFile });
      return { sessions };
    });
  },

  setSessionStatus: (sessionId, status, error, piVersion) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (s) {
        // S1/S2: a terminal status means the turn is definitively over (host
        // exited/failed). Clear isStreaming + the working timer so the
        // indicator stops and the ESC handler never fires abort at a dead
        // session. ONLY when transitioning INTO a terminal status — never on
        // a benign ready/starting re-emission (which would prematurely clear
        // a live turn).
        const TERMINAL: ReadonlySet<SessionStatus> = new Set(["exited", "failed"]);
        const becomingTerminal = TERMINAL.has(status) && !TERMINAL.has(s.status);
        // Only store piVersion when explicitly provided (a non-host "ready"
        // or a status change without version info mustn't clobber a prior
        // value). See P1-c.
        const transcript = becomingTerminal ? finalizeActiveBlocks(s.transcript) : s.transcript;
        const runtime = becomingTerminal || status === "starting" ? resetRuntimeState(s) : s;
        sessions.set(sessionId, {
          ...runtime,
          status,
          error,
          transcript,
          ...(piVersion !== undefined ? { piVersion } : {}),
        });
      }
      return { sessions };
    });
    if (status === "ready") void get().refreshHistoricalCacheMissNotices(sessionId);
  },

  applyEvent: (sessionId, rawEvent) => {
    get().applyEvents(sessionId, [rawEvent]);
  },

  applyEvents: (sessionId, rawEvents) => {
    const events = rawEvents.filter(
      (rawEvent): rawEvent is KnownPiEvent => !("__unknown" in rawEvent),
    );
    if (events.length === 0) return;

    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};

      let current = s;
      let newSessionDrafts = state.newSessionDrafts;
      let newSessionSetupDrafts = state.newSessionSetupDrafts;
      let sessionDrafts = state.sessionDrafts;
      let anyPromoted = false;

      for (const event of events) {
        let unreadStatus = current.unreadStatus;
        let turnErrored = current.turnErrored;
        if (event.type === "agent_start") {
          // Runtime liveness comes only from direct snapshots; lifecycle events
          // update transcript/result metadata but never runtime booleans.
          turnErrored = false;
          unreadStatus = undefined;
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          if (detectTurnError(event.message).isError) turnErrored = true;
        }
        if (event.type === "auto_retry_end" && event.success === false) turnErrored = true;
        const transcript = applyPiEvent(current.transcript, event);
        const authoritativeUserEcho =
          transcript.userMessageSequence > current.transcript.userMessageSequence
            ? transcript.authoritativeUserEchoes.at(-1)
            : undefined;
        const consumedPendingEcho =
          transcript.pendingEchoes.length < current.transcript.pendingEchoes.length;
        // Delivery transfers visible ownership atomically from the queued
        // projection to the normal transcript bubble only when no optimistic
        // bubble already owned this echo. Otherwise removing another matching
        // item would collapse repeated identical queued submissions.
        const queuedMessages =
          authoritativeUserEcho?.intentId && !consumedPendingEcho
            ? removeQueuedMessageByIntent(current.queuedMessages, authoritativeUserEcho.intentId)
            : current.queuedMessages;
        // Raw Pi events remain authoritative for durable/session metadata and
        // transcript detail. They deliberately do not derive runtime liveness:
        // only direct host snapshots may change working/idle state.
        const thinkingLevel =
          event.type === "thinking_level_changed" ? event.level : current.thinkingLevel;
        const sessionName =
          event.type === "session_info_changed" ? event.name : current.sessionName;
        const userEchoed =
          event.type === "message_start" &&
          event.message?.role === "user" &&
          transcriptBlockCount(transcript) > transcriptBlockCount(current.transcript);
        const promoted = !!current.isNewPending && userEchoed;
        if (promoted) {
          const pendingDraft = newSessionDrafts.get(current.workspacePath);
          newSessionDrafts = clearNewSessionDraftFor(newSessionDrafts, current.workspacePath, true);
          if (pendingDraft !== undefined) {
            sessionDrafts = setSessionDraftFor(sessionDrafts, sessionId, pendingDraft);
          }
          newSessionSetupDrafts = clearNewSessionSetupFor(
            newSessionSetupDrafts,
            current.workspacePath,
            true,
          );
          anyPromoted = true;
        }
        current = {
          ...current,
          transcript,
          queuedMessages,
          thinkingLevel,
          sessionName,
          unreadStatus,
          turnErrored,

          isNewPending: promoted ? false : current.isNewPending,
          editorInjection: promoted ? undefined : current.editorInjection,
        };
      }

      sessions.set(sessionId, current);
      return anyPromoted
        ? { sessions, newSessionDrafts, newSessionSetupDrafts, sessionDrafts }
        : { sessions };
    });
  },

  seedHistory: (sessionId, history) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const page = Array.isArray(history)
        ? { blocks: history, startIndex: 0, total: history.length }
        : history;
      const transcript = seedFromHistory(s.transcript, page.blocks);
      sessions.set(sessionId, {
        ...s,
        transcript,
        historyCursor: { startIndex: page.startIndex, total: page.total },
        historyGeneration: s.historyGeneration + 1,
        historyLoadingEarlier: undefined,
        hasTreeHistory: s.hasTreeHistory || page.total > 0,
      });
      return { sessions };
    });
    if (get().sessions.get(sessionId)?.status === "ready") {
      void get().refreshHistoricalCacheMissNotices(sessionId);
    }
  },

  loadEarlierHistory: async (sessionId) => {
    const s = get().sessions.get(sessionId);
    const cursor = s?.historyCursor;
    if (!s?.sessionFile || !cursor || cursor.startIndex <= 0 || s.historyLoadingEarlier)
      return false;
    const requestedStartIndex = cursor.startIndex;
    const requestedFile = s.sessionFile;
    const historyCapture = captureHistoryRead(s);
    if (!historyCapture) return false;
    set((state) => {
      const sessions = new Map(state.sessions);
      const cur = sessions.get(sessionId);
      if (!cur || cur.historyCursor?.startIndex !== requestedStartIndex) return {};
      sessions.set(sessionId, { ...cur, historyLoadingEarlier: true });
      return { sessions };
    });
    let accepted = false;
    try {
      const page = await requestBoundHistoryPage(sessionId, historyCapture, {
        before: requestedStartIndex,
      });
      set((state) => {
        const sessions = new Map(state.sessions);
        const cur = sessions.get(sessionId);
        if (!cur) return {};
        if (
          cur.sessionFile !== requestedFile ||
          cur.historyGeneration !== historyCapture.historyGeneration ||
          cur.historyCursor?.startIndex !== requestedStartIndex
        ) {
          return {};
        }
        if (!page) {
          sessions.set(sessionId, { ...cur, historyLoadingEarlier: undefined });
          return { sessions };
        }
        // A page based on a concurrently shortened/rewritten file can carry a
        // lower cursor but no older transcript blocks. Treat it as stale: if
        // we advanced the cursor, the retry affordance would disappear even
        // though nothing became visible.
        const transcript = prependHistory(cur.transcript, page.blocks);
        if (transcript === cur.transcript || page.startIndex >= requestedStartIndex) {
          sessions.set(sessionId, { ...cur, historyLoadingEarlier: undefined });
          return { sessions };
        }
        sessions.set(sessionId, {
          ...cur,
          transcript,
          historyCursor: { startIndex: page.startIndex, total: page.total },
          historyGeneration: cur.historyGeneration + 1,
          historyLoadingEarlier: undefined,
          hasTreeHistory: cur.hasTreeHistory || page.total > 0,
        });
        accepted = true;
        return { sessions };
      });
    } catch (err) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const cur = sessions.get(sessionId);
        if (
          !cur ||
          cur.sessionFile !== requestedFile ||
          cur.historyGeneration !== historyCapture.historyGeneration ||
          cur.historyCursor?.startIndex !== requestedStartIndex
        )
          return {};
        sessions.set(sessionId, { ...cur, historyLoadingEarlier: undefined });
        return { sessions };
      });
      console.error("Failed to load earlier history:", err);
      return false;
    }
    if (accepted) void get().refreshHistoricalCacheMissNotices(sessionId);
    return accepted;
  },

  refreshHistoricalCacheMissNotices: async (sessionId) => {
    const session = get().sessions.get(sessionId);
    if (
      !session?.sessionFile ||
      session.status !== "ready" ||
      session.availability !== "available" ||
      !session.hostInstanceId
    )
      return;
    const runtime = {
      hostInstanceId: session.hostInstanceId,
      sessionEpoch: session.sessionEpoch,
    };
    const sessionEpoch = session.sessionEpoch;
    const sessionFile = session.sessionFile;
    try {
      const response = await invokeSessionCommand(
        sessionId,
        { type: "get_cache_miss_notices" },
        runtime,
      );
      if (!response.success) return;
      const parsed = CacheMissNoticeEventSchema.array().safeParse(
        (response.data as { notices?: unknown } | undefined)?.notices,
      );
      if (!parsed.success) return;
      const current = get().sessions.get(sessionId);
      if (current?.sessionEpoch !== sessionEpoch || current.sessionFile !== sessionFile) return;
      get().applyEvents(sessionId, parsed.data);
    } catch {}
  },

  addUserMessage: (sessionId, content, images, opts) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const arrivedEchoIndex =
        opts?.registerEcho === true &&
        opts.afterUserMessageSequence !== undefined &&
        opts.intentId !== undefined
          ? s.transcript.authoritativeUserEchoes.findIndex(
              (echo) =>
                echo.sequence > (opts.afterUserMessageSequence ?? Number.MAX_SAFE_INTEGER) &&
                echo.intentId === opts.intentId &&
                (echo.images?.length ?? 0) === (images?.length ?? 0) &&
                (echo.images ?? []).every((image, index) => image === images?.[index]),
            )
          : -1;
      const echoAlreadyArrived = arrivedEchoIndex >= 0;
      const transcript = echoAlreadyArrived
        ? {
            ...s.transcript,
            // An authoritative echo may settle only one submission response.
            // Consume it so concurrent identical submissions cannot both
            // claim the same already-rendered bubble.
            authoritativeUserEchoes: [
              ...s.transcript.authoritativeUserEchoes.slice(0, arrivedEchoIndex),
              ...s.transcript.authoritativeUserEchoes.slice(arrivedEchoIndex + 1),
            ],
          }
        : addUserBlock(s.transcript, content, images, opts?.registerEcho ?? true, opts?.intentId);
      // A queued snapshot can legally arrive before the submit response. Once
      // the optimistic normal bubble owns this prompt, retire exactly one
      // matching queued projection in the same Zustand commit.
      const queuedMessages =
        !echoAlreadyArrived && opts?.registerEcho !== false && opts?.intentId
          ? removeQueuedMessageByIntent(s.queuedMessages, opts.intentId)
          : s.queuedMessages;
      // Self-label a brand-new session from its first prompt so the tab and
      // header have a meaningful identity before pi or the user renames it.
      // Do not overwrite a name set by pi (session_info_changed → sessionName)
      // or a title set by an extension (setTitle → sessionTitle) or by the
      // resume preview path (createSession's `title` param).
      let sessionTitle = s.sessionTitle;
      if (!s.sessionName && !sessionTitle) {
        const firstLine = content.trim().split("\n", 1)[0] ?? "";
        const trimmed = firstLine.slice(0, 80);
        if (trimmed.length > 0) sessionTitle = trimmed;
      }
      // Submitting a prompt is the only thing that promotes a session in the
      // sidebar order — opening/activating it does not (see lastActivityAt).
      sessions.set(sessionId, {
        ...s,
        transcript,
        queuedMessages,
        sessionTitle,
        lastActivityAt: Date.now(),
        isNewPending: false,
        editorInjection: undefined,
      });
      // A Composer may have newer text by the time host custody returns.
      // Promote that pending-session draft to the real session before clearing
      // the workspace slot; the caller clears it only when the accepted
      // submission still owns the same local edit generation.
      const pendingDraft = s.isNewPending ? state.newSessionDrafts.get(s.workspacePath) : undefined;
      const drafts = clearNewSessionDraftFor(
        state.newSessionDrafts,
        s.workspacePath,
        !!s.isNewPending,
      );
      const setupDrafts = clearNewSessionSetupFor(
        state.newSessionSetupDrafts,
        s.workspacePath,
        !!s.isNewPending,
      );
      let sessionDrafts: Map<SessionId, string>;
      if (opts?.clearDraft === false) {
        sessionDrafts = new Map(state.sessionDrafts);
        if (pendingDraft !== undefined) sessionDrafts.set(sessionId, pendingDraft);
      } else {
        sessionDrafts = clearSessionDraftFor(state.sessionDrafts, sessionId);
      }
      return {
        sessions,
        newSessionDrafts: drafts,
        newSessionSetupDrafts: setupDrafts,
        sessionDrafts,
      };
    });
  },

  clearPendingUserEcho: (sessionId, content) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const wasEmptyBeforeOptimisticSend = transcriptBlockCount(s.transcript) <= 1;
      const transcript = clearPendingUserEcho(s.transcript, content);
      if (transcript === s.transcript) return {};
      const restoredPending =
        !s.resumed && wasEmptyBeforeOptimisticSend && !transcriptHasBlocks(transcript);
      sessions.set(sessionId, {
        ...s,
        transcript,
        isNewPending: restoredPending ? true : s.isNewPending,
      });
      const newSessionDrafts = restoredPending
        ? setNewSessionDraftFor(state.newSessionDrafts, s.workspacePath, content)
        : state.newSessionDrafts;
      const sessionDrafts = restoredPending
        ? state.sessionDrafts
        : setSessionDraftFor(state.sessionDrafts, sessionId, content);
      return { sessions, newSessionDrafts, sessionDrafts };
    });
  },

  addBashCommand: (sessionId, command) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const transcript = addBashBlock(s.transcript, command);
      sessions.set(sessionId, {
        ...s,
        transcript,
        isNewPending: false,
        editorInjection: undefined,
      });
      // Clear the per-workspace draft when the pending session becomes real
      // (see addUserMessage for rationale).
      const drafts = clearNewSessionDraftFor(
        state.newSessionDrafts,
        s.workspacePath,
        !!s.isNewPending,
      );
      const setupDrafts = clearNewSessionSetupFor(
        state.newSessionSetupDrafts,
        s.workspacePath,
        !!s.isNewPending,
      );
      const sessionDrafts = clearSessionDraftFor(state.sessionDrafts, sessionId);
      return {
        sessions,
        newSessionDrafts: drafts,
        newSessionSetupDrafts: setupDrafts,
        sessionDrafts,
      };
    });
  },

  finishBashCommand: (sessionId, output, exitCode) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const transcript = finishBashBlock(s.transcript, output, exitCode);
      sessions.set(sessionId, {
        ...s,
        transcript,
      });
      return { sessions };
    });
  },

  applyRuntimeState: (sessionId, runtimeState) => {
    set((state) => {
      const current = state.sessions.get(sessionId);
      if (!current) return {};
      const incomingSnapshot = runtimeState.snapshot;
      const prior = current.runtimeSnapshot;
      const staleSnapshot =
        !!incomingSnapshot &&
        prior?.hostInstanceId === incomingSnapshot.hostInstanceId &&
        (incomingSnapshot.sessionEpoch < prior.sessionEpoch ||
          (incomingSnapshot.sessionEpoch === prior.sessionEpoch &&
            incomingSnapshot.snapshotSequence <= prior.snapshotSequence));
      // Availability is an independently sequenced transport fact. Main may
      // intentionally repeat the last snapshot when a lease expires or a
      // transition starts; reject only stale snapshot replacement, never the
      // unavailable/transitioning update itself.
      const snapshot = staleSnapshot ? undefined : incomingSnapshot;
      const available =
        runtimeState.availability === "available" && !!(snapshot ?? current.runtimeSnapshot);
      // Preserve the last direct snapshot for diagnostics and correlated
      // resumption; availability gates every selector, so this cannot be
      // mistaken for current idle/running authority while transport is fenced.
      const nextSnapshot = snapshot ?? current.runtimeSnapshot;
      const wasRunning = isSessionWorking(current);
      const nowRunning = available && nextSnapshot?.isStreaming === true;
      const authoritativeTurnEnded =
        prior?.isStreaming === true &&
        runtimeState.availability === "available" &&
        snapshot?.isStreaming === false &&
        snapshot.hostInstanceId === prior.hostInstanceId &&
        snapshot.sessionEpoch === prior.sessionEpoch;
      const catalog = snapshot?.catalog;
      const statusSegments = catalog
        ? new Map(Object.entries(catalog.statuses))
        : current.statusSegments;
      const widgets = catalog ? new Map(Object.entries(catalog.widgets)) : current.widgets;
      const knownToastIds = new Set(current.toasts.map((toast) => toast.id));
      const replicatedToasts = catalog
        ? [
            ...catalog.notifications
              .filter((notice) => !knownToastIds.has(notice.id))
              .map((notice) => ({
                id: notice.id,
                message: notice.message,
                type: notice.type,
                createdAt: Date.now(),
              })),
            ...catalog.capabilityDiagnostics
              // A local public Theme is the expected, fully functional path
              // for pi-vis-owned panels on current Pi. Keep the limitation in
              // replicated diagnostics, but do not alarm users on every
              // session startup for this non-actionable decorative fallback.
              .filter((message) => message !== LOCAL_THEME_FALLBACK_DIAGNOSTIC)
              .map((message) => ({ id: `capability:${message}`, message }))
              .filter((notice) => !knownToastIds.has(notice.id))
              .map((notice) => ({
                ...notice,
                type: "warning",
                createdAt: Date.now(),
              })),
          ]
        : [];
      const editorGenerationChanged =
        !!snapshot &&
        (current.hostInstanceId !== snapshot.hostInstanceId ||
          current.sessionEpoch !== snapshot.sessionEpoch);
      const editorChanged =
        !!snapshot &&
        (editorGenerationChanged || snapshot.editor.revision > current.editorRevision);
      const localDraft = state.sessionDrafts.get(sessionId) ?? "";
      const localEditorDiverged =
        !!snapshot &&
        editorGenerationChanged &&
        (localDraft !== snapshot.editor.text ||
          JSON.stringify(current.editorAttachments) !==
            JSON.stringify(snapshot.editor.attachments));
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        availability: runtimeState.availability,
        runtimeSnapshot: nextSnapshot,
        hostInstanceId:
          runtimeState.hostInstanceId ?? snapshot?.hostInstanceId ?? current.hostInstanceId,
        sessionEpoch: snapshot?.sessionEpoch ?? current.sessionEpoch,
        historyGeneration: editorGenerationChanged
          ? current.historyGeneration + 1
          : current.historyGeneration,
        historyLoadingEarlier: editorGenerationChanged ? undefined : current.historyLoadingEarlier,
        editorRevision: editorChanged
          ? (snapshot?.editor.revision ?? current.editorRevision)
          : current.editorRevision,
        editorAttachments:
          editorChanged && !localEditorDiverged && current.editorPatchPending === 0
            ? (snapshot?.editor.attachments ?? [])
            : current.editorAttachments,
        editorConflict: snapshot
          ? editorConflictFromCandidates(
              snapshot.editor,
              localEditorDiverged
                ? { text: localDraft, attachments: current.editorAttachments }
                : undefined,
            )
          : current.editorConflict,
        // Snapshot editor state is replicated host state. Conflict text stays
        // separately available in the host snapshot; never replace a local edit
        // with it while a conflict is being reviewed.
        editorInjection:
          editorChanged &&
          current.editorPatchPending === 0 &&
          !localEditorDiverged &&
          snapshot?.editor.conflictText === undefined
            ? {
                text: snapshot.editor.text,
                nonce: ++editorInjectionNonce,
                revision: snapshot.editor.revision,
              }
            : current.editorInjection,
        unreadStatus: authoritativeTurnEnded
          ? current.turnErrored || current.unreadStatus === "error"
            ? "error"
            : "done"
          : current.unreadStatus,
        turnErrored: authoritativeTurnEnded ? false : current.turnErrored,
        runningSince:
          !wasRunning && nowRunning
            ? Date.now()
            : wasRunning && !nowRunning
              ? undefined
              : current.runningSince,
        queuedMessages: snapshot
          ? queuedMessagesFromSnapshot(
              snapshot.steering,
              snapshot.followUp,
              snapshot.steeringIntentIds,
              snapshot.followUpIntentIds,
              current.transcript.pendingEchoes,
            )
          : current.queuedMessages,
        currentModel: snapshot?.model?.id ?? current.currentModel,
        currentProvider: snapshot?.model?.provider ?? current.currentProvider,
        thinkingLevel: snapshot?.thinkingLevel ?? current.thinkingLevel,
        sessionFile: snapshot?.sessionFile ?? current.sessionFile,
        sessionName: snapshot ? snapshot.sessionName : current.sessionName,
        statusSegments,
        widgets,
        toasts: replicatedToasts.length ? [...current.toasts, ...replicatedToasts] : current.toasts,
        sessionTitle: catalog?.title ?? current.sessionTitle,
      });
      return { sessions };
    });
  },

  applyTransitionBatch: (sessionId, records, runtimeState) => {
    runAtomically(() => {
      for (const record of records) {
        if (record.type === "event") get().applyEvents(sessionId, [record.event]);
        else if (record.type === "ui") get().addUiRequest(sessionId, record.request);
        else if (record.type === "panel") get().handlePanelEvent(sessionId, record.event);
        else if (record.type === "submission") {
          get().applySubmissionDisposition(sessionId, record.result);
        } else if (record.type === "queue_restoration") {
          get().applyQueueRestoration(sessionId, record);
        }
      }
      get().applyRuntimeState(sessionId, runtimeState);
    });
  },

  applyQueueRestoration: (sessionId, restoration) => {
    const clearedIntentIds = restoration.clearedIntentIds ?? [];
    if (clearedIntentIds.length > 0) {
      set((state) => {
        const current = state.sessions.get(sessionId);
        if (!current) return {};
        const transcript = retirePendingUserEchoesByIntent(current.transcript, clearedIntentIds);
        if (transcript === current.transcript) return {};
        const sessions = new Map(state.sessions);
        sessions.set(sessionId, { ...current, transcript });
        return { sessions };
      });
    }
    const hasRecoverableText = [...restoration.steering, ...restoration.followUp].some(
      (value) => value.trim().length > 0,
    );
    const hasRecoverableAttachments = restoration.originalAttachments.some(
      (item) => item.images.length > 0,
    );
    const hasCommandReview = !!restoration.commandDescription?.trim();
    // A zero-payload custody marker gives the user nothing to review. Retire it
    // through the same main acknowledgement instead of rendering an alarming,
    // empty recovery card that can only be dismissed.
    if (!hasRecoverableText && !hasRecoverableAttachments && !hasCommandReview) {
      void window.pivis.invoke("session.acknowledgeRestoration", {
        sessionId,
        restorationId: restoration.restorationId,
      });
      return;
    }
    const session = get().sessions.get(sessionId);
    if (
      !session ||
      session.queueRestorations?.some((item) => item.restorationId === restoration.restorationId)
    ) {
      return;
    }
    const restored = [...restoration.steering, ...restoration.followUp].join("\n\n");
    const currentDraft =
      get().sessionDrafts.get(sessionId) ??
      session.editorInjection?.text ??
      session.runtimeSnapshot?.editor.text ??
      "";
    set((state) => {
      const current = state.sessions.get(sessionId);
      if (!current) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        queueRestorations: [...(current.queueRestorations ?? []), structuredClone(restoration)],
      });
      return { sessions };
    });
    // Never overwrite newer typing. With a non-empty editor the review card
    // exposes an explicit Restore action instead.
    if (restored && !hasCommandReview && currentDraft.trim() === "") {
      get().injectEditorText(sessionId, restored);
    }
    get().addToast(
      sessionId,
      hasCommandReview
        ? "A command may have completed before acknowledgement; review it before retrying."
        : "Queued text and possible original attachments require review; extensions may have transformed or consumed queue items.",
      "warning",
    );
  },

  dismissQueueRestoration: async (sessionId, restorationId) => {
    const response = await window.pivis.invoke("session.acknowledgeRestoration", {
      sessionId,
      restorationId,
    });
    if (!response.acknowledged) return;
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...session,
        queueRestorations: (session.queueRestorations ?? []).filter(
          (item) => item.restorationId !== restorationId,
        ),
      });
      return { sessions };
    });
  },

  restoreQueueRestorationText: (sessionId, restorationId) => {
    const restoration = get()
      .sessions.get(sessionId)
      ?.queueRestorations?.find((item) => item.restorationId === restorationId);
    if (!restoration) return;
    const restored = [...restoration.steering, ...restoration.followUp].join("\n\n");
    if (restored) get().injectEditorText(sessionId, restored);
  },

  applySubmissionDisposition: (sessionId, result) => {
    if (result.disposition === "outcome_unknown" || result.disposition === "extension_error") {
      get().addToast(
        sessionId,
        result.message ??
          (result.disposition === "outcome_unknown"
            ? "Submission outcome is unknown; review it before retrying."
            : "Extension command failed."),
        result.disposition === "outcome_unknown" ? "warning" : "error",
      );
    }
  },

  abortSession: (sessionId) => {
    // ESC routing is host-authoritative: renderer state never decides whether
    // an abort is applicable. The acknowledged disposition is retained in the
    // runtime record/snapshot and surfaced if it is exceptional.
    const requestId = crypto.randomUUID();
    const session = get().sessions.get(sessionId);
    if (!session?.hostInstanceId || session.availability !== "available") return;
    void window.pivis
      .invoke("session.escape", {
        sessionId,
        requestId,
        expectedHostInstanceId: session.hostInstanceId,
        expectedSessionEpoch: session.sessionEpoch,
      })
      .then((result) => {
        if (result.disposition === "failed" || result.disposition === "outcome_unknown") {
          get().addToast(
            sessionId,
            result.message ?? "Interrupt outcome is unknown.",
            result.disposition === "outcome_unknown" ? "warning" : "error",
          );
        }
      })
      .catch((error) => get().addToast(sessionId, String(error), "error"));
  },

  addUiRequest: (sessionId, request) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s) return {};

      // Handle fire-and-forget methods as side effects
      if (
        ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)
      ) {
        // Build the clone only when we actually need to mutate.
        const sessions = new Map(state.sessions);
        const sFinal = s;

        if (request.method === "notify") {
          const toastId = `toast-${++toastCounter}`;
          const notifyReq = request as { message: string; notifyType?: string };
          sessions.set(sessionId, {
            ...sFinal,
            toasts: [
              ...sFinal.toasts,
              {
                id: toastId,
                message: notifyReq.message,
                type: notifyReq.notifyType,
                createdAt: Date.now(),
              },
            ],
          });
        } else if (request.method === "setStatus") {
          // Pi sends `statusText: undefined` to clear a segment (the field is
          // omitted from the JSON wire). A present `statusText` (including the
          // empty string) replaces the entry. `Map.delete` on a non-existent
          // key is a no-op, so clearing a missing key is safe.
          const statusSegments = new Map(sFinal.statusSegments);
          const sr = request as { statusKey: string; statusText?: string };
          if (sr.statusText === undefined) {
            statusSegments.delete(sr.statusKey);
          } else {
            statusSegments.set(sr.statusKey, sr.statusText);
          }
          sessions.set(sessionId, { ...sFinal, statusSegments });
        } else if (request.method === "setWidget") {
          // Same clear-on-undefined contract as setStatus. The store keeps
          // `widgets` typed as `Map<string, string[]>` and guarantees no
          // undefined values, so the Composer's widget strip never has to
          // guard for them.
          const widgets = new Map(sFinal.widgets);
          const wr = request as { widgetKey: string; widgetLines?: string[] };
          if (wr.widgetLines === undefined) {
            widgets.delete(wr.widgetKey);
          } else {
            widgets.set(wr.widgetKey, wr.widgetLines);
          }
          sessions.set(sessionId, { ...sFinal, widgets });
        } else if (request.method === "setTitle") {
          const tr = request as { title: string };
          sessions.set(sessionId, { ...sFinal, sessionTitle: tr.title });
        } else if (request.method === "set_editor_text") {
          // Editor injection is consumed by the Composer via a useEffect on
          // editorInjection.nonce. The nonce is a monotonic counter so the
          // same Composer instance can re-inject the same text on demand.
          const er = request as { text: string };
          sessions.set(sessionId, {
            ...sFinal,
            editorInjection: { text: er.text, nonce: ++editorInjectionNonce },
          });
        }
        return { sessions };
      }

      // Dialog requests — queue them. Build the clone only when we mutate.
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...s, pendingDialogs: [...s.pendingDialogs, request] });
      return { sessions };
    });
  },

  dismissUiRequest: (sessionId, requestId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        pendingDialogs: s.pendingDialogs.filter((d) => d.id !== requestId),
      });
      return { sessions };
    });
  },

  handlePanelEvent: (sessionId, event) => {
    const current = get().sessions.get(sessionId);
    if (event.type === "panel_open" || event.type === "panel_close") {
      // A host may reuse a numeric panel id after restart and React may
      // coalesce clear/open renders. Every open is nevertheless a new
      // host-bound input stream whose sequence starts at zero.
      forgetPanelInputSequence(sessionId, event.panelId);
    } else if (event.type === "panel_clear_all" && current?.panel) {
      forgetPanelInputSequence(sessionId, current.panel.id);
    } else if (event.type === "unified_panel_reset" && current?.unifiedPanel) {
      forgetPanelInputSequence(sessionId, current.unifiedPanel.id);
    }
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s) return {};
      const sessions = new Map(state.sessions);

      switch (event.type) {
        case "panel_open":
          if (event.unified) {
            // Persistent unified-TUI panel (factory setWidget) — rendered by
            // UnifiedTuiHost, NOT the transient custom() overlay path.
            // A fresh panel always starts visible (user can toggle to the
            // Composer via the view switcher afterwards).
            sessions.set(sessionId, {
              ...s,
              unifiedPanel: {
                id: event.panelId,
                hostInstanceId: event.hostInstanceId ?? s.hostInstanceId ?? "",
                sessionEpoch: event.sessionEpoch ?? s.sessionEpoch,
                buffer: [],
              },
              unifiedPanelHidden: false,
            });
          } else {
            sessions.set(sessionId, {
              ...s,
              panel: {
                id: event.panelId,
                overlay: event.overlay,
                hostInstanceId: event.hostInstanceId ?? s.hostInstanceId ?? "",
                sessionEpoch: event.sessionEpoch ?? s.sessionEpoch,
                buffer: [],
              },
            });
          }
          break;
        case "panel_data":
          if (s.unifiedPanel?.id === event.panelId) {
            // The unified panel can outlive its renderer xterm across session
            // switches. Keep a replay segment, not an unbounded ANSI log: when
            // pi-tui emits a hard full-screen clear, anything before it is stale
            // history and corrupts remount sizing if replayed.
            const buffer = appendUnifiedReplayBuffer(s.unifiedPanel.buffer, event.data);
            sessions.set(sessionId, { ...s, unifiedPanel: { ...s.unifiedPanel, buffer } });
          } else if (s.panel?.id === event.panelId) {
            // The buffer is only a remount snapshot (CustomPanelHost replays it
            // into a fresh xterm). A TUI panel redraws continuously, so an
            // unbounded buffer is a steady leak. Keep a bounded tail; oldest
            // chunks are dropped first.
            const buffer = appendBoundedPanelBuffer(s.panel.buffer, event.data);
            sessions.set(sessionId, { ...s, panel: { ...s.panel, buffer } });
          }
          break;
        case "panel_close":
          if (s.unifiedPanel?.id === event.panelId) {
            sessions.set(sessionId, { ...s, unifiedPanel: undefined, unifiedPanelHidden: false });
          } else if (s.panel?.id === event.panelId) {
            sessions.set(sessionId, { ...s, panel: undefined });
          }
          break;
        case "panel_mode":
          // A pi-tui overlay opened/closed. Switch the host's sizing model
          // (viewport-pin vs content-tracking). Routed to whichever panel the
          // id matches — the unified TUI (reuse-path overlays) or a standalone
          // custom() panel (both share the createPanelSizer engine).
          if (s.unifiedPanel?.id === event.panelId && s.unifiedPanel.mode !== event.mode) {
            sessions.set(sessionId, {
              ...s,
              unifiedPanel: { ...s.unifiedPanel, mode: event.mode },
            });
          } else if (s.panel?.id === event.panelId && s.panel.mode !== event.mode) {
            sessions.set(sessionId, { ...s, panel: { ...s.panel, mode: event.mode } });
          }
          break;
        case "panel_clear_all":
          sessions.set(sessionId, { ...s, panel: undefined });
          break;
        case "unified_panel_reset":
          // The unified-TUI host process is gone (/reload, crash, close) and
          // couldn't emit a reliable panel_close. Drop stale unified-panel
          // state so the native Composer is restored. (Does NOT clear custom()
          // overlay panels — those are handled by panel_clear_all.)
          sessions.set(sessionId, { ...s, unifiedPanel: undefined, unifiedPanelHidden: false });
          break;
        case "session_warning":
          // Non-fatal warning (e.g. session file open elsewhere). Toast it.
          sessions.set(sessionId, {
            ...s,
            toasts: [
              ...s.toasts,
              {
                id: `toast-${++toastCounter}`,
                message: event.message,
                type: "warning",
                createdAt: Date.now(),
              },
            ],
          });
          break;
      }
      return { sessions };
    });
  },

  handleUnifiedSubmitRequest: async (
    sessionId,
    id,
    text,
    editorRevision,
    submissionIntentId,
    hostInstanceId,
    sessionEpoch,
  ) => {
    const trimmed = text.trim();
    const state = get();
    const session = state.sessions.get(sessionId);
    const pendingDiffComments = state.getDiffCommentsForPrompt(sessionId);
    const claim = await window.pivis.invoke("session.claimUnifiedSubmit", {
      sessionId,
      id,
      rendererGeneration: RENDERER_GENERATION,
      expectedHostInstanceId: hostInstanceId,
      expectedSessionEpoch: sessionEpoch,
    });
    if (!claim.claimed) return;
    const origin = { hostInstanceId, sessionEpoch };
    const claimCurrent = (): boolean =>
      Date.now() < claim.expiresAt && sessionMatchesRuntime(get().sessions.get(sessionId), origin);
    const ensureClaimCurrent = (): void => {
      if (!claimCurrent()) {
        throw new InputNotConsumedError("Unified action claim expired or changed runtime");
      }
    };
    const respond = async (result: { ok: boolean; bailed?: boolean; error?: string }) => {
      if (!claimCurrent()) return { ok: false };
      return window.pivis.invoke("session.unifiedSubmitResponse", {
        sessionId,
        id,
        rendererGeneration: RENDERER_GENERATION,
        claimId: claim.claimId,
        expectedHostInstanceId: hostInstanceId,
        expectedSessionEpoch: sessionEpoch,
        ...result,
      });
    };
    if (
      !session ||
      session.hostInstanceId !== hostInstanceId ||
      session.sessionEpoch !== sessionEpoch ||
      session.availability !== "available" ||
      !claimCurrent()
    ) {
      void respond({
        ok: false,
        bailed: true,
        error: "Session runtime is unavailable",
      });
      return;
    }

    // Mirror the React Composer's early bail: an empty/whitespace submit is a
    // no-op unless pending diff comments are the prompt body. Tell the host it
    // bailed so it can restore — though empty restore is a no-op, keeping the
    // contract uniform is simplest.
    if (
      !trimmed &&
      pendingDiffComments.length === 0 &&
      (session?.editorAttachments.length ?? 0) === 0
    ) {
      void respond({ ok: false, bailed: true });
      return;
    }
    if ((session?.editorAttachmentReads ?? 0) > 0) {
      get().addToast(sessionId, "Wait for image attachments to finish loading", "warning");
      void respond({ ok: false, bailed: true, error: "Attachment reads are still pending" });
      return;
    }

    const discovered = new Map((session?.commands ?? []).map((c) => [c.name, c]));
    const parsedAction = parseComposerInput(text, { discovered });
    const isRealPrompt = parsedAction.kind === "send-prompt" && !text.startsWith("/");
    const replicated = parseReplicatedAttachments(session?.editorAttachments ?? []);
    let promptText = parsedAction.kind === "send-prompt" ? parsedAction.text : text;
    let promptImages = isRealPrompt ? replicated.images : [];
    if (isRealPrompt && replicated.files.length > 0) {
      promptText = textWithPrependedFilePaths(
        promptText,
        replicated.files.map((attachment) => attachment.path),
      );
    }
    if (isRealPrompt && pendingDiffComments.length > 0) {
      promptText = prependCodeCommentsToPrompt(promptText, pendingDiffComments);
    }
    const currentModelInfo = findCurrentModel(
      session?.availableModels ?? [],
      session?.currentModel,
      session?.currentProvider,
    );
    const modelSupportsImages = currentModelInfo?.input
      ? currentModelInfo.input.includes("image")
      : true;
    if (isRealPrompt && promptImages.length > 0 && !modelSupportsImages) {
      const modelLabel = currentModelInfo?.name ?? session?.currentModel ?? "This model";
      get().addToast(
        sessionId,
        `${modelLabel} doesn't support image input — sending image file paths instead`,
        "warning",
      );
      promptText = textWithAppendedFilePaths(
        promptText,
        promptImages.map((attachment) => attachment.path),
      );
      promptImages = [];
    }
    const action =
      parsedAction.kind === "send-prompt"
        ? {
            ...parsedAction,
            text: promptText,
            ...(promptImages.length > 0
              ? { images: runtimeImagesFromAttachments(promptImages) }
              : {}),
          }
        : parsedAction;

    // No-model guard (send-prompt only; /model and bash bypass). A bail here
    // tells the host to restore the editor text so the prompt isn't lost.
    if (
      action.kind === "send-prompt" &&
      !session?.currentModel &&
      action.commandSource === undefined
    ) {
      get().addToast(sessionId, "No model selected", "error");
      void respond({
        ok: false,
        bailed: true,
        error: "No model selected",
      });
      return;
    }

    const guarded =
      <Args extends unknown[]>(fn: (...args: Args) => void) =>
      (...args: Args): void => {
        if (claimCurrent()) fn(...args);
      };

    // Build the same deps the React Composer builds, but from store state (the
    // TUI path has no attachments/worktree pre-send block). executeAction + the
    // store actions it calls fire the optimistic bubble, draft clear, etc.
    const deps = {
      invoke: async <T = unknown>(channel: string, payload: unknown) => {
        ensureClaimCurrent();
        let commandPayload = payload;
        if (channel === "session.sendCommand") {
          const command = (payload as { command: PiRpcCommand }).command;
          commandPayload = {
            ...(payload as object),
            requestId: crypto.randomUUID(),
            expectedHostInstanceId: session.hostInstanceId!,
            expectedSessionEpoch: session.sessionEpoch,
            ...(commandNeedsIntent(command) ? { intentId: crypto.randomUUID() } : {}),
            sourceText: trimmed,
            editorRevision,
            uiSurface: "unified",
          };
        } else if (channel === "session.reload") {
          commandPayload = {
            sessionId,
            request: {
              requestId: crypto.randomUUID(),
              intentId: crypto.randomUUID(),
              expectedHostInstanceId: session.hostInstanceId!,
              expectedSessionEpoch: session.sessionEpoch,
              sourceText: trimmed,
            },
          };
        } else if (channel === "session.share") {
          commandPayload = {
            ...(payload as object),
            expectedHostInstanceId: session.hostInstanceId!,
            expectedSessionEpoch: session.sessionEpoch,
            exportIntentId: crypto.randomUUID(),
          };
        }
        const result = (await window.pivis.invoke(
          channel as Parameters<typeof window.pivis.invoke>[0],
          commandPayload as Parameters<typeof window.pivis.invoke>[1],
        )) as unknown as {
          success: boolean;
          data?: T;
          error?: string;
          disposition?: "not_executed" | "completed" | "outcome_unknown";
          successorIdentity?: { hostInstanceId: string; sessionEpoch: number };
        };
        ensureClaimCurrent();
        if (
          (channel === "session.sendCommand" || channel === "session.reload") &&
          result.disposition &&
          result.disposition !== "completed"
        ) {
          throw new InputNotConsumedError(result.error ?? `Command ${result.disposition}`);
        }
        if (
          channel === "session.sendCommand" &&
          !result.successorIdentity &&
          !sessionMatchesRuntime(get().sessions.get(sessionId), { hostInstanceId, sessionEpoch })
        ) {
          throw new InputNotConsumedError("Session changed before command continuation");
        }
        return result;
      },
      uiSurface: "unified" as const,
      submit: async (
        sid: SessionId,
        submission: import("@shared/pi-protocol/runtime-state.js").SessionSubmission,
      ) => {
        ensureClaimCurrent();
        const result = await window.pivis.invoke("session.submit", { sessionId: sid, submission });
        ensureClaimCurrent();
        return result;
      },
      getSubmissionContext: (sid: SessionId) => {
        if (!claimCurrent()) return undefined;
        const current = get().sessions.get(sid);
        const origin = { hostInstanceId, sessionEpoch };
        if (!sessionMatchesRuntime(current, origin)) return undefined;
        return {
          ...origin,
          editorRevision,
          userMessageSequence: current.transcript.userMessageSequence,
          intentId: submissionIntentId,
        };
      },
      addToast: guarded(get().addToast),
      addUserMessage: guarded(get().addUserMessage),
      clearPendingUserEcho: guarded(get().clearPendingUserEcho),
      addBashCommand: guarded(get().addBashCommand),
      finishBashCommand: guarded(get().finishBashCommand),
      applyModelChange: async (
        sid: SessionId,
        model: ModelInfo,
        expectedRuntime?: { hostInstanceId: string; sessionEpoch: number },
      ) => {
        ensureClaimCurrent();
        const result = await get().applyModelChange(sid, model, expectedRuntime);
        ensureClaimCurrent();
        return result;
      },
      addCustomMessage: guarded(get().addCustomMessage),
      openChangelog: guarded((markdown: string) =>
        useChangelogStore.getState().openChangelog(markdown),
      ),
      openPicker: guarded((sid: SessionId, picker: PickerRequest) =>
        get().openPicker(sid, {
          ...picker,
          expectedHostInstanceId: session.hostInstanceId!,
          expectedSessionEpoch: session.sessionEpoch,
        }),
      ),
      adoptSessionFile: (sid: SessionId, file?: string, name?: string) =>
        get().adoptSessionFileAndHydrate(sid, file, name, undefined, claimCurrent),
      closeSessionTab: async (sid: SessionId) => {
        ensureClaimCurrent();
        await get().closeSessionTab(sid);
        ensureClaimCurrent();
      },
      openAppSettings: guarded(() => window.dispatchEvent(new CustomEvent("pivis:open-settings"))),
      openDiffViewer: guarded((sid: SessionId) => openDiffForSession(sid)),
      // Lazy import: tree-store imports sessions-store, so a static import here
      // would be circular. The unified-TUI submit path rarely hits /tree, so
      // deferring the module load is fine.
      openTreeViewer: (sid: SessionId) => {
        if (!claimCurrent()) return;
        void import("./tree-store.js").then((m) => {
          if (claimCurrent()) m.useTreeStore.getState().openTreeForSession(sid);
        });
      },
      openLogin: guarded(() => window.dispatchEvent(new CustomEvent("pivis:open-login"))),
      copyToClipboard: async (t: string) => {
        ensureClaimCurrent();
        await window.pivis.invoke("clipboard.writeText", { text: t });
        ensureClaimCurrent();
      },
      getAvailableModels: (sid: SessionId): ModelInfo[] =>
        get().sessions.get(sid)?.availableModels ?? [],
      getSessionName: (sid: SessionId) => get().sessions.get(sid)?.sessionName,
      setSessionName: guarded(get().setSessionName),
      getCurrentModel: (sid: SessionId) => get().sessions.get(sid)?.currentModel,
      isWorking: (sid: SessionId) => isSessionWorking(get().sessions.get(sid)),
      getSessionWorkspacePath: (sid: SessionId) => get().sessions.get(sid)?.workspacePath,
      listSessions: async (p: string) => {
        ensureClaimCurrent();
        const result = await window.pivis.invoke("workspace.listSessions", { workspacePath: p });
        ensureClaimCurrent();
        return result;
      },
      onPromptAccepted: () => {
        if (claimCurrent() && isRealPrompt && pendingDiffComments.length > 0) {
          get().clearSubmittedDiffComments(sessionId, pendingDiffComments);
        }
      },
    };

    try {
      const result = await executeAction(sessionId, action, deps);
      ensureClaimCurrent();
      const submissionResult = result && "disposition" in result ? result : undefined;
      const promptAccepted =
        action.kind !== "send-prompt" ||
        (submissionResult !== undefined &&
          ["in_custody", "consumed", "completed", "extension_error"].includes(
            submissionResult.disposition,
          ));
      if (!promptAccepted) {
        void respond({
          ok: false,
          bailed: true,
          error: submissionResult?.message ?? "Submission was not accepted by the runtime",
        });
        return;
      }
      if (isRealPrompt && pendingDiffComments.length > 0) {
        get().clearSubmittedDiffComments(sessionId, pendingDiffComments);
      }
      void respond({ ok: true });
    } catch (err) {
      // executeAction threw (invoke failure, etc.) — tell the host to restore
      // so the user can retry. The error itself surfaces via addToast inside
      // executeAction's error handling where applicable.
      void respond({
        ok: false,
        bailed: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  addToast: (sessionId, message, type) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const toastId = `toast-${++toastCounter}`;
      sessions.set(sessionId, {
        ...s,
        toasts: [...s.toasts, { id: toastId, message, type, createdAt: Date.now() }],
      });
      return { sessions };
    });
  },

  dismissToast: (sessionId, toastId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const toasts = s.toasts.filter((t) => t.id !== toastId);
      sessions.set(sessionId, {
        ...s,
        toasts,
        notificationPanelOpen: toasts.length === 0 ? false : s.notificationPanelOpen,
      });
      return { sessions };
    });
  },

  clearToasts: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s || s.toasts.length === 0) return {};
      sessions.set(sessionId, { ...s, toasts: [], notificationPanelOpen: false });
      return { sessions };
    });
  },

  setNotificationPanelOpen: (sessionId, open) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, notificationPanelOpen: open });
      return { sessions };
    });
  },

  // ── Worktree actions ────────────────────────────────────────────

  setWorktreeMode: (sessionId, mode) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      // Switching segments is a fresh start — drop any stale failure.
      // Also drop `worktreeAttachPath` when switching away from attach
      // so a stale path from a prior selection can't leak into a new
      // attempt (the input clears its own value too, but the store is
      // the source of truth for the submit-time path).
      sessions.set(sessionId, {
        ...s,
        worktreeMode: mode,
        ...(mode !== "attach" ? { worktreeAttachPath: undefined } : {}),
        worktreeError: undefined,
      });
      return { sessions };
    });
  },

  setWorktreeAttachPath: (sessionId, path) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      // Each keystroke (or pick) is a fresh start — drop any stale
      // failure so the status line updates without an old error.
      sessions.set(sessionId, {
        ...s,
        worktreeAttachPath: path,
        worktreeError: undefined,
      });
      return { sessions };
    });
  },

  setWorktreeBase: (sessionId, base) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      // Changing the base is a fresh start — drop any stale failure.
      sessions.set(sessionId, { ...s, worktreeBase: base, worktreeError: undefined });
      return { sessions };
    });
  },

  setWorktreeCreating: (sessionId, v) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      // Starting a new attempt clears the previous error.
      sessions.set(sessionId, {
        ...s,
        worktreeCreating: v,
        ...(v ? { worktreeError: undefined } : {}),
      });
      return { sessions };
    });
  },

  setWorktreeError: (sessionId, message) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, worktreeError: message ?? undefined });
      return { sessions };
    });
  },

  applyWorktree: (sessionId, result) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        worktreePath: result.worktreePath,
        worktreeBranch: result.branch,
        worktreeName: result.name,
        worktreeFromBase: result.base,
      });
      return { sessions };
    });
  },

  clearWorktreeIntent: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        worktreeMode: undefined,
        worktreeAttachPath: undefined,
        worktreeBase: undefined,
        worktreeCreating: undefined,
        worktreeError: undefined,
      });
      return { sessions };
    });
  },

  setUnifiedPanelHidden: (sessionId, hidden) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      // No-op if there's no live unified panel to toggle away from — avoids
      // leaving a stale `hidden` flag that would suppress a future panel.
      if (!s.unifiedPanel) return {};
      sessions.set(sessionId, { ...s, unifiedPanelHidden: hidden });
      return { sessions };
    });
  },

  setStats: (sessionId, stats) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, stats });
      return { sessions };
    });
  },

  setTreeHistoryPresent: (sessionId, present) => {
    if (!present) return;
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      // Do not turn a truly brand-new, fileless, no-message tab into a visible
      // session just because pi reports bootstrap/settings tree entries. Once
      // the user sends anything, `isNewPending` is cleared and tree history can
      // keep the session visible even when the active branch is empty.
      if (
        !s ||
        s.hasTreeHistory ||
        (s.isNewPending && !s.sessionFile && !transcriptHasBlocks(s.transcript))
      ) {
        return {};
      }
      sessions.set(sessionId, { ...s, hasTreeHistory: true });
      return { sessions };
    });
  },

  setAvailableModels: (sessionId, models) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, availableModels: models });
      return { sessions };
    });
  },

  refreshAvailableModels: async (sessionId, expectedRuntime) => {
    if (typeof window === "undefined" || !window.pivis) return [];
    const currentModels = () => get().sessions.get(sessionId)?.availableModels ?? [];
    const runtime =
      expectedRuntime ??
      (() => {
        const session = get().sessions.get(sessionId);
        return session?.hostInstanceId
          ? { hostInstanceId: session.hostInstanceId, sessionEpoch: session.sessionEpoch }
          : undefined;
      })();
    if (!runtime || !sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) {
      return currentModels();
    }
    try {
      const res = await invokeSessionCommand(sessionId, { type: "get_available_models" }, runtime);
      if (!res.success || !sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) {
        return currentModels();
      }
      const raw = res.data as { models?: unknown[]; currentModelId?: string } | undefined;
      const list = Array.isArray(raw?.models) ? raw.models : [];
      const models = list
        .map((m) => {
          const r = ModelInfoSchema.safeParse(m);
          return r.success ? r.data : null;
        })
        .filter((m): m is ModelInfo => m !== null);
      if (!sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) return currentModels();
      get().setAvailableModels(sessionId, models);
      return models;
    } catch {
      /* best effort — leave the dropdown showing whatever the store already has */
      return currentModels();
    }
  },

  setCurrentModel: (sessionId, model, provider) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, currentModel: model, currentProvider: provider });
      return { sessions };
    });
  },

  setThinkingLevel: (sessionId, level) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, thinkingLevel: level });
      return { sessions };
    });
  },

  bootstrapModelState: async (sessionId) => {
    if (typeof window === "undefined" || !window.pivis) return;
    const existing = get().sessions.get(sessionId);
    // Run at most once per session. Bailing on `modelInitialized` here is what
    // structurally enforces invariant #2: a SessionHeader remount (every tab
    // switch) re-invokes this, but after the first run it is a no-op, so the
    // global last-used preference can NEVER be re-applied to an already-live
    // session and silently change its model.
    if (
      !existing ||
      existing.modelInitialized ||
      !existing.hostInstanceId ||
      existing.availability !== "available"
    )
      return;
    const runtime = {
      hostInstanceId: existing.hostInstanceId,
      sessionEpoch: existing.sessionEpoch,
    };
    const resumed = existing.resumed;

    // Claim the bootstrap synchronously, BEFORE any await, so a concurrent
    // caller (StrictMode double-invoke, a racing remount) sees the flag set
    // and returns early instead of double-applying the preference.
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, modelInitialized: true });
      return { sessions };
    });

    // The global "last selected" preference applies ONLY to brand-new sessions.
    // Resumed sessions keep the model/level pi restored from the session file,
    // so they read no preference here.
    const settings = useSettingsStore.getState().settings;
    const lum = resumed ? null : settings.lastUsedModel;
    const ltl = resumed ? null : settings.lastUsedThinkingLevel;

    // 1. Available models + current model. All writes target THIS sessionId.
    // `refreshAvailableModels` fetches the effective list (scoped subset when
    // a scope is active) and stores it; the current-model id is established
    // in step 2 from `get_state` (the authoritative source).
    try {
      const models = await get().refreshAvailableModels(sessionId, runtime);
      if (!sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) return;
      // Match the last-used preference on BOTH id and provider — the
      // preference is provider-scoped (settings.lastUsedModel = {provider,
      // modelId}), so when two providers offer the same id we must pick the
      // user's actual last-used provider, not whichever copy happens to sort
      // first. We only fall back to an id-only match when it is UNAMBIGUOUS
      // (exactly one same-id copy exists, e.g. a provider-string casing
      // drift on a single-provider model); with multiple same-id copies we
      // refuse to guess and let pi's reported current model apply instead.
      const sameId = lum ? models.filter((m) => m.id === lum.modelId) : [];
      const match = lum
        ? (sameId.find((m) => m.provider === lum.provider) ??
          (sameId.length === 1 ? sameId[0] : undefined))
        : undefined;
      if (match) {
        await invokeSessionCommand(
          sessionId,
          {
            type: "set_model",
            ...(match.provider ? { provider: match.provider } : {}),
            modelId: match.id,
          },
          runtime,
        )
          .then((res) => {
            if (res.success && sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) {
              get().setCurrentModel(sessionId, match.id, match.provider);
            }
          })
          .catch(() => {});
      } else {
        // No last-used match: fall back to pi's reported current model. The
        // list endpoint tags the active model with `current: true`; step 2's
        // `get_state` is the authoritative source and will overwrite this.
        const active = models.find((m) => (m as Record<string, unknown>)["current"] === true);
        if (active && sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) {
          get().setCurrentModel(sessionId, active.id, active.provider);
        }
      }
    } catch {
      /* best effort — leave the dropdown showing whatever the store already has */
    }

    // 2. Thinking level + session name/file (get_state).
    try {
      const res = await invokeSessionCommand(sessionId, { type: "get_state" }, runtime);
      if (!sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) return;
      const raw = res?.data as
        | {
            thinkingLevel?: unknown;
            model?: { id?: unknown; provider?: unknown };
            sessionName?: unknown;
            sessionFile?: unknown;
          }
        | undefined;
      if (!raw) return;
      if (typeof raw.thinkingLevel === "string") {
        const parsed = ThinkingLevelSchema.safeParse(raw.thinkingLevel);
        if (parsed.success) get().setThinkingLevel(sessionId, parsed.data);
      }
      if (ltl) {
        // Apply the preferred level through the SAME path the user takes when
        // choosing a level in the header (`applyThinkingLevel`), which sends
        // set_thinking_level and then RECONCILES with the level pi actually
        // applied — a model may clamp it (e.g. a model that doesn't support
        // "xhigh"). The model was already set in step 1, so pi clamps relative
        // to the right model. The old inline path blindly wrote `ltl` into the
        // store, so a new session that inherited (say) "xhigh" from one session
        // and a non-xhigh model from another would show "xhigh" even though pi
        // had clamped it.
        await get().applyThinkingLevel(sessionId, ltl);
        if (!sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) return;
      }
      if (raw.model && typeof raw.model.id === "string") {
        // Adopt pi's authoritative model id, and its provider when pi reports
        // one. But DON'T clobber an already-known provider (set in step 1 from
        // the last-used match) when pi omits it — that would blank
        // `currentProvider` and make the dropdown fall back to id-only matching,
        // highlighting the wrong same-id row. Only carry over the existing
        // provider when the id is unchanged (a different id has no basis).
        const existing = get().sessions.get(sessionId);
        const provider =
          typeof raw.model.provider === "string"
            ? raw.model.provider
            : raw.model.id === existing?.currentModel
              ? existing?.currentProvider
              : undefined;
        get().setCurrentModel(sessionId, raw.model.id, provider);
      }
      if (typeof raw.sessionName === "string" && raw.sessionName) {
        get().setSessionName(sessionId, raw.sessionName);
      }
      if (typeof raw.sessionFile === "string" && raw.sessionFile) {
        get().setSessionFile(sessionId, raw.sessionFile);
      }
    } catch {
      /* best effort */
    }
  },

  applyModelChange: async (sessionId, model, expectedRuntime) => {
    if (typeof window === "undefined" || !window.pivis) {
      return { ok: false, error: "Unavailable" };
    }
    const before = get().sessions.get(sessionId);
    if (!before) return { ok: false, error: "Unknown session" };
    const prevModel = before.currentModel;
    const prevProvider = before.currentProvider;
    const runtime =
      expectedRuntime ??
      (before.hostInstanceId
        ? { hostInstanceId: before.hostInstanceId, sessionEpoch: before.sessionEpoch }
        : undefined);
    if (!runtime || !sessionMatchesRuntime(before, runtime)) {
      return { ok: false, error: "Runtime unavailable" };
    }
    // The provider we actually send to pi. True providerless registry entries
    // must stay providerless: synthesizing one from the id makes the SDK host's
    // exact provider+id lookup miss. The host supports id-only resolution when
    // this is omitted.
    const provider = model.provider;

    // Optimistic: show the requested model right away (invariant #1's "queued
    // change about to be sent").
    get().setCurrentModel(sessionId, model.id, provider);

    try {
      const res = await invokeSessionCommand(
        sessionId,
        { type: "set_model", ...(provider ? { provider } : {}), modelId: model.id },
        runtime,
      );
      if (!res.success) throw new Error(res.error ?? "set_model failed");
      if (!sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) {
        throw new Error("Session changed before model settlement");
      }
    } catch (err) {
      // Revert so the dropdown reflects the model still actually in effect —
      // but only if our optimistic value is still the one showing. A newer
      // change (or a pi event) that landed in the meantime wins. We compare
      // BOTH id and provider: two rapid switches between same-id/different-
      // provider copies must not let a failed earlier switch revert the
      // in-flight later one's provider.
      set((state) => {
        const sessions = new Map(state.sessions);
        const s = sessions.get(sessionId);
        if (
          !sessionMatchesRuntime(s, runtime) ||
          s.currentModel !== model.id ||
          s.currentProvider !== provider
        )
          return {};
        sessions.set(sessionId, { ...s, currentModel: prevModel, currentProvider: prevProvider });
        return { sessions };
      });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Reconcile with the model pi actually applied (mirrors applyThinkingLevel's
    // get_state reconciliation, improved with a supersession-safe persist). pi
    // may normalize the provider string (or, in principle, the id); adopting
    // its authoritative value keeps the store, the dropdown highlight, and the
    // persisted last-used preference honest. We persist the reconciled values
    // ONLY when this switch is still in effect — a newer change that lands
    // during the round-trip owns its own persist, and a failed get_state must
    // not leak a stale preference either.
    let persistId = model.id;
    let persistProvider = provider;
    let shouldPersist = true;
    try {
      const stateRes = await invokeSessionCommand(sessionId, { type: "get_state" }, runtime);
      const raw = stateRes?.data as { model?: { id?: unknown; provider?: unknown } } | undefined;
      const s = get().sessions.get(sessionId);
      if (!sessionMatchesRuntime(s, runtime)) return { ok: false, error: "Session changed" };
      if (s && s.currentModel === model.id && s.currentProvider === provider) {
        // Still our optimistic value — adopt pi's authoritative id/provider.
        // Only adopt the provider when pi returns a string: a missing/non-string
        // provider must not clobber the one we sent (that would re-introduce
        // ambiguous highlighting when duplicate same-id entries exist).
        if (raw?.model && typeof raw.model.id === "string") {
          persistId = raw.model.id;
          persistProvider =
            typeof raw.model.provider === "string" ? raw.model.provider : persistProvider;
          get().setCurrentModel(sessionId, persistId, persistProvider);
        }
      } else {
        // A newer change landed during the get_state round-trip — don't persist
        // our now-stale values; the newer change owns its own persist.
        shouldPersist = false;
      }
    } catch {
      // get_state failed: keep the optimistic value, but only persist if our
      // switch is still the one in effect (a newer change may have landed).
      const s = get().sessions.get(sessionId);
      shouldPersist = !!(
        sessionMatchesRuntime(s, runtime) &&
        s.currentModel === model.id &&
        s.currentProvider === provider
      );
    }

    if (shouldPersist) {
      void useSettingsStore.getState().update({
        lastUsedModel: {
          ...(persistProvider ? { provider: persistProvider } : {}),
          modelId: persistId,
        },
      });

      // The model switch can change the context window. Refresh stats from pi
      // once this switch is still known to be current so the context meter's
      // denominator updates promptly instead of waiting for the header's
      // periodic/agent_end refresh.
      try {
        const statsRes = await invokeSessionCommand(
          sessionId,
          { type: "get_session_stats" },
          runtime,
        );
        if (statsRes.success && statsRes.data) {
          const parsed = SessionStatsSchema.safeParse(statsRes.data);
          const s = get().sessions.get(sessionId);
          if (
            parsed.success &&
            sessionMatchesRuntime(s, runtime) &&
            s.currentModel === persistId &&
            s.currentProvider === persistProvider
          ) {
            get().setStats(sessionId, parsed.data as SessionStats);
          }
        }
      } catch {
        /* best effort — the header's normal stats polling will catch up */
      }
    }
    return { ok: true };
  },

  applyThinkingLevel: async (sessionId, level) => {
    if (typeof window === "undefined" || !window.pivis) {
      return { ok: false, error: "Unavailable" };
    }
    const before = get().sessions.get(sessionId);
    if (!before) return { ok: false, error: "Unknown session" };
    if (
      !before.hostInstanceId ||
      before.availability !== "available" ||
      before.status !== "ready"
    ) {
      return { ok: false, error: "Runtime unavailable" };
    }
    const runtime = {
      hostInstanceId: before.hostInstanceId,
      sessionEpoch: before.sessionEpoch,
    };
    const prevLevel = before.thinkingLevel;

    const requestId = nextThinkingRequestId++;
    pendingThinkingRequests.set(sessionId, requestId);

    // Optimistic update.
    get().setThinkingLevel(sessionId, level);

    try {
      const res = await invokeSessionCommand(
        sessionId,
        { type: "set_thinking_level", level },
        runtime,
      );
      if (!res.success) throw new Error(res.error ?? "set_thinking_level failed");
      if (!sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) {
        throw new Error("Session changed before thinking-level settlement");
      }

      // Reconcile with the level pi actually applied (a model may clamp it).
      let clampedTo: ThinkingLevel | undefined;
      const stateRes = await invokeSessionCommand(sessionId, { type: "get_state" }, runtime);
      if (!sessionMatchesRuntime(get().sessions.get(sessionId), runtime)) {
        throw new Error("Session changed before thinking-level reconciliation");
      }
      const raw = stateRes?.data as { thinkingLevel?: unknown } | undefined;
      if (raw && typeof raw.thinkingLevel === "string") {
        const confirmed = ThinkingLevelSchema.safeParse(raw.thinkingLevel);
        // Only adopt pi's value if this request has not been superseded by a
        // newer user choice. Do NOT key this off the current store value: pi
        // may have already emitted `thinking_level_changed` for this same
        // request before the get_state round-trip returns. In that case the
        // store is already clamped, but the caller still needs `clampedTo` so
        // SessionHeader can show the warning toast on the first unsupported
        // choice in a session.
        if (confirmed.success && pendingThinkingRequests.get(sessionId) === requestId) {
          get().setThinkingLevel(sessionId, confirmed.data);
          if (confirmed.data !== level) clampedTo = confirmed.data;
        }
      }

      if (pendingThinkingRequests.get(sessionId) === requestId) {
        pendingThinkingRequests.delete(sessionId);
        void useSettingsStore.getState().update({ lastUsedThinkingLevel: level });
      }
      return clampedTo ? { ok: true, clampedTo } : { ok: true };
    } catch (err) {
      if (pendingThinkingRequests.get(sessionId) === requestId) {
        pendingThinkingRequests.delete(sessionId);
      }
      set((state) => {
        const sessions = new Map(state.sessions);
        const s = sessions.get(sessionId);
        if (!sessionMatchesRuntime(s, runtime) || s.thinkingLevel !== level) return {};
        sessions.set(sessionId, { ...s, thinkingLevel: prevLevel });
        return { sessions };
      });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  setSessionName: (sessionId, name) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, sessionName: name });
      return { sessions };
    });
  },

  refreshWorkspaceSessions: async (path) => {
    if (typeof window === "undefined" || !window.pivis) return;
    try {
      const sessions = await window.pivis.invoke("workspace.listSessions", { workspacePath: path });
      get().setWorkspaceSessions(path, sessions);
    } catch (err) {
      console.error("Failed to refresh workspace sessions:", err);
    }
  },

  /**
   * Re-point a session to a new file (used by the fileChanged flow after
   * /new, /fork, /clone, /switch_session). Overrides the only-if-unset
   * guard that setSessionFile enforces for normal harvests — pi has
   * confirmed the file is the new authoritative path.
   *
   * Steps:
   *   1. Update sessionFile (may be undefined for a lazy new_session).
   *   2. Clear the transcript (the new session is empty until loadHistory).
   *   3. Update sessionName if pi provided one.
   *
   * (Tab-persistence was removed: openTabs is no longer tracked in
   * settings, so there is no step 4. The session stays in memory for
   * this run; a relaunch will open a fresh session in the MRU
   * workspace.)
   */
  adoptSessionFile: async (sessionId, sessionFile, sessionName) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const next: SessionViewState = {
        ...resetRuntimeState(s),
        sessionFile,
        transcript: createTranscriptState(),
        hasTreeHistory: false,
        historyCursor: undefined,
        historyGeneration: s.historyGeneration + 1,
        historyLoadingEarlier: undefined,
        unreadStatus: undefined,
        turnErrored: false,
        ...(sessionName !== undefined ? { sessionName } : {}),
      };
      sessions.set(sessionId, next);
      return { sessions };
    });
  },

  /** Adopt a new session file, then load its transcript history and refresh the
   *  workspace session list. Shared by the React Composer and the unified-TUI
   *  submit path so a `/fork`|`/clone`|`/switch_session`|`/resume` behaves
   *  identically regardless of which surface dispatched it. Mirrors the exact
   *  post-adopt steps the Composer used to inline (loadHistory + seedHistory +
   *  refreshWorkspaceSessions when there's a workspace). */
  adoptSessionFileAndHydrate: async (
    sessionId,
    sessionFile,
    sessionName,
    expectedRuntime,
    continuationGuard = () => true,
  ) => {
    if (!continuationGuard()) return;
    const before = get().sessions.get(sessionId);
    if (expectedRuntime && !sessionMatchesRuntime(before, expectedRuntime)) return;
    await get().adoptSessionFile(sessionId, sessionFile, sessionName);
    if (!continuationGuard()) return;
    if (expectedRuntime && before?.runtimeSnapshot) {
      const adopted = get().sessions.get(sessionId);
      if (
        adopted?.availability === "unavailable" &&
        adopted.hostInstanceId === expectedRuntime.hostInstanceId &&
        adopted.sessionEpoch === expectedRuntime.sessionEpoch
      ) {
        get().applyRuntimeState(sessionId, {
          availability: "available",
          hostInstanceId: before.runtimeSnapshot.hostInstanceId,
          sessionEpoch: before.runtimeSnapshot.sessionEpoch,
          receivedAt: Date.now(),
          snapshot: before.runtimeSnapshot,
        });
      }
    }
    if (!sessionFile) return;
    // Initial hydration is replacement, not pagination. If transcript events
    // race the file read, never overwrite or merge them with an overlapping
    // page: wait for the authoritative turn to become idle and reread until
    // the transcript remains unchanged for the entire request.
    while (continuationGuard()) {
      const beforeRead = get().sessions.get(sessionId);
      const historyCapture = captureHistoryRead(beforeRead, expectedRuntime);
      if (!historyCapture) return;
      if (isSessionWorking(beforeRead)) {
        if (!(await waitForHistoryHydrationIdle(sessionId, historyCapture))) return;
        continue;
      }
      const transcriptAtRequest = beforeRead?.transcript;
      const history = await requestBoundHistoryPage(sessionId, historyCapture);
      if (!history || !continuationGuard()) return;
      const current = get().sessions.get(sessionId);
      if (!historyCaptureMatches(current, historyCapture)) return;
      if (current?.transcript !== transcriptAtRequest) {
        if (!(await waitForHistoryHydrationIdle(sessionId, historyCapture))) return;
        continue;
      }
      get().seedHistory(sessionId, history);
      const workspacePath = current?.workspacePath;
      if (workspacePath) void get().refreshWorkspaceSessions(workspacePath);
      return;
    }
  },

  /** Refresh the discovered command list (extension / prompt / skill). */
  refreshCommands: async (sessionId) => {
    if (typeof window === "undefined" || !window.pivis) return;
    const session = get().sessions.get(sessionId);
    if (!session?.hostInstanceId || session.availability !== "available") return;
    const runtime = {
      hostInstanceId: session.hostInstanceId,
      sessionEpoch: session.sessionEpoch,
    };
    try {
      const res = await invokeSessionCommand(sessionId, { type: "get_commands" }, runtime);
      if (!res || !res.success) return;
      // Tolerant read: pi v0.79.1 returns { commands: RpcSlashCommand[] };
      // the contract's PiRpcResponse is a discriminated union, but we
      // only care about `data.commands` so a narrow cast is fine here.
      const data = (res as { data?: { commands?: unknown[] } }).data;
      const raw = data?.commands;
      if (!Array.isArray(raw)) return;
      const commands: SlashCommandInfo[] = raw
        .map((c) => {
          // Tolerant parse: SlashCommandInfoSchema is permissive and tolerates
          // both v0.79.1's nested sourceInfo shape and the docs' flat shape.
          const parsed = c as SlashCommandInfo | null;
          return parsed && typeof parsed.name === "string" ? parsed : null;
        })
        .filter((c): c is SlashCommandInfo => c !== null);
      set((state) => {
        const sessions = new Map(state.sessions);
        const s = sessions.get(sessionId);
        if (!s) return {};
        sessions.set(sessionId, { ...s, commands });
        return { sessions };
      });
    } catch {
      // best effort
    }
  },

  injectEditorText: (sessionId, text) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        editorInjection: { text, nonce: ++editorInjectionNonce },
      });
      return { sessions };
    });
  },

  beginEditorAttachmentRead: (sessionId) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...s, editorAttachmentReads: s.editorAttachmentReads + 1 });
      return { sessions };
    });
  },

  endEditorAttachmentRead: (sessionId) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s || s.editorAttachmentReads === 0) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...s,
        editorAttachmentReads: Math.max(0, s.editorAttachmentReads - 1),
      });
      return { sessions };
    });
  },

  stageEditorAttachments: (sessionId, attachments) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...s, editorAttachments: structuredClone(attachments) });
      return { sessions };
    });
  },

  beginEditorPatch: (sessionId) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...s, editorPatchPending: s.editorPatchPending + 1 });
      return { sessions };
    });
  },

  endEditorPatch: (sessionId) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s || s.editorPatchPending === 0) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...s,
        editorPatchPending: Math.max(0, s.editorPatchPending - 1),
      });
      return { sessions };
    });
  },

  clearEditorConflict: (sessionId) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s?.editorConflict) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...s, editorConflict: undefined });
      return { sessions };
    });
  },

  acknowledgeEditorPatch: (sessionId, revision) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s || revision < s.editorRevision) return {};
      const sessions = new Map(state.sessions);
      const staleInjection =
        s.editorInjection?.revision !== undefined && s.editorInjection.revision <= revision;
      sessions.set(sessionId, {
        ...s,
        editorRevision: revision,
        editorConflict: undefined,
        editorInjection: staleInjection ? undefined : s.editorInjection,
      });
      return { sessions };
    });
  },

  clearEditorInjection: (sessionId) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s?.editorInjection) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...s, editorInjection: undefined });
      return { sessions };
    });
  },

  openPicker: (sessionId, picker) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        pendingPicker: {
          ...picker,
          ...(picker.expectedHostInstanceId
            ? { expectedHostInstanceId: picker.expectedHostInstanceId }
            : s.hostInstanceId
              ? { expectedHostInstanceId: s.hostInstanceId }
              : {}),
          expectedSessionEpoch: picker.expectedSessionEpoch ?? s.sessionEpoch,
        } as PickerRequest,
      });
      return { sessions };
    });
  },

  closePicker: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, pendingPicker: undefined });
      return { sessions };
    });
  },

  addCustomMessage: (sessionId, content) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const next: SessionViewState = {
        ...s,
        transcript: addCustomMessageBlock(s.transcript, content),
        isNewPending: false,
        editorInjection: undefined,
      };
      sessions.set(sessionId, next);
      // Clear the per-workspace draft when the pending session becomes real
      // (see addUserMessage for rationale).
      const drafts = clearNewSessionDraftFor(
        state.newSessionDrafts,
        s.workspacePath,
        !!s.isNewPending,
      );
      const setupDrafts = clearNewSessionSetupFor(
        state.newSessionSetupDrafts,
        s.workspacePath,
        !!s.isNewPending,
      );
      const sessionDrafts = clearSessionDraftFor(state.sessionDrafts, sessionId);
      return {
        sessions,
        newSessionDrafts: drafts,
        newSessionSetupDrafts: setupDrafts,
        sessionDrafts,
      };
    });
  },

  openSessionTab: async (workspacePath, sessionFile, opts) => {
    const focus = opts?.focus ?? true;
    if (!sessionFile && focus && isPendingNewSessionActiveFor(get(), workspacePath)) {
      return get().activeSessionId;
    }
    if (typeof window === "undefined" || !window.pivis) return null;
    try {
      // Renderer-side dedupe: a session already open with the same file is reused.
      // (Fast path; main's session.open is also idempotent so this is not load-bearing.)
      if (sessionFile) {
        for (const s of get().sessions.values()) {
          if (s.sessionFile === sessionFile) {
            if (focus) get().setActiveSession(s.sessionId);
            return s.sessionId;
          }
        }
      }
      // session.open is idempotent and non-throwing: it returns
      //   { outcome: "opened" | "existing", sessionId, name, preview, sessionStatus }
      // when the file exists, or { outcome: "missing" } for stale tab entries.
      // "existing" means the file is already open in the main registry — we
      // adopt the existing record instead of failing, so renderer reloads and
      // double-clicks on a stored row are both lossless.
      const res = await window.pivis.invoke("session.open", {
        workspacePath,
        sessionFile,
      });
      if (res.outcome === "missing") return null; // stale tab: skip; the cold-open call site decides whether to surface a new session
      const { sessionId, name, preview, sessionStatus } = res;

      // A concurrent openSessionTab for the same file may have already adopted
      // this id (double-click TOCTOU) — never recreate/reseed an existing record.
      if (get().sessions.has(sessionId)) {
        if (focus) get().setActiveSession(sessionId);
        return sessionId;
      }

      get().createSession(
        sessionId,
        workspacePath,
        sessionFile,
        name ?? undefined,
        preview ?? undefined,
        res.outcome === "existing" ? sessionStatus : "cold",
      );
      if (sessionFile) {
        const storageKey = diffCommentsStorageSessionKey(sessionFile);
        const storedComments = get().diffComments.get(storageKey);
        if (storedComments) {
          set((state) => {
            const diffComments = new Map(state.diffComments);
            diffComments.delete(storageKey);
            diffComments.set(sessionId, storedComments);
            persistCodeComments(diffComments);
            return { diffComments };
          });
        }
      }
      // Re-attach worktree identity for a resumed worktree session so the
      // chip renders and git operations target the worktree (not the parent
      // workspace). New sessions have no worktree and skip this.
      if (res.worktree) {
        get().applyWorktree(sessionId, {
          worktreePath: res.worktree.path,
          branch: res.worktree.branch,
          name: res.worktree.name,
          base: res.worktree.base,
        });
      }
      // loadHistory + seedHistory exactly as before. For adopted sessions pi
      // persists entries as it goes, so the file IS the transcript.
      if (sessionFile) {
        try {
          let historyCapture = captureHistoryRead(get().sessions.get(sessionId));
          let history = historyCapture
            ? await requestBoundHistoryPage(sessionId, historyCapture)
            : undefined;
          // Renderer attach may install the already-running host identity while
          // a cold/open history read is in flight. Retry once against that new
          // explicit owner; never apply the predecessor result.
          if (!history && historyCapture) {
            historyCapture = await waitForHistoryOwnershipChange(sessionId, historyCapture);
            history = historyCapture
              ? await requestBoundHistoryPage(sessionId, historyCapture)
              : undefined;
          }
          if (history && historyCaptureMatches(get().sessions.get(sessionId), historyCapture!)) {
            get().seedHistory(sessionId, history);
          }
        } catch {
          /* stale or unavailable history — fine */
        }
      }
      if (focus) get().setActiveSession(sessionId);
      return sessionId;
    } catch (err) {
      console.error("Failed to open session:", err);
      return null;
    }
  },

  closeSessionTab: async (sessionId, opts) => {
    if (typeof window !== "undefined" && window.pivis) {
      try {
        let prepared = await window.pivis.invoke("session.prepareClose", { sessionId });
        const checkpoint = prepared?.checkpoint as
          | {
              snapshot?: AgentSessionSnapshot;
              editor?: {
                text?: string;
                attachments?: unknown[];
                conflictText?: string;
                conflictAttachments?: unknown[];
                alternateConflictText?: string;
                alternateConflictAttachments?: unknown[];
                additionalConflictCandidates?: Array<{ text: string; attachments: unknown[] }>;
              };
              intents?: unknown[];
              restorations?: unknown[];
              dialogs?: unknown[];
              panels?: unknown[];
            }
          | undefined;
        const localDraft = opts?.preservePendingDraft
          ? ""
          : (get().sessionDrafts.get(sessionId) ?? "");
        const localSession = get().sessions.get(sessionId);
        const localEditor = {
          attachments: localSession?.editorAttachments ?? [],
          pendingAttachmentReads: localSession?.editorAttachmentReads ?? 0,
        };
        const hasReviewableWork =
          localDraft.trim().length > 0 ||
          localEditor.attachments.length > 0 ||
          localEditor.pendingAttachmentReads > 0 ||
          !!checkpoint?.editor?.text?.trim() ||
          checkpoint?.editor?.conflictText !== undefined ||
          checkpoint?.editor?.alternateConflictText !== undefined ||
          (checkpoint?.editor?.attachments?.length ?? 0) > 0 ||
          (checkpoint?.editor?.conflictAttachments?.length ?? 0) > 0 ||
          (checkpoint?.editor?.alternateConflictAttachments?.length ?? 0) > 0 ||
          (checkpoint?.editor?.additionalConflictCandidates?.length ?? 0) > 0 ||
          (checkpoint?.intents?.length ?? 0) > 0 ||
          (checkpoint?.restorations?.length ?? 0) > 0 ||
          (checkpoint?.dialogs?.length ?? 0) > 0 ||
          (checkpoint?.panels?.length ?? 0) > 0 ||
          checkpoint?.snapshot?.isIdle === false ||
          checkpoint?.snapshot?.hostFacts.submitting === true ||
          (checkpoint?.snapshot?.hostFacts.custodyCount ?? 0) > 0;
        if (hasReviewableWork) {
          const confirmed = window.confirm(
            `Review the close checkpoint below. Force closing permanently discards this in-memory checkpoint and may leave work outcomes unknown.\n\n${closeCheckpointPreview(
              checkpoint,
              localDraft,
              localEditor,
            )}\n\nForce close now?`,
          );
          if (!confirmed) {
            if (prepared?.reviewToken) {
              await window.pivis.invoke("session.cancelClose", {
                sessionId,
                reviewToken: prepared.reviewToken,
              });
            }
            return;
          }
          if (prepared?.reviewToken) {
            await window.pivis.invoke("session.cancelClose", {
              sessionId,
              reviewToken: prepared.reviewToken,
            });
          }
          prepared = await window.pivis.invoke("session.prepareClose", { sessionId, force: true });
        }
        if (prepared?.reviewToken) {
          const result = await window.pivis.invoke("session.confirmClose", {
            sessionId,
            reviewToken: prepared.reviewToken,
          });
          if (!result.closed) {
            get().addToast(
              sessionId,
              result.reason ?? "Session changed; review it before closing",
              "warning",
            );
            return;
          }
        }
      } catch (error) {
        console.error(error);
        return;
      }
    }
    get().removeSession(sessionId, opts);
  },

  archiveSession: async (sessionId, filePath, workspacePath) => {
    // 1. Add file path to archivedSessions in settings
    try {
      const settings = await window.pivis.invoke("settings.get", undefined);
      const archived = settings.archivedSessions ?? [];
      if (archived.includes(filePath)) return;
      await window.pivis.invoke("settings.set", {
        archivedSessions: [...archived, filePath],
      });
    } catch (err) {
      console.error("Failed to archive session:", err);
      return;
    }

    // 2. If a live record exists, close its tab
    if (sessionId) {
      await get().closeSessionTab(sessionId);
    }

    // 3. Refresh the workspace list so the archived row disappears
    await get().refreshWorkspaceSessions(workspacePath);
  },

  setActiveSession: (sessionId) => {
    const previousActiveId = get().activeSessionId;
    const returningVisitId = sessionId
      ? get().sessions.get(sessionId)?.activationVisitId
      : undefined;
    set((state) => {
      if (sessionId === null) {
        return { activeSessionId: null, activeWorkspacePath: null };
      }
      // Switching away from the previously-active session clears its unread
      // turn-result dot: the user has now "seen" it and moved on. Sessions
      // that were never activated (background notifications) are left alone
      // so their dot persists until the user actually visits them.
      const prev = state.activeSessionId;
      const next = state.sessions.get(sessionId);
      const nextWs = next?.workspacePath ?? null;
      if (prev && prev !== sessionId) {
        const prevSession = state.sessions.get(prev);
        if (prevSession?.unreadStatus) {
          const sessions = new Map(state.sessions);
          sessions.set(prev, { ...prevSession, unreadStatus: undefined });
          return {
            sessions,
            activeSessionId: sessionId,
            activeWorkspacePath: nextWs,
          };
        }
      }
      return { activeSessionId: sessionId, activeWorkspacePath: nextWs };
    });

    if (typeof window === "undefined" || !window.pivis) return;

    const activateForVisit = (targetId: SessionId): void => {
      const activationVisitId = crypto.randomUUID();
      set((state) => {
        const target = state.sessions.get(targetId);
        if (!target) return {};
        const sessions = new Map(state.sessions);
        sessions.set(targetId, { ...target, activationVisitId });
        return { sessions };
      });
      void window.pivis
        .invoke("session.activate", { sessionId: targetId, activationVisitId })
        .catch((err) => {
          set((state) => {
            const target = state.sessions.get(targetId);
            if (!target || target.activationVisitId !== activationVisitId) return {};
            const sessions = new Map(state.sessions);
            sessions.set(targetId, { ...target, activationVisitId: undefined });
            return { sessions };
          });
          get().setSessionStatus(targetId, "failed", String(err));
        });
    };

    if (previousActiveId && previousActiveId !== sessionId) {
      const previous = get().sessions.get(previousActiveId);
      if (shouldReapPendingNewSession(previous)) {
        void get().closeSessionTab(previousActiveId, { preservePendingDraft: true });
      } else if (previous?.activationVisitId) {
        const activationVisitId = previous.activationVisitId;
        void window.pivis
          .invoke("session.releaseActivationVisit", {
            sessionId: previousActiveId,
            activationVisitId,
          })
          .catch(() => ({ released: false }))
          .finally(() => {
            set((state) => {
              const current = state.sessions.get(previousActiveId);
              if (!current || current.activationVisitId !== activationVisitId) return {};
              const sessions = new Map(state.sessions);
              sessions.set(previousActiveId, { ...current, activationVisitId: undefined });
              return { sessions };
            });
          });
      }
    }

    if (!sessionId || sessionId === previousActiveId) return;
    if (returningVisitId) {
      // If the user comes back while the fresh-snapshot release check is in
      // flight, cancel it. If main already completed the release, immediately
      // start a new activation even if the renderer has not received the cold
      // status event yet.
      void window.pivis
        .invoke("session.cancelActivationVisitRelease", {
          sessionId,
          activationVisitId: returningVisitId,
        })
        .then(({ cancelled }) => {
          if (!cancelled && get().activeSessionId === sessionId) activateForVisit(sessionId);
        })
        .catch(() => {
          if (get().activeSessionId === sessionId) activateForVisit(sessionId);
        });
      return;
    }
    const target = get().sessions.get(sessionId);
    if (
      target &&
      (target.status === "cold" || target.status === "exited" || target.status === "failed")
    ) {
      // Main binds the token only when this visit actually causes activation;
      // an already-live process can therefore never be reaped by a stale UI
      // status or duplicate invoke.
      activateForVisit(sessionId);
    }
  },

  setActiveWorkspace: (path) => {
    set({ activeWorkspacePath: path });
  },
  setHeaderCompact: (v) => {
    set({ headerCompact: v });
  },

  setNewSessionDraft: (workspacePath, text) => {
    set((state) => {
      const drafts = new Map(state.newSessionDrafts);
      drafts.set(workspacePath, text);
      return { newSessionDrafts: drafts };
    });
  },

  clearNewSessionDraft: (workspacePath) => {
    set((state) => {
      if (!state.newSessionDrafts.has(workspacePath)) return {};
      const drafts = new Map(state.newSessionDrafts);
      drafts.delete(workspacePath);
      return { newSessionDrafts: drafts };
    });
  },

  setSessionDraft: (sessionId, text) => {
    set((state) => {
      if (text === "") {
        if (!state.sessionDrafts.has(sessionId)) return {};
        const drafts = new Map(state.sessionDrafts);
        drafts.delete(sessionId);
        return { sessionDrafts: drafts };
      }
      const drafts = new Map(state.sessionDrafts);
      drafts.set(sessionId, text);
      return { sessionDrafts: drafts };
    });
  },

  setDiffComment: (sessionId, comment) => {
    const text = comment.text.trim();
    if (text.length === 0) {
      get().deleteDiffComment(sessionId, comment.filePath, comment.lineNumber);
      return;
    }
    set((state) => {
      const diffComments = new Map(state.diffComments);
      const existingForSession = diffComments.get(sessionId) ?? new Map<string, CodeComment>();
      const comments = new Map(existingForSession);
      const key = codeCommentKey(comment.filePath, comment.lineNumber);
      const existing = comments.get(key);
      const now = Date.now();
      comments.set(key, {
        id: existing?.id ?? createCodeCommentId(),
        filePath: comment.filePath,
        lineNumber: comment.lineNumber,
        originalLineNumber: existing?.originalLineNumber ?? comment.lineNumber,
        lineText: comment.lineText,
        anchorStatus: "current",
        text,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      diffComments.set(sessionId, comments);
      persistCodeComments(diffComments);
      return { diffComments };
    });
  },

  deleteDiffComment: (sessionId, filePath, lineNumber) => {
    set((state) => {
      const existingForSession = state.diffComments.get(sessionId);
      if (!existingForSession) return {};
      const key = codeCommentKey(filePath, lineNumber);
      if (!existingForSession.has(key)) return {};
      const comments = new Map(existingForSession);
      comments.delete(key);
      const diffComments = new Map(state.diffComments);
      if (comments.size === 0) diffComments.delete(sessionId);
      else diffComments.set(sessionId, comments);
      persistCodeComments(diffComments);
      return { diffComments };
    });
  },

  clearDiffComments: (sessionId) => {
    set((state) => {
      if (!state.diffComments.has(sessionId)) return {};
      const diffComments = new Map(state.diffComments);
      diffComments.delete(sessionId);
      persistCodeComments(diffComments);
      return { diffComments };
    });
  },

  clearSubmittedDiffComments: (sessionId, submitted) => {
    if (submitted.length === 0) return;
    set((state) => {
      const existingForSession = state.diffComments.get(sessionId);
      if (!existingForSession) return {};
      const comments = new Map(existingForSession);
      let changed = false;
      for (const submittedComment of submitted) {
        for (const [key, current] of comments) {
          if (sameCommentRevision(current, submittedComment)) {
            comments.delete(key);
            changed = true;
            break;
          }
        }
      }
      if (!changed) return {};
      const diffComments = new Map(state.diffComments);
      if (comments.size === 0) diffComments.delete(sessionId);
      else diffComments.set(sessionId, comments);
      persistCodeComments(diffComments);
      return { diffComments };
    });
  },

  reconcileDiffCommentsForFile: (sessionId, filePath, model) => {
    const currentLines = newSideLineText(model);
    set((state) => {
      const existingForSession = state.diffComments.get(sessionId);
      if (!existingForSession) return {};
      let comments: Map<string, CodeComment> | null = null;
      const ensureComments = (): Map<string, CodeComment> => {
        comments ??= new Map(existingForSession);
        return comments;
      };
      let changed = false;

      for (const [key, comment] of existingForSession) {
        if (comment.filePath !== filePath) continue;
        const currentText = currentLines.get(comment.lineNumber);
        if (currentText === comment.lineText) {
          if (comment.anchorStatus !== "current") {
            ensureComments().set(key, { ...comment, anchorStatus: "current" });
            changed = true;
          }
          continue;
        }

        const relocatedLine = findUniqueLineByText(currentLines, comment.lineText);
        if (relocatedLine !== null) {
          const nextKey = codeCommentKey(filePath, relocatedLine);
          const nextComments = ensureComments();
          const occupant = nextComments.get(nextKey);
          if (!occupant || occupant.id === comment.id) {
            const nextComment: CodeComment = {
              ...comment,
              lineNumber: relocatedLine,
              originalLineNumber: comment.originalLineNumber,
              anchorStatus: relocatedLine === comment.originalLineNumber ? "current" : "relocated",
            };
            nextComments.delete(key);
            nextComments.set(nextKey, nextComment);
            changed = true;
            continue;
          }
        }

        if (comment.anchorStatus !== "stale") {
          ensureComments().set(key, { ...comment, anchorStatus: "stale" });
          changed = true;
        }
      }

      if (!changed || !comments) return {};
      const diffComments = new Map(state.diffComments);
      diffComments.set(sessionId, comments);
      persistCodeComments(diffComments);
      return { diffComments };
    });
  },

  markDiffCommentsStaleForMissingFiles: (sessionId, currentFilePaths) => {
    set((state) => {
      const existingForSession = state.diffComments.get(sessionId);
      if (!existingForSession) return {};
      let comments: Map<string, CodeComment> | null = null;
      for (const [key, comment] of existingForSession) {
        if (currentFilePaths.has(comment.filePath) || comment.anchorStatus === "stale") continue;
        comments ??= new Map(existingForSession);
        comments.set(key, { ...comment, anchorStatus: "stale" });
      }
      if (!comments) return {};
      const diffComments = new Map(state.diffComments);
      diffComments.set(sessionId, comments);
      persistCodeComments(diffComments);
      return { diffComments };
    });
  },

  applyDiffEditReanchor: (sessionId, filePath, edit) => {
    set((state) => {
      const existingForSession = state.diffComments.get(sessionId);
      if (!existingForSession) return {};
      const hasFile = Array.from(existingForSession.values()).some((c) => c.filePath === filePath);
      if (!hasFile) return {};
      const reanchored = reanchorCommentsForEdit(
        Array.from(existingForSession.values()),
        filePath,
        edit,
      );
      // Re-key the Map (lineNumbers may have moved) and drop any stale dupes.
      const comments = new Map<string, CodeComment>();
      for (const c of reanchored) {
        comments.set(codeCommentKey(c.filePath, c.lineNumber), c);
      }
      const diffComments = new Map(state.diffComments);
      diffComments.set(sessionId, comments);
      persistCodeComments(diffComments);
      return { diffComments };
    });
  },

  getDiffCommentsForPrompt: (sessionId) => {
    return Array.from(get().diffComments.get(sessionId)?.values() ?? []);
  },

  prependDiffCommentsToPrompt: (sessionId, prompt) => {
    return prependCodeCommentsToPrompt(prompt, get().getDiffCommentsForPrompt(sessionId));
  },
});

export const useSessionsStore = create<SessionsStore>((rawSet, rawGet) => {
  type StoreUpdate =
    | SessionsStore
    | Partial<SessionsStore>
    | ((state: SessionsStore) => SessionsStore | Partial<SessionsStore>);
  let transitionDraft: SessionsStore | undefined;
  const invokeRawSet = rawSet as unknown as (update: StoreUpdate, replace?: boolean) => void;
  const get = (): SessionsStore => transitionDraft ?? rawGet();
  const set = ((update: StoreUpdate, replace?: boolean) => {
    if (!transitionDraft) {
      invokeRawSet(update, replace);
      return;
    }
    const partial = typeof update === "function" ? update(transitionDraft) : update;
    transitionDraft = replace
      ? (partial as SessionsStore)
      : ({ ...transitionDraft, ...partial } as SessionsStore);
  }) as typeof rawSet;
  const runAtomically = (operation: () => void): void => {
    if (transitionDraft) throw new Error("Nested transition batches are not supported");
    transitionDraft = rawGet();
    let committed: SessionsStore | undefined;
    try {
      operation();
      committed = transitionDraft;
    } finally {
      transitionDraft = undefined;
    }
    if (committed) invokeRawSet(committed, true);
  };
  return buildSessionsStore(set, get, runAtomically);
});

/**
 * Derive the git root for a session — prefers the worktree path
 * over the workspace path. Callers that need the root for git
 * operations (diff viewer, changes badge) must use this.
 */
export function gitRootForSession(
  session: Pick<SessionViewState, "worktreePath" | "workspacePath"> | undefined,
): string | undefined {
  return session?.worktreePath ?? session?.workspacePath;
}
