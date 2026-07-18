import type { SessionId } from "@shared/ids.js";
import type { SessionStatus, SessionSummary, TranscriptBlock } from "@shared/ipc-contract.js";
import {
  CacheMissNoticeEventSchema,
  type KnownPiEvent,
  type PiEvent,
  PiEventSchema,
} from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import type { ModelInfo, SessionStats, SlashCommandInfo } from "@shared/pi-protocol/responses.js";
import { ModelInfoSchema } from "@shared/pi-protocol/responses.js";
import type {
  AgentSessionSnapshot,
  AuthorityAttachResponse,
  CompactionActivity,
  IntentOutcome,
  RendererPublication,
  RuntimeIdentity,
  RuntimeRecord,
  RuntimeStateUpdate,
  SemanticSnapshot,
  SessionIntent,
  SessionQuery,
  SubmissionResult,
} from "@shared/pi-protocol/runtime-state.js";
import type { ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import { detectTurnError } from "@shared/pi-protocol/turn-error.js";
import type { SessionSearchOpenResult } from "@shared/session-search.js";
import { type StateCreator, create } from "zustand";
import type { PickerRequest } from "../lib/commands/execute.js";
import { InputNotConsumedError, executeAction } from "../lib/commands/execute.js";
import { parseComposerInput } from "../lib/commands/parse.js";
import {
  parseReplicatedAttachments,
  restorationImagesToComposerAttachments,
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
import { describeIpcError } from "../lib/ipc-errors.js";
import { findCurrentModel } from "../lib/model-utils.js";
import {
  activatePanelInputIdentity,
  forgetPanelInputSequence,
  forgetPanelInputSession,
  retirePanelInputIdentity,
} from "../lib/panel-input-sequence.js";
import { RENDERER_GENERATION } from "../lib/renderer-generation.js";
import { dispatchSessionIntent, querySession } from "../lib/session-intent.js";

// One SWR mutation per live session. The key is deliberately session-local:
// each invocation rechecks its captured authority owner before writing.
const modelRefreshFlights = new Map<SessionId, Promise<boolean>>();
import {
  type RendererAuthorityState,
  createRendererAuthorityState,
  reduceAuthorityAttach,
  reduceAuthorityPublication,
  unavailableAuthority,
} from "./authority-reducer.js";
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
  retirePendingUserEchoesByIntent,
  seedFromHistory,
  transcriptBlockCount,
  transcriptHasBlocks,
} from "./transcript.js";

export interface QueuedMessage {
  id: string;
  text: string;
  intentId?: string | undefined;
  source: "optimistic" | "authoritative";
}

interface PendingComposerSubmission {
  intentId: string;
  owner: RuntimeIdentity;
  editorRevision: number;
  /** Which renderer draft map owned composerText when dispatch began. */
  draftScope: "workspace" | "session";
  /** Renderer text that may be cleared only while it is still the saved draft. */
  composerText: string;
  /** Actual prompt after staged files/comments; used for untagged legacy echoes. */
  submittedText: string;
  submittedComments: CodeComment[];
}

export interface SessionViewState {
  sessionId: SessionId;
  workspacePath: string;
  sessionFile?: string | undefined;
  status: SessionStatus;
  error?: string | undefined;
  transcript: TranscriptState;
  /** Compatibility transport diagnostic. It never authorizes semantic controls. */
  availability: RuntimeStateUpdate["availability"];
  /** Legacy direct snapshot retained only for compatibility diagnostics. */
  runtimeSnapshot?: AgentSessionSnapshot | undefined;
  /** Sole renderer semantic projection. Only a following semantic plane is authoritative. */
  authorityProjection?: RendererAuthorityState | undefined;
  hostInstanceId?: string | undefined;
  sessionEpoch: number;
  editorRevision: number;
  editorAttachments: unknown[];
  editorAttachmentReads: number;
  editorPatchPending: number;
  /**
   * Component-independent custody for one ordinary Composer submission.
   * Survives switching away from the session so correlated acceptance can
   * retire the exact draft/comment revisions while its Composer is unmounted.
   */
  pendingComposerSubmission?: PendingComposerSubmission | undefined;
  /** Cold→live activation owned by the current view-only visit, if any. */
  activationVisitId?: string | undefined;
  activationVisitReleasePending?: boolean | undefined;
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
  /** Canonical pending queue projection for the Composer queue manager. */
  pendingQueueMessages?: { steering: QueuedMessage[]; followUp: QueuedMessage[] } | undefined;
  /** Legacy transcript ownership projection retained while queued messages are in flight. */
  queuedMessages?: { steering: QueuedMessage[]; followUp: QueuedMessage[] } | undefined;
  /** Queued records are retained solely to suppress late optimistic echoes. */
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
  /** Restore instructions already applied; survives duplicate IPC delivery. */
  appliedRestoreDraftIds?: string[] | undefined;
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
  /** Owner-scoped automatic catalog refresh failure; enables a discreet retry. */
  modelRefreshFailure?: RuntimeIdentity | undefined;
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
  editorInjection?:
    | {
        text: string;
        nonce: number;
        revision?: number;
        /** Only a fresh owner baseline may yield to an existing renderer draft. */
        preserveRendererDraft?: boolean;
        /** Renderer-owned restored attachments to apply with this injection. */
        attachments?: unknown[];
      }
    | undefined;
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
  /** Monotonic main-process identity revision used to fence reload races. */
  worktreeIdentityRevision: number;
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
        /** True once a sequenced authority panel projection exists. */
        authority?: boolean;
        inputEnabled?: boolean;
        renderRevision?: number;
        /** Complete authority keyframe rendered and awaiting acknowledgement. */
        keyframeReady?: boolean;
        outputSequence?: number;
        outputKind?: "keyframe" | "delta" | "reset";
        outputAnsi?: string;
        inputAcknowledgedThrough?: number;
        syncState?: "following" | "synchronizing" | "unavailable";
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
        authority?: boolean;
        inputEnabled?: boolean;
        renderRevision?: number;
        /** Complete authority keyframe rendered and awaiting acknowledgement. */
        keyframeReady?: boolean;
        outputSequence?: number;
        outputKind?: "keyframe" | "delta" | "reset";
        outputAnsi?: string;
        inputAcknowledgedThrough?: number;
        syncState?: "following" | "synchronizing" | "unavailable";
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
  /** Renderer-local transcript ownership generation. Delayed history reads may
   *  apply only while this generation, file, and runtime identity still match. */
  historyGeneration: number;
  /** True while complete persisted transcript hydration is in progress. */
  historyHydrating?: boolean | undefined;
  /** Owner token preventing an older full-history read from clearing a successor marker. */
  historyHydrationToken?: string | undefined;
  /** Number of transcript-plane entries rejected by presentation parsing/filtering. */
  droppedTranscriptEntryCount: number;
  /** Persisted presentation may be newer than the materialized transcript. */
  transcriptPresentationDirty?: boolean | undefined;
  /** Monotonic fence for drops that do not change the transcript object identity. */
  transcriptPresentationRevision: number;
  /** Bounded owner-qualified compaction operations already checked for a result block. */
  reconciledCompactionOperationIds: string[];
  /** Result-block count captured when each observed live compaction began. */
  compactionOperationBlockBaselines: Record<string, number>;
  /** Completed operations waiting for the ordered transcript delta and next idle frame. */
  pendingCompactionReconciliations: Record<string, number | null>;
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

function panelInputIdentities(
  session: SessionViewState | undefined,
): Array<{ hostInstanceId: string; sessionEpoch: number; panelId: number }> {
  if (!session) return [];
  return [session.panel, session.unifiedPanel].flatMap((panel) =>
    panel
      ? [
          {
            hostInstanceId: panel.hostInstanceId,
            sessionEpoch: panel.sessionEpoch,
            panelId: panel.id,
          },
        ]
      : [],
  );
}

function retireSupersededPanelInputIdentities(
  sessionId: SessionId,
  previous: SessionViewState | undefined,
  current: SessionViewState | undefined,
): void {
  const currentIdentities = panelInputIdentities(current);
  const previousIdentities = panelInputIdentities(previous);
  for (const previousIdentity of previousIdentities) {
    const retained = currentIdentities.some(
      (identity) =>
        identity.hostInstanceId === previousIdentity.hostInstanceId &&
        identity.sessionEpoch === previousIdentity.sessionEpoch &&
        identity.panelId === previousIdentity.panelId,
    );
    if (!retained) retirePanelInputIdentity(sessionId, previousIdentity);
  }
  for (const currentIdentity of currentIdentities) {
    const retained = previousIdentities.some(
      (identity) =>
        identity.hostInstanceId === currentIdentity.hostInstanceId &&
        identity.sessionEpoch === currentIdentity.sessionEpoch &&
        identity.panelId === currentIdentity.panelId,
    );
    if (!retained) activatePanelInputIdentity(sessionId, currentIdentity);
  }
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

function withoutSubmittedCommentRevisions(
  existing: Map<string, CodeComment> | undefined,
  submitted: readonly CodeComment[],
): Map<string, CodeComment> | undefined {
  if (!existing || submitted.length === 0) return existing;
  const comments = new Map(existing);
  let changed = false;
  for (const submittedComment of submitted) {
    for (const [key, current] of comments) {
      if (!sameCommentRevision(current, submittedComment)) continue;
      comments.delete(key);
      changed = true;
      break;
    }
  }
  return changed ? comments : existing;
}

function clearMatchingDraft<K>(drafts: Map<K, string>, key: K, text: string): Map<K, string> {
  if (drafts.get(key) !== text) return drafts;
  const next = new Map(drafts);
  next.delete(key);
  return next;
}

function submissionDispositionProvesCustody(disposition: SubmissionResult["disposition"]): boolean {
  return ["in_custody", "consumed", "completed", "extension_error"].includes(disposition);
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
export function authoritySnapshotFor(
  session: SessionViewState | undefined,
): SemanticSnapshot | undefined {
  const projection = session?.authorityProjection;
  return projection?.semantic.state === "following" ? projection.authoritativeSnapshot : undefined;
}

/** Semantic controls require a complete authority frame, never a legacy lease. */
export function hasAuthoritativeSemanticState(session: SessionViewState | undefined): boolean {
  return authoritySnapshotFor(session) !== undefined;
}

export function isSessionWorking(session: SessionViewState | undefined): boolean {
  return authoritySnapshotFor(session)?.sdk.isStreaming === true;
}

export function sessionCompactionActivity(
  session: SessionViewState | undefined,
): CompactionActivity | undefined {
  const snapshot = authoritySnapshotFor(session);
  if (!snapshot) return undefined;
  // Pi's generic SDK getter also covers branch summarization. The child-owned
  // operation journal/activity projection is the only source that can
  // distinguish real context compaction from tree navigation.
  return snapshot.activity.compaction;
}

function isSessionHistoryBusy(session: SessionViewState | undefined): boolean {
  return isSessionWorking(session) || sessionCompactionActivity(session) !== undefined;
}

function authorityObservation(session: SessionViewState) {
  const snapshot = authoritySnapshotFor(session);
  const semantic = session.authorityProjection;
  if (!snapshot || semantic?.semantic.state !== "following") return undefined;
  return { owner: snapshot.owner, cursor: semantic.semantic.cursor };
}

export function sessionMatchesRuntime(
  session: SessionViewState | undefined,
  runtime: { hostInstanceId: string; sessionEpoch: number },
): session is SessionViewState {
  const snapshot = authoritySnapshotFor(session);
  return (
    session?.status === "ready" &&
    snapshot?.owner.hostInstanceId === runtime.hostInstanceId &&
    snapshot.owner.sessionEpoch === runtime.sessionEpoch
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
  const snapshot = authoritySnapshotFor(session);
  const runtime =
    expectedRuntime ?? (session.status === "ready" && snapshot ? snapshot.owner : undefined);
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
      if (
        !session ||
        !session.sessionFile ||
        session.status === "failed" ||
        session.status === "exited"
      ) {
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
      if (!isSessionHistoryBusy(session)) finish(true);
    };
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
    unsubscribe = useSessionsStore.subscribe(inspect);
    inspect();
  });
}

async function requestBoundHistory(
  sessionId: SessionId,
  capture: HistoryReadCapture,
): Promise<TranscriptBlock[] | undefined> {
  const result = await window.pivis.invoke("session.loadHistory", {
    sessionId,
    expectedSessionFile: capture.sessionFile,
    historyGeneration: capture.historyGeneration,
    expectedHostInstanceId: capture.expectedRuntime?.hostInstanceId ?? null,
    expectedSessionEpoch: capture.expectedRuntime?.sessionEpoch ?? null,
  });
  if (result.status !== "loaded" || result.historyGeneration !== capture.historyGeneration) {
    return undefined;
  }
  if (!historyCaptureMatches(useSessionsStore.getState().sessions.get(sessionId), capture)) {
    return undefined;
  }
  return result.history;
}

export function shouldShowWorkingIndicator(session: SessionViewState | undefined): boolean {
  if (!session) return false;
  if (sessionCompactionActivity(session)) return true;
  if (!isSessionWorking(session)) return false;
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
  pendingEchoes: TranscriptState["pendingEchoes"] = [],
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

function extensionErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "An extension failed while handling this session.";
}

function appendQueueRestorations(
  current: SessionViewState,
  restorations: ReadonlyArray<{
    restorationId: string;
    steering: string[];
    followUp: string[];
    originalAttachments: Array<{ intentId: string; images: unknown[] }>;
    clearedIntentIds?: string[] | undefined;
    commandDescription?: string | undefined;
  }>,
): SessionViewState {
  let next = current;
  for (const restoration of restorations) {
    if (next.queueRestorations?.some((item) => item.restorationId === restoration.restorationId))
      continue;
    const transcript = restoration.clearedIntentIds?.length
      ? retirePendingUserEchoesByIntent(next.transcript, restoration.clearedIntentIds)
      : next.transcript;
    // Keep original image objects as review custody; never convert or drop
    // them while applying a semantic frame or attach baseline.
    next = {
      ...next,
      transcript,
      queueRestorations: [...(next.queueRestorations ?? []), structuredClone(restoration)],
    };
  }
  return next;
}

function applyAuthoritySemanticProjection(
  current: SessionViewState,
  authorityProjection: RendererAuthorityState,
): SessionViewState {
  const snapshot = authorityProjection.authoritativeSnapshot;
  const extensionPresentation =
    authorityProjection.extensionUi.state === "following"
      ? {
          statusSegments: new Map(
            Object.entries(authorityProjection.extensionUiBaseline?.statuses ?? {}),
          ),
          widgets: new Map(Object.entries(authorityProjection.extensionUiBaseline?.widgets ?? {})),
        }
      : {
          // A semantic publication cannot clear a separately fenced extension
          // UI plane. Retain its last presentation until that plane follows a
          // baseline that authoritatively replaces it.
          statusSegments: current.statusSegments,
          widgets: current.widgets,
        };
  if (authorityProjection.semantic.state !== "following" || !snapshot) {
    // A retained frame is explicitly diagnostic while fenced. Retain only
    // presentation compatibility fields; clear all control/dispatch state.
    return {
      ...current,
      hostInstanceId: undefined,
      runningSince: undefined,
      pendingQueueMessages: undefined,
      queuedMessages: undefined,
      ...extensionPresentation,
      editorInjection: undefined,
    };
  }
  const priorOwner =
    current.authorityProjection?.authoritativeSnapshot?.owner ??
    current.authorityProjection?.staleDiagnosticSnapshot?.owner;
  const ownerChanged = priorOwner
    ? priorOwner.hostInstanceId !== snapshot.owner.hostInstanceId ||
      priorOwner.sessionEpoch !== snapshot.owner.sessionEpoch
    : current.hostInstanceId !== snapshot.owner.hostInstanceId ||
      current.sessionEpoch !== snapshot.owner.sessionEpoch;
  const priorStreaming = authoritySnapshotFor(current)?.sdk.isStreaming === true;
  // An editor publication changes component state only when it advances the
  // authoritative editor baseline. Replaying the same revision for unrelated
  // semantic work must not reset a controlled textarea while a native key
  // event is in flight. While local patches own custody, suppress replacement;
  // acceptance already leaves the optimistic value in place, while rejection
  // is represented explicitly by snapshot.editor conflict candidates.
  const editorRevisionChanged = ownerChanged || snapshot.editor.revision !== current.editorRevision;
  const editorInjection =
    snapshot.editor.conflictText !== undefined || current.editorPatchPending > 0
      ? undefined
      : editorRevisionChanged
        ? {
            text: snapshot.editor.text,
            nonce: ++editorInjectionNonce,
            revision: snapshot.editor.revision,
            ...(ownerChanged && snapshot.editor.text === "" ? { preserveRendererDraft: true } : {}),
          }
        : current.editorInjection;

  // This is deliberately one object construction: frame records and every
  // compatibility projection of its terminal semantic snapshot commit together.
  return {
    ...current,
    hostInstanceId: snapshot.owner.hostInstanceId,
    sessionEpoch: snapshot.owner.sessionEpoch,
    historyGeneration: ownerChanged ? current.historyGeneration + 1 : current.historyGeneration,
    currentModel: snapshot.model?.id,
    currentProvider: snapshot.model?.provider,
    thinkingLevel: snapshot.thinkingLevel,
    // The complete semantic snapshot is canonical, including an explicit
    // clear; rename outcomes are operation evidence, not presentation state.
    sessionName: snapshot.sessionName,
    editorRevision: snapshot.editor.revision,
    editorAttachments: snapshot.editor.attachments,
    editorConflict: editorConflictFromCandidates(snapshot.editor),
    editorInjection,
    runningSince:
      !priorStreaming && snapshot.sdk.isStreaming
        ? Date.now()
        : priorStreaming && !snapshot.sdk.isStreaming
          ? undefined
          : current.runningSince,
    pendingQueueMessages: queuedMessagesFromSnapshot(
      snapshot.queues.steering,
      snapshot.queues.followUp,
      snapshot.queues.steeringIntentIds,
      snapshot.queues.followUpIntentIds,
    ),
    queuedMessages: queuedMessagesFromSnapshot(
      snapshot.queues.steering,
      snapshot.queues.followUp,
      snapshot.queues.steeringIntentIds,
      snapshot.queues.followUpIntentIds,
      current.transcript.pendingEchoes,
    ),
    ...extensionPresentation,
    sessionTitle: snapshot.catalog.title,
  };
}

function resetRuntimeState(session: SessionViewState): SessionViewState {
  return {
    ...session,
    availability: "unavailable",
    runtimeSnapshot: undefined,
    runningSince: undefined,
    pendingQueueMessages: undefined,
    queuedMessages: undefined,
  };
}

export function isSessionAbortable(session: SessionViewState | undefined): boolean {
  return !!session && session.status !== "exited" && session.status !== "failed";
}

export function submissionDispositionKey(
  intentId: string,
  owner: Pick<RuntimeIdentity, "hostInstanceId" | "sessionEpoch">,
): string {
  return `${intentId}\u0000${owner.hostInstanceId}\u0000${owner.sessionEpoch}`;
}

interface SessionsStore {
  workspaces: Map<string, WorkspaceState>;
  sessions: Map<SessionId, SessionViewState>;
  /** Bounded renderer-presentation-only admission feedback. Never semantic authority. */
  submissionDispositions: Map<string, SubmissionResult>;
  /** One-shot native Composer focus request, distinct from session selection. */
  composerFocusRequest?: { sessionId: SessionId; nonce: number } | undefined;
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
  registerPendingComposerSubmission: (
    sessionId: SessionId,
    submission: PendingComposerSubmission,
  ) => void;

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
    opts?: {
      focus?: boolean;
      /** Explicit user-entry request for the native Composer, not selection semantics. */
      requestComposerFocus?: boolean;
      preopened?: Extract<SessionSearchOpenResult, { sessionId: unknown }>;
    },
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
  seedHistory: (
    sessionId: SessionId,
    history: TranscriptBlock[],
    opts?: { hydrationToken?: string },
  ) => void;
  /** Replace only the visible transcript from a completed, owner-bound tree navigation. */
  replaceTranscriptForNavigate: (
    sessionId: SessionId,
    outcome: Extract<IntentOutcome, { kind: "navigate" }>,
    history: TranscriptBlock[],
  ) => boolean;
  /** Rebuild presentation from persisted JSONL under history ownership and idle fences. */
  rehydrateHistory: (sessionId: SessionId) => Promise<void>;
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
  /** Shadow reducer entry points for the authority-frame protocol. */
  applyAuthorityAttach: (sessionId: SessionId, response: AuthorityAttachResponse) => void;
  applyAuthorityPublication: (publication: RendererPublication) => void;
  markAuthorityUnavailable: (sessionId: SessionId, reason: string) => void;
  applyTransitionBatch: (
    sessionId: SessionId,
    records: RuntimeRecord[],
    state: RuntimeStateUpdate,
  ) => void;
  applySubmissionDisposition: (sessionId: SessionId, result: SubmissionResult) => void;
  /** Request a one-shot focus attempt by the matching mounted native Composer. */
  requestComposerFocus: (sessionId: SessionId) => void;
  /** Consume only the exact matching request; refused attempts are final. */
  consumeComposerFocus: (sessionId: SessionId, nonce: number) => void;
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
  applyRestoreDraft: (
    sessionId: SessionId,
    restoration: {
      restorationId: string;
      text: string;
      attachments: unknown[];
      disposition: "restore" | "dropped";
    },
  ) => void;
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
    revision?: number,
  ) => void;
  /** Clear linked-worktree identity after an authoritative move to Workspace. */
  applyWorkspace: (sessionId: SessionId, revision?: number) => void;
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
  /** Silent stale-while-revalidate catalog refresh. Never activates a cold session. */
  refreshModelsSilently: (sessionId: SessionId) => Promise<boolean>;
  setCurrentModel: (sessionId: SessionId, model: string, provider?: string) => void;
  setThinkingLevel: (sessionId: SessionId, level: ThinkingLevel) => void;
  /**
   * One-time bootstrap for the model catalog and brand-new-session preferences.
   * It dispatches preferences as intents; canonical model/thinking values wait
   * for their subsequent authoritative snapshot or semantic frame.
   */
  bootstrapModelState: (sessionId: SessionId) => Promise<void>;
  /** Dispatch an owner-bound model intent. Receipt feedback never changes the
   * canonical selection; the terminal authority frame does. */
  applyModelChange: (
    sessionId: SessionId,
    model: ModelInfo,
    expectedRuntime?: { hostInstanceId: string; sessionEpoch: number },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Dispatch an owner-bound thinking intent. Pi's applied/clamped level is
   * projected only by an authoritative snapshot or semantic frame. */
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

  /** Selects synchronously. A cold-open caller may fence subprocess activation
   *  behind persisted-history hydration so the selected transcript/editor are
   *  useful before runtime attach begins. */
  setActiveSession: (
    sessionId: SessionId | null,
    opts?: { beforeActivation?: Promise<unknown> },
  ) => Promise<boolean>;
  /** Retry activation for an already-active failed/exited session. Switching
   *  to a session is what normally reactivates it, so a session that dies
   *  while active (host crash, sleep/wake) needs this explicit recovery. */
  reactivateSession: (sessionId: SessionId) => Promise<boolean>;
  setActiveWorkspace: (path: string | null) => void;
}

let toastCounter = 0;
let editorInjectionNonce = 0;
let composerFocusNonce = 0;
const SUBMISSION_DISPOSITION_CACHE_LIMIT = 128;

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

function recentCompactionBlockCount(state: TranscriptState): number {
  const newestArchiveCount =
    state.archivedBlockChunks.at(-1)?.filter((block) => block.type === "compaction").length ?? 0;
  return newestArchiveCount + state.blocks.filter((block) => block.type === "compaction").length;
}

function observedCompactionKey(
  operation: SemanticSnapshot["recentObservedOperations"][number],
): string {
  return `${operation.owner.hostInstanceId}\u0000${operation.owner.sessionEpoch}\u0000${operation.operationId}`;
}

const scheduledPresentationRehydrates = new Set<SessionId>();
let historyHydrationCounter = 0;

function newHistoryHydrationToken(): string {
  return `history-${++historyHydrationCounter}`;
}

function schedulePresentationRehydrateIfIdle(sessionId: SessionId): void {
  const session = useSessionsStore.getState().sessions.get(sessionId);
  if (
    !session?.sessionFile ||
    !session.transcriptPresentationDirty ||
    session.historyHydrating ||
    isSessionHistoryBusy(session) ||
    scheduledPresentationRehydrates.has(sessionId)
  ) {
    return;
  }
  scheduledPresentationRehydrates.add(sessionId);
  queueMicrotask(() => {
    scheduledPresentationRehydrates.delete(sessionId);
    void useSessionsStore.getState().rehydrateHistory(sessionId);
  });
}

const buildSessionsStore = (
  set: SessionsSet,
  get: SessionsGet,
  runAtomically: (operation: () => void) => void,
): SessionsStore => ({
  workspaces: new Map(),
  sessions: new Map(),
  submissionDispositions: new Map(),
  composerFocusRequest: undefined,
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
    // A reused renderer session id is a new input generation. In-flight work
    // from the removed record may settle, but can never mutate this successor.
    forgetPanelInputSession(sessionId);
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
        authorityProjection: createRendererAuthorityState(),
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
        worktreeIdentityRevision: 0,
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
        historyHydrating: false,
        historyHydrationToken: undefined,
        droppedTranscriptEntryCount: 0,
        transcriptPresentationDirty: false,
        transcriptPresentationRevision: 0,
        reconciledCompactionOperationIds: [],
        compactionOperationBlockBaselines: {},
        pendingCompactionReconciliations: {},
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
    forgetPanelInputSession(sessionId);
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
        const transcript = becomingTerminal
          ? finalizeActiveBlocks(s.transcript, { markInterrupted: true })
          : s.transcript;
        const runtime = becomingTerminal || status === "starting" ? resetRuntimeState(s) : s;
        const authorityProjection =
          becomingTerminal || status === "starting"
            ? unavailableAuthority(
                s.authorityProjection ?? createRendererAuthorityState(),
                error ?? `session_${status}`,
              )
            : s.authorityProjection;
        sessions.set(sessionId, {
          ...(authorityProjection
            ? applyAuthoritySemanticProjection(runtime, authorityProjection)
            : runtime),
          ...(authorityProjection ? { authorityProjection } : {}),
          status,
          error,
          transcript,
          ...(status === "failed" || status === "exited"
            ? { activationVisitId: undefined, activationVisitReleasePending: undefined }
            : {}),
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
    const unknownEvents = rawEvents.filter((rawEvent) => "__unknown" in rawEvent);
    for (const event of unknownEvents) {
      console.warn("Dropped unknown transcript-plane entry", {
        sessionId,
        type: event.type,
        reason: "unknown_event_type",
      });
    }
    if (unknownEvents.length > 0) {
      set((state) => {
        const current = state.sessions.get(sessionId);
        if (!current) return {};
        const sessions = new Map(state.sessions);
        sessions.set(sessionId, {
          ...current,
          droppedTranscriptEntryCount: current.droppedTranscriptEntryCount + unknownEvents.length,
          transcriptPresentationDirty: true,
          transcriptPresentationRevision: current.transcriptPresentationRevision + 1,
        });
        return { sessions };
      });
    }
    const events = rawEvents.filter(
      (rawEvent): rawEvent is KnownPiEvent => !("__unknown" in rawEvent),
    );
    if (events.length === 0) {
      schedulePresentationRehydrateIfIdle(sessionId);
      return;
    }

    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};

      let current = s;
      let newSessionDrafts = state.newSessionDrafts;
      let newSessionSetupDrafts = state.newSessionSetupDrafts;
      let sessionDrafts = state.sessionDrafts;
      let diffComments = state.diffComments;
      let anyPromoted = false;
      let acceptedPendingSubmission = false;

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
        // A retry starts a fresh attempt. Do not let the failed attempt color a
        // later successful terminal result.
        if (event.type === "agent_end" && event.willRetry) turnErrored = false;
        // agent_settled is Pi's session-level terminal boundary: no automatic
        // retry, compaction, or queued continuation remains. The semantic frame
        // still owns liveness; this transcript-plane marker only preserves the
        // completed result as a solid sidebar notification once flashing stops.
        if (event.type === "agent_settled") {
          unreadStatus = turnErrored ? "error" : "done";
        }
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
        // Transcript events render activity only. Pi-owned semantic state
        // (including thinking level and session name) is reduced exclusively
        // from authority snapshots, frames, and typed intent outcomes.
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
        const pendingSubmission = current.pendingComposerSubmission;
        const submissionEchoed =
          !!pendingSubmission &&
          !!authoritativeUserEcho &&
          (authoritativeUserEcho.intentId === pendingSubmission.intentId ||
            (authoritativeUserEcho.intentId === undefined &&
              authoritativeUserEcho.content === pendingSubmission.submittedText));
        if (submissionEchoed && pendingSubmission) {
          // A tagged host echo is exact delivery evidence. The content fallback
          // is retained for older hosts and remains scoped to the single
          // registered submission. Clear only the draft text and comment
          // revisions that were actually dispatched so later edits survive.
          if (pendingSubmission.draftScope === "workspace") {
            newSessionDrafts = clearMatchingDraft(
              newSessionDrafts,
              current.workspacePath,
              pendingSubmission.composerText,
            );
            // A first user echo promotes a pending workspace draft into its
            // real session earlier in this reducer turn. Retire that migrated
            // copy too, but never touch a session draft for an unrelated
            // established-session disposition.
            if (promoted) {
              sessionDrafts = clearMatchingDraft(
                sessionDrafts,
                sessionId,
                pendingSubmission.composerText,
              );
            }
          } else {
            sessionDrafts = clearMatchingDraft(
              sessionDrafts,
              sessionId,
              pendingSubmission.composerText,
            );
          }
          const existingComments = diffComments.get(sessionId);
          const remainingComments = withoutSubmittedCommentRevisions(
            existingComments,
            pendingSubmission.submittedComments,
          );
          if (remainingComments !== existingComments) {
            diffComments = new Map(diffComments);
            if (!remainingComments || remainingComments.size === 0) diffComments.delete(sessionId);
            else diffComments.set(sessionId, remainingComments);
          }
          acceptedPendingSubmission = true;
        }
        const toasts =
          event.type === "extension_error"
            ? [
                ...current.toasts,
                {
                  id: `toast-${++toastCounter}`,
                  message: extensionErrorMessage(event.error),
                  type: "error",
                  createdAt: Date.now(),
                },
              ]
            : current.toasts;
        current = {
          ...current,
          transcript,
          queuedMessages,
          unreadStatus,
          turnErrored,
          toasts,

          isNewPending: promoted ? false : current.isNewPending,
          editorInjection: promoted ? undefined : current.editorInjection,
          pendingComposerSubmission: submissionEchoed
            ? undefined
            : current.pendingComposerSubmission,
        };
      }

      if (diffComments !== state.diffComments) persistCodeComments(diffComments);
      sessions.set(sessionId, current);
      return anyPromoted || acceptedPendingSubmission
        ? { sessions, newSessionDrafts, newSessionSetupDrafts, sessionDrafts, diffComments }
        : { sessions };
    });
    schedulePresentationRehydrateIfIdle(sessionId);
  },

  seedHistory: (sessionId, history, opts) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (
        !s ||
        (opts?.hydrationToken !== undefined && s.historyHydrationToken !== opts.hydrationToken)
      )
        return {};
      const transcript = seedFromHistory(s.transcript, history);
      sessions.set(sessionId, {
        ...s,
        transcript,
        historyHydrating: false,
        historyHydrationToken: undefined,
        historyGeneration: s.historyGeneration + 1,
        transcriptPresentationDirty: false,
        hasTreeHistory: s.hasTreeHistory || history.length > 0,
      });
      return { sessions };
    });
    if (get().sessions.get(sessionId)?.status === "ready") {
      void get().refreshHistoricalCacheMissNotices(sessionId);
    }
  },

  replaceTranscriptForNavigate: (sessionId, outcome, history) => {
    let replaced = false;
    set((state) => {
      const current = state.sessions.get(sessionId);
      const snapshot = authoritySnapshotFor(current);
      const currentOutcome = snapshot?.recentIntentOutcomes.find(
        (candidate) =>
          candidate.kind === "navigate" &&
          candidate.intentId === outcome.intentId &&
          candidate.owner.hostInstanceId === outcome.owner.hostInstanceId &&
          candidate.owner.sessionEpoch === outcome.owner.sessionEpoch,
      );
      // A conversion result is presentation-only and is valid only while the
      // same terminal authority evidence that requested it remains current.
      // Authority reducers may clone a retained outcome in a later same-owner
      // frame, so compare its stable owner-bound intent identity and terminal
      // state rather than JavaScript object identity. Never let a stale owner
      // or changed terminal settlement replace a successor's visible branch.
      if (
        !current ||
        !snapshot ||
        snapshot.owner.hostInstanceId !== outcome.owner.hostInstanceId ||
        snapshot.owner.sessionEpoch !== outcome.owner.sessionEpoch ||
        !currentOutcome ||
        currentOutcome.state !== outcome.state
      ) {
        return {};
      }
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        transcript: seedFromHistory(current.transcript, history),
      });
      replaced = true;
      return { sessions };
    });
    return replaced;
  },

  rehydrateHistory: async (sessionId) => {
    const initial = get().sessions.get(sessionId);
    if (!initial?.sessionFile || initial.historyHydrating) return;
    const hydrationToken = newHistoryHydrationToken();
    set((state) => {
      const sessions = new Map(state.sessions);
      const session = sessions.get(sessionId);
      if (!session?.sessionFile || session.historyHydrating) return {};
      sessions.set(sessionId, {
        ...session,
        historyHydrating: true,
        historyHydrationToken: hydrationToken,
      });
      return { sessions };
    });
    let retryAfterFinish = false;
    try {
      // Renderer attach and live events can race a large file read. Read only
      // while both model work and compaction are idle, require the transcript
      // to remain unchanged, and retry only against a newly installed owner.
      let historyCapture = captureHistoryRead(get().sessions.get(sessionId));
      while (historyCapture) {
        const beforeRead = get().sessions.get(sessionId);
        if (beforeRead?.historyHydrationToken !== hydrationToken) return;
        if (!historyCaptureMatches(beforeRead, historyCapture)) {
          historyCapture = await waitForHistoryOwnershipChange(sessionId, historyCapture);
          continue;
        }
        if (isSessionHistoryBusy(beforeRead)) {
          if (await waitForHistoryHydrationIdle(sessionId, historyCapture)) continue;
          historyCapture = await waitForHistoryOwnershipChange(sessionId, historyCapture);
          continue;
        }
        const transcriptAtRequest = beforeRead?.transcript;
        const presentationRevisionAtRequest = beforeRead?.transcriptPresentationRevision;
        const history = await requestBoundHistory(sessionId, historyCapture);
        if (!history) {
          historyCapture = await waitForHistoryOwnershipChange(sessionId, historyCapture);
          continue;
        }
        const current = get().sessions.get(sessionId);
        if (current?.historyHydrationToken !== hydrationToken) return;
        if (!historyCaptureMatches(current, historyCapture)) {
          historyCapture = await waitForHistoryOwnershipChange(sessionId, historyCapture);
          continue;
        }
        if (
          current?.transcript !== transcriptAtRequest ||
          current?.transcriptPresentationRevision !== presentationRevisionAtRequest
        ) {
          retryAfterFinish = true;
          if (await waitForHistoryHydrationIdle(sessionId, historyCapture)) continue;
          historyCapture = await waitForHistoryOwnershipChange(sessionId, historyCapture);
          continue;
        }
        get().seedHistory(sessionId, history, { hydrationToken });
        break;
      }
    } catch {
      /* stale or unavailable history — presentation remains dirty for a later boundary */
    } finally {
      set((state) => {
        const sessions = new Map(state.sessions);
        const session = sessions.get(sessionId);
        if (!session || session.historyHydrationToken !== hydrationToken) return {};
        sessions.set(sessionId, {
          ...session,
          historyHydrating: false,
          historyHydrationToken: undefined,
        });
        return { sessions };
      });
      if (retryAfterFinish) schedulePresentationRehydrateIfIdle(sessionId);
    }
  },

  refreshHistoricalCacheMissNotices: async (sessionId) => {
    const session = get().sessions.get(sessionId);
    if (!session?.sessionFile || session.status !== "ready" || !authoritySnapshotFor(session))
      return;
    const observation = authorityObservation(session);
    if (!observation) return;
    const sessionEpoch = session.sessionEpoch;
    const sessionFile = session.sessionFile;
    try {
      const result = await querySession(sessionId, { type: "get_cache_miss_notices" }, observation);
      if (result.status !== "ok" || !result.response.success) return;
      const parsed = CacheMissNoticeEventSchema.array().safeParse(
        (result.response.data as { notices?: unknown } | undefined)?.notices,
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
      // ESC restoration can win the race with a queued submission's terminal
      // outcome. Once review custody names that intent, a late Composer
      // acknowledgement must not recreate its optimistic user bubble beside
      // the review card (or imply it was delivered).
      const optimisticIntentId = opts?.intentId;
      const alreadyRestored =
        optimisticIntentId !== undefined &&
        s.queueRestorations?.some((restoration) =>
          restoration.clearedIntentIds?.includes(optimisticIntentId),
        );
      if (alreadyRestored) return {};
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
      const incoming = runtimeState.snapshot;
      const prior = current.runtimeSnapshot;
      const stale =
        !!incoming &&
        prior?.hostInstanceId === incoming.hostInstanceId &&
        (incoming.sessionEpoch < prior.sessionEpoch ||
          (incoming.sessionEpoch === prior.sessionEpoch &&
            incoming.snapshotSequence <= prior.snapshotSequence));
      // Direct snapshots remain an isolated compatibility diagnostic. In
      // particular they must not update owner, liveness, queues, editor,
      // catalog, model, thinking, or intent-derived fields.
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        availability: runtimeState.availability,
        runtimeSnapshot: stale ? prior : (incoming ?? prior),
      });
      return { sessions };
    });
  },

  applyAuthorityAttach: (sessionId, response) => {
    if (response.status !== "ready") return;
    const previousSession = get().sessions.get(sessionId);
    // Main buffers publications while the child serializes its baseline. The
    // authority reducer advances every plane through that replay, but transcript
    // payloads must also reach the presentation reducer; otherwise a user
    // message emitted during attach vanishes while the later assistant delta is
    // rendered. Parse before the atomic commit and apply only if the transcript
    // plane accepts the attach.
    const replayTranscriptEntries = response.replay.flatMap((publication) =>
      publication.plane === "transcript" && publication.payload.kind === "delta"
        ? publication.payload.entries
        : [],
    );
    const invalidReplayEntries: unknown[] = [];
    const replayEvents = replayTranscriptEntries.flatMap((entry) => {
      const parsed = PiEventSchema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      invalidReplayEntries.push(entry);
      return [];
    });
    let following = false;
    let transcriptFollowing = false;
    runAtomically(() => {
      set((state) => {
        const current = state.sessions.get(sessionId);
        if (!current) return {};
        const authorityProjection = reduceAuthorityAttach(
          current.authorityProjection ?? createRendererAuthorityState(),
          response,
        );
        if (authorityProjection === current.authorityProjection) return {};
        following = authorityProjection.semantic.state === "following";
        transcriptFollowing = authorityProjection.transcript.state === "following";
        const restorations = [
          ...response.baseline.restorations,
          ...response.replay.flatMap((publication) =>
            publication.plane === "semantic"
              ? publication.payload.records.filter(
                  (record): record is Extract<typeof record, { type: "queue_restoration" }> =>
                    record.type === "queue_restoration",
                )
              : [],
          ),
        ];
        const sessions = new Map(state.sessions);
        const extension = authorityProjection.extensionUiBaseline;
        const authorityPanels = [...authorityProjection.panels.values()];
        const customPanel = authorityPanels.find((panel) => !panel.baseline.unified);
        const unifiedPanel = authorityPanels.find((panel) => panel.baseline.unified);
        const droppedReplayCount = transcriptFollowing
          ? invalidReplayEntries.length
          : replayTranscriptEntries.length;
        sessions.set(sessionId, {
          ...appendQueueRestorations(
            applyAuthoritySemanticProjection(current, authorityProjection),
            restorations,
          ),
          authorityProjection,
          panel: customPanel
            ? {
                id: customPanel.baseline.panelId,
                overlay: customPanel.baseline.overlay,
                hostInstanceId: customPanel.baseline.owner.hostInstanceId,
                sessionEpoch: customPanel.baseline.owner.sessionEpoch,
                buffer: [...customPanel.ansi],
                mode: customPanel.baseline.mode,
                authority: true,
                inputEnabled: customPanel.inputEnabled,
                inputAcknowledgedThrough: customPanel.baseline.inputAcknowledgedThrough,
                renderRevision: customPanel.baseline.keyframe.renderRevision,
                keyframeReady: customPanel.baseline.keyframe.kind === "keyframe",
                ...(customPanel.output
                  ? {
                      outputSequence: customPanel.output.sequence,
                      outputKind: customPanel.output.kind,
                      outputAnsi: customPanel.output.ansi,
                    }
                  : {}),
                syncState: customPanel.sync.state,
              }
            : undefined,
          unifiedPanel: unifiedPanel
            ? {
                id: unifiedPanel.baseline.panelId,
                hostInstanceId: unifiedPanel.baseline.owner.hostInstanceId,
                sessionEpoch: unifiedPanel.baseline.owner.sessionEpoch,
                buffer: [...unifiedPanel.ansi],
                mode: unifiedPanel.baseline.mode,
                authority: true,
                inputEnabled: unifiedPanel.inputEnabled,
                inputAcknowledgedThrough: unifiedPanel.baseline.inputAcknowledgedThrough,
                renderRevision: unifiedPanel.baseline.keyframe.renderRevision,
                keyframeReady: unifiedPanel.baseline.keyframe.kind === "keyframe",
                ...(unifiedPanel.output
                  ? {
                      outputSequence: unifiedPanel.output.sequence,
                      outputKind: unifiedPanel.output.kind,
                      outputAnsi: unifiedPanel.output.ansi,
                    }
                  : {}),
                syncState: unifiedPanel.sync.state,
              }
            : undefined,
          ...(extension
            ? {
                pendingDialogs: extension.dialogs
                  .filter((dialog) => dialog.inputPending && !dialog.acknowledged)
                  .map((dialog) => dialog.request),
                statusSegments: new Map(Object.entries(extension.statuses)),
                widgets: new Map(
                  Object.entries(extension.widgets).map(([key, lines]) => [key, [...lines]]),
                ),
                toasts: extension.notifications.map((notification) => ({
                  ...notification,
                  createdAt: Date.now(),
                })),
              }
            : {}),
          droppedTranscriptEntryCount: current.droppedTranscriptEntryCount + droppedReplayCount,
          transcriptPresentationDirty:
            current.transcriptPresentationDirty || droppedReplayCount > 0,
          transcriptPresentationRevision:
            current.transcriptPresentationRevision + (droppedReplayCount > 0 ? 1 : 0),
        });
        return { sessions };
      });
      if (transcriptFollowing && replayEvents.length > 0) {
        get().applyEvents(sessionId, replayEvents);
      }
    });
    retireSupersededPanelInputIdentities(sessionId, previousSession, get().sessions.get(sessionId));
    const droppedReplayEntries = transcriptFollowing
      ? invalidReplayEntries
      : replayTranscriptEntries;
    for (const entry of droppedReplayEntries) {
      const type =
        entry && typeof entry === "object" && "type" in entry
          ? String((entry as { type?: unknown }).type ?? "unknown")
          : "unknown";
      console.warn("Dropped transcript attach-replay entry", {
        sessionId,
        type,
        reason: transcriptFollowing ? "schema_validation_failed" : "attach_not_following",
      });
    }
    schedulePresentationRehydrateIfIdle(sessionId);
    if (following && get().sessions.get(sessionId)?.status === "ready") {
      void get().refreshCommands(sessionId);
    }
  },

  applyAuthorityPublication: (publication) => {
    const sessionId = publication.sessionId as SessionId;
    const previousSession = get().sessions.get(sessionId);
    // Transcript is a separate presentation plane. Semantic frames intentionally
    // carry no Pi event records, so no event can become a liveness authority.
    const transcriptEntries =
      publication.plane === "transcript" && publication.payload.kind === "delta"
        ? publication.payload.entries
        : [];
    const invalidTranscriptEntries: unknown[] = [];
    const events = transcriptEntries.flatMap((entry) => {
      const parsed = PiEventSchema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      invalidTranscriptEntries.push(entry);
      return [];
    });
    const uiRequest =
      publication.plane === "extensionUi" && publication.payload.kind === "request"
        ? publication.payload.request
        : undefined;
    const restorations =
      publication.plane === "semantic"
        ? publication.payload.records.filter(
            (record): record is Extract<typeof record, { type: "queue_restoration" }> =>
              record.type === "queue_restoration",
          )
        : [];
    // Transcript records and the complete resulting semantic snapshot are one
    // renderer commit. The transcript remains presentation-only, but cannot
    // visually race the cursor that names its semantic boundary.
    let accepted = false;
    let authorityRejectedTranscript = false;
    runAtomically(() => {
      set((state) => {
        const current = state.sessions.get(sessionId);
        if (!current) return {};
        const authorityProjection = reduceAuthorityPublication(
          current.authorityProjection ?? createRendererAuthorityState(),
          publication,
        );
        if (authorityProjection === current.authorityProjection) return {};
        accepted =
          publication.plane === "semantic"
            ? authorityProjection.lastSemanticFrame?.frameId === publication.payload.frameId
            : publication.plane === "transcript"
              ? authorityProjection.transcript.state === "following" &&
                authorityProjection.transcript.cursor.transportSequence ===
                  publication.payload.cursor.transportSequence
              : publication.plane === "extensionUi"
                ? authorityProjection.extensionUi.state === "following" &&
                  authorityProjection.extensionUi.cursor.transportSequence ===
                    publication.payload.cursor.transportSequence
                : (() => {
                    const key =
                      publication.payload.kind === "keyframe"
                        ? publication.payload.panel.panelKey
                        : publication.payload.panelKey;
                    const panel = authorityProjection.panels.get(key);
                    return (
                      panel?.sync.state === "following" &&
                      panel.sync.cursor.transportSequence ===
                        publication.payload.cursor.transportSequence
                    );
                  })();
        const sessions = new Map(state.sessions);
        const authorityPanels = [...authorityProjection.panels.values()];
        const customPanel = authorityPanels.find((panel) => !panel.baseline.unified);
        const unifiedPanel = authorityPanels.find((panel) => panel.baseline.unified);
        authorityRejectedTranscript =
          publication.plane === "transcript" && !accepted && transcriptEntries.length > 0;
        const droppedCount =
          publication.plane === "transcript"
            ? accepted
              ? invalidTranscriptEntries.length
              : transcriptEntries.length
            : 0;
        const observedCompactions =
          accepted && publication.plane === "semantic"
            ? (authorityProjection.authoritativeSnapshot?.recentObservedOperations ?? []).filter(
                (operation) => operation.kind === "compaction",
              )
            : [];
        const compactionBlockCount = recentCompactionBlockCount(current.transcript);
        const semanticSnapshot = authorityProjection.authoritativeSnapshot;
        const reachedIdleBoundary =
          accepted &&
          publication.plane === "semantic" &&
          !!semanticSnapshot &&
          !semanticSnapshot.sdk.isStreaming &&
          !semanticSnapshot.sdk.isCompacting &&
          semanticSnapshot.activity.compaction === undefined;
        let pendingCompactionReconciliations = current.pendingCompactionReconciliations;
        let reconciledCompactionOperationIds = current.reconciledCompactionOperationIds;
        let compactionResultMissing = false;
        if (
          reachedIdleBoundary &&
          Object.keys(current.pendingCompactionReconciliations).length > 0
        ) {
          const settled = Object.entries(current.pendingCompactionReconciliations);
          compactionResultMissing = settled.some(
            ([, baseline]) => baseline === null || compactionBlockCount <= baseline,
          );
          reconciledCompactionOperationIds = [
            ...current.reconciledCompactionOperationIds,
            ...settled.map(([operationKey]) => operationKey),
          ].slice(-128);
          pendingCompactionReconciliations = {};
        }

        let compactionOperationBlockBaselines = current.compactionOperationBlockBaselines;
        const terminalStates = new Set(["completed", "aborted", "failed", "unknown"]);
        for (const operation of observedCompactions) {
          const operationKey = observedCompactionKey(operation);
          if (
            !terminalStates.has(operation.state) &&
            compactionOperationBlockBaselines[operationKey] === undefined
          ) {
            compactionOperationBlockBaselines = {
              ...compactionOperationBlockBaselines,
              [operationKey]: compactionBlockCount,
            };
            continue;
          }
          if (!terminalStates.has(operation.state)) continue;
          const baseline = compactionOperationBlockBaselines[operationKey];
          if (baseline !== undefined) {
            const { [operationKey]: _settled, ...remainingBaselines } =
              compactionOperationBlockBaselines;
            compactionOperationBlockBaselines = remainingBaselines;
          }
          if (
            operation.state === "completed" &&
            !reconciledCompactionOperationIds.includes(operationKey) &&
            pendingCompactionReconciliations[operationKey] === undefined
          ) {
            pendingCompactionReconciliations = {
              ...pendingCompactionReconciliations,
              [operationKey]: baseline ?? null,
            };
          }
        }
        compactionOperationBlockBaselines = Object.fromEntries(
          Object.entries(compactionOperationBlockBaselines).slice(-128),
        );
        pendingCompactionReconciliations = Object.fromEntries(
          Object.entries(pendingCompactionReconciliations).slice(-128),
        );
        sessions.set(sessionId, {
          ...appendQueueRestorations(
            applyAuthoritySemanticProjection(current, authorityProjection),
            restorations,
          ),
          authorityProjection,
          panel: customPanel
            ? {
                id: customPanel.baseline.panelId,
                overlay: customPanel.baseline.overlay,
                hostInstanceId: customPanel.baseline.owner.hostInstanceId,
                sessionEpoch: customPanel.baseline.owner.sessionEpoch,
                buffer: [...customPanel.ansi],
                mode: customPanel.baseline.mode,
                authority: true,
                inputEnabled: customPanel.inputEnabled,
                inputAcknowledgedThrough: customPanel.baseline.inputAcknowledgedThrough,
                renderRevision: customPanel.baseline.keyframe.renderRevision,
                keyframeReady: customPanel.baseline.keyframe.kind === "keyframe",
                ...(customPanel.output
                  ? {
                      outputSequence: customPanel.output.sequence,
                      outputKind: customPanel.output.kind,
                      outputAnsi: customPanel.output.ansi,
                    }
                  : {}),
                syncState: customPanel.sync.state,
              }
            : undefined,
          unifiedPanel: unifiedPanel
            ? {
                id: unifiedPanel.baseline.panelId,
                hostInstanceId: unifiedPanel.baseline.owner.hostInstanceId,
                sessionEpoch: unifiedPanel.baseline.owner.sessionEpoch,
                buffer: [...unifiedPanel.ansi],
                mode: unifiedPanel.baseline.mode,
                authority: true,
                inputEnabled: unifiedPanel.inputEnabled,
                inputAcknowledgedThrough: unifiedPanel.baseline.inputAcknowledgedThrough,
                renderRevision: unifiedPanel.baseline.keyframe.renderRevision,
                keyframeReady: unifiedPanel.baseline.keyframe.kind === "keyframe",
                ...(unifiedPanel.output
                  ? {
                      outputSequence: unifiedPanel.output.sequence,
                      outputKind: unifiedPanel.output.kind,
                      outputAnsi: unifiedPanel.output.ansi,
                    }
                  : {}),
                syncState: unifiedPanel.sync.state,
              }
            : undefined,
          droppedTranscriptEntryCount: current.droppedTranscriptEntryCount + droppedCount,
          transcriptPresentationDirty:
            current.transcriptPresentationDirty || droppedCount > 0 || compactionResultMissing,
          transcriptPresentationRevision:
            current.transcriptPresentationRevision +
            (droppedCount > 0 || compactionResultMissing ? 1 : 0),
          reconciledCompactionOperationIds,
          compactionOperationBlockBaselines,
          pendingCompactionReconciliations,
        });
        return { sessions };
      });
      if (accepted && events.length > 0) get().applyEvents(sessionId, events);
      if (accepted && uiRequest) get().addUiRequest(sessionId, uiRequest);
    });
    retireSupersededPanelInputIdentities(sessionId, previousSession, get().sessions.get(sessionId));
    const droppedEntries = authorityRejectedTranscript
      ? transcriptEntries
      : accepted
        ? invalidTranscriptEntries
        : [];
    for (const entry of droppedEntries) {
      const type =
        entry && typeof entry === "object" && "type" in entry
          ? String((entry as { type?: unknown }).type ?? "unknown")
          : "unknown";
      console.warn("Dropped transcript-plane entry", {
        sessionId,
        type,
        reason: authorityRejectedTranscript ? "authority_rejected" : "schema_validation_failed",
      });
    }
    if (accepted || authorityRejectedTranscript) schedulePresentationRehydrateIfIdle(sessionId);
  },

  markAuthorityUnavailable: (sessionId, reason) => {
    set((state) => {
      const current = state.sessions.get(sessionId);
      if (!current) return {};
      const authorityProjection = unavailableAuthority(
        current.authorityProjection ?? createRendererAuthorityState(),
        reason,
      );
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...applyAuthoritySemanticProjection(current, authorityProjection),
        authorityProjection,
      });
      return { sessions };
    });
  },

  applyTransitionBatch: (sessionId, records, runtimeState) => {
    runAtomically(() => {
      for (const record of records) {
        // Compatibility transition records may still reconstruct presentation,
        // but never mutate semantic state or settle an intent.
        if (record.type === "event") get().applyEvents(sessionId, [record.event]);
        else if (record.type === "ui") get().addUiRequest(sessionId, record.request);
        else if (record.type === "panel") get().handlePanelEvent(sessionId, record.event);
        else if (record.type === "queue_restoration")
          get().applyQueueRestoration(sessionId, record);
      }
      get().applyRuntimeState(sessionId, runtimeState);
    });
  },

  applyQueueRestoration: (sessionId, restoration) => {
    // Authority records remain only as custody markers for late optimistic
    // transcript echoes. They never inject text, request review, or toast.
    set((state) => {
      const current = state.sessions.get(sessionId);
      if (
        !current ||
        current.queueRestorations?.some((item) => item.restorationId === restoration.restorationId)
      )
        return {};
      const transcript = restoration.clearedIntentIds?.length
        ? retirePendingUserEchoesByIntent(current.transcript, restoration.clearedIntentIds)
        : current.transcript;
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        transcript,
        queueRestorations: [...(current.queueRestorations ?? []), structuredClone(restoration)],
      });
      return { sessions };
    });
  },

  applyRestoreDraft: (sessionId, restoration) => {
    let applied = false;
    let shouldAcknowledge = false;
    set((state) => {
      const current = state.sessions.get(sessionId);
      // An absent renderer session has not assumed restoration custody. Do not
      // acknowledge it: main must retain and redeliver after reattachment.
      if (!current) return {};
      // Main retains this instruction until acknowledgement. A redelivery
      // after transient IPC failure must not mutate the draft twice, but it
      // must retry the idempotent acknowledgement so custody can retire.
      shouldAcknowledge = true;
      if (current.appliedRestoreDraftIds?.includes(restoration.restorationId)) return {};
      applied = true;
      const sessions = new Map(state.sessions);
      const appliedRestoreDraftIds = [
        ...(current.appliedRestoreDraftIds ?? []),
        restoration.restorationId,
      ];
      if (restoration.disposition === "dropped") {
        sessions.set(sessionId, { ...current, appliedRestoreDraftIds });
        return { sessions };
      }
      const draft =
        state.sessionDrafts.get(sessionId) ??
        current.editorInjection?.text ??
        current.runtimeSnapshot?.editor.text ??
        "";
      const text = restoration.text.trim()
        ? draft.trim()
          ? `${draft}\n\n${restoration.text}`
          : restoration.text
        : draft;
      const attachments = [
        ...(current.editorInjection?.attachments ?? current.editorAttachments ?? []),
        ...restorationImagesToComposerAttachments(restoration.attachments),
      ];
      sessions.set(sessionId, {
        ...current,
        appliedRestoreDraftIds,
        editorInjection: { text, attachments, nonce: ++editorInjectionNonce },
      });
      return { sessions };
    });
    if (!shouldAcknowledge) return;
    if (applied && restoration.disposition === "dropped") {
      get().addToast(sessionId, "Interrupted command was not restored.", "info");
    }
    void window.pivis
      .invoke("session.acknowledgeRestoration", {
        sessionId,
        restorationId: restoration.restorationId,
      })
      .catch(() => {});
  },

  applySubmissionDisposition: (sessionId, result) => {
    // Compatibility admission feedback is renderer presentation only. It is
    // intentionally bounded and never changes authority, transcript, queues,
    // host editor custody, or liveness. A correlated custody disposition may
    // retire the exact renderer draft/comment revisions registered before
    // dispatch; this is the same presentation-only clearing a mounted Composer
    // performs, but it survives session switches and system sleep.
    set((state) => {
      const current = state.sessions.get(sessionId);
      if (!current) return {};
      const key = submissionDispositionKey(result.intentId, result);
      const submissionDispositions = new Map(state.submissionDispositions);
      submissionDispositions.delete(key);
      submissionDispositions.set(key, result);
      while (submissionDispositions.size > SUBMISSION_DISPOSITION_CACHE_LIMIT) {
        const oldest = submissionDispositions.keys().next().value;
        if (oldest === undefined) break;
        submissionDispositions.delete(oldest);
      }
      const pending = current.pendingComposerSubmission;
      const matchesPending =
        pending?.intentId === result.intentId &&
        pending.owner.hostInstanceId === result.hostInstanceId &&
        pending.owner.sessionEpoch === result.sessionEpoch &&
        pending.editorRevision === result.editorRevision;
      if (!matchesPending || !pending) return { submissionDispositions };

      if (!submissionDispositionProvesCustody(result.disposition)) {
        // A definitive pre-dispatch rejection preserves the draft/comments but
        // retires this correlation. `admitting` and `outcome_unknown` remain
        // eligible for later exact user-echo evidence.
        if (!["not_submitted", "rejected"].includes(result.disposition)) {
          return { submissionDispositions };
        }
        const sessions = new Map(state.sessions);
        sessions.set(sessionId, { ...current, pendingComposerSubmission: undefined });
        return { submissionDispositions, sessions };
      }

      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...current, pendingComposerSubmission: undefined });
      const newSessionDrafts =
        pending.draftScope === "workspace"
          ? clearMatchingDraft(state.newSessionDrafts, current.workspacePath, pending.composerText)
          : state.newSessionDrafts;
      const sessionDrafts =
        pending.draftScope === "session"
          ? clearMatchingDraft(state.sessionDrafts, sessionId, pending.composerText)
          : state.sessionDrafts;
      const existingComments = state.diffComments.get(sessionId);
      const remainingComments = withoutSubmittedCommentRevisions(
        existingComments,
        pending.submittedComments,
      );
      let diffComments = state.diffComments;
      if (remainingComments !== existingComments) {
        diffComments = new Map(state.diffComments);
        if (!remainingComments || remainingComments.size === 0) diffComments.delete(sessionId);
        else diffComments.set(sessionId, remainingComments);
        persistCodeComments(diffComments);
      }
      return {
        submissionDispositions,
        sessions,
        newSessionDrafts,
        sessionDrafts,
        diffComments,
      };
    });
  },

  requestComposerFocus: (sessionId) => {
    set({ composerFocusRequest: { sessionId, nonce: ++composerFocusNonce } });
  },

  consumeComposerFocus: (sessionId, nonce) => {
    set((state) => {
      const request = state.composerFocusRequest;
      if (!request || request.sessionId !== sessionId || request.nonce !== nonce) return {};
      return { composerFocusRequest: undefined };
    });
  },

  abortSession: (sessionId) => {
    // A receipt is admission feedback only. Interrupt outcome and liveness are
    // reduced later from the semantic authority frame.
    const session = get().sessions.get(sessionId);
    if (!session) return;
    const observation = authorityObservation(session);
    if (!observation) return;
    void dispatchSessionIntent(sessionId, { kind: "interrupt" }, observation).catch((error) => {
      const message = describeIpcError(error);
      if (message) get().addToast(sessionId, message, "error");
    });
  },

  addUiRequest: (sessionId, request) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s) return {};

      // Only notifications remain a compatibility presentation side effect.
      // Catalog/editor mutations are projected exclusively by semantic frames.
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
        } else {
          // Retain no semantic mutation from compatibility UI events.
          sessions.set(sessionId, sFinal);
        }
        return { sessions };
      }

      // Dialog requests — queue them. Build the clone only when we mutate.
      const sessions = new Map(state.sessions);
      // Provider auth is a persistent, updatable surface: retain one entry per
      // stable dialog id instead of stacking stale OAuth/device progress cards.
      const existing = s.pendingDialogs.findIndex((dialog) => dialog.id === request.id);
      const pendingDialogs =
        existing < 0
          ? [...s.pendingDialogs, request]
          : s.pendingDialogs.map((dialog, index) => (index === existing ? request : dialog));
      sessions.set(sessionId, { ...s, pendingDialogs });
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
    // Legacy panel events are a bootstrap fallback only. Once a sequenced
    // authority projection names this panel, it is the exclusive render,
    // mode, and input source; independently dropped legacy traffic cannot
    // overwrite it.
    if (event.type !== "session_warning" && current?.authorityProjection?.panels.size) {
      const panelId = "panelId" in event ? event.panelId : undefined;
      const authorityOwnsEvent =
        panelId === undefined
          ? true
          : [...current.authorityProjection.panels.values()].some(
              (panel) => panel.baseline.panelId === panelId,
            );
      if (authorityOwnsEvent) return;
    }
    if (event.type === "panel_open") {
      // A host may reuse a numeric panel id after restart and React may
      // coalesce clear/open renders. Every open is nevertheless a new
      // host-bound input stream whose sequence starts at zero.
      forgetPanelInputSequence(sessionId, event.panelId);
      activatePanelInputIdentity(sessionId, {
        hostInstanceId: event.hostInstanceId ?? current?.hostInstanceId ?? "",
        sessionEpoch: event.sessionEpoch ?? current?.sessionEpoch ?? 0,
        panelId: event.panelId,
      });
    } else if (event.type === "panel_close") {
      const displayed = [current?.panel, current?.unifiedPanel].find(
        (panel) => panel?.id === event.panelId,
      );
      if (displayed) {
        retirePanelInputIdentity(sessionId, {
          hostInstanceId: displayed.hostInstanceId,
          sessionEpoch: displayed.sessionEpoch,
          panelId: displayed.id,
        });
      } else {
        forgetPanelInputSequence(sessionId, event.panelId);
      }
    } else if (event.type === "panel_clear_all" && current?.panel) {
      retirePanelInputIdentity(sessionId, {
        hostInstanceId: current.panel.hostInstanceId,
        sessionEpoch: current.panel.sessionEpoch,
        panelId: current.panel.id,
      });
    } else if (event.type === "unified_panel_reset" && current?.unifiedPanel) {
      retirePanelInputIdentity(sessionId, {
        hostInstanceId: current.unifiedPanel.hostInstanceId,
        sessionEpoch: current.unifiedPanel.sessionEpoch,
        panelId: current.unifiedPanel.id,
      });
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
    if (!session || !claimCurrent()) {
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
    const intentObservation = (sid: SessionId) => {
      if (!claimCurrent()) return undefined;
      const current = get().sessions.get(sid);
      const observation = current ? authorityObservation(current) : undefined;
      if (!observation) return undefined;
      return {
        ...observation,
        editorRevision,
        userMessageSequence: current?.transcript.userMessageSequence ?? 0,
      };
    };
    const awaitIntentOutcome = (
      sid: SessionId,
      intentId: string,
      owner: RuntimeIdentity,
    ): Promise<IntentOutcome> => {
      const findOutcome = (): IntentOutcome | undefined =>
        get()
          .sessions.get(sid)
          ?.authorityProjection?.authoritativeSnapshot?.recentIntentOutcomes.find(
            (outcome) =>
              outcome.intentId === intentId &&
              outcome.owner.hostInstanceId === owner.hostInstanceId &&
              outcome.owner.sessionEpoch === owner.sessionEpoch,
          );
      const immediate = findOutcome();
      if (immediate) return Promise.resolve(immediate);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (operation: () => void) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(expiryTimer);
          unsubscribe();
          operation();
        };
        const unsubscribe = useSessionsStore.subscribe(() => {
          const outcome = findOutcome();
          if (outcome) {
            finish(() => resolve(outcome));
            return;
          }
          const current = get().sessions.get(sid);
          const projection = current?.authorityProjection;
          if (
            !claimCurrent() ||
            projection?.semantic.state !== "following" ||
            projection.semantic.cursor.hostInstanceId !== owner.hostInstanceId ||
            projection.semantic.cursor.sessionEpoch !== owner.sessionEpoch
          ) {
            finish(() => reject(new InputNotConsumedError("Intent authority became unavailable")));
          }
        });
        const expiryTimer = globalThis.setTimeout(
          () =>
            finish(() =>
              reject(new InputNotConsumedError("Unified action claim expired before settlement")),
            ),
          Math.max(0, claim.expiresAt - Date.now() + 1),
        );
      });
    };

    const deps = {
      dispatch: (sid: SessionId, intent: SessionIntent, intentId?: string) => {
        ensureClaimCurrent();
        const observation = intentObservation(sid);
        if (!observation) throw new InputNotConsumedError("Session runtime is unavailable");
        return dispatchSessionIntent(sid, intent, observation, intentId);
      },
      query: (sid: SessionId, query: SessionQuery) => {
        ensureClaimCurrent();
        const observation = intentObservation(sid);
        if (!observation) throw new InputNotConsumedError("Session runtime is unavailable");
        return querySession(sid, query, observation);
      },
      awaitIntentOutcome,
      getIntentObservation: intentObservation,
      ...(action.kind === "reload"
        ? {
            getReloadEditorCommand: () => ({ editorRevision, editorText: text }),
          }
        : {}),
      createIntentId: () => submissionIntentId,
      invoke: async <T = unknown>(channel: string, payload: unknown) => {
        ensureClaimCurrent();
        const result = (await window.pivis.invoke(
          channel as Parameters<typeof window.pivis.invoke>[0],
          payload as Parameters<typeof window.pivis.invoke>[1],
        )) as { success: boolean; data?: T; error?: string };
        ensureClaimCurrent();
        return result;
      },
      uiSurface: "unified" as const,
      submit: async (
        sid: SessionId,
        submission: import("@shared/pi-protocol/runtime-state.js").SessionSubmission,
      ) => {
        ensureClaimCurrent();
        const current = get().sessions.get(sid);
        const observation = current ? authorityObservation(current) : undefined;
        if (!observation) throw new InputNotConsumedError("Session runtime is unavailable");
        const receipt = await dispatchSessionIntent(
          sid,
          {
            kind: "submit",
            editorRevision: submission.editorRevision,
            text: submission.text,
            images: submission.images,
            requestedMode: submission.requestedMode,
            surface: submission.surface,
          },
          observation,
          submission.intentId as ReturnType<typeof crypto.randomUUID>,
        );
        ensureClaimCurrent();
        // Receipts are not dispositions. This compatibility return only keeps
        // executeAction from treating delivery feedback as a transcript/editor
        // settlement; canonical submission state arrives in an authority frame.
        const disposition: SubmissionResult["disposition"] =
          receipt.status === "admitted" || receipt.status === "duplicate"
            ? "consumed"
            : receipt.status === "delivery_unknown"
              ? "outcome_unknown"
              : "rejected";
        return {
          intentId: submission.intentId,
          hostInstanceId: observation.owner.hostInstanceId,
          sessionEpoch: observation.owner.sessionEpoch,
          editorRevision: submission.editorRevision,
          disposition,
          queued: false,
          ...(receipt.status === "not_admitted"
            ? { message: `Submission was not admitted: ${receipt.reason}` }
            : {}),
        };
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
      // A rename receipt is admission-only; the semantic frame/outcome owns
      // the canonical label.
      setSessionName: () => {},
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

  applyWorktree: (sessionId, result, revision) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s || (revision !== undefined && revision < s.worktreeIdentityRevision)) return {};
      sessions.set(sessionId, {
        ...s,
        worktreePath: result.worktreePath,
        worktreeBranch: result.branch,
        worktreeName: result.name,
        worktreeFromBase: result.base,
        worktreeIdentityRevision: revision ?? s.worktreeIdentityRevision,
      });
      return { sessions };
    });
  },

  applyWorkspace: (sessionId, revision) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s || (revision !== undefined && revision < s.worktreeIdentityRevision)) return {};
      sessions.set(sessionId, {
        ...s,
        worktreePath: undefined,
        worktreeBranch: undefined,
        worktreeName: undefined,
        worktreeFromBase: undefined,
        worktreeIdentityRevision: revision ?? s.worktreeIdentityRevision,
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
    const session = get().sessions.get(sessionId);
    if (!session) return currentModels();
    const observation = authorityObservation(session);
    if (
      !observation ||
      (expectedRuntime &&
        (observation.owner.hostInstanceId !== expectedRuntime.hostInstanceId ||
          observation.owner.sessionEpoch !== expectedRuntime.sessionEpoch))
    ) {
      return currentModels();
    }
    try {
      const result = await querySession(sessionId, { type: "get_available_models" }, observation);
      if (
        result.status !== "ok" ||
        !result.response.success ||
        !sessionMatchesRuntime(get().sessions.get(sessionId), observation.owner)
      ) {
        return currentModels();
      }
      const raw = result.response.data as { models?: unknown[] } | undefined;
      const models = (Array.isArray(raw?.models) ? raw.models : [])
        .map((model) => {
          const parsed = ModelInfoSchema.safeParse(model);
          return parsed.success ? parsed.data : null;
        })
        .filter((model): model is ModelInfo => model !== null);
      get().setAvailableModels(sessionId, models);
      return models;
    } catch {
      return currentModels();
    }
  },

  refreshModelsSilently: (sessionId) => {
    const existing = modelRefreshFlights.get(sessionId);
    if (existing) return existing;
    const flight = (async (): Promise<boolean> => {
      const session = get().sessions.get(sessionId);
      const observation = session ? authorityObservation(session) : undefined;
      // Do not turn a picker/auth notification into cold-session activation.
      if (!observation) return false;
      const owner = observation.owner;
      const intentId = crypto.randomUUID();
      let receiptFailed = false;
      try {
        const receipt = await dispatchSessionIntent(
          sessionId,
          { kind: "refreshModels" },
          observation,
          intentId,
        );
        receiptFailed = receipt.status === "not_admitted";
      } catch {
        // A receipt can be lost after dispatch; the owner-bound frame decides.
      }
      const outcome = await new Promise<IntentOutcome | undefined>((resolve) => {
        const find = () =>
          get()
            .sessions.get(sessionId)
            ?.authorityProjection?.authoritativeSnapshot?.recentIntentOutcomes.find(
              (item) =>
                item.intentId === intentId &&
                item.owner.hostInstanceId === owner.hostInstanceId &&
                item.owner.sessionEpoch === owner.sessionEpoch,
            );
        const immediate = find();
        if (immediate) return resolve(immediate);
        const timer = setTimeout(() => finish(undefined), 10_000);
        const unsubscribe = useSessionsStore.subscribe(() => {
          const next = find();
          if (next) finish(next);
          else if (!sessionMatchesRuntime(get().sessions.get(sessionId), owner)) finish(undefined);
        });
        function finish(value: IntentOutcome | undefined): void {
          clearTimeout(timer);
          unsubscribe();
          resolve(value);
        }
      });
      const settled = await outcome;
      const succeeded =
        !receiptFailed && settled?.kind === "refreshModels" && settled.state === "completed";
      if (succeeded && sessionMatchesRuntime(get().sessions.get(sessionId), owner)) {
        await get().refreshAvailableModels(sessionId, owner);
        if (sessionMatchesRuntime(get().sessions.get(sessionId), owner)) {
          set((state) => {
            const sessions = new Map(state.sessions);
            const current = sessions.get(sessionId);
            if (current) sessions.set(sessionId, { ...current, modelRefreshFailure: undefined });
            return { sessions };
          });
        }
        return true;
      }
      if (sessionMatchesRuntime(get().sessions.get(sessionId), owner)) {
        set((state) => {
          const sessions = new Map(state.sessions);
          const current = sessions.get(sessionId);
          if (current) sessions.set(sessionId, { ...current, modelRefreshFailure: owner });
          return { sessions };
        });
      }
      return false;
    })().finally(() => modelRefreshFlights.delete(sessionId));
    modelRefreshFlights.set(sessionId, flight);
    return flight;
  },

  // Retained as compatibility no-ops for legacy consumers. Canonical model
  // and thinking values are only projected from snapshots/semantic frames.
  setCurrentModel: () => {},
  setThinkingLevel: () => {},

  bootstrapModelState: async (sessionId) => {
    if (typeof window === "undefined" || !window.pivis) return;
    const session = get().sessions.get(sessionId);
    if (!session || session.modelInitialized || !authorityObservation(session)) {
      return;
    }
    set((state) => {
      const sessions = new Map(state.sessions);
      const current = sessions.get(sessionId);
      if (!current) return {};
      sessions.set(sessionId, { ...current, modelInitialized: true });
      return { sessions };
    });

    const models = await get().refreshAvailableModels(sessionId);
    const current = get().sessions.get(sessionId);
    const observation = current ? authorityObservation(current) : undefined;
    if (!current || !observation || current.resumed) return;
    const lastModel = useSettingsStore.getState().settings.lastUsedModel;
    const lastThinking = useSettingsStore.getState().settings.lastUsedThinkingLevel;
    const sameId = lastModel ? models.filter((model) => model.id === lastModel.modelId) : [];
    const model = lastModel
      ? (sameId.find((candidate) => candidate.provider === lastModel.provider) ??
        (sameId.length === 1 ? sameId[0] : undefined))
      : undefined;
    // These dispatches deliberately do not update canonical fields. The
    // following semantic frame supplies Pi's selected/clamped values.
    if (model) void get().applyModelChange(sessionId, model, observation.owner);
    if (lastThinking) void get().applyThinkingLevel(sessionId, lastThinking);
  },

  applyModelChange: async (sessionId, model, expectedRuntime) => {
    if (typeof window === "undefined" || !window.pivis) return { ok: false, error: "Unavailable" };
    const session = get().sessions.get(sessionId);
    const observation = session ? authorityObservation(session) : undefined;
    if (
      !session ||
      !observation ||
      (expectedRuntime &&
        (expectedRuntime.hostInstanceId !== observation.owner.hostInstanceId ||
          expectedRuntime.sessionEpoch !== observation.owner.sessionEpoch))
    ) {
      return { ok: false, error: "Runtime unavailable" };
    }
    try {
      const receipt = await dispatchSessionIntent(
        sessionId,
        { kind: "setModel", provider: model.provider ?? "", modelId: model.id },
        observation,
      );
      if (receipt.status === "admitted" || receipt.status === "duplicate") return { ok: true };
      return {
        ok: false,
        error:
          receipt.status === "delivery_unknown"
            ? "Model-change delivery outcome is unknown"
            : `Model change was not admitted: ${receipt.reason}`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  applyThinkingLevel: async (sessionId, level) => {
    if (typeof window === "undefined" || !window.pivis) return { ok: false, error: "Unavailable" };
    const session = get().sessions.get(sessionId);
    const observation = session ? authorityObservation(session) : undefined;
    if (!session || !observation) {
      return { ok: false, error: "Runtime unavailable" };
    }
    try {
      const receipt = await dispatchSessionIntent(
        sessionId,
        { kind: "setThinking", level },
        observation,
      );
      if (receipt.status === "admitted" || receipt.status === "duplicate") return { ok: true };
      return {
        ok: false,
        error:
          receipt.status === "delivery_unknown"
            ? "Thinking-level delivery outcome is unknown"
            : `Thinking-level change was not admitted: ${receipt.reason}`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  // A direct setter would make a receipt or transcript event authoritative.
  // Keep the compatibility surface inert; snapshots/frames/outcomes own names.
  setSessionName: () => {},

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
        historyGeneration: s.historyGeneration + 1,
        historyHydrating: false,
        historyHydrationToken: undefined,
        unreadStatus: undefined,
        turnErrored: false,
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
    if (!sessionFile) return;
    const hydrationToken = newHistoryHydrationToken();
    // Initial hydration replaces the transcript. If transcript events race
    // the file read, never overwrite them with overlapping persisted history:
    // wait for the authoritative turn to become idle and reread until
    // the transcript and presentation-dirty revision remain unchanged.
    set((state) => {
      const current = state.sessions.get(sessionId);
      if (!current) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        historyHydrating: true,
        historyHydrationToken: hydrationToken,
      });
      return { sessions };
    });
    try {
      while (continuationGuard()) {
        const beforeRead = get().sessions.get(sessionId);
        if (beforeRead?.historyHydrationToken !== hydrationToken) return;
        const historyCapture = captureHistoryRead(beforeRead, expectedRuntime);
        if (!historyCapture) return;
        if (isSessionHistoryBusy(beforeRead)) {
          if (!(await waitForHistoryHydrationIdle(sessionId, historyCapture))) return;
          continue;
        }
        const transcriptAtRequest = beforeRead?.transcript;
        const presentationRevisionAtRequest = beforeRead?.transcriptPresentationRevision;
        const history = await requestBoundHistory(sessionId, historyCapture);
        if (!history || !continuationGuard()) return;
        const current = get().sessions.get(sessionId);
        if (current?.historyHydrationToken !== hydrationToken) return;
        if (!historyCaptureMatches(current, historyCapture)) return;
        if (
          isSessionHistoryBusy(current) ||
          current?.transcript !== transcriptAtRequest ||
          current?.transcriptPresentationRevision !== presentationRevisionAtRequest
        ) {
          if (!(await waitForHistoryHydrationIdle(sessionId, historyCapture))) return;
          continue;
        }
        get().seedHistory(sessionId, history, { hydrationToken });
        const workspacePath = current?.workspacePath;
        if (workspacePath) void get().refreshWorkspaceSessions(workspacePath);
        return;
      }
    } finally {
      set((state) => {
        const current = state.sessions.get(sessionId);
        if (!current || current.historyHydrationToken !== hydrationToken) return {};
        const sessions = new Map(state.sessions);
        sessions.set(sessionId, {
          ...current,
          historyHydrating: false,
          historyHydrationToken: undefined,
        });
        return { sessions };
      });
      schedulePresentationRehydrateIfIdle(sessionId);
    }
  },

  /** Refresh the discovered command list (extension / prompt / skill). */
  refreshCommands: async (sessionId) => {
    if (typeof window === "undefined" || !window.pivis) return;
    const session = get().sessions.get(sessionId);
    if (!session) return;
    const observation = authorityObservation(session);
    if (!observation) return;
    try {
      const result = await querySession(sessionId, { type: "get_commands" }, observation);
      if (result.status !== "ok" || !result.response.success) return;
      // Tolerant read: pi v0.79.1 returns { commands: RpcSlashCommand[] };
      // the contract's PiRpcResponse is a discriminated union, but we
      // only care about `data.commands` so a narrow cast is fine here.
      const data = result.response.data as { commands?: unknown[] } | undefined;
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

  acknowledgeEditorPatch: () => {
    // Patch transport acknowledgement is not canonical editor state. The next
    // revisioned snapshot/frame reconciles revision, text, and conflicts.
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
          if (s.sessionFile !== sessionFile) continue;
          if (!opts?.preopened || s.sessionId === opts.preopened.sessionId) {
            if (focus) {
              if (opts?.requestComposerFocus) get().requestComposerFocus(s.sessionId);
              if (!(await get().setActiveSession(s.sessionId))) return null;
            }
            return s.sessionId;
          }
          // sessionSearch.open may have replaced an exited/failed main record.
          // Its validated pre-open is authoritative; never focus the stale
          // renderer ID and report a false success. This is local reconciliation
          // only—the normal setActiveSession activation-visit path remains below.
          get().removeSession(s.sessionId, { preservePendingDraft: true });
        }
      }
      // session.open is idempotent and non-throwing: it returns
      //   { outcome: "opened" | "existing", sessionId, name, preview, sessionStatus }
      // when the file exists, or { outcome: "missing" } for stale tab entries.
      // "existing" means the file is already open in the main registry — we
      // adopt the existing record instead of failing, so renderer reloads and
      // double-clicks on a stored row are both lossless.
      const res =
        opts?.preopened ??
        (await window.pivis.invoke("session.open", {
          workspacePath,
          sessionFile,
        }));
      if (!("sessionId" in res)) {
        return null; // stale/invalid tab: the caller keeps any recoverable UI open
      }
      const { sessionId, name, preview, sessionStatus } = res;

      // A concurrent openSessionTab for the same file may have already adopted
      // this id (double-click TOCTOU) — never recreate/reseed an existing record.
      if (get().sessions.has(sessionId)) {
        if (focus) {
          if (opts?.requestComposerFocus) get().requestComposerFocus(sessionId);
          if (!(await get().setActiveSession(sessionId))) return null;
        }
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
      // Select the reconstructed session immediately, then hydrate its saved
      // transcript before asking main to attach the subprocess. The textarea
      // is intentionally usable without semantic authority, so the user can
      // read and compose while this cold-open fence settles.
      const hydration = sessionFile ? get().rehydrateHistory(sessionId) : Promise.resolve();
      let activation: Promise<boolean> | undefined;
      if (focus) {
        if (opts?.requestComposerFocus) get().requestComposerFocus(sessionId);
        activation = get().setActiveSession(sessionId, { beforeActivation: hydration });
      }
      // Re-attach worktree identity for a resumed worktree session so the
      // chip renders and git operations target the worktree (not the parent
      // workspace). New sessions have no worktree and skip this.
      if (res.worktreeOperationInProgress) {
        get().setWorktreeCreating(sessionId, true);
        const stillActive = await window.pivis
          .invoke("session.worktreeOperationStatus", { sessionId })
          .catch(() => true);
        get().setWorktreeCreating(sessionId, stillActive);
      }
      if (res.worktreeOperationError) {
        get().setWorktreeError(sessionId, res.worktreeOperationError);
      }
      if (res.worktree) {
        get().applyWorktree(
          sessionId,
          {
            worktreePath: res.worktree.path,
            branch: res.worktree.branch,
            name: res.worktree.name,
            base: res.worktree.base,
          },
          res.worktreeIdentityRevision,
        );
      } else {
        get().applyWorkspace(sessionId, res.worktreeIdentityRevision);
      }
      // Re-query after the renderer owns the record. Revision fencing makes
      // this safe whether a newer worktreeChanged event arrives before or
      // after the response, and recovers events dropped during reconstruction.
      try {
        const snapshot = await window.pivis.invoke("session.worktreeSnapshot", { sessionId });
        if (snapshot.worktree) {
          get().applyWorktree(
            sessionId,
            {
              worktreePath: snapshot.worktree.path,
              branch: snapshot.worktree.branch,
              name: snapshot.worktree.name,
              base: snapshot.worktree.base,
            },
            snapshot.revision,
          );
        } else {
          get().applyWorkspace(sessionId, snapshot.revision);
        }
      } catch {
        // The initial revisioned snapshot remains valid if the session closed
        // before the follow-up query completed.
      }
      if (activation) {
        if (!(await activation)) {
          await hydration.catch(() => {});
          return null;
        }
      }
      await hydration;
      return sessionId;
    } catch (err) {
      console.error("Failed to open session:", err);
      return null;
    }
  },

  closeSessionTab: async (sessionId, opts) => {
    if (typeof window !== "undefined" && window.pivis) {
      try {
        await window.pivis.invoke("session.close", { sessionId });
      } catch (error) {
        // A tab close is local UI cleanup as well as best-effort host disposal.
        // Main guarantees file preservation; never strand a tab on IPC failure.
        console.error("Failed to close session:", error);
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

  setActiveSession: async (sessionId, opts) => {
    const previousActiveId = get().activeSessionId;
    const returningSession = sessionId ? get().sessions.get(sessionId) : undefined;
    const returningVisitId = returningSession?.activationVisitReleasePending
      ? returningSession.activationVisitId
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

    if (typeof window === "undefined" || !window.pivis) return true;

    const activateForVisit = async (targetId: SessionId): Promise<boolean> => {
      const activationVisitId = crypto.randomUUID();
      set((state) => {
        const target = state.sessions.get(targetId);
        if (!target) return {};
        const sessions = new Map(state.sessions);
        sessions.set(targetId, {
          ...target,
          activationVisitId,
          activationVisitReleasePending: undefined,
        });
        return { sessions };
      });
      try {
        await window.pivis.invoke("session.activate", { sessionId: targetId, activationVisitId });
        return true;
      } catch (err) {
        set((state) => {
          const target = state.sessions.get(targetId);
          if (!target || target.activationVisitId !== activationVisitId) return {};
          const sessions = new Map(state.sessions);
          sessions.set(targetId, {
            ...target,
            activationVisitId: undefined,
            activationVisitReleasePending: undefined,
          });
          return { sessions };
        });
        get().setSessionStatus(targetId, "failed", String(err));
        return false;
      }
    };

    let previousReleaseStarted = false;
    const releasePrevious = (): void => {
      if (previousReleaseStarted) return;
      if (!previousActiveId || previousActiveId === sessionId) return;
      previousReleaseStarted = true;
      const previous = get().sessions.get(previousActiveId);
      if (shouldReapPendingNewSession(previous)) {
        void get().closeSessionTab(previousActiveId, { preservePendingDraft: true });
      } else if (previous?.activationVisitId) {
        const activationVisitId = previous.activationVisitId;
        set((state) => {
          const current = state.sessions.get(previousActiveId);
          if (!current || current.activationVisitId !== activationVisitId) return {};
          const sessions = new Map(state.sessions);
          sessions.set(previousActiveId, { ...current, activationVisitReleasePending: true });
          return { sessions };
        });
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
              sessions.set(previousActiveId, {
                ...current,
                activationVisitId: undefined,
                activationVisitReleasePending: undefined,
              });
              return { sessions };
            });
          });
      }
    };

    if (sessionId && sessionId !== previousActiveId && opts?.beforeActivation) {
      // Selection is already visible. Release the old view now so a second
      // switch during a slow history read cannot strand its activation visit,
      // then suppress attach if this session is no longer selected.
      releasePrevious();
      await opts.beforeActivation.catch(() => {});
      if (get().activeSessionId !== sessionId) return true;
    }

    if (!sessionId || sessionId === previousActiveId) {
      releasePrevious();
      return true;
    }
    if (returningVisitId) {
      // If the user comes back while the fresh-snapshot release check is in
      // flight, cancel it. If main already completed the release, immediately
      // start a new activation even if the renderer has not received the cold
      // status event yet.
      try {
        const { cancelled } = await window.pivis.invoke("session.cancelActivationVisitRelease", {
          sessionId,
          activationVisitId: returningVisitId,
        });
        if (!cancelled && get().activeSessionId === sessionId) {
          await activateForVisit(sessionId);
          if (get().activeSessionId === sessionId) releasePrevious();
          // Visible session selection is independent of SDK-host startup. A
          // failed activation leaves the persisted transcript selected and a
          // retryable failed runtime instead of making a valid saved session
          // look unopenable.
          return true;
        }
        releasePrevious();
        return true;
      } catch {
        if (get().activeSessionId !== sessionId) return true;
        await activateForVisit(sessionId);
        if (get().activeSessionId === sessionId) releasePrevious();
        return true;
      }
    }
    const target = get().sessions.get(sessionId);
    if (
      target &&
      (target.status === "cold" || target.status === "exited" || target.status === "failed")
    ) {
      // Main binds the token only when this visit actually causes activation;
      // an already-live process can therefore never be reaped by a stale UI
      // status or duplicate invoke.
      await activateForVisit(sessionId);
      if (get().activeSessionId === sessionId) releasePrevious();
      return true;
    }
    releasePrevious();
    return true;
  },

  reactivateSession: async (sessionId) => {
    const target = get().sessions.get(sessionId);
    if (!target) return false;
    // Only a dead runtime is eligible: live/starting sessions and cold
    // activation-visit flows own their own lifecycles.
    if (target.status !== "failed" && target.status !== "exited") return false;
    if (target.activationVisitId || target.activationVisitReleasePending) return false;
    if (typeof window === "undefined" || !window.pivis) return false;
    const activationVisitId = crypto.randomUUID();
    set((state) => {
      const current = state.sessions.get(sessionId);
      if (!current) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        activationVisitId,
        activationVisitReleasePending: undefined,
      });
      return { sessions };
    });
    try {
      await window.pivis.invoke("session.activate", { sessionId, activationVisitId });
      return true;
    } catch (err) {
      set((state) => {
        const current = state.sessions.get(sessionId);
        if (!current || current.activationVisitId !== activationVisitId) return {};
        const sessions = new Map(state.sessions);
        sessions.set(sessionId, {
          ...current,
          activationVisitId: undefined,
          activationVisitReleasePending: undefined,
        });
        return { sessions };
      });
      get().setSessionStatus(sessionId, "failed", String(err));
      return false;
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

  registerPendingComposerSubmission: (sessionId, submission) => {
    set((state) => {
      const current = state.sessions.get(sessionId);
      if (!current) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        pendingComposerSubmission: {
          ...submission,
          owner: { ...submission.owner },
          submittedComments: submission.submittedComments.map((comment) => ({ ...comment })),
        },
      });
      return { sessions };
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
      const comments = withoutSubmittedCommentRevisions(existingForSession, submitted);
      if (comments === existingForSession) return {};
      const diffComments = new Map(state.diffComments);
      if (!comments || comments.size === 0) diffComments.delete(sessionId);
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
