import type { SessionId } from "@shared/ids.js";
import type { HistoryPage, SessionStatus, SessionSummary } from "@shared/ipc-contract.js";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import type { ModelInfo, SessionStats, SlashCommandInfo } from "@shared/pi-protocol/responses.js";
import {
  ModelInfoSchema,
  SessionStateSchema,
  SessionStatsSchema,
} from "@shared/pi-protocol/responses.js";
import type { ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import { ThinkingLevelSchema } from "@shared/pi-protocol/thinking.js";
import { detectTurnError } from "@shared/pi-protocol/turn-error.js";
import { create } from "zustand";
import type { PickerRequest } from "../lib/commands/execute.js";
import { executeAction } from "../lib/commands/execute.js";
import { parseComposerInput } from "../lib/commands/parse.js";
import {
  type CodeComment,
  codeCommentKey,
  createCodeCommentId,
  loadPersistedCodeComments,
  persistCodeComments,
  prependCodeCommentsToPrompt,
} from "../lib/diff-comments.js";
import type { DiffModel } from "../lib/diff/diff-model.js";
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
  seedFromHistory,
} from "./transcript.js";

let nextThinkingRequestId = 1;
const pendingThinkingRequests = new Map<SessionId, number>();

export interface QueuedMessage {
  id: string;
  text: string;
  source: "optimistic" | "authoritative";
}

export interface SessionViewState {
  sessionId: SessionId;
  workspacePath: string;
  sessionFile?: string | undefined;
  status: SessionStatus;
  error?: string | undefined;
  transcript: TranscriptState;
  isStreaming: boolean;
  queuedMessages?: { steering: QueuedMessage[]; followUp: QueuedMessage[] } | undefined;
  promptsInFlight: number;
  retryPending: boolean;
  streamingEpoch: number;
  queueEpoch: number;
  identityEpoch: number;
  /** Wall-clock timestamp (ms) when the session became logically working
   *  (`isStreaming || promptsInFlight > 0`). It is set on the false→true
   *  working transition and cleared on the true→false transition, so prompt
   *  preflight, streaming, and retry backoff share one continuous timer. */
  runningSince?: number | undefined;
  /**
   * Unread turn-result marker for the sidebar status dot. Set to "done" or
   * "error" when a turn finishes (see applyEvent's agent_end handling). It
   * acts as a notification for background sessions: it persists until the
   * user views the session and moves on (setActiveSession clears the
   * previously-active session) or starts a new turn there (agent_start).
   */
  unreadStatus?: "done" | "error" | undefined;
  /** Transient: did the current agent attempt produce a provider/model error?
   *  Reset on agent_start and on a willRetry agent_end (each auto-retry attempt
   *  starts clean), set on an erroring assistant message_end, consumed at the
   *  final (non-retrying) agent_end to decide unreadStatus. */
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
  editorInjection?: { text: string; nonce: number } | undefined;
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
    | { id: number; overlay: boolean; buffer: string[]; mode?: "content" | "viewport" }
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
  unifiedPanel?: { id: number; buffer: string[]; mode?: "content" | "viewport" } | undefined;
  /** When a `unifiedPanel` is live, the user can toggle between the
   *  extension's TUI surface and the native Composer (both stay mounted-
   *  ready, only the visible one renders). `false` (default) shows the
   *  unified TUI — the parity-correct surface when a factory widget is
   *  live; `true` shows the Composer instead. Reset to `false` whenever a
   *  panel opens/closes/resets so a fresh panel always starts visible. */
  unifiedPanelHidden?: boolean | undefined;
  /** pi version reported by the SDK-host on ready (undefined for pi --mode rpc).
   *  Surfaced in the SessionHeader tooltip. See P1-c. */
  piVersion?: string | undefined;
  /** True once we know the session has conversation-tree history outside the
   *  currently-visible branch. `/tree` can navigate to the root before any
   *  messages, which legitimately leaves `transcript.blocks` empty; sidebar /
   *  first-send affordances must still treat that session as non-empty. */
  hasTreeHistory?: boolean | undefined;
  historyCursor?: { startIndex: number; total: number } | undefined;
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
  return !!s && (s.transcript.blocks.length > 0 || !!s.hasTreeHistory);
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
    !s.unifiedPanel
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
  return !!session && (session.isStreaming || session.promptsInFlight > 0);
}

export function shouldShowWorkingIndicator(session: SessionViewState | undefined): boolean {
  if (!session || !isSessionWorking(session)) return false;
  const extensionUiActive = session.pendingDialogs.length > 0 || session.panel != null;
  return !extensionUiActive || hasActiveAgentWork(session);
}

function hasActiveBash(session: SessionViewState | undefined): boolean {
  return session?.transcript.activeBashId != null;
}

let queuedMessageCounter = 0;

function queuedFromSnapshot(kind: "steering" | "followUp", texts: string[]): QueuedMessage[] {
  return texts.map((text, index) => ({
    id: `auth-${kind}-${index}-${text}`,
    text,
    source: "authoritative" as const,
  }));
}

function queuedMessagesFromSnapshot(
  steering: string[],
  followUp: string[],
): SessionViewState["queuedMessages"] {
  if (steering.length === 0 && followUp.length === 0) return undefined;
  return {
    steering: queuedFromSnapshot("steering", steering),
    followUp: queuedFromSnapshot("followUp", followUp),
  };
}

function applyLivenessPatch(
  session: SessionViewState,
  patch: Partial<Pick<SessionViewState, "isStreaming" | "promptsInFlight" | "retryPending">>,
): SessionViewState {
  const wasWorking = isSessionWorking(session);
  const next: SessionViewState = { ...session, ...patch };
  const nowWorking = isSessionWorking(next);
  let runningSince = session.runningSince;
  if (!wasWorking && nowWorking) runningSince = Date.now();
  if (wasWorking && !nowWorking) runningSince = undefined;
  const livenessChanged =
    session.isStreaming !== next.isStreaming ||
    session.promptsInFlight !== next.promptsInFlight ||
    session.retryPending !== next.retryPending;
  return {
    ...next,
    runningSince,
    streamingEpoch: livenessChanged ? session.streamingEpoch + 1 : session.streamingEpoch,
  };
}

function resetRuntimeState(
  session: SessionViewState,
  opts?: { bumpIdentity?: boolean },
): SessionViewState {
  return {
    ...session,
    isStreaming: false,
    promptsInFlight: 0,
    retryPending: false,
    runningSince: undefined,
    queuedMessages: undefined,
    streamingEpoch: session.streamingEpoch + 1,
    queueEpoch: session.queueEpoch + 1,
    identityEpoch: opts?.bumpIdentity ? session.identityEpoch + 1 : session.identityEpoch,
  };
}

export function isSessionAbortable(session: SessionViewState | undefined): boolean {
  if (!session || session.status === "exited" || session.status === "failed") return false;
  return isSessionWorking(session) || hasActiveAgentWork(session) || hasActiveBash(session);
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
  loadEarlierHistory: (sessionId: SessionId) => Promise<void>;
  addUserMessage: (
    sessionId: SessionId,
    content: string,
    images?: string[],
    opts?: { registerEcho?: boolean },
  ) => void;
  clearPendingUserEcho: (sessionId: SessionId, content: string) => void;
  addBashCommand: (sessionId: SessionId, command: string) => void;
  finishBashCommand: (sessionId: SessionId, output: string, exitCode?: number) => void;
  setStreaming: (sessionId: SessionId, isStreaming: boolean) => void;
  beginPromptInFlight: (sessionId: SessionId) => void;
  endPromptInFlight: (sessionId: SessionId) => void;
  enqueueOptimisticSteer: (sessionId: SessionId, text: string) => string;
  removeOptimisticQueuedMessage: (sessionId: SessionId, id: string) => void;
  replaceQueueFromAuthoritativeSnapshot: (
    sessionId: SessionId,
    steering: string[],
    followUp: string[],
  ) => void;
  clearQueue: (sessionId: SessionId) => void;
  reconcileSessionState: (
    sessionId: SessionId,
    snapshot: unknown,
    captured: { identityEpoch: number; streamingEpoch: number; queueEpoch: number },
  ) => void;
  /** Interrupt the active turn or standalone bash command. No-op (no IPC)
   *  when the session has nothing abortable; rejection-safe when it does send
   *  (host-fallback transition can reject). S3. */
  abortSession: (sessionId: SessionId) => void;
  addUiRequest: (sessionId: SessionId, request: ExtensionUiRequest) => void;
  handlePanelEvent: (sessionId: SessionId, event: PanelEvent) => void;
  /** Run the unified-TUI editor's submitted text through the shared submit
   *  pipeline (parseComposerInput + executeAction), then reply to the host
   *  via `session.unifiedSubmitResponse` so it can restore the editor text on
   *  a guard bail (e.g. no model). Deps mirror the React Composer's exactly —
   *  including `adoptSessionFileAndHydrate` (adopt + load history + refresh the
   *  sidebar), so /fork, /clone, /switch_session, /resume work identically to
   *  the native Composer. No re-entrancy guard is needed: pi clears the editor
   *  synchronously in submitValue, so a second Enter before the first resolves
   *  is an empty submit (caught by the !trimmed bail), and a second DISTINCT
   *  prompt during an active turn is routed to a `steer` by executeAction
   *  (the intended course-correction path — a dropping guard would suppress it). */
  handleUnifiedSubmitRequest: (sessionId: SessionId, id: string, text: string) => Promise<void>;
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
  refreshAvailableModels: (sessionId: SessionId) => Promise<ModelInfo[]>;
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
  ) => Promise<void>;
  /** Refresh the discovered command list (extension/prompt/skill) from pi. */
  refreshCommands: (sessionId: SessionId) => Promise<void>;
  /** Drop a fresh nonce on editorInjection so the Composer re-picks it up. */
  injectEditorText: (sessionId: SessionId, text: string) => void;
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

export const useSessionsStore = create<SessionsStore>((set, get) => ({
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
        isStreaming: false,
        queuedMessages: undefined,
        promptsInFlight: 0,
        retryPending: false,
        streamingEpoch: 0,
        queueEpoch: 0,
        identityEpoch: 0,
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
        const runtime =
          becomingTerminal || status === "starting"
            ? resetRuntimeState(s, { bumpIdentity: true })
            : s;
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
      let anyPromoted = false;

      for (const event of events) {
        let unreadStatus = current.unreadStatus;
        let turnErrored = current.turnErrored;
        let livenessPatch: Partial<Pick<SessionViewState, "isStreaming" | "retryPending">> = {};
        let queuePatch: Pick<SessionViewState, "queuedMessages" | "queueEpoch"> | null = null;
        const sessionName =
          event.type === "session_info_changed" ? event.name : current.sessionName;

        if (event.type === "agent_start") {
          livenessPatch = { retryPending: false, isStreaming: true };
          turnErrored = false;
          unreadStatus = undefined;
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          if (detectTurnError(event.message).isError) turnErrored = true;
        }
        if (event.type === "agent_end") {
          if (event.willRetry) {
            livenessPatch = { retryPending: true, isStreaming: true };
            turnErrored = false;
          } else {
            livenessPatch = { retryPending: false, isStreaming: false };
            unreadStatus = turnErrored ? "error" : "done";
            turnErrored = false;
          }
        }
        if (event.type === "auto_retry_start") {
          livenessPatch = { retryPending: true, isStreaming: true };
        }
        if (event.type === "auto_retry_end" && event.success === false && current.isStreaming) {
          livenessPatch = { retryPending: false, isStreaming: false };
          unreadStatus = "error";
          turnErrored = false;
        }
        if (event.type === "streaming_state") {
          livenessPatch = event.isStreaming
            ? { isStreaming: true }
            : current.retryPending
              ? {}
              : { isStreaming: false };
        }
        if (event.type === "queue_update") {
          queuePatch = {
            queuedMessages: queuedMessagesFromSnapshot(event.steering, event.followUp),
            queueEpoch: current.queueEpoch + 1,
          };
        }

        const thinkingLevel =
          event.type === "thinking_level_changed" ? event.level : current.thinkingLevel;
        const transcript = applyPiEvent(current.transcript, event);
        const userEchoed =
          event.type === "message_start" &&
          event.message?.role === "user" &&
          transcript.blocks.length > current.transcript.blocks.length;
        const promoted = !!current.isNewPending && userEchoed;
        if (promoted) {
          newSessionDrafts = clearNewSessionDraftFor(newSessionDrafts, current.workspacePath, true);
          newSessionSetupDrafts = clearNewSessionSetupFor(
            newSessionSetupDrafts,
            current.workspacePath,
            true,
          );
          anyPromoted = true;
        }
        const live = applyLivenessPatch(current, livenessPatch);
        current = {
          ...live,
          transcript,
          unreadStatus,
          turnErrored,
          sessionName,
          thinkingLevel,
          ...(queuePatch ?? {}),
          isNewPending: promoted ? false : current.isNewPending,
          editorInjection: promoted ? undefined : current.editorInjection,
        };
      }

      sessions.set(sessionId, current);
      return anyPromoted ? { sessions, newSessionDrafts, newSessionSetupDrafts } : { sessions };
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
        hasTreeHistory: s.hasTreeHistory || page.total > 0,
      });
      return { sessions };
    });
  },

  loadEarlierHistory: async (sessionId) => {
    const s = get().sessions.get(sessionId);
    const cursor = s?.historyCursor;
    if (!s?.sessionFile || !cursor || cursor.startIndex <= 0 || s.historyLoadingEarlier) return;
    const requestedStartIndex = cursor.startIndex;
    const requestedFile = s.sessionFile;
    set((state) => {
      const sessions = new Map(state.sessions);
      const cur = sessions.get(sessionId);
      if (!cur || cur.historyCursor?.startIndex !== requestedStartIndex) return {};
      sessions.set(sessionId, { ...cur, historyLoadingEarlier: true });
      return { sessions };
    });
    try {
      const page = await window.pivis.invoke("session.loadHistory", {
        sessionId,
        before: requestedStartIndex,
      });
      set((state) => {
        const sessions = new Map(state.sessions);
        const cur = sessions.get(sessionId);
        if (!cur) return {};
        if (
          cur.sessionFile !== requestedFile ||
          cur.historyCursor?.startIndex !== requestedStartIndex
        ) {
          sessions.set(sessionId, { ...cur, historyLoadingEarlier: undefined });
          return { sessions };
        }
        sessions.set(sessionId, {
          ...cur,
          transcript: prependHistory(cur.transcript, page.blocks),
          historyCursor: { startIndex: page.startIndex, total: page.total },
          historyLoadingEarlier: undefined,
          hasTreeHistory: cur.hasTreeHistory || page.total > 0,
        });
        return { sessions };
      });
    } catch (err) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const cur = sessions.get(sessionId);
        if (!cur) return {};
        sessions.set(sessionId, { ...cur, historyLoadingEarlier: undefined });
        return { sessions };
      });
      console.error("Failed to load earlier history:", err);
    }
  },

  addUserMessage: (sessionId, content, images, opts) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const transcript = addUserBlock(s.transcript, content, images, opts?.registerEcho ?? true);
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
        sessionTitle,
        lastActivityAt: Date.now(),
        isNewPending: false,
        editorInjection: undefined,
      });
      // Clear the per-workspace draft exactly when the pending session
      // becomes real (content landed). Doing it here — not in the Composer's
      // submit handler — means a send that bails early (no-model guard,
      // abort, worktree-creation failure) preserves the draft for retry.
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
      // Clear the per-session draft (non-pending sessions) — content landed,
      // so the typed text is consumed and won't resurface on switch-back.
      // No-op when there's nothing stored (clearSessionDraftFor returns the
      // same ref). Same early-bail rationale as the per-workspace clear above.
      const sessionDrafts = clearSessionDraftFor(state.sessionDrafts, sessionId);
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
      const wasEmptyBeforeOptimisticSend = s.transcript.blocks.length <= 1;
      const transcript = clearPendingUserEcho(s.transcript, content);
      if (transcript === s.transcript) return {};
      const restoredPending =
        !s.resumed && wasEmptyBeforeOptimisticSend && transcript.blocks.length === 0;
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
      sessions.set(sessionId, { ...s, transcript });
      return { sessions };
    });
  },

  setStreaming: (sessionId, isStreaming) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, applyLivenessPatch(s, { isStreaming }));
      return { sessions };
    });
  },

  beginPromptInFlight: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, applyLivenessPatch(s, { promptsInFlight: s.promptsInFlight + 1 }));
      return { sessions };
    });
  },

  endPromptInFlight: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(
        sessionId,
        applyLivenessPatch(s, { promptsInFlight: Math.max(0, s.promptsInFlight - 1) }),
      );
      return { sessions };
    });
  },

  enqueueOptimisticSteer: (sessionId, text) => {
    const id = `optimistic-${++queuedMessageCounter}`;
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const queued = s.queuedMessages ?? { steering: [], followUp: [] };
      sessions.set(sessionId, {
        ...s,
        queuedMessages: {
          ...queued,
          steering: [...queued.steering, { id, text, source: "optimistic" }],
        },
        queueEpoch: s.queueEpoch + 1,
      });
      return { sessions };
    });
    return id;
  },

  removeOptimisticQueuedMessage: (sessionId, id) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s?.queuedMessages) return {};
      const steering = s.queuedMessages.steering.filter(
        (m) => !(m.id === id && m.source === "optimistic"),
      );
      const followUp = s.queuedMessages.followUp.filter(
        (m) => !(m.id === id && m.source === "optimistic"),
      );
      if (
        steering.length === s.queuedMessages.steering.length &&
        followUp.length === s.queuedMessages.followUp.length
      )
        return {};
      sessions.set(sessionId, {
        ...s,
        queuedMessages: steering.length || followUp.length ? { steering, followUp } : undefined,
        queueEpoch: s.queueEpoch + 1,
      });
      return { sessions };
    });
  },

  replaceQueueFromAuthoritativeSnapshot: (sessionId, steering, followUp) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        queuedMessages: queuedMessagesFromSnapshot(steering, followUp),
        queueEpoch: s.queueEpoch + 1,
      });
      return { sessions };
    });
  },

  clearQueue: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, queuedMessages: undefined, queueEpoch: s.queueEpoch + 1 });
      return { sessions };
    });
  },

  reconcileSessionState: (sessionId, snapshot, captured) => {
    const parsed = SessionStateSchema.safeParse(snapshot);
    if (!parsed.success) return;
    const snap = parsed.data;
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s || s.identityEpoch !== captured.identityEpoch) return {};

      let next = s;
      if (
        next.streamingEpoch === captured.streamingEpoch &&
        typeof snap.isStreaming === "boolean"
      ) {
        if (snap.isStreaming) {
          next = applyLivenessPatch(next, { isStreaming: true, retryPending: false });
        } else if (!next.retryPending) {
          next = applyLivenessPatch(next, { isStreaming: false, retryPending: false });
        }
      }

      if (next.queueEpoch === captured.queueEpoch) {
        if (snap.steering || snap.followUp) {
          next = {
            ...next,
            queuedMessages: queuedMessagesFromSnapshot(snap.steering ?? [], snap.followUp ?? []),
            queueEpoch: next.queueEpoch + 1,
          };
        } else if (snap.pendingMessageCount === 0) {
          next = { ...next, queuedMessages: undefined, queueEpoch: next.queueEpoch + 1 };
        }
      }

      if (next === s) return {};
      sessions.set(sessionId, next);
      return { sessions };
    });
  },

  abortSession: (sessionId) => {
    const s = get().sessions.get(sessionId);
    if (!s || s.status === "exited" || s.status === "failed") return;
    const command =
      isSessionWorking(s) || hasActiveAgentWork(s)
        ? { type: "abort" as const }
        : hasActiveBash(s)
          ? { type: "abort_bash" as const }
          : null;
    if (!command) return; // S3 no-op when idle
    void window.pivis.invoke("session.sendCommand", { sessionId, command }).catch(() => {}); // S3 rejection-safe
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
              unifiedPanel: { id: event.panelId, buffer: [] },
              unifiedPanelHidden: false,
            });
          } else {
            sessions.set(sessionId, {
              ...s,
              panel: { id: event.panelId, overlay: event.overlay, buffer: [] },
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
        case "host_fallback":
          // The host couldn't start (pi too old / SDK import failed) and we
          // fell back to pi --mode rpc. Panels are unavailable — surface as a
          // toast so the user knows to update pi, without blocking the session.
          sessions.set(sessionId, {
            ...s,
            toasts: [
              ...s.toasts,
              {
                id: `toast-${++toastCounter}`,
                message: event.reason,
                type: "warning",
                createdAt: Date.now(),
              },
            ],
          });
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

  handleUnifiedSubmitRequest: async (sessionId, id, text) => {
    const trimmed = text.trim();
    const state = get();
    const session = state.sessions.get(sessionId);
    const pendingDiffComments = state.getDiffCommentsForPrompt(sessionId);
    // Mirror the React Composer's early bail: an empty/whitespace submit is a
    // no-op unless pending diff comments are the prompt body. Tell the host it
    // bailed so it can restore — though empty restore is a no-op, keeping the
    // contract uniform is simplest.
    if (!trimmed && pendingDiffComments.length === 0) {
      void window.pivis.invoke("session.unifiedSubmitResponse", {
        sessionId,
        id,
        ok: false,
        bailed: true,
      });
      return;
    }

    const discovered = new Map((session?.commands ?? []).map((c) => [c.name, c]));
    const parsedAction = parseComposerInput(trimmed, { discovered });
    const action =
      parsedAction.kind === "send-prompt" && pendingDiffComments.length > 0
        ? {
            ...parsedAction,
            text: prependCodeCommentsToPrompt(parsedAction.text, pendingDiffComments),
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
      void window.pivis.invoke("session.unifiedSubmitResponse", {
        sessionId,
        id,
        ok: false,
        bailed: true,
        error: "No model selected",
      });
      return;
    }

    // Build the same deps the React Composer builds, but from store state (the
    // TUI path has no attachments/worktree pre-send block). executeAction + the
    // store actions it calls fire the optimistic bubble, draft clear, etc.
    const deps = {
      invoke: <T = unknown>(channel: string, payload: unknown) =>
        window.pivis.invoke(
          channel as Parameters<typeof window.pivis.invoke>[0],
          payload as Parameters<typeof window.pivis.invoke>[1],
        ) as unknown as Promise<{ success: boolean; data?: T; error?: string }>,
      uiSurface: "unified" as const,
      beginPromptInFlight: get().beginPromptInFlight,
      endPromptInFlight: get().endPromptInFlight,
      enqueueOptimisticSteer: get().enqueueOptimisticSteer,
      removeOptimisticQueuedMessage: get().removeOptimisticQueuedMessage,
      addToast: get().addToast,
      addUserMessage: get().addUserMessage,
      clearPendingUserEcho: get().clearPendingUserEcho,
      addBashCommand: get().addBashCommand,
      finishBashCommand: get().finishBashCommand,
      applyModelChange: get().applyModelChange,
      addCustomMessage: get().addCustomMessage,
      openChangelog: (markdown: string) => useChangelogStore.getState().openChangelog(markdown),
      openPicker: get().openPicker,
      adoptSessionFile: get().adoptSessionFileAndHydrate,
      closeSessionTab: get().closeSessionTab,
      openAppSettings: () => window.dispatchEvent(new CustomEvent("pivis:open-settings")),
      openDiffViewer: (sid: SessionId) => openDiffForSession(sid),
      // Lazy import: tree-store imports sessions-store, so a static import here
      // would be circular. The unified-TUI submit path rarely hits /tree, so
      // deferring the module load is fine.
      openTreeViewer: (sid: SessionId) => {
        void import("./tree-store.js").then((m) =>
          m.useTreeStore.getState().openTreeForSession(sid),
        );
      },
      openLogin: () => window.dispatchEvent(new CustomEvent("pivis:open-login")),
      copyToClipboard: async (t: string) => {
        await window.pivis.invoke("clipboard.writeText", { text: t });
      },
      getAvailableModels: (sid: SessionId): ModelInfo[] =>
        get().sessions.get(sid)?.availableModels ?? [],
      getSessionName: (sid: SessionId) => get().sessions.get(sid)?.sessionName,
      setSessionName: get().setSessionName,
      getCurrentModel: (sid: SessionId) => get().sessions.get(sid)?.currentModel,
      isWorking: (sid: SessionId) => isSessionWorking(get().sessions.get(sid)),
      getSessionWorkspacePath: (sid: SessionId) => get().sessions.get(sid)?.workspacePath,
      listSessions: (p: string) =>
        window.pivis.invoke("workspace.listSessions", { workspacePath: p }),
      onPromptAccepted: () => {
        if (action.kind === "send-prompt" && pendingDiffComments.length > 0) {
          get().clearSubmittedDiffComments(sessionId, pendingDiffComments);
        }
      },
    };

    try {
      await executeAction(sessionId, action, deps);
      if (
        action.kind === "send-prompt" &&
        action.commandSource !== "extension" &&
        pendingDiffComments.length > 0
      ) {
        get().clearSubmittedDiffComments(sessionId, pendingDiffComments);
      }
      void window.pivis.invoke("session.unifiedSubmitResponse", {
        sessionId,
        id,
        ok: true,
      });
    } catch (err) {
      // executeAction threw (invoke failure, etc.) — tell the host to restore
      // so the user can retry. The error itself surfaces via addToast inside
      // executeAction's error handling where applicable.
      void window.pivis.invoke("session.unifiedSubmitResponse", {
        sessionId,
        id,
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
        (s.isNewPending && !s.sessionFile && s.transcript.blocks.length === 0)
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

  refreshAvailableModels: async (sessionId) => {
    if (typeof window === "undefined" || !window.pivis) return [];
    const currentModels = () => get().sessions.get(sessionId)?.availableModels ?? [];
    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_available_models" },
      });
      if (!res.success) return currentModels();
      const raw = res.data as { models?: unknown[]; currentModelId?: string } | undefined;
      const list = Array.isArray(raw?.models) ? raw.models : [];
      const models = list
        .map((m) => {
          const r = ModelInfoSchema.safeParse(m);
          return r.success ? r.data : null;
        })
        .filter((m): m is ModelInfo => m !== null);
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
    if (!existing || existing.modelInitialized) return;
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
      const models = await get().refreshAvailableModels(sessionId);
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
        await window.pivis
          .invoke("session.sendCommand", {
            sessionId,
            command: {
              type: "set_model",
              ...(match.provider ? { provider: match.provider } : {}),
              modelId: match.id,
            },
          })
          .then((res) => {
            if (res.success) get().setCurrentModel(sessionId, match.id, match.provider);
          })
          .catch(() => {});
      } else {
        // No last-used match: fall back to pi's reported current model. The
        // list endpoint tags the active model with `current: true`; step 2's
        // `get_state` is the authoritative source and will overwrite this.
        const active = models.find((m) => (m as Record<string, unknown>)["current"] === true);
        if (active) get().setCurrentModel(sessionId, active.id, active.provider);
      }
    } catch {
      /* best effort — leave the dropdown showing whatever the store already has */
    }

    // 2. Thinking level + session name/file (get_state).
    try {
      const capturedSession = get().sessions.get(sessionId);
      const captured = capturedSession
        ? {
            identityEpoch: capturedSession.identityEpoch,
            streamingEpoch: capturedSession.streamingEpoch,
            queueEpoch: capturedSession.queueEpoch,
          }
        : null;
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_state" },
      });
      if (!captured) return;
      const currentAfterState = get().sessions.get(sessionId);
      if (!currentAfterState || currentAfterState.identityEpoch !== captured.identityEpoch) return;
      get().reconcileSessionState(sessionId, res?.data, captured);
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

  applyModelChange: async (sessionId, model) => {
    if (typeof window === "undefined" || !window.pivis) {
      return { ok: false, error: "Unavailable" };
    }
    const before = get().sessions.get(sessionId);
    if (!before) return { ok: false, error: "Unknown session" };
    const prevModel = before.currentModel;
    const prevProvider = before.currentProvider;
    // The provider we actually send to pi. True providerless registry entries
    // must stay providerless: synthesizing one from the id makes the SDK host's
    // exact provider+id lookup miss. The host supports id-only resolution when
    // this is omitted.
    const provider = model.provider;

    // Optimistic: show the requested model right away (invariant #1's "queued
    // change about to be sent").
    get().setCurrentModel(sessionId, model.id, provider);

    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "set_model", ...(provider ? { provider } : {}), modelId: model.id },
      });
      if (!res.success) throw new Error(res.error ?? "set_model failed");
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
        if (!s || s.currentModel !== model.id || s.currentProvider !== provider) return {};
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
      const stateRes = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_state" },
      });
      const raw = stateRes?.data as { model?: { id?: unknown; provider?: unknown } } | undefined;
      const s = get().sessions.get(sessionId);
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
      shouldPersist = !!(s && s.currentModel === model.id && s.currentProvider === provider);
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
        const statsRes = await window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: { type: "get_session_stats" },
        });
        if (statsRes.success && statsRes.data) {
          const parsed = SessionStatsSchema.safeParse(statsRes.data);
          const s = get().sessions.get(sessionId);
          if (
            parsed.success &&
            s?.currentModel === persistId &&
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
    const prevLevel = before.thinkingLevel;

    const requestId = nextThinkingRequestId++;
    pendingThinkingRequests.set(sessionId, requestId);

    // Optimistic update.
    get().setThinkingLevel(sessionId, level);

    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "set_thinking_level", level },
      });
      if (!res.success) throw new Error(res.error ?? "set_thinking_level failed");

      // Reconcile with the level pi actually applied (a model may clamp it).
      let clampedTo: ThinkingLevel | undefined;
      const stateRes = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_state" },
      });
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
        if (!s || s.thinkingLevel !== level) return {};
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
        ...resetRuntimeState(s, { bumpIdentity: true }),
        sessionFile,
        transcript: createTranscriptState(),
        hasTreeHistory: false,
        historyCursor: undefined,
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
  adoptSessionFileAndHydrate: async (sessionId, sessionFile, sessionName) => {
    await get().adoptSessionFile(sessionId, sessionFile, sessionName);
    if (!sessionFile) return;
    const history = await window.pivis.invoke("session.loadHistory", { sessionId });
    get().seedHistory(sessionId, history ?? { blocks: [], startIndex: 0, total: 0 });
    const workspacePath = get().sessions.get(sessionId)?.workspacePath;
    if (workspacePath) void get().refreshWorkspaceSessions(workspacePath);
  },

  /** Refresh the discovered command list (extension / prompt / skill). */
  refreshCommands: async (sessionId) => {
    if (typeof window === "undefined" || !window.pivis) return;
    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_commands" },
      });
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
      sessions.set(sessionId, { ...s, pendingPicker: picker });
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
          const history = await window.pivis.invoke("session.loadHistory", { sessionId });
          get().seedHistory(sessionId, history ?? { blocks: [], startIndex: 0, total: 0 });
        } catch {
          /* no history — fine */
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
      await window.pivis.invoke("session.close", { sessionId }).catch(console.error);
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

    if (
      previousActiveId &&
      previousActiveId !== sessionId &&
      typeof window !== "undefined" &&
      window.pivis &&
      shouldReapPendingNewSession(get().sessions.get(previousActiveId))
    ) {
      void get().closeSessionTab(previousActiveId, { preservePendingDraft: true });
    }

    if (sessionId && typeof window !== "undefined" && window.pivis) {
      const s = get().sessions.get(sessionId);
      if (s && (s.status === "cold" || s.status === "exited" || s.status === "failed")) {
        // Activation triggers a session.activate; the main process emits
        // statusChanged("starting") which App.tsx applies. Re-invoking
        // activate before that lands is no-op'd by main's idempotency.
        window.pivis.invoke("session.activate", { sessionId }).catch((err) => {
          get().setSessionStatus(sessionId, "failed", String(err));
        });
      }
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

  getDiffCommentsForPrompt: (sessionId) => {
    return Array.from(get().diffComments.get(sessionId)?.values() ?? []);
  },

  prependDiffCommentsToPrompt: (sessionId, prompt) => {
    return prependCodeCommentsToPrompt(prompt, get().getDiffCommentsForPrompt(sessionId));
  },
}));

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
