import * as crypto from "node:crypto";
import { closeSync, fstatSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { newSessionId } from "@shared/ids.js";
import type { SessionId } from "@shared/ids.js";
import type { RendererAttachResult, SessionStatus } from "@shared/ipc-contract.js";
import type { PiReadOnlyCommand } from "@shared/pi-protocol/commands.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";
import {
  type AgentSessionSnapshot,
  AgentSessionSnapshotSchema,
  type AuthorityAttachBaselineResponse,
  type AuthorityAttachResponse,
  type AuthorityFrame,
  type EscapeResult,
  type IntentEnvelope,
  type IntentReceipt,
  type QueueRestorationRecord,
  QueueRestorationRecordSchema,
  type ReloadRequest,
  ReloadRequestSchema,
  type ReloadSettlement,
  type RendererPublication,
  type RuntimeIdentity,
  type RuntimeRecord,
  type RuntimeStateUpdate,
  type SessionQuery,
  type SessionQueryEnvelope,
  SessionQueryEnvelopeSchema,
  type SessionQueryResult,
  type SessionSubmission,
  SessionSubmissionSchema,
  type SubmissionResult,
  SubmissionResultSchema,
  type TransitionBatch,
  TransitionBatchSchema,
} from "@shared/pi-protocol/runtime-state.js";
import lockfile from "proper-lockfile";
import { resolveHostExecPath } from "../pi/locate-node.js";
import { HostRequestUnavailableError, SessionHost } from "../pi/session-host.js";
import { type AuthorityPublication, RendererPublicationRouter } from "./renderer-publication.js";
import { reconcileRestoration } from "./restoration-reconciler.js";
import {
  assertConfinedRegularFileDescriptor,
  createPinnedSessionHardLink,
  openConfinedRegularFileForHost,
} from "./session-search/entry-extractor.js";

interface RetainedIntent {
  payload: SessionSubmission;
  disposition: SubmissionResult["disposition"];
  updatedAt: number;
  recoveryPublished?: boolean | undefined;
  queuedAtAdmission?: boolean | undefined;
  result?: SubmissionResult | undefined;
  /** Byte boundary captured immediately before sending to the retained host. */
  sessionFileOffsetAtDispatch?: number | undefined;
}

/** Preserve a child-requested queue label for ambiguity review; this never
 * selects Pi admission behavior. */
function reviewQueues(submission: SessionSubmission): {
  steering: string[];
  followUp: string[];
} {
  const { requestedMode: queueLabel, text } = submission;
  return {
    steering: queueLabel === "steer" ? [text] : [],
    followUp: queueLabel === "followUp" ? [text] : [],
  };
}

/**
 * Main-only evidence that child IPC may have accepted an owner-bound intent.
 * It is deliberately not a retry queue: semantic outcomes stay child-owned.
 */
interface RetainedDispatchIntent {
  envelope: IntentEnvelope;
  possibleDispatch: boolean;
  deliveryUnknown?: boolean | undefined;
  /** Main emits a review-only unknown escrow once if this owner dies first. */
  recoveryPublished?: boolean | undefined;
  /** Byte boundary captured immediately before sending to the retained host. */
  sessionFileOffsetAtDispatch?: number | undefined;
}

interface PendingUnifiedSubmit {
  id: string;
  text: string;
  editorRevision: number;
  submissionIntentId: string;
  hostInstanceId: string;
  sessionEpoch: number;
  claimedGeneration?: number | undefined;
  claimId?: string | undefined;
  claimExpiresAt?: number | undefined;
}

export interface SessionRecord {
  sessionId: SessionId;
  workspacePath: string;
  worktreePath?: string | undefined;
  sessionFile?: string | undefined;
  /** Search-open file identity pinned across the cold activation IPC gap. */
  _confinedSessionDescriptor?: number | undefined;
  _confinedSessionRoot?: string | undefined;
  /** Windows-only hard link that names the descriptor-pinned runtime inode. */
  _confinedSessionAlias?: string | undefined;
  status: SessionStatus;
  error?: string | undefined;
  proc?: SessionHost | undefined;
  lastActiveAt: number;
  availability: RuntimeStateUpdate["availability"];
  snapshot?: AgentSessionSnapshot | undefined;
  _snapshotMutationFingerprint?: string | undefined;
  _editorRecovery?: AgentSessionSnapshot["editor"] | undefined;
  _deferredInitialBatch?: TransitionBatch | undefined;
  snapshotReceivedAt?: number | undefined;
  leaseExpiresAt?: number | undefined;
  _hasLock?: boolean | undefined;
  /** The file represented by the primary held lock; never infer this from sessionFile. */
  _lockPath?: string | undefined;
  /** Current primary-lock callback identity; retired before unlock/replacement. */
  _primaryLockToken?: string | undefined;
  /** A compromise is terminal for this record: never restart or re-admit it. */
  _lockCompromised?: boolean | undefined;
  _handlingLockCompromise?: boolean | undefined;
  /** A replacement retains the predecessor lock while holding this successor lock. */
  _transitionLock?:
    | {
        transitionId: string;
        oldLockPath?: string | undefined;
        targetFile?: string | undefined;
        successorLocked: boolean;
        successorLockToken?: string | undefined;
        successorCompromised?: boolean | undefined;
      }
    | undefined;
  /** Serializes a pathless host's discovered-file reservation before binding. */
  _initialSessionFileReservation?: Promise<void> | undefined;
  _activating?: boolean | undefined;
  _activationDone?: Promise<void> | undefined;
  _resolveActivationDone?: (() => void) | undefined;
  /** Renderer visit that caused this otherwise-cold host to be activated. */
  _activationVisitId?: string | undefined;
  _activationVisitStartedAt?: number | undefined;
  _activationVisitInteracted?: boolean | undefined;
  _activationVisitReleaseCancelled?: boolean | undefined;
  /** Release can beat session.activate while main is still locating Pi. */
  _releasedActivationVisits: Map<string, number>;
  _restartChain?: Promise<void> | undefined;
  _dead?: boolean | undefined;
  _procReady?: boolean | undefined;
  _piPath?: string | undefined;
  _env?: Record<string, string> | undefined;
  _rapidFailureCount: number;
  _lastFailureAt?: number | undefined;
  _leaseTimer?: ReturnType<typeof setTimeout> | undefined;
  _lifecycleUiLease?: boolean | undefined;
  _hostTransition?:
    | {
        transitionId: string;
        provisionalEpoch: number;
        kind?: string;
      }
    | undefined;
  _worktreeTransition?: boolean | undefined;
  _retainedIntents: Map<string, RetainedIntent>;
  _pendingSubmissionPromises: Map<string, Promise<SubmissionResult>>;
  _expiredUnifiedIntents: Set<string>;
  _acknowledgedUnifiedIntents: Set<string>;
  _unifiedRestorationIntents: Map<string, string>;
  _retainedDispatchIntents: Map<string, RetainedDispatchIntent>;
  _restorations: Map<string, unknown>;
  _resolvedRestorations: Set<string>;
  /** Resolved legacy restore-draft instructions retained until renderer acknowledgement. */
  _resolvedRestorationInstructions: Map<string, unknown>;
  _rendererGeneration: number;
  _mutationSequence: number;
  _closing?: boolean | undefined;
  _panelInputSequence: Map<number, number>;
  _panelInputChains: Map<
    number,
    Promise<{
      acknowledgedThrough: number;
      gap?: { expected: number; received: number };
    }>
  >;
  _pendingUiRequests: Map<string, ExtensionUiRequest>;
  _openPanels: Map<number, PanelEvent>;
  _pendingUnifiedSubmits: Map<string, PendingUnifiedSubmit>;
  _retiredUnifiedRequests: Set<string>;
  _unifiedClaimTimers: Map<string, ReturnType<typeof setTimeout>>;
  _panelCheckpoints: Map<number, { lastData?: string; mode?: "content" | "viewport" }>;
  _pendingUiAcks: Map<
    string,
    {
      promise: Promise<boolean>;
      resolve: (value: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  _authorityPublications?: RendererPublicationRouter | undefined;
  _pendingRendererCancellation?:
    | {
        generation: number;
        resolve: (acknowledged: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
}

const RAPID_FAILURE_WINDOW_MS = 30_000;
function removeRuntimePinWithRetry(alias: string, attemptsRemaining = 60): void {
  try {
    unlinkSync(alias);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || attemptsRemaining <= 0) return;
    const timer = setTimeout(() => removeRuntimePinWithRetry(alias, attemptsRemaining - 1), 1_000);
    timer.unref?.();
  }
}

// Transport freshness is independent of child Pi liveness. Semantic admission
// is delegated to the serialized child lifecycle-permit transaction.
// Child idle heartbeats are emitted every two seconds. Keep a full missed-beat
// margin so ordinary timer/IPC jitter cannot repeatedly fence a healthy host.
const TRANSPORT_LEASE_MS = 5_000;
/** A visit release is startup cancellation, never a later idle-host policy. */
const ACTIVATION_VISIT_RELEASE_WINDOW_MS = 2_000;
const DEFAULT_UNIFIED_CLAIM_TIMEOUT_MS = 60_000;
const CLOSE_ESCAPE_DEADLINE_MS = 250;

/** The query protocol is deliberately narrower than Pi's general command union. */
function commandForSessionQuery(query: SessionQuery): PiReadOnlyCommand {
  switch (query.type) {
    case "get_available_models":
    case "get_login_providers":
    case "get_scoped_models":
    case "get_logout_providers":
    case "get_commands":
    case "get_state":
    case "get_session_stats":
    case "get_messages":
    case "get_fork_messages":
    case "get_last_assistant_text":
    case "get_trust_state":
    case "get_tree":
    case "get_cache_miss_notices":
      return { type: query.type };
    case "render_entry":
      return {
        type: "render_entry",
        entryId: query.entryId,
        cols: query.cols,
        ...(query.expanded !== undefined ? { expanded: query.expanded } : {}),
      };
  }
}

type SessionEventCallback = (sessionId: SessionId, event: PiEvent) => void;
type UiRequestCallback = (sessionId: SessionId, req: ExtensionUiRequest) => void;
type StatusChangedCallback = (
  sessionId: SessionId,
  status: SessionStatus,
  error?: string,
  piVersion?: string,
) => void;
type PanelEventCallback = (sessionId: SessionId, event: PanelEvent) => void;
type UnifiedSubmitRequestCallback = (
  sessionId: SessionId,
  req: {
    id: string;
    text: string;
    editorRevision: number;
    submissionIntentId: string;
    hostInstanceId: string;
    sessionEpoch: number;
  },
) => void;
type RuntimeStateCallback = (sessionId: SessionId, state: RuntimeStateUpdate) => void;
type SubmissionCallback = (sessionId: SessionId, result: SubmissionResult) => void;
type QueueRestorationCallback = (sessionId: SessionId, payload: unknown) => void;
type UiAcknowledgedCallback = (sessionId: SessionId, operationId: string) => void;
type TransitionBatchCallback = (
  sessionId: SessionId,
  records: RuntimeRecord[],
  state: RuntimeStateUpdate,
) => void;
type AuthorityPublicationCallback = (publication: RendererPublication) => void;
type SessionFileChangedCallback = (
  sessionId: SessionId,
  owner: RuntimeIdentity,
  sessionFile: string | undefined,
  sessionName?: string,
) => void;

export class SessionRegistry {
  private sessions = new Map<SessionId, SessionRecord>();
  private byFile = new Map<string, SessionId>();

  constructor(
    private onEvent: SessionEventCallback,
    private onUiRequest: UiRequestCallback,
    private onStatusChanged: StatusChangedCallback,
    private onPanelEvent: PanelEventCallback,
    private onUnifiedSubmitRequest: UnifiedSubmitRequestCallback,
    private onRuntimeState: RuntimeStateCallback = () => {},
    private onSubmission: SubmissionCallback = () => {},
    private onQueueRestoration: QueueRestorationCallback = () => {},
    private onUiAcknowledged: UiAcknowledgedCallback = () => {},
    private onTransitionBatch: TransitionBatchCallback = () => {},
    private options: {
      unifiedClaimTimeoutMs?: number;
      authorityPublicationBufferLimit?: number;
    } = {},
    private onAuthorityPublication: AuthorityPublicationCallback = () => {},
    private onSessionFileChanged: SessionFileChangedCallback = () => {},
  ) {}

  private sessionFileOffset(record: SessionRecord): number | undefined {
    if (!record.sessionFile) return undefined;
    try {
      return statSync(record.sessionFile).size;
    } catch {
      return undefined;
    }
  }

  private emitResolvedRestoration(record: SessionRecord, restorationId: string): void {
    const instruction = record._resolvedRestorationInstructions.get(restorationId);
    if (instruction) this.onQueueRestoration(record.sessionId, structuredClone(instruction));
  }

  /** Main is the sole authority deciding whether custody returns to a draft. */
  private async resolveRestoration(record: SessionRecord, payload: unknown): Promise<void> {
    // Legacy host records are wrapped in a transport envelope while semantic
    // frames and attach baselines carry the record directly. Retain only the
    // record fields before strict protocol validation in both cases.
    const value =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const parsed = QueueRestorationRecordSchema.safeParse({
      type: value.type,
      restorationId: value.restorationId,
      steering: value.steering,
      followUp: value.followUp,
      originalAttachments: value.originalAttachments,
      ...(value.clearedIntentIds !== undefined ? { clearedIntentIds: value.clearedIntentIds } : {}),
      ...(value.commandDescription !== undefined
        ? { commandDescription: value.commandDescription }
        : {}),
      certainty: value.certainty,
    });
    if (!parsed.success) return;
    const restoration: QueueRestorationRecord = parsed.data;
    if (record._resolvedRestorationInstructions.has(restoration.restorationId)) {
      this.emitResolvedRestoration(record, restoration.restorationId);
      return;
    }
    if (record._resolvedRestorations.has(restoration.restorationId)) return;
    record._resolvedRestorations.add(restoration.restorationId);
    const textParts = [...restoration.steering, ...restoration.followUp].filter((text) =>
      text.trim(),
    );
    const attachments = restoration.originalAttachments.flatMap((item) => item.images);
    let disposition: "restore" | "dropped";
    if (
      restoration.commandDescription?.trim() &&
      textParts.length === 0 &&
      attachments.length === 0
    ) {
      disposition = "dropped";
    } else if (restoration.certainty === "not_processed") {
      disposition = "restore";
    } else {
      const intentIds = new Set([
        ...(restoration.clearedIntentIds ?? []),
        ...restoration.originalAttachments.map((item) => item.intentId),
      ]);
      let offset: number | undefined;
      for (const retained of record._retainedIntents.values()) {
        if (intentIds.has(retained.payload.intentId)) {
          offset = retained.sessionFileOffsetAtDispatch;
          break;
        }
      }
      if (offset === undefined) {
        for (const retained of record._retainedDispatchIntents.values()) {
          if (intentIds.has(retained.envelope.intentId)) {
            offset = retained.sessionFileOffsetAtDispatch;
            break;
          }
        }
      }
      disposition = await reconcileRestoration(record.sessionFile, offset, textParts);
    }
    // An acknowledgement can win while async reconciliation is in flight.
    // Do not resurrect custody after that acknowledgement.
    if (!record._restorations.has(restoration.restorationId)) return;
    record._resolvedRestorationInstructions.set(restoration.restorationId, {
      restorationId: restoration.restorationId,
      text: textParts.join("\n\n"),
      attachments: structuredClone(attachments),
      disposition,
    });
    this.emitResolvedRestoration(record, restoration.restorationId);
  }

  private queueRestoration(record: SessionRecord, payload: unknown): void {
    void this.resolveRestoration(record, payload);
  }

  openSession(
    workspacePath: string,
    sessionFile?: string,
    worktreePath?: string,
    confinedSessionDescriptor?: number,
    confinedSessionRoot?: string,
  ): SessionId {
    if (sessionFile) {
      const resolved = path.resolve(sessionFile);
      const existing = this.byFile.get(resolved);
      if (existing) {
        const record = this.sessions.get(existing);
        if (record && record.status !== "exited" && record.status !== "failed") {
          throw new Error(`Session file already open: ${resolved}`);
        }
        if (record) this.releaseConfinedSource(record);
        this.sessions.delete(existing);
        this.byFile.delete(resolved);
      }
    }
    const sessionId = newSessionId();
    const record: SessionRecord = {
      sessionId,
      workspacePath,
      worktreePath,
      sessionFile,
      ...(confinedSessionDescriptor !== undefined
        ? {
            _confinedSessionDescriptor: confinedSessionDescriptor,
            _confinedSessionRoot: confinedSessionRoot,
          }
        : {}),
      status: "cold",
      lastActiveAt: Date.now(),
      availability: "unavailable",
      _rapidFailureCount: 0,
      _releasedActivationVisits: new Map(),
      _retainedIntents: new Map(),
      _pendingSubmissionPromises: new Map(),
      _expiredUnifiedIntents: new Set(),
      _acknowledgedUnifiedIntents: new Set(),
      _unifiedRestorationIntents: new Map(),
      _retainedDispatchIntents: new Map(),
      _restorations: new Map(),
      _resolvedRestorations: new Set(),
      _resolvedRestorationInstructions: new Map(),
      _rendererGeneration: 0,
      _mutationSequence: 0,
      _panelInputSequence: new Map(),
      _panelInputChains: new Map(),
      _pendingUiRequests: new Map(),
      _openPanels: new Map(),
      _pendingUnifiedSubmits: new Map(),
      _retiredUnifiedRequests: new Set(),
      _unifiedClaimTimers: new Map(),
      _panelCheckpoints: new Map(),
      _pendingUiAcks: new Map(),
    };
    this.sessions.set(sessionId, record);
    if (sessionFile) this.byFile.set(path.resolve(sessionFile), sessionId);
    return sessionId;
  }

  async activateSession(
    sessionId: SessionId,
    piPath: string,
    env?: Record<string, string> | Promise<Record<string, string>>,
    activationVisitId?: string,
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    // A rapid switch-away can reach main while session.activate is still
    // locating Pi/getting the login environment. Honour that cancellation
    // before reserving or spawning a process.
    if (activationVisitId) {
      const releasedAt = record._releasedActivationVisits.get(activationVisitId);
      record._releasedActivationVisits.delete(activationVisitId);
      if (
        releasedAt !== undefined &&
        Date.now() - releasedAt <= ACTIVATION_VISIT_RELEASE_WINDOW_MS
      ) {
        return;
      }
    }
    if (record._lockCompromised || record._dead) {
      throw new Error("Session lock was compromised; this session must be reopened");
    }
    if (record._activating) return record._activationDone;
    if (record.proc && (record.status === "starting" || record.status === "ready")) return;

    record._activationVisitId = activationVisitId;
    record._activationVisitStartedAt = activationVisitId ? Date.now() : undefined;
    record._activationVisitInteracted = false;
    record._activationVisitReleaseCancelled = false;
    record._activating = true;
    record._activationDone = new Promise((resolve) => {
      record._resolveActivationDone = resolve;
    });
    record._piPath = piPath;
    record._env = undefined;
    record.error = undefined;
    record.status = "starting";
    record.availability = "transitioning";
    this.onStatusChanged(sessionId, "starting");
    this.publishRuntime(record, "transitioning", "Host startup");

    try {
      const resolvedEnv = env ? await env : undefined;
      if (record._dead) return;
      record._env = resolvedEnv;
      await this.acquireLock(record);
      if (record._dead) return;
      const { execPath } = await resolveHostExecPath();
      if (record._dead) return;
      if (
        record.sessionFile &&
        record._confinedSessionDescriptor !== undefined &&
        record._confinedSessionRoot
      ) {
        // Rebind the pathname to the still-open descriptor at the actual host
        // activation boundary. The child inherits this descriptor, so a path
        // replacement after validation cannot redirect SessionManager.open().
        assertConfinedRegularFileDescriptor(
          record.sessionFile,
          record._confinedSessionRoot,
          record._confinedSessionDescriptor,
        );
        if (process.platform === "win32") {
          // Windows has no descriptor filesystem. A verified hard link gives
          // SessionManager a stable path to the pinned inode while preserving
          // normal append behavior on the original file.
          record._confinedSessionAlias = createPinnedSessionHardLink(
            record.sessionFile,
            record._confinedSessionDescriptor,
          );
          closeSync(record._confinedSessionDescriptor);
          record._confinedSessionDescriptor = undefined;
        } else {
          // Use a fresh offset-zero O_APPEND file description for every spawn.
          // Retaining a prior description would share its EOF read offset
          // across reactivation, while read-only would reject appends.
          const hostDescriptor = openConfinedRegularFileForHost(
            record.sessionFile,
            record._confinedSessionRoot,
          );
          const pinnedStat = fstatSync(record._confinedSessionDescriptor);
          const hostStat = fstatSync(hostDescriptor);
          if (pinnedStat.dev !== hostStat.dev || pinnedStat.ino !== hostStat.ino) {
            closeSync(hostDescriptor);
            throw new Error("Session search source changed before host activation");
          }
          closeSync(record._confinedSessionDescriptor);
          record._confinedSessionDescriptor = hostDescriptor;
        }
      }
      const proc = new SessionHost(
        piPath,
        record.worktreePath ?? record.workspacePath,
        record.sessionFile,
        resolvedEnv,
        execPath,
        record._confinedSessionDescriptor,
        record._confinedSessionAlias,
      );
      record.proc = proc;
      this.attachHost(record, proc);
      await proc.waitForReady();
      if (record._dead || record.proc !== proc) {
        proc.stop();
        return;
      }
      await this.recoverEditorAfterRestart(record, proc);
      if (record._dead || record.proc !== proc) {
        proc.stop();
        return;
      }
      record._procReady = true;
      record.status = "ready";
      record.error = undefined;
      // Install the first owner-correlated snapshot before exposing `ready`.
      // Otherwise renderer ready listeners can dispatch queries against an
      // owner that changes while the initial resync is still in flight.
      await this.resyncSession(sessionId);
      if (record._dead || record.proc !== proc) {
        proc.stop();
        return;
      }
      // Keep the recovery budget across a successful ready handshake. A second
      // crash inside RAPID_FAILURE_WINDOW_MS must leave the session failed
      // rather than creating an endless crash/restart loop.
      this.onStatusChanged(sessionId, "ready", undefined, proc.piVersion);
    } catch (error) {
      if (record._dead) return;
      const message = error instanceof Error ? error.message : String(error);
      record.proc?.stop();
      record.proc = undefined;
      record._procReady = false;
      record.status = "failed";
      record.error = message;
      if (!activationVisitId || record._activationVisitId === activationVisitId) {
        record._activationVisitId = undefined;
        record._activationVisitStartedAt = undefined;
        record._activationVisitInteracted = undefined;
        record._activationVisitReleaseCancelled = undefined;
      }
      this.releaseLock(record);
      this.onStatusChanged(sessionId, "failed", message);
      this.publishUnavailable(record, message);
      throw error;
    } finally {
      record._activating = false;
      record._resolveActivationDone?.();
      record._resolveActivationDone = undefined;
      record._activationDone = undefined;
    }
  }

  private markActivationVisitInteracted(record: SessionRecord | undefined): void {
    if (record?._activationVisitId) record._activationVisitInteracted = true;
  }

  private attachHost(record: SessionRecord, proc: SessionHost): void {
    const current = () => this.sessions.get(record.sessionId) === record && record.proc === proc;
    proc.on("event", (event) => {
      if (!current()) return;
      record.lastActiveAt = Date.now();
      record._mutationSequence++;
      this.onEvent(record.sessionId, event);
    });
    proc.on("uiRequest", (request) => {
      if (!current()) return;
      record._mutationSequence++;
      if (request.method === "set_editor_text") {
        // Extension editor writes are already committed to host-authoritative
        // revisioned state. Fetch that state instead of forwarding the legacy
        // unversioned injection, which could overwrite an in-flight local edit.
        void this.resyncSession(record.sessionId).catch((error) => {
          if (current())
            this.publishUnavailable(record, error instanceof Error ? error.message : String(error));
        });
        return;
      }
      const operationId =
        (request as ExtensionUiRequest & { operationId?: string }).operationId ?? request.id;
      record._pendingUiRequests.set(operationId, structuredClone(request));
      this.onUiRequest(record.sessionId, request);
    });
    proc.on("lifecycleUiLease", (active) => {
      if (!current()) return;
      record._lifecycleUiLease = active;
      if (record._leaseTimer) clearTimeout(record._leaseTimer);
      record._leaseTimer = undefined;
      if (active) {
        record.leaseExpiresAt = undefined;
      } else if (record.snapshot) {
        record.leaseExpiresAt = Date.now() + TRANSPORT_LEASE_MS;
        this.armLease(record, TRANSPORT_LEASE_MS);
      }
      this.publishRuntime(record, record.availability);
    });
    proc.on("panelOpen", (panelId, overlay, unified, hostInstanceId, sessionEpoch, baseline) => {
      if (!current()) return;
      record._mutationSequence++;
      record._panelInputSequence.set(panelId, 0);
      const event: PanelEvent = {
        type: "panel_open",
        panelId,
        overlay,
        hostInstanceId,
        sessionEpoch,
        ...(unified ? { unified: true } : {}),
        ...(baseline ? { baseline } : {}),
      };
      record._openPanels.set(panelId, event);
      this.onPanelEvent(record.sessionId, event);
    });
    proc.on("panelRepaint", (panelId, revision) => {
      if (!current()) return;
      record._mutationSequence++;
      this.onPanelEvent(record.sessionId, {
        type: "panel_repaint",
        panelId,
        revision,
      });
    });
    proc.on("panelData", (panelId, data) => {
      if (!current()) return;
      record._mutationSequence++;
      const checkpoint = record._panelCheckpoints.get(panelId) ?? {};
      record._panelCheckpoints.set(panelId, { ...checkpoint, lastData: data });
      this.onPanelEvent(record.sessionId, {
        type: "panel_data",
        panelId,
        data,
      });
    });
    proc.on("panelClose", (panelId) => {
      if (!current()) return;
      record._mutationSequence++;
      record._panelInputSequence.delete(panelId);
      record._panelInputChains.delete(panelId);
      record._openPanels.delete(panelId);
      record._panelCheckpoints.delete(panelId);
      this.onPanelEvent(record.sessionId, { type: "panel_close", panelId });
    });
    proc.on("panelMode", (panelId, mode) => {
      if (!current()) return;
      record._mutationSequence++;
      const checkpoint = record._panelCheckpoints.get(panelId) ?? {};
      record._panelCheckpoints.set(panelId, { ...checkpoint, mode });
      this.onPanelEvent(record.sessionId, {
        type: "panel_mode",
        panelId,
        mode,
      });
    });
    proc.on("panelClearAll", () => {
      if (!current()) return;
      record._mutationSequence++;
      record._openPanels.clear();
      record._panelInputSequence.clear();
      record._panelInputChains.clear();
      record._panelCheckpoints.clear();
      this.onPanelEvent(record.sessionId, { type: "panel_clear_all" });
    });
    proc.on("unifiedSubmitRequest", (id, text, editorRevision) => {
      if (!current() || !proc.hostInstanceId) return;
      record._mutationSequence++;
      const retiredKey = `${proc.hostInstanceId}\0${proc.sessionEpoch}\0${id}`;
      if (record._retiredUnifiedRequests.has(retiredKey)) {
        proc.sendUnifiedSubmitResponse(
          id,
          false,
          false,
          "Unified request was already retired and cannot execute again",
        );
        return;
      }
      const existing = record._pendingUnifiedSubmits.get(id);
      if (
        existing?.hostInstanceId === proc.hostInstanceId &&
        existing.sessionEpoch === proc.sessionEpoch
      ) {
        if (existing.claimedGeneration === undefined) {
          this.onUnifiedSubmitRequest(record.sessionId, structuredClone(existing));
        }
        return;
      }
      if (existing) this.clearUnifiedClaimTimer(record, id);
      const request: PendingUnifiedSubmit = {
        id,
        text,
        editorRevision,
        submissionIntentId: crypto.randomUUID(),
        hostInstanceId: proc.hostInstanceId,
        sessionEpoch: proc.sessionEpoch,
      };
      record._pendingUnifiedSubmits.set(id, structuredClone(request));
      this.onUnifiedSubmitRequest(record.sessionId, request);
    });
    proc.on("transitionStarted", (transitionId, provisionalEpoch) => {
      if (!current()) return;
      record._hostTransition = { transitionId, provisionalEpoch };
      record.availability = "transitioning";
      this.publishRuntime(record, "transitioning", "Session replacement in progress");
    });
    proc.on("transitionPrepare", (request) => {
      if (!current()) return;
      if (record._hostTransition?.transitionId === request.transitionId) {
        record._hostTransition = { ...record._hostTransition, kind: request.kind };
      }
      void this.permitTransition(record, proc, request).then(
        () => proc.sendTransitionPermit(request.transitionId, true),
        (error) =>
          proc.sendTransitionPermit(
            request.transitionId,
            false,
            error instanceof Error ? error.message : String(error),
          ),
      );
    });
    proc.on("initialSessionFile", (sessionFile) => {
      if (!current()) return;
      // The child waits for this reply before its initial extension binding.
      // A contention denial is intentionally fatal startup admission, not a
      // best-effort warning after mutable extension work has begun.
      void this.permitInitialSessionFile(record, proc, sessionFile).then(
        () => proc.sendInitialSessionFilePermit(true),
        (error) =>
          proc.sendInitialSessionFilePermit(
            false,
            error instanceof Error ? error.message : String(error),
          ),
      );
    });
    proc.on("transitionCancelled", (transitionId) => {
      if (!current() || record._hostTransition?.transitionId !== transitionId) return;
      this.abortTransitionLock(record, transitionId);
      record._hostTransition = undefined;
      record.availability = "available";
      if (record.snapshot) {
        record.snapshotReceivedAt = Date.now();
        record.leaseExpiresAt = record.snapshotReceivedAt + TRANSPORT_LEASE_MS;
        this.armLease(record, TRANSPORT_LEASE_MS);
      }
      this.publishRuntime(record, "available");
    });
    proc.on("snapshot", (snapshot) => {
      if (!current() || (record._editorRecovery && record._deferredInitialBatch)) return;
      this.installSnapshot(record, snapshot);
    });
    proc.on("authorityFrame", (frame) => {
      if (!current()) return;
      this.routeAuthorityPublication(record.sessionId, {
        plane: "semantic",
        owner: frame.owner,
        payload: frame,
      });
    });
    proc.on("authorityPublication", (publication) => {
      if (!current()) return;
      // Per-plane source continuity belongs to the child. Main only fences
      // owner identity and assigns renderer publication sequence.
      this.routeAuthorityPublication(record.sessionId, publication);
    });
    proc.on("transitionBatch", (batch) => {
      if (!current()) return;
      const allowInitial =
        !record._procReady &&
        record._hostTransition === undefined &&
        batch.transitionId.startsWith("initial-");
      if (record._editorRecovery) {
        if (!allowInitial) {
          this.publishUnavailable(record, "Unexpected transition batch during host recovery");
          return;
        }
        record._deferredInitialBatch = structuredClone(batch);
        return;
      }
      this.installTransitionBatch(record, batch, {
        expectedTransition: record._hostTransition,
        allowInitial,
      });
    });
    proc.on("controlSilence", () => {
      if (!current()) return;
      this.publishUnavailable(record, "Host missed the correlated state-probe deadline");
    });
    proc.on("transportGap", (expected, received) => {
      if (!current()) return;
      this.publishUnavailable(
        record,
        `Host transport gap (expected ${expected}, received ${received})`,
      );
      void this.resyncSession(record.sessionId).catch(() => {});
    });
    proc.on("submissionDisposition", (result) => {
      if (!current()) return;
      const settlementIsCurrent =
        record.availability === "available" &&
        record._hostTransition === undefined &&
        result.hostInstanceId === record.proc?.hostInstanceId &&
        result.sessionEpoch === record.snapshot?.sessionEpoch;
      if (!settlementIsCurrent) {
        this.retireStaleSubmissionDisposition(
          record,
          result,
          "Submission settled after its admitted runtime entered a replacement boundary",
        );
        return;
      }
      this.retainDisposition(record, result);
      this.onSubmission(record.sessionId, result);
    });
    proc.on("queueRestoration", (payload) => {
      if (!current()) return;
      const restorationId = (payload as { restorationId?: unknown }).restorationId;
      if (typeof restorationId !== "string" || record._restorations.has(restorationId)) return;
      record._restorations.set(restorationId, structuredClone(payload));
      this.queueRestoration(record, payload);
    });
    proc.on("rendererCancelled", (generation) => {
      if (!current()) return;
      const pending = record._pendingRendererCancellation;
      if (!pending || pending.generation !== generation) return;
      clearTimeout(pending.timer);
      record._pendingRendererCancellation = undefined;
      pending.resolve(true);
    });
    proc.on("uiAcknowledged", (operationId) => {
      if (!current()) return;
      const pending = record._pendingUiAcks.get(operationId);
      if (pending) {
        clearTimeout(pending.timer);
        record._pendingUiAcks.delete(operationId);
        pending.resolve(true);
      }
      record._pendingUiRequests.delete(operationId);
      this.onUiAcknowledged(record.sessionId, operationId);
    });
    proc.on("unresponsive", () => {
      if (current())
        this.handleRuntimeFailure(record, proc, "Host control channel was unresponsive");
    });
    proc.on("exit", (_code, _signal, diagnostic) => {
      if (!current() || (record._activating && !record._procReady)) return;
      this.handleRuntimeFailure(record, proc, diagnostic.message);
    });
    proc.on("error", (error) => {
      if (!current() || (record._activating && !record._procReady)) return;
      this.handleRuntimeFailure(record, proc, error.message);
    });
  }

  private installSnapshot(
    record: SessionRecord,
    snapshotInput: AgentSessionSnapshot,
    publish = true,
    adoptSessionFile = true,
  ): void {
    const parsed = AgentSessionSnapshotSchema.safeParse(snapshotInput);
    if (!parsed.success) {
      this.publishUnavailable(record, `Invalid runtime snapshot: ${parsed.error.message}`);
      return;
    }
    const snapshot =
      (record._confinedSessionDescriptor !== undefined || record._confinedSessionAlias) &&
      record.sessionFile
        ? { ...parsed.data, sessionFile: record.sessionFile }
        : parsed.data;
    const prior = record.snapshot;
    if (record.proc?.hostInstanceId && snapshot.hostInstanceId !== record.proc.hostInstanceId)
      return;
    if (prior?.hostInstanceId === snapshot.hostInstanceId) {
      if (snapshot.sessionEpoch < prior.sessionEpoch) return;
      if (
        snapshot.sessionEpoch === prior.sessionEpoch &&
        snapshot.snapshotSequence <= prior.snapshotSequence
      ) {
        return;
      }
    }
    const { snapshotSequence: _sequence, capturedAt: _capturedAt, ...mutationFacts } = snapshot;
    const mutationFingerprint = JSON.stringify(mutationFacts);
    if (
      record._snapshotMutationFingerprint !== undefined &&
      record._snapshotMutationFingerprint !== mutationFingerprint
    ) {
      record._mutationSequence++;
    }
    record._snapshotMutationFingerprint = mutationFingerprint;
    record.snapshot = snapshot;
    record._authorityPublications?.setExpectedOwner({
      hostInstanceId: snapshot.hostInstanceId,
      sessionEpoch: snapshot.sessionEpoch,
    });
    // Retained intent retirement follows explicit child dispositions/outcomes,
    // never a main-process inference from an apparently idle snapshot.
    record.snapshotReceivedAt = Date.now();
    const transitionPending =
      record._hostTransition !== undefined || record._worktreeTransition === true;
    record.leaseExpiresAt = transitionPending
      ? undefined
      : record.snapshotReceivedAt + TRANSPORT_LEASE_MS;
    record.availability = transitionPending ? "transitioning" : "available";
    record.lastActiveAt = Date.now();
    if (adoptSessionFile && snapshot.sessionFile) {
      this.noteSessionFile(record.sessionId, snapshot.sessionFile);
    }
    if (transitionPending) {
      if (record._leaseTimer) clearTimeout(record._leaseTimer);
      record._leaseTimer = undefined;
    } else {
      this.armLease(record, TRANSPORT_LEASE_MS);
    }
    if (publish) this.publishRuntime(record, record.availability);
  }

  private installTransitionBatch(
    record: SessionRecord,
    batchInput: TransitionBatch,
    options: {
      expectedTransition?:
        | {
            transitionId: string;
            provisionalEpoch: number;
            kind?: string;
          }
        | undefined;
      allowInitial?: boolean | undefined;
    } = {},
  ): boolean {
    const parsed = TransitionBatchSchema.safeParse(batchInput);
    if (!parsed.success) {
      this.publishUnavailable(record, `Invalid transition batch: ${parsed.error.message}`);
      return false;
    }
    const batch = parsed.data;
    const terminal = batch.terminalSnapshot;
    const correlated =
      (options.allowInitial === true &&
        batch.transitionId === `initial-${terminal.hostInstanceId}`) ||
      (options.expectedTransition !== undefined &&
        batch.transitionId === options.expectedTransition.transitionId &&
        batch.provisionalEpoch === options.expectedTransition.provisionalEpoch);
    if (!correlated) {
      this.publishUnavailable(record, "Uncorrelated transition batch");
      return false;
    }
    const prior = record.snapshot;
    if (
      terminal.sessionEpoch !== batch.provisionalEpoch ||
      record.proc?.hostInstanceId !== terminal.hostInstanceId ||
      (prior?.hostInstanceId === terminal.hostInstanceId &&
        (terminal.sessionEpoch < prior.sessionEpoch ||
          (terminal.sessionEpoch === prior.sessionEpoch &&
            terminal.snapshotSequence <= prior.snapshotSequence))) ||
      batch.records.some(
        (item) =>
          (item.type === "submission" || item.type === "escape") &&
          (item.result.hostInstanceId !== terminal.hostInstanceId ||
            item.result.sessionEpoch !== batch.provisionalEpoch),
      )
    ) {
      this.publishUnavailable(record, "Invalid transition batch identity");
      return false;
    }
    if (options.expectedTransition !== undefined) {
      const lock = record._transitionLock;
      const terminalFile = terminal.sessionFile ? path.resolve(terminal.sessionFile) : undefined;
      if (
        record._dead ||
        record._lockCompromised ||
        !lock ||
        lock.transitionId !== batch.transitionId ||
        !lock.successorLocked ||
        lock.successorCompromised ||
        (lock.targetFile !== undefined && terminalFile !== lock.targetFile)
      ) {
        this.publishUnavailable(record, "Successor transition batch arrived without its held lock");
        return false;
      }
      record._hostTransition = undefined;
    }
    // Reduce every record privately in wire order. Nothing is renderer-visible
    // until the terminal direct snapshot is installed and one combined IPC
    // update is published.
    record.snapshot = undefined;
    for (const item of batch.records) {
      if (item.type === "event") {
        record._mutationSequence++;
      } else if (item.type === "ui") {
        record._mutationSequence++;
        const operationId =
          (item.request as ExtensionUiRequest & { operationId?: string }).operationId ??
          item.request.id;
        record._pendingUiRequests.set(operationId, structuredClone(item.request));
      } else if (item.type === "panel") {
        record._mutationSequence++;
        if (item.event.type === "panel_open") {
          record._openPanels.set(item.event.panelId, structuredClone(item.event));
          record._panelInputSequence.set(item.event.panelId, 0);
        } else if (item.event.type === "panel_data") {
          const checkpoint = record._panelCheckpoints.get(item.event.panelId) ?? {};
          record._panelCheckpoints.set(item.event.panelId, {
            ...checkpoint,
            lastData: item.event.data,
          });
        } else if (item.event.type === "panel_mode") {
          const checkpoint = record._panelCheckpoints.get(item.event.panelId) ?? {};
          record._panelCheckpoints.set(item.event.panelId, {
            ...checkpoint,
            mode: item.event.mode,
          });
        } else if (item.event.type === "panel_close") {
          record._openPanels.delete(item.event.panelId);
          record._panelInputSequence.delete(item.event.panelId);
          record._panelInputChains.delete(item.event.panelId);
          record._panelCheckpoints.delete(item.event.panelId);
        } else if (item.event.type === "panel_clear_all") {
          record._openPanels.clear();
          record._panelInputSequence.clear();
          record._panelInputChains.clear();
          record._panelCheckpoints.clear();
        }
      } else if (item.type === "submission") {
        this.retainDisposition(record, item.result);
      } else if (item.type === "queue_restoration") {
        if (!record._restorations.has(item.restorationId)) {
          record._restorations.set(item.restorationId, structuredClone(item));
          this.queueRestoration(record, item);
        }
      }
      // Escape results are already correlated to their request. Keeping them in
      // this combined record stream preserves ordering without inventing state.
    }
    // A different-file successor is already reserved by `_transitionLock`,
    // while the predecessor remains the primary route until this atomic
    // commit completes. Defer file adoption to `commitTransitionLock` rather
    // than asking the generic snapshot path to move a held primary lock.
    this.installSnapshot(record, terminal, false, options.expectedTransition === undefined);
    const state = this.publishRuntime(record, "available", undefined, false);
    // Routing is now committed and the successor lock is still held. Only at
    // this point may the predecessor advisory lock be released.
    if (options.expectedTransition !== undefined) {
      this.commitTransitionLock(record, batch.transitionId);
      // Reload is the only host transition that intentionally preserves the
      // current conversation. Every other successor represents a semantic
      // session replacement and must reseed renderer transcript ownership,
      // even when Pi temporarily reuses the same file path or the prepare
      // record did not expose a more specific replacement kind.
      const semanticReplacement = options.expectedTransition.kind !== "reload";
      if (semanticReplacement || terminal.sessionFile !== prior?.sessionFile) {
        this.onSessionFileChanged(
          record.sessionId,
          {
            hostInstanceId: terminal.hostInstanceId,
            sessionEpoch: terminal.sessionEpoch,
          },
          terminal.sessionFile,
          terminal.sessionName,
        );
      }
    }
    this.onTransitionBatch(record.sessionId, batch.records, state);
    return true;
  }

  private armLease(record: SessionRecord, leaseMs: number): void {
    if (record._leaseTimer) clearTimeout(record._leaseTimer);
    if (record._lifecycleUiLease) {
      record._leaseTimer = undefined;
      record.leaseExpiresAt = undefined;
      return;
    }
    record._leaseTimer = setTimeout(() => {
      if (!record.snapshotReceivedAt || Date.now() < (record.leaseExpiresAt ?? 0)) return;
      this.publishUnavailable(record, "Runtime snapshot lease expired");
      void this.resyncSession(record.sessionId).catch(() => {});
    }, leaseMs + 10);
    record._leaseTimer.unref?.();
  }

  private publishRuntime(
    record: SessionRecord,
    availability: RuntimeStateUpdate["availability"],
    reason?: string,
    notify = true,
  ): RuntimeStateUpdate {
    const state: RuntimeStateUpdate = {
      availability,
      receivedAt: Date.now(),
      ...(record.proc?.hostInstanceId ? { hostInstanceId: record.proc.hostInstanceId } : {}),
      ...(record.snapshot
        ? {
            sessionEpoch: record.snapshot.sessionEpoch,
            snapshot: record.snapshot,
          }
        : {}),
      ...(record.leaseExpiresAt ? { leaseExpiresAt: record.leaseExpiresAt } : {}),
      ...(reason ? { reason } : {}),
    };
    if (notify) this.onRuntimeState(record.sessionId, state);
    return state;
  }

  private publishUnavailable(record: SessionRecord, reason: string): RuntimeStateUpdate {
    record.availability = "unavailable";
    // Preserve booleans in the last snapshot for diagnostics; selectors must
    // gate them on availability and therefore cannot mistake stale state for idle.
    return this.publishRuntime(record, "unavailable", reason);
  }

  private retireHostUi(record: SessionRecord): void {
    record._lifecycleUiLease = false;
    if (record._leaseTimer) clearTimeout(record._leaseTimer);
    record._leaseTimer = undefined;
    for (const pending of record._pendingUiAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    record._pendingUiAcks.clear();
    if (record._pendingRendererCancellation) {
      clearTimeout(record._pendingRendererCancellation.timer);
      record._pendingRendererCancellation.resolve(false);
      record._pendingRendererCancellation = undefined;
    }
    for (const operationId of record._pendingUiRequests.keys()) {
      this.onUiAcknowledged(record.sessionId, operationId);
    }
    record._pendingUiRequests.clear();
    record._openPanels.clear();
    record._panelCheckpoints.clear();
    record._panelInputSequence.clear();
    record._panelInputChains.clear();
  }

  private captureEditorRecovery(record: SessionRecord): void {
    const editor = record.snapshot?.editor;
    if (
      editor &&
      (editor.text !== "" || editor.conflictText !== undefined || editor.attachments.length > 0)
    ) {
      record._editorRecovery = structuredClone(editor);
    }
  }

  private async recoverEditorAfterRestart(record: SessionRecord, proc: SessionHost): Promise<void> {
    const recovery = record._editorRecovery;
    const initialBatch = record._deferredInitialBatch;
    if (!recovery || !initialBatch) return;
    const initial = initialBatch.terminalSnapshot.editor;
    const equal = JSON.stringify(initial) === JSON.stringify(recovery);
    if (!equal) {
      type EditorCandidate = { text: string; attachments: unknown[] };
      const storedCandidates = (editor: typeof recovery): EditorCandidate[] => [
        ...(editor.conflictText !== undefined
          ? [
              {
                text: editor.conflictText,
                attachments: editor.conflictAttachments ?? [],
              },
            ]
          : []),
        ...(editor.alternateConflictText !== undefined
          ? [
              {
                text: editor.alternateConflictText,
                attachments: editor.alternateConflictAttachments ?? [],
              },
            ]
          : []),
        ...(editor.additionalConflictCandidates ?? []),
      ];
      const deduplicateCandidates = (
        represented: EditorCandidate[],
        candidates: EditorCandidate[],
      ): EditorCandidate[] => {
        const seen = [...represented];
        const unique: EditorCandidate[] = [];
        for (const candidate of candidates) {
          if (
            seen.some(
              (existing) =>
                existing.text === candidate.text &&
                JSON.stringify(existing.attachments) === JSON.stringify(candidate.attachments),
            )
          )
            continue;
          seen.push(candidate);
          unique.push(candidate);
        }
        return unique;
      };
      let replacementState = initial;
      let restoredRevision: number | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const carriedCandidates = deduplicateCandidates(
          [
            { text: recovery.text, attachments: recovery.attachments },
            {
              text: replacementState.text,
              attachments: replacementState.attachments,
            },
          ],
          [...storedCandidates(recovery), ...storedCandidates(replacementState)],
        );
        const [carriedAlternate, ...carriedAdditional] = carriedCandidates;
        const restored = await proc.sendEditorPatch({
          baseRevision: replacementState.revision,
          revision: replacementState.revision + 1,
          text: recovery.text,
          attachments: recovery.attachments,
          ...(carriedAlternate
            ? {
                alternateConflictText: carriedAlternate.text,
                alternateConflictAttachments: carriedAlternate.attachments,
              }
            : {}),
          ...(carriedAdditional.length > 0
            ? { additionalConflictCandidates: carriedAdditional }
            : {}),
        });
        if (!restored.success) throw new Error(restored.error ?? "Editor recovery failed");
        const result = restored.data as
          | {
              accepted?: boolean;
              revision?: number;
              text?: string;
              attachments?: unknown[];
              conflictText?: string;
              conflictAttachments?: unknown[];
              alternateConflictText?: string;
              alternateConflictAttachments?: unknown[];
              additionalConflictCandidates?: Array<{
                text: string;
                attachments: unknown[];
              }>;
            }
          | undefined;
        if (result?.accepted === true && typeof result.revision === "number") {
          restoredRevision = result.revision;
          break;
        }
        if (
          typeof result?.revision !== "number" ||
          typeof result.text !== "string" ||
          !Array.isArray(result.attachments)
        ) {
          throw new Error("Invalid editor recovery response");
        }
        replacementState = {
          revision: result.revision,
          text: result.text,
          attachments: result.attachments,
          ...(result.conflictText !== undefined
            ? {
                conflictText: result.conflictText,
                conflictAttachments: result.conflictAttachments ?? [],
                ...(result.alternateConflictText !== undefined
                  ? {
                      alternateConflictText: result.alternateConflictText,
                      alternateConflictAttachments: result.alternateConflictAttachments ?? [],
                    }
                  : {}),
                ...(result.additionalConflictCandidates?.length
                  ? {
                      additionalConflictCandidates: result.additionalConflictCandidates,
                    }
                  : {}),
              }
            : {}),
        };
      }
      // If all retries conflict, the last rejected patch has already preserved
      // the recovery text/attachments in host conflict state. Keep that live
      // replacement instead of killing it and losing its canonical draft.
      if (restoredRevision !== undefined) {
        const candidates = deduplicateCandidates(
          [{ text: recovery.text, attachments: recovery.attachments }],
          [
            ...storedCandidates(recovery),
            ...(replacementState.text !== "" || replacementState.attachments.length > 0
              ? [
                  {
                    text: replacementState.text,
                    attachments: replacementState.attachments,
                  },
                ]
              : []),
            ...storedCandidates(replacementState),
          ],
        );
        const [primaryConflict, alternateConflict, ...additionalConflicts] = candidates;
        if (primaryConflict) {
          const review = await proc.sendEditorPatch({
            baseRevision: restoredRevision - 1,
            revision: restoredRevision + 1,
            text: primaryConflict.text,
            attachments: primaryConflict.attachments,
            ...(alternateConflict
              ? {
                  alternateConflictText: alternateConflict.text,
                  alternateConflictAttachments: alternateConflict.attachments,
                }
              : {}),
            ...(additionalConflicts.length > 0
              ? { additionalConflictCandidates: additionalConflicts }
              : {}),
          });
          if (
            !review.success ||
            (review.data as { accepted?: boolean } | undefined)?.accepted !== false
          )
            throw new Error(review.error ?? "Editor conflict recovery failed");
        }
      }
    }
    const snapshot = await proc.requestSnapshot();
    record._editorRecovery = undefined;
    record._deferredInitialBatch = undefined;
    this.installTransitionBatch(
      record,
      {
        ...initialBatch,
        provisionalEpoch: snapshot.sessionEpoch,
        terminalSnapshot: snapshot,
      },
      { allowInitial: true },
    );
  }

  /**
   * Receipt escrow is released only by a typed child terminal record with the
   * same owner and intent ID. This is deliberately the sole semantic peek in
   * main: it cannot interpret result/error/state or manufacture completion.
   */
  private settleDispatchEscrowFromFrame(record: SessionRecord, frame: AuthorityFrame): void {
    for (const item of frame.records) {
      if (item.type !== "intent_outcome") continue;
      const outcome = item.outcome;
      const escrowKey = `${outcome.owner.hostInstanceId}\0${outcome.owner.sessionEpoch}\0${outcome.intentId}`;
      const retained = record._retainedDispatchIntents.get(escrowKey);
      if (!retained) continue;
      const expected = retained.envelope.expectedOwner;
      if (
        expected.hostInstanceId === outcome.owner.hostInstanceId &&
        expected.sessionEpoch === outcome.owner.sessionEpoch &&
        retained.envelope.intentId === outcome.intentId
      ) {
        record._retainedDispatchIntents.delete(escrowKey);
      }
    }
  }

  private publishDispatchFailureEscrow(
    record: SessionRecord,
    proc: SessionHost,
    reason: string,
  ): void {
    for (const [escrowKey, retained] of record._retainedDispatchIntents) {
      const owner = retained.envelope.expectedOwner;
      if (
        owner.hostInstanceId !== proc.hostInstanceId ||
        owner.sessionEpoch !== proc.sessionEpoch ||
        retained.recoveryPublished
      )
        continue;
      retained.deliveryUnknown = true;
      retained.recoveryPublished = true;
      // This is review/failure escrow, never a replay queue and never a
      // synthesized success/end outcome. Its payload remains opaque to main.
      const restorationId = `ambiguous-intent:${owner.hostInstanceId}:${owner.sessionEpoch}:${retained.envelope.intentId}`;
      if (record._restorations.has(restorationId)) continue;
      const intent = retained.envelope.intent;
      // An admitted submit may have crossed Pi before the child dies. Its
      // original envelope is the only lossless custody source: never replace
      // it with a generic command marker or attempt a successor replay.
      const restoration: RuntimeRecord & { type: "queue_restoration" } =
        intent.kind === "submit"
          ? {
              type: "queue_restoration",
              restorationId,
              ...reviewQueues({
                intentId: retained.envelope.intentId,
                expectedHostId: owner.hostInstanceId,
                expectedEpoch: owner.sessionEpoch,
                editorRevision: intent.editorRevision,
                text: intent.text,
                images: structuredClone(intent.images),
                requestedMode: intent.requestedMode,
                surface: intent.surface,
              }),
              originalAttachments: [
                {
                  intentId: retained.envelope.intentId,
                  images: structuredClone(intent.images),
                },
              ],
              certainty: "unknown",
            }
          : {
              type: "queue_restoration",
              restorationId,
              steering: [],
              followUp: [],
              originalAttachments: [],
              commandDescription: `Intent ${retained.envelope.intentId} has outcome_unknown because its owning host failed: ${reason}`,
              certainty: "unknown",
            };
      record._restorations.set(restorationId, structuredClone(restoration));
      this.queueRestoration(record, restoration);
      // Keep the entry as a tombstone. A successor is never allowed to replay
      // it and an old delayed frame cannot clear a new owner's escrow.
      record._retainedDispatchIntents.set(escrowKey, retained);
    }
  }

  private handleRuntimeFailure(record: SessionRecord, proc: SessionHost, reason: string): void {
    if (record.proc !== proc) return;
    this.captureEditorRecovery(record);
    if (record._hostTransition)
      this.abortTransitionLock(record, record._hostTransition.transitionId);
    record.proc = undefined;
    this.retireHostUi(record);
    record._procReady = false;
    proc.stop();
    record.status = "failed";
    record.error = reason;
    this.publishDispatchFailureEscrow(record, proc, reason);
    for (const retained of record._retainedIntents.values()) {
      const recoverable =
        ["in_custody", "consumed", "outcome_unknown"].includes(retained.disposition) ||
        (retained.disposition === "completed" && retained.queuedAtAdmission === true);
      if (!recoverable) continue;
      retained.disposition = "outcome_unknown";
      retained.updatedAt = Date.now();
      if (retained.recoveryPublished) continue;
      retained.recoveryPublished = true;
      const payload = retained.payload;
      const restoration: RuntimeRecord & { type: "queue_restoration" } = {
        type: "queue_restoration",
        restorationId: `ambiguous-submission:${payload.intentId}`,
        ...reviewQueues(payload),
        originalAttachments: [{ intentId: payload.intentId, images: payload.images }],
        certainty: "unknown",
      };
      if (!record._restorations.has(restoration.restorationId)) {
        record._restorations.set(restoration.restorationId, structuredClone(restoration));
        this.queueRestoration(record, restoration);
      }
      this.onSubmission(record.sessionId, {
        intentId: payload.intentId,
        hostInstanceId: payload.expectedHostId,
        sessionEpoch: payload.expectedEpoch,
        editorRevision: payload.editorRevision,
        disposition: "outcome_unknown",
        message: "Host failed after custody; review the retained submission before retrying",
      });
    }
    // A unified request belongs to the host identity that emitted it. If that
    // host dies before the renderer response, never execute it against a
    // replacement host. Convert its text into an explicit review-required
    // restoration instead.
    for (const pending of [...record._pendingUnifiedSubmits.values()]) {
      if (pending.claimedGeneration !== undefined) {
        this.retireUnifiedAsAmbiguous(
          record,
          pending,
          "Unified submission may have executed before host acknowledgement was lost",
          false,
        );
        continue;
      }
      const restoration: RuntimeRecord & { type: "queue_restoration" } = {
        type: "queue_restoration",
        restorationId: `interrupted-unified:${pending.id}`,
        steering: [],
        followUp: [pending.text],
        originalAttachments: [],
        certainty: "not_processed",
      };
      record._restorations.set(restoration.restorationId, structuredClone(restoration));
      this.queueRestoration(record, restoration);
      record._pendingUnifiedSubmits.delete(pending.id);
    }
    this.publishUnavailable(record, reason);
    this.onPanelEvent(record.sessionId, { type: "panel_clear_all" });
    this.onPanelEvent(record.sessionId, { type: "unified_panel_reset" });
    this.onStatusChanged(record.sessionId, "failed", reason);

    const now = Date.now();
    const rapid = now - (record._lastFailureAt ?? 0) < RAPID_FAILURE_WINDOW_MS;
    record._lastFailureAt = now;
    record._rapidFailureCount = rapid ? record._rapidFailureCount + 1 : 1;
    if (record._rapidFailureCount > 1 || record._dead || !record._piPath) {
      this.releaseLock(record);
      return;
    }
    queueMicrotask(() => {
      if (record._dead || record.proc || record._activating) return;
      void this.activateSession(record.sessionId, record._piPath as string, record._env).catch(
        () => {},
      );
    });
  }

  /**
   * Forward an opaque, owner-bound intent to the child controller. Main only
   * fences renderer/session transport ownership; it never interprets intent
   * kinds, Pi liveness, or terminal outcomes.
   */
  async dispatchIntent(envelope: IntentEnvelope): Promise<IntentReceipt> {
    if (
      !envelope ||
      typeof envelope.sessionId !== "string" ||
      envelope.sessionId.length === 0 ||
      typeof envelope.intentId !== "string" ||
      envelope.intentId.length === 0 ||
      !Number.isInteger(envelope.rendererGeneration) ||
      envelope.rendererGeneration < 0 ||
      !envelope.expectedOwner ||
      typeof envelope.expectedOwner.hostInstanceId !== "string" ||
      envelope.expectedOwner.hostInstanceId.length === 0 ||
      !Number.isInteger(envelope.expectedOwner.sessionEpoch) ||
      envelope.expectedOwner.sessionEpoch < 0 ||
      !envelope.intent ||
      typeof envelope.intent !== "object"
    ) {
      throw new Error("Invalid intent envelope");
    }

    const sessionId = envelope.sessionId as SessionId;
    const record = this.sessions.get(sessionId);
    const notAdmitted = (
      reason: Extract<IntentReceipt, { status: "not_admitted" }>["reason"],
    ): IntentReceipt => ({
      status: "not_admitted",
      intentId: envelope.intentId,
      reason,
    });
    if (!record) return notAdmitted("stale_owner");
    if (envelope.rendererGeneration !== record._rendererGeneration) return notAdmitted("invalid");
    if (record._closing) return notAdmitted("closing");
    if (record._hostTransition || record.availability === "transitioning") {
      return notAdmitted("transitioning");
    }
    if (
      !record.proc ||
      !record._procReady ||
      record.status !== "ready" ||
      record._dead ||
      record.availability !== "available"
    ) {
      return notAdmitted("transport_unavailable");
    }
    if (
      record.proc.hostInstanceId !== envelope.expectedOwner.hostInstanceId ||
      record.proc.sessionEpoch !== envelope.expectedOwner.sessionEpoch
    ) {
      return notAdmitted("stale_owner");
    }

    this.markActivationVisitInteracted(record);
    const proc = record.proc;
    const escrowKey = `${envelope.expectedOwner.hostInstanceId}\0${envelope.expectedOwner.sessionEpoch}\0${envelope.intentId}`;
    // Install this before invoking child IPC: a send can cross the child
    // boundary before its acknowledgement is lost.
    const retained: RetainedDispatchIntent = {
      envelope: structuredClone(envelope),
      possibleDispatch: true,
      sessionFileOffsetAtDispatch: this.sessionFileOffset(record),
    };
    record._retainedDispatchIntents.set(escrowKey, retained);
    record._mutationSequence++;
    const {
      sessionId: _sessionId,
      rendererGeneration: _rendererGeneration,
      ...childEnvelope
    } = envelope;
    try {
      // SessionHost deliberately has a transport-only receipt shape; this
      // shared cast preserves the renderer IPC contract without inspecting the
      // child-owned semantic payload.
      const receipt = (await proc.dispatchIntent(childEnvelope)) as IntentReceipt;
      if (receipt.status === "delivery_unknown") {
        retained.deliveryUnknown = true;
        return receipt;
      }
      // A receipt proves only admission/deduplication. Keep owner-bound
      // transport escrow until the matching terminal authority frame arrives.
      // `not_admitted` is the only receipt that proves no child outcome exists.
      if (receipt.status === "not_admitted") record._retainedDispatchIntents.delete(escrowKey);
      return receipt;
    } catch {
      // Never retry or reinterpret a possible dispatch. Keep owner-scoped
      // evidence so it cannot silently migrate to a replacement host.
      retained.deliveryUnknown = true;
      return {
        status: "delivery_unknown",
        intentId: envelope.intentId,
        owner: envelope.expectedOwner,
      };
    }
  }

  /**
   * Explicitly test-only real-child controls. IPC calls this only when
   * PIVIS_TEST_REAL_HOST_CONTROL=1; keeping the guard here makes accidental
   * in-process callers fail closed too. Replacement stays entirely inside the
   * real child authority. Kill waits for one bounded restart/terminal state,
   * so E2E never needs to race CDP against Electron process teardown.
   */
  async testControl(
    sessionId: SessionId,
    action: "replacement" | "kill",
    timeoutMs = 10_000,
  ): Promise<
    | { status: "replacement" | "restarted" | "terminal" | "timeout"; owner?: RuntimeIdentity }
    | { status: "disabled" | "unavailable" }
  > {
    if (process.env.PIVIS_TEST_REAL_HOST_CONTROL !== "1") return { status: "disabled" };
    const record = this.sessions.get(sessionId);
    const proc = record?.proc;
    if (!record || !proc || !record._procReady || record.status !== "ready") {
      return { status: "unavailable" };
    }
    if (action === "replacement") {
      // SessionHost validates the response envelope against its live runtime
      // identity. The terminal frame can race behind that response, so callers
      // must attach for the baseline rather than incorrectly treating the
      // ordinary independent-IPC ordering as a terminal failure.
      return { status: "replacement", owner: await proc.testControl("replacement") };
    }

    proc.killForTests();
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 250), 15_000);
    while (Date.now() < deadline) {
      if (record.proc && record.proc !== proc && record._procReady && record.status === "ready") {
        const snapshot = record.snapshot;
        if (snapshot) {
          return {
            status: "restarted",
            owner: {
              hostInstanceId: snapshot.hostInstanceId,
              sessionEpoch: snapshot.sessionEpoch,
            },
          };
        }
      }
      if (!record.proc && (record.error !== undefined || record._dead))
        return { status: "terminal" };
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    return { status: "timeout" };
  }

  /**
   * Execute one owner-bound read-only host query. Query responses are opaque:
   * registry only correlates transport ownership and never retries a callback.
   */
  async query(envelopeInput: SessionQueryEnvelope): Promise<SessionQueryResult> {
    const parsed = SessionQueryEnvelopeSchema.safeParse(envelopeInput);
    if (!parsed.success) throw new Error(`Invalid session query: ${parsed.error.message}`);
    const envelope = parsed.data;
    const sessionId = envelope.sessionId as SessionId;
    const expected = envelope.expectedOwner;
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);

    const stable = await this.awaitStableRuntime(record, expected, 2_000);
    if (stable !== "ready") return { status: stable };
    const proc = record.proc!;
    try {
      const response = await proc.query(commandForSessionQuery(envelope.query));
      if (this.sessions.get(sessionId) !== record || record.proc !== proc) {
        return { status: "superseded", reason: "process_replaced" };
      }
      const after = await this.awaitStableRuntime(record, expected, 0);
      if (after !== "ready") return { status: after };
      return {
        status: "ok",
        queryId: envelope.queryId,
        owner: expected,
        queryType: envelope.query.type,
        response,
      };
    } catch (error) {
      // A child disappearing during a read is an expected lifecycle boundary.
      const after = await this.awaitStableRuntime(record, expected, 0);
      if (after !== "ready") return { status: after };
      throw error;
    }
  }

  private async awaitStableRuntime(
    record: SessionRecord,
    expected: RuntimeIdentity,
    timeoutMs: number,
  ): Promise<"ready" | "superseded" | "transitioning" | "unavailable"> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.sessions.get(record.sessionId) !== record) return "superseded";
      // An owner mismatch cannot be repaired by waiting; the caller's read is
      // fenced to that exact runtime identity.
      if (
        record.proc &&
        !this.matchesExpectedRuntime(record, expected.hostInstanceId, expected.sessionEpoch)
      ) {
        return "superseded";
      }
      if (record._closing || record._dead || record.status === "failed") return "unavailable";
      if (
        record.proc &&
        record._procReady &&
        record.status === "ready" &&
        record.availability === "available" &&
        !record._hostTransition
      ) {
        return "ready";
      }
      if (Date.now() >= deadline) {
        // Cold/dead hosts are unavailable; a host merely settling a normal
        // transition/readiness boundary is retryable.
        return !record.proc || record._dead || record._closing ? "unavailable" : "transitioning";
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(25, deadline - Date.now())),
      );
    }
  }

  async submit(
    sessionId: SessionId,
    submissionInput: SessionSubmission,
  ): Promise<SubmissionResult> {
    const record = this.sessions.get(sessionId);
    const parsed = SessionSubmissionSchema.safeParse(submissionInput);
    if (!parsed.success) throw new Error(`Invalid submission: ${parsed.error.message}`);
    this.markActivationVisitInteracted(record);
    const submission = parsed.data;
    const rejectBeforeDispatch = (message: string): SubmissionResult => {
      const result: SubmissionResult = {
        intentId: submission.intentId,
        hostInstanceId: submission.expectedHostId,
        sessionEpoch: submission.expectedEpoch,
        editorRevision: submission.editorRevision,
        disposition: "not_submitted",
        message,
      };
      if (record) this.onSubmission(sessionId, result);
      return result;
    };
    if (record?._expiredUnifiedIntents.has(submission.intentId)) {
      const result: SubmissionResult = {
        intentId: submission.intentId,
        hostInstanceId: submission.expectedHostId,
        sessionEpoch: submission.expectedEpoch,
        editorRevision: submission.editorRevision,
        disposition: "outcome_unknown",
        message: "Unified action claim expired before a safe settlement boundary",
      };
      this.onSubmission(sessionId, result);
      return result;
    }
    if (record?._closing) {
      return rejectBeforeDispatch("Session close preparation is in progress");
    }
    if (!record?.proc || !record._procReady) {
      return rejectBeforeDispatch(`No active SDK host for session ${sessionId}`);
    }
    if (record.availability !== "available") {
      return rejectBeforeDispatch(
        `Session runtime is ${record.availability}; submission was not dispatched`,
      );
    }
    if (
      submission.expectedHostId !== record.proc.hostInstanceId ||
      submission.expectedEpoch !== record.snapshot?.sessionEpoch
    ) {
      return rejectBeforeDispatch("Submission host identity or epoch is stale");
    }
    const prior = record._retainedIntents.get(submission.intentId);
    if (prior) {
      if (!isDeepStrictEqual(prior.payload, submission)) {
        return rejectBeforeDispatch("Submission intent was reused with a different payload");
      }
      const pending = record._pendingSubmissionPromises.get(submission.intentId);
      if (pending) return pending;
      if (prior.result) return structuredClone(prior.result);
      return rejectBeforeDispatch("Submission intent is already unresolved");
    }

    const retained: RetainedIntent = {
      payload: structuredClone(submission),
      // Once IPC dispatch begins the host may cross the consumption boundary
      // before its correlated response reaches main. Treat the unresolved
      // interval conservatively so host loss can never imply safe replay.
      disposition: "outcome_unknown",
      updatedAt: Date.now(),
    };
    record._retainedIntents.set(submission.intentId, retained);
    const admittedProc = record.proc;
    const ownerIsCurrent = (): boolean =>
      this.sessions.get(sessionId) === record &&
      !record._closing &&
      !record._dead &&
      record.proc === admittedProc &&
      admittedProc.hostInstanceId === submission.expectedHostId &&
      admittedProc.sessionEpoch === submission.expectedEpoch &&
      record.snapshot?.hostInstanceId === submission.expectedHostId &&
      record.snapshot.sessionEpoch === submission.expectedEpoch &&
      record.availability === "available" &&
      record._hostTransition === undefined;
    const settleUnknown = (
      message: string,
      publishRestoration: boolean,
      publishDisposition: boolean,
    ): SubmissionResult => {
      retained.disposition = "outcome_unknown";
      retained.updatedAt = Date.now();
      const result: SubmissionResult = {
        intentId: submission.intentId,
        hostInstanceId: submission.expectedHostId,
        sessionEpoch: submission.expectedEpoch,
        editorRevision: submission.editorRevision,
        disposition: "outcome_unknown",
        message,
      };
      retained.result = structuredClone(result);
      if (publishRestoration && !retained.recoveryPublished) {
        retained.recoveryPublished = true;
        const restorationId = `ambiguous-submission:${submission.intentId}`;
        const restoration: RuntimeRecord & { type: "queue_restoration" } = {
          type: "queue_restoration",
          restorationId,
          ...reviewQueues(submission),
          originalAttachments: [{ intentId: submission.intentId, images: submission.images }],
          certainty: "unknown",
        };
        record._restorations.set(restorationId, structuredClone(restoration));
        this.queueRestoration(record, restoration);
      }
      if (publishDisposition) this.onSubmission(sessionId, result);
      return result;
    };
    const operation = (async (): Promise<SubmissionResult> => {
      try {
        retained.sessionFileOffsetAtDispatch = this.sessionFileOffset(record);
        const result = await admittedProc.submit(submission);
        if (record._expiredUnifiedIntents.has(submission.intentId)) {
          return (
            retained.result ?? {
              intentId: submission.intentId,
              hostInstanceId: submission.expectedHostId,
              sessionEpoch: submission.expectedEpoch,
              editorRevision: submission.editorRevision,
              disposition: "outcome_unknown",
              message: "Unified action claim expired before a safe settlement boundary",
            }
          );
        }
        if (!ownerIsCurrent()) {
          return settleUnknown(
            "Submission settled after its admitted runtime or session lifecycle was retired",
            this.sessions.get(sessionId) === record && !record._closing && !record._dead,
            false,
          );
        }
        retained.result = structuredClone(result);
        this.retainDisposition(record, result);
        this.onSubmission(sessionId, result);
        return result;
      } catch (error) {
        const currentOwner = ownerIsCurrent();
        return settleUnknown(
          `Submission may have crossed into Pi before acknowledgement was lost: ${error instanceof Error ? error.message : String(error)}`,
          this.sessions.get(sessionId) === record && !record._closing && !record._dead,
          currentOwner,
        );
      }
    })();
    record._pendingSubmissionPromises.set(submission.intentId, operation);
    void operation.finally(() => {
      if (record._pendingSubmissionPromises.get(submission.intentId) === operation) {
        record._pendingSubmissionPromises.delete(submission.intentId);
      }
      if (record._acknowledgedUnifiedIntents.delete(submission.intentId)) {
        record._expiredUnifiedIntents.delete(submission.intentId);
        record._retainedIntents.delete(submission.intentId);
      }
    });
    return operation;
  }

  private retireStaleSubmissionDisposition(
    record: SessionRecord,
    result: SubmissionResult,
    message: string,
  ): void {
    const retained = record._retainedIntents.get(result.intentId);
    if (!retained) return;
    const unknown: SubmissionResult = {
      intentId: result.intentId,
      hostInstanceId: retained.payload.expectedHostId,
      sessionEpoch: retained.payload.expectedEpoch,
      editorRevision: retained.payload.editorRevision,
      disposition: "outcome_unknown",
      message,
    };
    retained.disposition = "outcome_unknown";
    retained.result = structuredClone(unknown);
    retained.updatedAt = Date.now();
    if (retained.recoveryPublished) return;
    retained.recoveryPublished = true;
    const restorationId = `ambiguous-submission:${result.intentId}`;
    const restoration: RuntimeRecord & { type: "queue_restoration" } = {
      type: "queue_restoration",
      restorationId,
      ...reviewQueues(retained.payload),
      originalAttachments: [
        {
          intentId: retained.payload.intentId,
          images: retained.payload.images,
        },
      ],
      certainty: "unknown",
    };
    record._restorations.set(restorationId, structuredClone(restoration));
    this.queueRestoration(record, restoration);
  }

  private retainDisposition(record: SessionRecord, resultInput: SubmissionResult): void {
    const parsed = SubmissionResultSchema.safeParse(resultInput);
    if (!parsed.success) return;
    const result = parsed.data;
    if (
      result.hostInstanceId !== record.proc?.hostInstanceId ||
      result.sessionEpoch !== record.snapshot?.sessionEpoch
    )
      return;
    const retained = record._retainedIntents.get(result.intentId);
    if (!retained) return;
    retained.disposition = result.disposition;
    retained.updatedAt = Date.now();
    if (result.queued !== undefined) retained.queuedAtAdmission = result.queued;
    if (["not_submitted", "rejected"].includes(result.disposition)) {
      record._retainedIntents.delete(result.intentId);
    }
  }

  async escapeSession(
    sessionId: SessionId,
    requestId: string,
    expected: { hostInstanceId: string; sessionEpoch: number },
  ): Promise<EscapeResult> {
    const record = this.sessions.get(sessionId);
    this.markActivationVisitInteracted(record);
    const base = {
      requestId,
      hostInstanceId: expected.hostInstanceId,
      sessionEpoch: expected.sessionEpoch,
    };
    if (
      !record?.proc ||
      !record._procReady ||
      record.status !== "ready" ||
      record.availability !== "available" ||
      record._hostTransition ||
      !this.matchesExpectedRuntime(record, expected.hostInstanceId, expected.sessionEpoch)
    ) {
      return {
        ...base,
        disposition: "not_applicable",
        message: "Session changed or became unavailable before interrupt dispatch",
      };
    }
    const proc = record.proc;
    try {
      const result = await proc.escape(requestId);
      if (
        this.sessions.get(sessionId) !== record ||
        record._closing ||
        record._dead ||
        record.availability !== "available" ||
        record._hostTransition !== undefined ||
        record.proc !== proc ||
        !this.matchesExpectedRuntime(record, expected.hostInstanceId, expected.sessionEpoch)
      ) {
        return {
          ...base,
          disposition: "outcome_unknown",
          message: "Session changed before interrupt acknowledgement",
        };
      }
      return result;
    } catch (error) {
      return {
        ...base,
        disposition: "outcome_unknown",
        message: `Interrupt may have reached Pi before acknowledgement was lost: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async resyncSession(sessionId: SessionId): Promise<RuntimeStateUpdate> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    if (!record.proc || !record._procReady)
      return this.publishUnavailable(record, "Runtime unavailable");
    const proc = record.proc;
    try {
      const snapshot = await proc.requestSnapshot();
      if (
        this.sessions.get(sessionId) !== record ||
        record._closing ||
        record._dead ||
        record.proc !== proc ||
        !record._procReady
      ) {
        return this.publishUnavailable(
          record,
          "Session lifecycle changed before runtime resynchronization completed",
        );
      }
      this.installSnapshot(record, snapshot);
      return this.publishRuntime(record, record.availability);
    } catch (error) {
      if (
        this.sessions.get(sessionId) !== record ||
        record._closing ||
        record._dead ||
        record.proc !== proc
      ) {
        return this.publishUnavailable(
          record,
          "Session lifecycle changed before runtime resynchronization completed",
        );
      }
      return this.publishUnavailable(
        record,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private clearUnifiedClaimTimer(record: SessionRecord, id: string): void {
    const timer = record._unifiedClaimTimers.get(id);
    if (timer) clearTimeout(timer);
    record._unifiedClaimTimers.delete(id);
  }

  private retireUnifiedAsAmbiguous(
    record: SessionRecord,
    pending: PendingUnifiedSubmit,
    message: string,
    sendHostResponse: boolean,
  ): void {
    this.clearUnifiedClaimTimer(record, pending.id);
    const restorationId = `ambiguous-unified:${pending.id}`;
    if (!record._restorations.has(restorationId)) {
      const restoration: RuntimeRecord & { type: "queue_restoration" } = {
        type: "queue_restoration",
        restorationId,
        steering: [],
        followUp: [],
        originalAttachments: [],
        commandDescription: `${message}: ${pending.text}`,
        certainty: "unknown",
      };
      record._restorations.set(restorationId, structuredClone(restoration));
      this.queueRestoration(record, restoration);
    }
    record._unifiedRestorationIntents.set(restorationId, pending.submissionIntentId);
    record._expiredUnifiedIntents.add(pending.submissionIntentId);
    record._retiredUnifiedRequests.add(
      `${pending.hostInstanceId}\0${pending.sessionEpoch}\0${pending.id}`,
    );
    const unknownResult: SubmissionResult = {
      intentId: pending.submissionIntentId,
      hostInstanceId: pending.hostInstanceId,
      sessionEpoch: pending.sessionEpoch,
      editorRevision: pending.editorRevision,
      disposition: "outcome_unknown",
      message,
    };
    const retained = record._retainedIntents.get(pending.submissionIntentId);
    if (retained) {
      retained.disposition = "outcome_unknown";
      retained.result = structuredClone(unknownResult);
      retained.updatedAt = Date.now();
      retained.recoveryPublished = true;
    } else {
      record._retainedIntents.set(pending.submissionIntentId, {
        payload: {
          intentId: pending.submissionIntentId,
          expectedHostId: pending.hostInstanceId,
          expectedEpoch: pending.sessionEpoch,
          editorRevision: pending.editorRevision,
          text: pending.text,
          images: [],
          requestedMode: "followUp",
          surface: "unified",
        },
        disposition: "outcome_unknown",
        result: structuredClone(unknownResult),
        updatedAt: Date.now(),
        recoveryPublished: true,
      });
    }
    if (
      sendHostResponse &&
      record.proc?.hostInstanceId === pending.hostInstanceId &&
      record.proc.sessionEpoch === pending.sessionEpoch
    ) {
      record.proc.sendUnifiedSubmitResponse(pending.id, false, false, message);
    }
    record._pendingUnifiedSubmits.delete(pending.id);
    record._mutationSequence++;
  }

  private expireUnifiedClaim(
    sessionId: SessionId,
    id: string,
    claimId: string,
    claimedGeneration: number,
  ): void {
    const record = this.sessions.get(sessionId);
    const pending = record?._pendingUnifiedSubmits.get(id);
    if (
      !record ||
      !pending ||
      pending.claimId !== claimId ||
      pending.claimedGeneration !== claimedGeneration
    )
      return;
    this.retireUnifiedAsAmbiguous(
      record,
      pending,
      "Unified action claim expired before renderer acknowledgement",
      true,
    );
  }

  /**
   * Route a child-owned frame without interpreting its semantic payload. The
   * host-frame transport is being rolled out independently, so this remains a
   * public registry seam until SessionHost exposes the new wire messages.
   */
  routeAuthorityPublication(sessionId: SessionId, publication: AuthorityPublication): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || !record.proc?.hostInstanceId) return false;
    const owner: RuntimeIdentity = {
      hostInstanceId: record.proc.hostInstanceId,
      sessionEpoch: record.proc.sessionEpoch,
    };
    if (
      publication.owner.hostInstanceId !== owner.hostInstanceId ||
      publication.owner.sessionEpoch !== owner.sessionEpoch
    ) {
      return false;
    }
    const router = this.authorityRouter(record);
    router.setExpectedOwner(owner);
    if (publication.plane === "semantic") {
      // Main remains opaque to intent semantics. It only releases transport
      // escrow when this owner supplies a terminal record for this intent.
      this.settleDispatchEscrowFromFrame(record, publication.payload);
      // Keep an acknowledgement mirror for frame-only custody. This does not
      // acknowledge or reinterpret it: the child keeps the authoritative copy
      // until the renderer explicitly dismisses this restoration.
      for (const item of publication.payload.records) {
        if (item.type === "queue_restoration" && !record._restorations.has(item.restorationId)) {
          record._restorations.set(item.restorationId, structuredClone(item));
          this.queueRestoration(record, item);
        }
      }
    }
    return router.route(publication);
  }

  /**
   * Return a child-serialized baseline plus the main-buffered contiguous tail.
   * The renderer-generation handshake remains separate while hosts without the
   * new frame endpoint continue on the compatibility channels.
   */
  async authorityAttach(
    sessionId: SessionId,
    generation: number,
  ): Promise<AuthorityAttachResponse> {
    const record = this.sessions.get(sessionId);
    if (!record || record._closing) {
      return { status: "unavailable", reason: "session_missing" };
    }
    const proc = record.proc as
      | (SessionHost & {
          requestAuthorityAttach?: (
            rendererGeneration: number,
          ) => Promise<AuthorityAttachBaselineResponse>;
        })
      | undefined;
    if (!proc?.hostInstanceId || !proc.requestAuthorityAttach) {
      return { status: "unavailable", reason: "host_cold" };
    }
    const runtimeIdentity = {
      proc,
      hostInstanceId: proc.hostInstanceId,
      sessionEpoch: proc.sessionEpoch,
    };
    const runtimeStillCurrent = (): boolean =>
      this.sessions.get(sessionId) === record &&
      !record._closing &&
      record.proc === runtimeIdentity.proc &&
      record.proc.hostInstanceId === runtimeIdentity.hostInstanceId &&
      record.proc.sessionEpoch === runtimeIdentity.sessionEpoch;
    const router = this.authorityRouter(record);
    router.setExpectedOwner({
      hostInstanceId: runtimeIdentity.hostInstanceId,
      sessionEpoch: runtimeIdentity.sessionEpoch,
    });
    let response: AuthorityAttachResponse;
    try {
      response = await router.attach(generation, () => proc.requestAuthorityAttach!(generation));
    } catch (error) {
      if (!runtimeStillCurrent()) {
        return { status: "unavailable", reason: "runtime_replaced" };
      }
      if (error instanceof HostRequestUnavailableError) {
        return { status: "unavailable", reason: "host_unresponsive" };
      }
      throw error;
    }
    if (!runtimeStillCurrent()) {
      return { status: "unavailable", reason: "runtime_replaced" };
    }
    // Frames emitted while detached are intentionally not routed, so seed the
    // main acknowledgement mirror from the child-serialized baseline. This is
    // not a delivery acknowledgement; the child retains every item until the
    // renderer later calls acknowledgeRestoration.
    if (response.status === "ready") {
      for (const restoration of response.baseline.restorations) {
        if (!record._restorations.has(restoration.restorationId)) {
          record._restorations.set(restoration.restorationId, structuredClone(restoration));
          this.queueRestoration(record, restoration);
        } else {
          this.emitResolvedRestoration(record, restoration.restorationId);
        }
      }
    }
    return response;
  }

  private authorityRouter(record: SessionRecord): RendererPublicationRouter {
    const options =
      this.options.authorityPublicationBufferLimit === undefined
        ? {}
        : {
            maxBufferedPublications: this.options.authorityPublicationBufferLimit,
          };
    record._authorityPublications ??= new RendererPublicationRouter(
      record.sessionId,
      this.onAuthorityPublication,
      options,
    );
    return record._authorityPublications;
  }

  async rendererAttach(sessionId: SessionId, generation: number): Promise<RendererAttachResult> {
    const record = this.sessions.get(sessionId);
    if (!record) return { status: "unavailable", reason: "session_missing" };
    if (record._closing) return { status: "unavailable", reason: "session_closing" };
    if (generation < record._rendererGeneration) {
      return { status: "unavailable", reason: "attach_superseded" };
    }
    const attachProc = record.proc;
    if (!attachProc?.hostInstanceId) {
      return { status: "unavailable", reason: "host_cold" };
    }
    const runtimeIdentity = {
      proc: attachProc,
      hostInstanceId: attachProc.hostInstanceId,
      sessionEpoch: attachProc.sessionEpoch,
    };
    const runtimeStillCurrent = (): boolean =>
      this.sessions.get(sessionId) === record &&
      !record._closing &&
      record.proc === runtimeIdentity.proc &&
      record.proc.hostInstanceId === runtimeIdentity.hostInstanceId &&
      record.proc.sessionEpoch === runtimeIdentity.sessionEpoch;
    if (generation > record._rendererGeneration) {
      const priorGeneration = record._rendererGeneration;
      record._rendererGeneration = generation;
      if (priorGeneration > 0) {
        const cancellationProc = attachProc;
        const supersededCancellation = record._pendingRendererCancellation;
        if (supersededCancellation) {
          clearTimeout(supersededCancellation.timer);
          record._pendingRendererCancellation = undefined;
          supersededCancellation.resolve(false);
        }
        const acknowledged = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            if (record._pendingRendererCancellation?.generation === priorGeneration) {
              record._pendingRendererCancellation = undefined;
            }
            resolve(false);
          }, 2_000);
          timer.unref?.();
          record._pendingRendererCancellation = {
            generation: priorGeneration,
            resolve,
            timer,
          };
          cancellationProc.sendRendererDetached(priorGeneration);
        });
        if (!runtimeStillCurrent()) {
          return { status: "unavailable", reason: "runtime_replaced" };
        }
        if (record._rendererGeneration !== generation) {
          return { status: "unavailable", reason: "attach_superseded" };
        }
        if (!acknowledged) {
          return {
            status: "attached",
            runtime: this.publishUnavailable(
              record,
              "Renderer cancellation acknowledgement timed out",
            ),
          };
        }
        // The successor renderer has a fresh local input sequencer. The host
        // fenced the old revision before acknowledging detachment, so reset
        // main's cumulative gate at the same boundary.
        record._panelInputSequence.clear();
        record._panelInputChains.clear();
      }
    }
    for (const request of [...record._pendingUnifiedSubmits.values()]) {
      if (
        request.hostInstanceId !== record.proc?.hostInstanceId ||
        request.sessionEpoch !== record.proc.sessionEpoch
      )
        continue;
      if (
        request.claimedGeneration !== undefined &&
        request.claimedGeneration !== record._rendererGeneration
      ) {
        this.retireUnifiedAsAmbiguous(
          record,
          request,
          "Unified submission may have executed before renderer acknowledgement was lost",
          true,
        );
        continue;
      }
      if (request.claimedGeneration === undefined) {
        this.onUnifiedSubmitRequest(sessionId, structuredClone(request));
      }
    }
    for (const [intentId, retained] of record._retainedIntents) {
      this.onSubmission(sessionId, {
        intentId,
        hostInstanceId:
          record.proc?.hostInstanceId ?? record.snapshot?.hostInstanceId ?? "unavailable",
        sessionEpoch: record.snapshot?.sessionEpoch ?? 0,
        editorRevision: retained.payload.editorRevision,
        disposition: retained.disposition,
        ...(retained.disposition === "outcome_unknown"
          ? {
              message:
                "The prior renderer lost contact before this operation reached a safe boundary",
            }
          : {}),
      });
    }
    // Reinstall panel metadata, never a retained ANSI delta as a keyframe.
    // Mounting issues a forced public pi-tui repaint before input can flow.
    for (const panel of record._openPanels.values()) {
      if (panel.type !== "panel_open") continue;
      this.onPanelEvent(sessionId, {
        ...structuredClone(panel),
        baseline: { revision: 1, repaintRequired: true },
      });
    }
    for (const restoration of record._restorations.values()) {
      this.queueRestoration(record, structuredClone(restoration));
    }
    if (!runtimeStillCurrent()) {
      return { status: "unavailable", reason: "runtime_replaced" };
    }
    if (record._rendererGeneration !== generation) {
      return { status: "unavailable", reason: "attach_superseded" };
    }
    try {
      const runtime = await this.resyncSession(sessionId);
      if (!runtimeStillCurrent()) {
        return { status: "unavailable", reason: "runtime_replaced" };
      }
      if (record._rendererGeneration !== generation) {
        return { status: "unavailable", reason: "attach_superseded" };
      }
      return { status: "attached", runtime };
    } catch (error) {
      if (!runtimeStillCurrent()) {
        return { status: "unavailable", reason: "runtime_replaced" };
      }
      if (record._rendererGeneration !== generation) {
        return { status: "unavailable", reason: "attach_superseded" };
      }
      if (error instanceof HostRequestUnavailableError) {
        return { status: "unavailable", reason: "host_unresponsive" };
      }
      throw error;
    }
  }

  acknowledgeRestoration(sessionId: SessionId, restorationId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    this.markActivationVisitInteracted(record);
    const acknowledged = record._restorations.delete(restorationId);
    if (acknowledged) {
      record._resolvedRestorationInstructions.delete(restorationId);
      // Main mirrors child-owned restoration custody for legacy delivery, but
      // only an explicit renderer acknowledgement may retire the child copy.
      record.proc?.acknowledgeRestoration(restorationId);
      const ambiguousIntentPrefix = "ambiguous-submission:";
      if (restorationId.startsWith(ambiguousIntentPrefix)) {
        record._retainedIntents.delete(restorationId.slice(ambiguousIntentPrefix.length));
      }
      const unifiedIntentId = record._unifiedRestorationIntents.get(restorationId);
      if (unifiedIntentId) {
        record._unifiedRestorationIntents.delete(restorationId);
        if (record._pendingSubmissionPromises.has(unifiedIntentId)) {
          // Review acknowledgement retires UI custody, not an unresolved host
          // operation. Keep the tombstone until that promise settles so its
          // late result can never escape the ambiguity fence.
          record._acknowledgedUnifiedIntents.add(unifiedIntentId);
        } else {
          record._expiredUnifiedIntents.delete(unifiedIntentId);
          record._retainedIntents.delete(unifiedIntentId);
        }
      }
      record._mutationSequence++;
    }
    return acknowledged;
  }

  claimUnifiedSubmit(
    sessionId: SessionId,
    id: string,
    rendererGeneration: number,
    expected: { hostInstanceId: string; sessionEpoch: number },
  ): { claimed: false } | { claimed: true; claimId: string; expiresAt: number } {
    const record = this.sessions.get(sessionId);
    this.markActivationVisitInteracted(record);
    const pending = record?._pendingUnifiedSubmits.get(id);
    if (
      !record ||
      !pending ||
      record._closing ||
      record._rendererGeneration !== rendererGeneration ||
      record.availability !== "available" ||
      pending.hostInstanceId !== expected.hostInstanceId ||
      pending.sessionEpoch !== expected.sessionEpoch ||
      record.proc?.hostInstanceId !== expected.hostInstanceId ||
      record.proc.sessionEpoch !== expected.sessionEpoch ||
      pending.claimedGeneration !== undefined
    ) {
      return { claimed: false };
    }
    const claimId = crypto.randomUUID();
    const timeoutMs = Math.max(
      1,
      this.options.unifiedClaimTimeoutMs ?? DEFAULT_UNIFIED_CLAIM_TIMEOUT_MS,
    );
    const expiresAt = Date.now() + timeoutMs;
    pending.claimedGeneration = rendererGeneration;
    pending.claimId = claimId;
    pending.claimExpiresAt = expiresAt;
    const timer = setTimeout(
      () => this.expireUnifiedClaim(sessionId, id, claimId, rendererGeneration),
      timeoutMs,
    );
    timer.unref?.();
    record._unifiedClaimTimers.set(id, timer);
    record._mutationSequence++;
    return { claimed: true, claimId, expiresAt };
  }

  respondToUnifiedSubmit(
    sessionId: SessionId,
    id: string,
    claim: { rendererGeneration: number; claimId: string },
    expected: { hostInstanceId: string; sessionEpoch: number },
    result: { ok: boolean; bailed?: boolean; error?: string },
  ): { accepted: boolean } {
    const record = this.sessions.get(sessionId);
    if (record?._closing) throw new Error("Session close preparation is in progress");
    const pending = record?._pendingUnifiedSubmits.get(id);
    if (!record || !pending) return { accepted: false };
    const claimMatches =
      pending.claimedGeneration === claim.rendererGeneration &&
      pending.claimId === claim.claimId &&
      record._rendererGeneration === claim.rendererGeneration &&
      (pending.claimExpiresAt ?? 0) > Date.now();
    if (!claimMatches) return { accepted: false };
    const identityMatches =
      pending.hostInstanceId === expected.hostInstanceId &&
      pending.sessionEpoch === expected.sessionEpoch &&
      record.proc?.hostInstanceId === expected.hostInstanceId &&
      record.proc.sessionEpoch === expected.sessionEpoch &&
      record.availability === "available";
    if (!identityMatches) {
      this.retireUnifiedAsAmbiguous(
        record,
        pending,
        "Unified submission may have executed before acknowledgement was lost",
        false,
      );
      return { accepted: false };
    }
    record._mutationSequence++;
    record.proc?.sendUnifiedSubmitResponse(id, result.ok, result.bailed, result.error);
    record._retiredUnifiedRequests.add(
      `${pending.hostInstanceId}\0${pending.sessionEpoch}\0${pending.id}`,
    );
    this.clearUnifiedClaimTimer(record, id);
    record._pendingUnifiedSubmits.delete(id);
    return { accepted: true };
  }

  private awaitUiAcknowledgement(
    record: SessionRecord,
    operationId: string,
    sendOperation: () => void,
  ): Promise<boolean> {
    const prior = record._pendingUiAcks.get(operationId);
    if (prior) return prior.promise;
    let resolvePromise: (value: boolean) => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });
    const timer = setTimeout(() => {
      record._pendingUiAcks.delete(operationId);
      if (this.sessions.get(record.sessionId) === record && !record._closing && !record._dead) {
        this.publishUnavailable(record, `UI acknowledgement timed out: ${operationId}`);
      }
      resolvePromise(false);
    }, 2_000);
    timer.unref?.();
    record._pendingUiAcks.set(operationId, {
      promise,
      resolve: resolvePromise,
      timer,
    });
    sendOperation();
    return promise;
  }

  /** Fence main-only effects to the authority that produced their typed outcome. */
  isCurrentOwner(sessionId: SessionId, owner: RuntimeIdentity): boolean {
    const record = this.sessions.get(sessionId);
    return Boolean(
      record &&
        !record._closing &&
        !record._dead &&
        record.availability === "available" &&
        !record._hostTransition &&
        this.matchesExpectedRuntime(record, owner.hostInstanceId, owner.sessionEpoch),
    );
  }

  private matchesExpectedRuntime(
    record: SessionRecord | undefined,
    hostInstanceId: string,
    sessionEpoch: number,
  ): record is SessionRecord & { proc: SessionHost } {
    return Boolean(
      record?.proc &&
        record.proc.hostInstanceId === hostInstanceId &&
        record.proc.sessionEpoch === sessionEpoch,
    );
  }

  async respondToUiRequest(
    sessionId: SessionId,
    rendererGeneration: number,
    expectedHostInstanceId: string,
    expectedSessionEpoch: number,
    operationId: string,
    response: ExtensionUiResponse,
  ): Promise<boolean> {
    const record = this.sessions.get(sessionId);
    if (record?._closing) throw new Error("Session close preparation is in progress");
    this.markActivationVisitInteracted(record);
    if (
      !this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch) ||
      rendererGeneration !== record._rendererGeneration
    )
      return false;
    const proc = record.proc;
    const admittedTransitionId = record._hostTransition?.transitionId;
    record._mutationSequence++;
    const acknowledged = await this.awaitUiAcknowledgement(record, operationId, () => {
      proc.sendUiResponse(JSON.stringify(response));
    });
    const ownerIsCurrent =
      this.sessions.get(sessionId) === record &&
      !record._closing &&
      !record._dead &&
      record.proc === proc &&
      rendererGeneration === record._rendererGeneration &&
      this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch) &&
      record._hostTransition?.transitionId === admittedTransitionId;
    if (acknowledged && ownerIsCurrent) record._mutationSequence++;
    return acknowledged && ownerIsCurrent;
  }

  async closePanel(
    sessionId: SessionId,
    expectedHostInstanceId: string,
    expectedSessionEpoch: number,
    panelId: number,
    operationId: string,
  ): Promise<boolean> {
    const record = this.sessions.get(sessionId);
    if (record?._closing) throw new Error("Session close preparation is in progress");
    this.markActivationVisitInteracted(record);
    if (!this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch))
      return false;
    const proc = record.proc;
    const admittedTransitionId = record._hostTransition?.transitionId;
    record._mutationSequence++;
    const acknowledged = await this.awaitUiAcknowledgement(record, operationId, () => {
      proc.sendPanelClose(panelId, operationId);
    });
    const ownerIsCurrent =
      this.sessions.get(sessionId) === record &&
      !record._closing &&
      !record._dead &&
      record.proc === proc &&
      this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch) &&
      record._hostTransition?.transitionId === admittedTransitionId;
    if (acknowledged && ownerIsCurrent) record._mutationSequence++;
    return acknowledged && ownerIsCurrent;
  }

  async applyEditorPatch(
    sessionId: SessionId,
    expectedHostInstanceId: string,
    expectedSessionEpoch: number,
    patch: {
      baseRevision: number;
      revision: number;
      text: string;
      attachments: unknown[];
    },
  ): Promise<{
    accepted: boolean;
    revision: number;
    text: string;
    attachments: unknown[];
    conflictText?: string;
    conflictAttachments?: unknown[];
    rejection?: "runtime_unavailable" | "runtime_replaced";
  }> {
    const rejected = (rejection: "runtime_unavailable" | "runtime_replaced") => {
      const editor = this.sessions.get(sessionId)?.snapshot?.editor;
      return {
        accepted: false,
        revision: editor?.revision ?? patch.baseRevision,
        text: editor?.text ?? "",
        attachments: editor?.attachments ?? [],
        rejection,
      };
    };
    const record = this.sessions.get(sessionId);
    // Editor synchronization is deliberately optimistic and can overlap /new,
    // reload, or a respawn. Those owner transitions are an expected rejection,
    // never an Electron handler exception.
    if (record?._closing) return rejected("runtime_unavailable");
    this.markActivationVisitInteracted(record);
    if (!this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch))
      return rejected("runtime_replaced");
    if (
      !record._procReady ||
      record.availability !== "available" ||
      record._hostTransition !== undefined
    )
      return rejected("runtime_unavailable");
    const admittedProc = record.proc;
    record._mutationSequence++;
    const response = await admittedProc.sendEditorPatch(patch);
    if (
      this.sessions.get(sessionId) !== record ||
      record._closing ||
      record._dead ||
      record.proc !== admittedProc ||
      !this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch) ||
      record.availability !== "available" ||
      record._hostTransition !== undefined
    )
      return rejected("runtime_replaced");
    if (!response.success || !response.data)
      throw new Error(response.error ?? "Editor patch failed");
    if ((response.data as { accepted?: boolean }).accepted) record._mutationSequence++;
    return response.data as {
      accepted: boolean;
      revision: number;
      text: string;
      attachments: unknown[];
      conflictText?: string;
      conflictAttachments?: unknown[];
    };
  }

  async sendPanelInput(
    sessionId: SessionId,
    expectedHostInstanceId: string,
    expectedSessionEpoch: number,
    panelId: number,
    revision: number,
    sequence: number,
    data: string,
  ): Promise<{
    acknowledgedThrough: number;
    gap?: { expected: number; received: number };
    repaintRequired?: { revision: number; repaintRequired: boolean };
  }> {
    const record = this.sessions.get(sessionId);
    if (record?._closing) throw new Error("Session close preparation is in progress");
    this.markActivationVisitInteracted(record);
    if (!this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch))
      return { acknowledgedThrough: 0 };
    const prior =
      record._panelInputChains.get(panelId) ?? Promise.resolve({ acknowledgedThrough: 0 });
    const current = prior
      .catch(() => ({
        acknowledgedThrough: record._panelInputSequence.get(panelId) ?? 0,
      }))
      .then(() =>
        this.forwardPanelInput(
          record,
          expectedHostInstanceId,
          expectedSessionEpoch,
          panelId,
          revision,
          sequence,
          data,
        ),
      );
    record._panelInputChains.set(panelId, current);
    try {
      return await current;
    } finally {
      if (record._panelInputChains.get(panelId) === current) {
        record._panelInputChains.delete(panelId);
      }
    }
  }

  private async forwardPanelInput(
    record: SessionRecord,
    expectedHostInstanceId: string,
    expectedSessionEpoch: number,
    panelId: number,
    revision: number,
    sequence: number,
    data: string,
  ): Promise<{
    acknowledgedThrough: number;
    gap?: { expected: number; received: number };
    repaintRequired?: { revision: number; repaintRequired: boolean };
  }> {
    const acknowledged = record._panelInputSequence.get(panelId) ?? 0;
    const expected = acknowledged + 1;
    if (sequence > acknowledged && sequence !== expected) {
      return {
        acknowledgedThrough: acknowledged,
        gap: { expected, received: sequence },
      };
    }
    if (
      !this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch) ||
      sequence <= acknowledged
    )
      return { acknowledgedThrough: acknowledged };
    const proc = record.proc;
    const result = await proc.sendPanelInput(panelId, revision, sequence, data);
    if (
      this.sessions.get(record.sessionId) !== record ||
      record._closing ||
      record._dead ||
      record.proc !== proc ||
      !this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch)
    )
      return { acknowledgedThrough: 0 };
    if (result.acknowledgedThrough > acknowledged) {
      record._panelInputSequence.set(panelId, result.acknowledgedThrough);
      record._mutationSequence++;
    }
    return result;
  }

  async acknowledgePanelRepaint(
    sessionId: SessionId,
    expectedHostInstanceId: string,
    expectedSessionEpoch: number,
    panelId: number,
    revision: number,
  ): Promise<{ acknowledged: boolean }> {
    const record = this.sessions.get(sessionId);
    if (
      !record ||
      record._closing ||
      !this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch)
    )
      return { acknowledged: false };
    const proc = record.proc;
    const acknowledged = await proc.acknowledgePanelRepaint(panelId, revision);
    if (
      this.sessions.get(sessionId) !== record ||
      record.proc !== proc ||
      !this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch)
    )
      return { acknowledged: false };
    if (acknowledged) record._mutationSequence++;
    return { acknowledged };
  }

  resizePanel(
    sessionId: SessionId,
    expectedHostInstanceId: string,
    expectedSessionEpoch: number,
    panelId: number,
    cols: number,
    rows: number,
    force = false,
  ): void {
    const record = this.sessions.get(sessionId);
    if (record?._closing) throw new Error("Session close preparation is in progress");
    if (!this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch)) return;
    record.proc.sendPanelResize(panelId, cols, rows, force);
    record._mutationSequence++;
  }

  async executeReload(
    sessionId: SessionId,
    requestInput: ReloadRequest,
  ): Promise<ReloadSettlement> {
    this.markActivationVisitInteracted(this.sessions.get(sessionId));
    const parsed = ReloadRequestSchema.safeParse(requestInput);
    if (!parsed.success) throw new Error(`Invalid reload request: ${parsed.error.message}`);
    const request = parsed.data;
    const base = {
      requestId: request.requestId,
      intentId: request.intentId,
      operation: "reload" as const,
      hostInstanceId: request.expectedHostInstanceId,
      sessionEpoch: request.expectedSessionEpoch,
    };
    let dispatched = false;
    try {
      const successorIdentity = await this.reloadSession(
        sessionId,
        undefined,
        undefined,
        {
          expectedHostInstanceId: request.expectedHostInstanceId,
          expectedSessionEpoch: request.expectedSessionEpoch,
        },
        () => {
          dispatched = true;
        },
      );
      return {
        ...base,
        success: true,
        disposition: "completed",
        successorIdentity,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!dispatched) {
        return {
          ...base,
          success: false,
          disposition: "not_executed",
          error: message,
        };
      }
      const record = this.sessions.get(sessionId);
      const restorationId = `ambiguous-reload:${request.intentId}`;
      if (record && !record._restorations.has(restorationId)) {
        const restoration: RuntimeRecord & { type: "queue_restoration" } = {
          type: "queue_restoration",
          restorationId,
          steering: [],
          followUp: request.sourceText?.trim() ? [request.sourceText] : [],
          originalAttachments: [],
          commandDescription:
            "reload may have completed before its acknowledgement was lost. Review before retrying.",
          certainty: "unknown",
        };
        record._restorations.set(restorationId, structuredClone(restoration));
        this.queueRestoration(record, restoration);
      }
      return {
        ...base,
        success: false,
        disposition: "outcome_unknown",
        error: message,
        restorationId,
      };
    }
  }

  async reloadSession(
    sessionId: SessionId,
    _piPath?: string,
    _env?: Record<string, string>,
    expectedRuntime: {
      expectedHostInstanceId?: string;
      expectedSessionEpoch?: number;
    } = {},
    onDispatched: () => void = () => {},
  ): Promise<{ hostInstanceId: string; sessionEpoch: number }> {
    const record = this.sessions.get(sessionId);
    if (
      !record?.proc ||
      !record._procReady ||
      record._closing ||
      record._dead ||
      record.availability !== "available" ||
      record._hostTransition !== undefined
    )
      throw new Error(`No available SDK host for session ${sessionId}`);
    const identityBound =
      expectedRuntime.expectedHostInstanceId !== undefined ||
      expectedRuntime.expectedSessionEpoch !== undefined;
    if (
      identityBound &&
      (!expectedRuntime.expectedHostInstanceId ||
        expectedRuntime.expectedSessionEpoch === undefined ||
        !this.matchesExpectedRuntime(
          record,
          expectedRuntime.expectedHostInstanceId,
          expectedRuntime.expectedSessionEpoch,
        ))
    ) {
      throw new Error("Session changed before reload dispatch");
    }
    const proc = record.proc;
    // This probe is transport-only. It deliberately does not let main inspect
    // Pi liveness; the following child permit owns semantic admission.
    await proc.requestSnapshot();
    if (record._closing) {
      throw new Error("Session close preparation began before reload dispatch");
    }
    // The host serializes this fresh SDK/custody/intent/editor/UI admission.
    // Main sees only an opaque verdict and revalidates transport ownership.
    const permit = await proc.requestLifecyclePermit("reload");
    if (!permit.allowed)
      throw new Error("Wait for the current response to finish before reloading.");
    if (record._closing) {
      throw new Error("Session close preparation began before reload dispatch");
    }
    if (
      this.sessions.get(sessionId) !== record ||
      record._dead ||
      record.proc !== proc ||
      !record._procReady ||
      record.availability !== "available" ||
      record._hostTransition !== undefined ||
      (identityBound &&
        !this.matchesExpectedRuntime(
          record,
          expectedRuntime.expectedHostInstanceId!,
          expectedRuntime.expectedSessionEpoch!,
        ))
    ) {
      throw new Error("Session changed before reload dispatch");
    }
    record.availability = "transitioning";
    this.publishRuntime(record, "transitioning", "Reloading session runtime");
    try {
      onDispatched();
      await proc.reloadInPlace();
      if (
        this.sessions.get(sessionId) !== record ||
        record._closing ||
        record._dead ||
        record.proc !== proc ||
        !record._procReady
      ) {
        throw new Error("Session changed while reload was in progress");
      }
      const runtime = await this.resyncSession(sessionId);
      if (!runtime.hostInstanceId || runtime.sessionEpoch === undefined) {
        throw new Error("Reload completed without a correlated runtime identity");
      }
      return {
        hostInstanceId: runtime.hostInstanceId,
        sessionEpoch: runtime.sessionEpoch,
      };
    } catch (error) {
      if (
        this.sessions.get(sessionId) === record &&
        !record._closing &&
        !record._dead &&
        record.proc === proc
      ) {
        this.publishUnavailable(record, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  /** Atomically admit user-requested worktree work and retain its activation visit. */
  beginWorktreeSwitch(sessionId: SessionId): void {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    this.assertWorktreeRespawnEligible(record);
    this.markActivationVisitInteracted(record);
  }

  /** Fast authoritative preflight for IPC callers before git worktree work. */
  assertWorktreeSwitchEligible(sessionId: SessionId): void {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    this.assertWorktreeRespawnEligible(record);
  }

  private assertWorktreeRespawnEligible(
    record: SessionRecord,
    allowWorktreeTransition = false,
  ): void {
    if (
      this.sessions.get(record.sessionId) !== record ||
      record._closing ||
      record._dead ||
      (record.availability !== "available" &&
        !(allowWorktreeTransition && record.availability === "transitioning")) ||
      record._hostTransition !== undefined ||
      record._retainedIntents.size > 0 ||
      record._pendingUnifiedSubmits.size > 0
    ) {
      throw new Error("Wait for active and retained work before moving the session to a worktree");
    }
  }

  private restoreAvailableRuntime(record: SessionRecord): void {
    if (
      this.sessions.get(record.sessionId) !== record ||
      record._closing ||
      record._dead ||
      !record.proc ||
      !record._procReady ||
      record._hostTransition !== undefined ||
      record._worktreeTransition === true ||
      record.availability !== "transitioning"
    )
      return;
    record.availability = "available";
    if (record.snapshot) {
      record.snapshotReceivedAt = Date.now();
      record.leaseExpiresAt = record.snapshotReceivedAt + TRANSPORT_LEASE_MS;
      this.armLease(record, TRANSPORT_LEASE_MS);
    }
    this.publishRuntime(record, "available");
  }

  async setWorktreeAndRespawn(
    sessionId: SessionId,
    worktreePath: string | undefined,
    piPath: string,
    env?: Record<string, string>,
    lifecycle?: {
      onBeforeDetach?: () => void | Promise<void>;
      onImmediatelyBeforeDetach?: () => void | Promise<void>;
      onDetachCommitted?: () => void;
    },
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    this.markActivationVisitInteracted(record);
    this.assertWorktreeRespawnEligible(record);
    await this.runRestart(record, async () => {
      this.assertWorktreeRespawnEligible(record);
      const old = record.worktreePath;
      const proc = record.proc;
      let detachmentCommitted = false;
      record._worktreeTransition = true;
      record.availability = "transitioning";
      this.publishRuntime(record, "transitioning", "Worktree replacement in progress");
      try {
        if (proc && record._procReady) {
          // The snapshot is a correlated transport/editor checkpoint only.
          // Child liveness and semantic eligibility come from the serialized permit.
          const freshSnapshot = await proc.requestSnapshot();
          if (record.proc !== proc) throw new Error("Session changed before worktree respawn");
          this.installSnapshot(record, freshSnapshot);
          const permit = await proc.requestLifecyclePermit("worktree_respawn");
          if (!permit.allowed) {
            throw new Error(
              "Wait for active and retained work before moving the session to a worktree",
            );
          }
          if (record.proc !== proc) throw new Error("Session changed before worktree respawn");
          this.assertWorktreeRespawnEligible(record, true);
        }
        this.assertWorktreeRespawnEligible(record, true);
        this.captureEditorRecovery(record);
        // Callers can finish asynchronous pre-detach work before the final
        // child permit. Destructive cleanup remains safe until commit below.
        await lifecycle?.onBeforeDetach?.();
        if (this.sessions.get(sessionId) !== record || record.proc !== proc) {
          throw new Error("Session changed before worktree respawn detachment");
        }
        if (proc && record._procReady) {
          const finalSnapshot = await proc.requestSnapshot();
          if (this.sessions.get(sessionId) !== record || record.proc !== proc) {
            throw new Error("Session changed before worktree respawn detachment");
          }
          this.installSnapshot(record, finalSnapshot);
          const finalPermit = await proc.requestLifecyclePermit("worktree_respawn");
          if (!finalPermit.allowed) {
            throw new Error(
              "Wait for active and retained work before moving the session to a worktree",
            );
          }
          if (this.sessions.get(sessionId) !== record || record.proc !== proc) {
            throw new Error("Session changed before worktree respawn detachment");
          }
        }
        // Source-checkout validation belongs here: no await may intervene
        // between this callback and the committed detachment boundary.
        await lifecycle?.onImmediatelyBeforeDetach?.();
        if (this.sessions.get(sessionId) !== record || record.proc !== proc) {
          throw new Error("Session changed before worktree respawn detachment");
        }
        this.assertWorktreeRespawnEligible(record, true);
        this.captureEditorRecovery(record);
        lifecycle?.onDetachCommitted?.();
        detachmentCommitted = true;
      } catch (error) {
        if (
          !detachmentCommitted &&
          this.sessions.get(sessionId) === record &&
          record.proc === proc &&
          !record._dead
        ) {
          // Clear this fence unless a silent tab close already owns `_closing`.
          record._worktreeTransition = undefined;
          this.restoreAvailableRuntime(record);
        }
        throw error;
      }
      record._worktreeTransition = undefined;
      record.proc = undefined;
      record._procReady = false;
      this.retireHostUi(record);
      this.onPanelEvent(record.sessionId, { type: "panel_clear_all" });
      this.onPanelEvent(record.sessionId, { type: "unified_panel_reset" });
      record._mutationSequence++;
      proc?.stop();
      record.worktreePath = worktreePath;
      try {
        await this.activateSession(sessionId, piPath, env);
        const activated = this.sessions.get(sessionId);
        if (
          activated !== record ||
          activated._closing ||
          activated._dead ||
          activated.availability !== "available"
        ) {
          throw new Error("Session lifecycle changed while worktree respawn was activating");
        }
      } catch (destinationError) {
        if (this.sessions.get(sessionId) !== record || record._closing || record._dead) {
          throw destinationError;
        }
        record.worktreePath = old;
        this.captureEditorRecovery(record);
        try {
          await this.activateSession(sessionId, piPath, env);
        } catch (rollbackError) {
          const destinationMessage =
            destinationError instanceof Error ? destinationError.message : String(destinationError);
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(
            `${destinationMessage} Restoring the previous checkout also failed: ${rollbackMessage}`,
          );
        }
        throw destinationError;
      }
    });
  }

  private async runRestart(record: SessionRecord, operation: () => Promise<void>): Promise<void> {
    const prior = record._restartChain ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    record._restartChain = current;
    try {
      await current;
    } finally {
      if (record._restartChain === current) record._restartChain = undefined;
    }
  }

  reloadRunningSessions(): Promise<void> {
    return Promise.resolve();
  }

  private async withCloseDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Close escape deadline exceeded")),
            CLOSE_ESCAPE_DEADLINE_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Dispose a tab without asking the renderer to arbitrate host state. The
   * main-process fence is installed first, so every normal ingress path loses
   * custody while the best-effort child shutdown is in flight.
   */
  async closeSessionGracefully(sessionId: SessionId): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record._closing = true;
    const proc = record.proc;
    try {
      if (proc && record._procReady && record.proc === proc) {
        try {
          const snapshot = await this.withCloseDeadline(proc.requestSnapshot());
          if (
            this.sessions.get(sessionId) === record &&
            record.proc === proc &&
            snapshot.hostInstanceId === proc.hostInstanceId &&
            snapshot.sessionEpoch === proc.sessionEpoch &&
            snapshot.isStreaming
          ) {
            await this.withCloseDeadline(proc.escape(crypto.randomUUID()));
          }
        } catch {
          // Snapshot and escape are best-effort. A failed or timed-out abort
          // must not delay the force-close protocol or local cleanup.
        }
        // This is a private child protocol: force preparation records the
        // shutdown token and confirmation fences its final outbound traffic.
        await proc.forceClose();
      }
    } catch {
      // The child may already be cold, failed, or unresponsive. In all cases
      // disposal below is still required and session files remain untouched.
    } finally {
      this.closeSession(sessionId);
    }
  }

  private closeSession(sessionId: SessionId): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record._dead = true;
    if (record._leaseTimer) clearTimeout(record._leaseTimer);
    for (const timer of record._unifiedClaimTimers.values()) clearTimeout(timer);
    record._unifiedClaimTimers.clear();
    for (const pending of record._pendingUiAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    record._pendingUiAcks.clear();
    if (record._pendingRendererCancellation) {
      clearTimeout(record._pendingRendererCancellation.timer);
      record._pendingRendererCancellation.resolve(false);
      record._pendingRendererCancellation = undefined;
    }
    const proc = record.proc;
    record.proc = undefined;
    proc?.stop();
    this.releaseLock(record);
    this.releaseConfinedSource(record);
    this.sessions.delete(sessionId);
    if (record.sessionFile && this.byFile.get(path.resolve(record.sessionFile)) === sessionId) {
      this.byFile.delete(path.resolve(record.sessionFile));
    }
  }

  /**
   * Reap only the host created by one renderer activation visit, and only when
   * that visit never crossed a user-interaction boundary. This is deliberately
   * not a general idle/LRU reaper: an older idle host may own extension
   * background work that public idle state cannot prove safe to terminate.
   */
  async releaseActivationVisit(
    sessionId: SessionId,
    activationVisitId: string,
  ): Promise<{ released: boolean }> {
    const record = this.sessions.get(sessionId);
    if (!record) return { released: false };
    if (record._activationVisitId !== activationVisitId) {
      // session.activate performs Pi discovery before entering the registry,
      // so remember a release for a still-cold record and let activation
      // consume it without spawning.
      if (!record.proc && !record._activating && record.status === "cold") {
        const releasedAt = Date.now();
        record._releasedActivationVisits.set(activationVisitId, releasedAt);
        const expiry = setTimeout(() => {
          if (record._releasedActivationVisits.get(activationVisitId) === releasedAt) {
            record._releasedActivationVisits.delete(activationVisitId);
          }
        }, ACTIVATION_VISIT_RELEASE_WINDOW_MS);
        expiry.unref?.();
      }
      return { released: false };
    }

    const releaseRequestedAt = Date.now();
    const abandonVisit = (): { released: false } => {
      if (record._activationVisitId === activationVisitId) {
        record._activationVisitId = undefined;
        record._activationVisitStartedAt = undefined;
        record._activationVisitInteracted = undefined;
        record._activationVisitReleaseCancelled = undefined;
      }
      record._releasedActivationVisits.delete(activationVisitId);
      return { released: false };
    };
    const visitStartedAt = record._activationVisitStartedAt;
    if (
      visitStartedAt === undefined ||
      releaseRequestedAt - visitStartedAt > ACTIVATION_VISIT_RELEASE_WINDOW_MS
    ) {
      return abandonVisit();
    }

    const activationDone = record._activationDone;
    if (activationDone) await activationDone;

    const proc = record.proc;
    if (
      this.sessions.get(sessionId) !== record ||
      record._activationVisitId !== activationVisitId ||
      record._activationVisitReleaseCancelled ||
      record._activationVisitInteracted ||
      !proc ||
      !record._procReady ||
      record.status !== "ready" ||
      record.availability !== "available"
    ) {
      return abandonVisit();
    }

    let freshSnapshot: AgentSessionSnapshot;
    try {
      freshSnapshot = await proc.requestSnapshot();
    } catch {
      return abandonVisit();
    }
    if (
      this.sessions.get(sessionId) !== record ||
      record.proc !== proc ||
      record._activationVisitId !== activationVisitId ||
      record._activationVisitReleaseCancelled ||
      record._activationVisitInteracted
    ) {
      return abandonVisit();
    }
    // A state probe establishes only transport continuity. The child performs
    // the fresh semantic/editor/UI admission in its serialized permit.
    this.installSnapshot(record, freshSnapshot, false);
    let permit: Awaited<ReturnType<SessionHost["requestLifecyclePermit"]>>;
    try {
      permit = await proc.requestLifecyclePermit("activation_visit_release");
    } catch {
      return abandonVisit();
    }
    const hasOpenPanel = [...record._openPanels.values()].some(
      (event) => event.type === "panel_open",
    );
    const safe =
      permit.allowed &&
      !record._closing &&
      !record._dead &&
      !record._hostTransition &&
      !record._restartChain &&
      !record._lifecycleUiLease &&
      !record._pendingRendererCancellation &&
      record._retainedIntents.size === 0 &&
      record._pendingSubmissionPromises.size === 0 &&
      record._restorations.size === 0 &&
      record._pendingUnifiedSubmits.size === 0 &&
      record._expiredUnifiedIntents.size === 0 &&
      record._acknowledgedUnifiedIntents.size === 0 &&
      record._unifiedRestorationIntents.size === 0 &&
      record._pendingUiRequests.size === 0 &&
      record._pendingUiAcks.size === 0 &&
      record._panelInputChains.size === 0 &&
      !hasOpenPanel;
    if (!safe || record._activationVisitReleaseCancelled || record._activationVisitInteracted) {
      return abandonVisit();
    }

    // Detach before stop so the expected exit cannot enter failure/restart.
    record._activationVisitId = undefined;
    record._activationVisitStartedAt = undefined;
    record._activationVisitInteracted = undefined;
    record._activationVisitReleaseCancelled = undefined;
    record._releasedActivationVisits.delete(activationVisitId);
    record.proc = undefined;
    record._procReady = false;
    this.retireHostUi(record);
    record.leaseExpiresAt = undefined;
    this.onPanelEvent(sessionId, { type: "panel_clear_all" });
    this.onPanelEvent(sessionId, { type: "unified_panel_reset" });
    record._mutationSequence++;
    proc.stop();
    this.releaseLock(record);
    record.status = "cold";
    record.error = undefined;
    this.publishUnavailable(record, "Unused activation visit released");
    this.onStatusChanged(sessionId, "cold");
    return { released: true };
  }

  cancelActivationVisitRelease(sessionId: SessionId, activationVisitId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || record._activationVisitId !== activationVisitId) return false;
    record._activationVisitReleaseCancelled = true;
    return true;
  }

  deactivateSession(sessionId: SessionId): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    for (const pending of [...record._pendingUnifiedSubmits.values()]) {
      if (pending.claimedGeneration !== undefined) {
        this.retireUnifiedAsAmbiguous(
          record,
          pending,
          "Unified submission may have executed before session deactivation",
          true,
        );
      } else {
        const restoration: RuntimeRecord & { type: "queue_restoration" } = {
          type: "queue_restoration",
          restorationId: `interrupted-unified:${pending.id}`,
          steering: [],
          followUp: [pending.text],
          originalAttachments: [],
          certainty: "not_processed",
        };
        record._restorations.set(restoration.restorationId, structuredClone(restoration));
        this.queueRestoration(record, restoration);
        record.proc?.sendUnifiedSubmitResponse(
          pending.id,
          false,
          true,
          "Session deactivated before unified action execution",
        );
        record._pendingUnifiedSubmits.delete(pending.id);
      }
    }
    const proc = record.proc;
    record.proc = undefined;
    proc?.stop();
    record._procReady = false;
    record.status = "cold";
    this.publishUnavailable(record, "Session deactivated explicitly");
    this.onStatusChanged(sessionId, "cold");
  }

  noteSessionFile(sessionId: SessionId, sessionFile: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const resolved = path.resolve(sessionFile);
    // Never accept a child-reported file that differs from the held primary
    // lock, including after an initial reservation has already adopted a path.
    if (record._hasLock && record._lockPath !== resolved) {
      throw new Error("A held session lock cannot silently move to a discovered file");
    }
    if (record.sessionFile) return;
    if (this.byFile.has(resolved)) return;
    record.sessionFile = sessionFile;
    this.byFile.set(resolved, sessionId);
  }

  updateSessionFile(sessionId: SessionId, sessionFile: string | undefined): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const next = sessionFile ? path.resolve(sessionFile) : undefined;
    if (record._hasLock && next !== record._lockPath) {
      throw new Error("updateSessionFile cannot move a held advisory lock");
    }
    this.releaseConfinedSource(record);
    if (record.sessionFile && this.byFile.get(path.resolve(record.sessionFile)) === sessionId) {
      this.byFile.delete(path.resolve(record.sessionFile));
    }
    record.sessionFile = sessionFile;
    if (sessionFile) this.byFile.set(path.resolve(sessionFile), sessionId);
  }

  private releaseConfinedSource(record: SessionRecord): void {
    if (record._confinedSessionDescriptor !== undefined) {
      closeSync(record._confinedSessionDescriptor);
      record._confinedSessionDescriptor = undefined;
    }
    if (record._confinedSessionAlias) {
      removeRuntimePinWithRetry(record._confinedSessionAlias);
      record._confinedSessionAlias = undefined;
    }
    record._confinedSessionRoot = undefined;
  }

  private async lockPath(
    record: SessionRecord,
    file: string,
    role: "primary" | "successor",
    transitionId?: string,
  ): Promise<string> {
    const resolved = path.resolve(file);
    const token = crypto.randomUUID();
    await lockfile.lock(resolved, {
      retries: 0,
      realpath: false,
      lockfilePath: `${resolved}.lock`,
      onCompromised: (error) => {
        this.handleLockCompromise(record, {
          role,
          path: resolved,
          token,
          ...(transitionId !== undefined ? { transitionId } : {}),
          error,
        });
      },
    });
    return token;
  }

  /**
   * proper-lockfile can invoke this callback from outside our awaited lifecycle
   * work. Fence all ingress before any observable callback or process teardown;
   * clearing a boolean alone would otherwise leave a live Pi authority running
   * without its ownership lock. Callback tokens make stale callbacks from a
   * released/replaced lock harmless.
   */
  private handleLockCompromise(
    record: SessionRecord,
    compromise: {
      role: "primary" | "successor";
      path: string;
      token: string;
      transitionId?: string | undefined;
      error: Error;
    },
  ): void {
    if (
      this.sessions.get(record.sessionId) !== record ||
      record._handlingLockCompromise ||
      record._lockCompromised
    )
      return;
    // A successor callback becomes the primary callback at transition commit,
    // so current ownership is determined by the token rather than its original
    // acquisition role.
    const primaryCurrent =
      record._hasLock === true &&
      record._lockPath === compromise.path &&
      record._primaryLockToken === compromise.token;
    const successor = record._transitionLock;
    const successorCurrent =
      compromise.role === "successor" &&
      successor !== undefined &&
      successor.transitionId === compromise.transitionId &&
      successor.targetFile === compromise.path &&
      successor.successorLocked === true &&
      successor.successorLockToken === compromise.token;
    if (!primaryCurrent && !successorCurrent) return;

    // These assignments are intentionally synchronous and precede publishing,
    // UI retirement, unlock, and stop: every reentrant ingress path sees a
    // terminally fenced owner.
    record._handlingLockCompromise = true;
    record._lockCompromised = true;
    record._dead = true;
    record._closing = true;
    record._procReady = false;
    record.status = "failed";
    const detail =
      compromise.error instanceof Error ? compromise.error.message : String(compromise.error);
    const reason = `Session advisory lock compromised (${compromise.path}): ${detail}`;
    record.error = reason;
    if (successorCurrent && successor) {
      successor.successorCompromised = true;
      successor.successorLocked = false;
      successor.successorLockToken = undefined;
    }
    // Do not leave a transition that an already-buffered successor batch could
    // commit after the lock callback returns.
    if (record._hostTransition)
      this.abortTransitionLock(record, record._hostTransition.transitionId);
    record._hostTransition = undefined;
    record.availability = "unavailable";
    this.publishUnavailable(record, reason);

    const proc = record.proc;
    if (proc) {
      // handleRuntimeFailure detaches before stop, so its exit/error callbacks
      // cannot recursively process this retired authority or schedule restart.
      this.handleRuntimeFailure(record, proc, reason);
    } else {
      this.retireHostUi(record);
      this.releaseLock(record);
      this.onStatusChanged(record.sessionId, "failed", reason);
    }
    record._handlingLockCompromise = false;
  }

  private async acquireLock(record: SessionRecord): Promise<void> {
    if (!record.sessionFile || record._hasLock) return;
    const resolved = path.resolve(record.sessionFile);
    try {
      const token = await this.lockPath(record, resolved, "primary");
      if (record._dead || record._lockCompromised) {
        this.unlockPath(resolved);
        throw new Error("Session lock was compromised during acquisition");
      }
      record._hasLock = true;
      record._lockPath = resolved;
      record._primaryLockToken = token;
    } catch (error) {
      record._hasLock = false;
      throw new Error(
        `Session file lock contention prevented activation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private unlockPath(file: string | undefined): void {
    if (!file) return;
    void lockfile.unlock(file, { lockfilePath: `${file}.lock`, realpath: false }).catch(() => {});
  }

  private releaseLock(record: SessionRecord): void {
    const primary = record._lockPath;
    const successor = record._transitionLock?.targetFile;
    // Retire callback identities before unlock, because proper-lockfile may
    // report an error while its release work is still unwinding.
    record._primaryLockToken = undefined;
    if (record._transitionLock) record._transitionLock.successorLockToken = undefined;
    record._hasLock = false;
    record._lockPath = undefined;
    record._transitionLock = undefined;
    this.unlockPath(primary);
    this.unlockPath(successor);
    // A failed/retired activation must not retain a rejected reservation and
    // block a later activation from attempting to acquire its file anew.
    record._initialSessionFileReservation = undefined;
  }

  private async permitInitialSessionFile(
    record: SessionRecord,
    proc: SessionHost,
    sessionFile: string,
  ): Promise<void> {
    const target = path.resolve(sessionFile);
    const prior = record._initialSessionFileReservation;
    if (prior) return prior;
    const reservation = (async () => {
      if (
        this.sessions.get(record.sessionId) !== record ||
        record.proc !== proc ||
        record._dead ||
        record._closing
      ) {
        throw new Error("Session lifecycle rejected initial session-file lock");
      }
      if (record.sessionFile) {
        if (
          path.resolve(record.sessionFile) !== target ||
          !record._hasLock ||
          record._lockPath !== target
        ) {
          throw new Error("Initial session file does not match the held advisory lock");
        }
        return;
      }
      const occupied = this.byFile.get(target);
      if (occupied && occupied !== record.sessionId)
        throw new Error("Target session file is already active");
      let token: string;
      try {
        token = await this.lockPath(record, target, "primary");
      } catch (error) {
        throw new Error(
          `Session file lock contention prevented activation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Closing can race proper-lockfile's async acquisition. Do not leave a
      // lock behind for a record that no longer owns a live host.
      if (
        this.sessions.get(record.sessionId) !== record ||
        record.proc !== proc ||
        record._dead ||
        record._closing
      ) {
        this.unlockPath(target);
        throw new Error("Session lifecycle changed while reserving initial session file");
      }
      record._hasLock = true;
      record._lockPath = target;
      record._primaryLockToken = token;
      record.sessionFile = target;
      this.byFile.set(target, record.sessionId);
    })();
    record._initialSessionFileReservation = reservation;
    return reservation;
  }

  private async permitTransition(
    record: SessionRecord,
    proc: SessionHost,
    request: {
      transitionId: string;
      phase: "prepare" | "successor";
      kind: string;
      targetFile?: string;
    },
  ): Promise<void> {
    if (
      this.sessions.get(record.sessionId) !== record ||
      record.proc !== proc ||
      record._closing ||
      record._dead ||
      !record._procReady ||
      record._lockCompromised
    ) {
      throw new Error("Session lifecycle rejected transition permit");
    }
    const active = record._hostTransition;
    if (!active || active.transitionId !== request.transitionId) {
      throw new Error("Uncorrelated transition prepare");
    }
    if (!record._transitionLock) {
      record._transitionLock = {
        transitionId: request.transitionId,
        ...(record._lockPath ? { oldLockPath: record._lockPath } : {}),
        successorLocked: false,
      };
    }
    const lock = record._transitionLock;
    if (lock.transitionId !== request.transitionId)
      throw new Error("Another transition owns the lock reservation");
    if (request.phase === "prepare" && request.targetFile === undefined) return;
    if (request.phase === "successor" && request.targetFile === undefined) {
      throw new Error("Successor session file was not provided for lock reservation");
    }
    const target = path.resolve(request.targetFile!);
    const occupied = this.byFile.get(target);
    if (occupied && occupied !== record.sessionId)
      throw new Error("Target session file is already active");
    if (lock.targetFile && lock.targetFile !== target)
      throw new Error("Transition target changed after reservation");
    lock.targetFile = target;
    if (target === record._lockPath && record._hasLock) {
      lock.successorLocked = true;
      return;
    }
    try {
      const token = await this.lockPath(record, target, "successor", request.transitionId);
      if (record._dead || record._lockCompromised || record._transitionLock !== lock) {
        this.unlockPath(target);
        throw new Error("Session lock was compromised during transition reservation");
      }
      lock.successorLocked = true;
      lock.successorLockToken = token;
    } catch (error) {
      throw new Error(
        `Session file lock contention prevented transition: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private abortTransitionLock(record: SessionRecord, transitionId: string): void {
    const lock = record._transitionLock;
    if (!lock || lock.transitionId !== transitionId) return;
    if (lock.targetFile && lock.targetFile !== lock.oldLockPath) {
      lock.successorLockToken = undefined;
      this.unlockPath(lock.targetFile);
    }
    record._transitionLock = undefined;
  }

  private commitTransitionLock(record: SessionRecord, transitionId: string): void {
    const lock = record._transitionLock;
    if (
      record._dead ||
      record._lockCompromised ||
      !lock ||
      lock.transitionId !== transitionId ||
      !lock.successorLocked ||
      lock.successorCompromised ||
      !lock.targetFile ||
      (lock.targetFile !== lock.oldLockPath && !lock.successorLockToken)
    ) {
      throw new Error("Cannot commit transition routing without successor lock");
    }
    const old = lock.oldLockPath;
    const priorSessionFile = record.sessionFile;
    record._lockPath = lock.targetFile;
    record._hasLock = true;
    // A same-file transition keeps the already-held primary lock and callback
    // identity. A different-file transition promotes the successor identity.
    if (lock.targetFile !== old) record._primaryLockToken = lock.successorLockToken;
    // The routing map changes only as part of the same commit that transfers
    // lock ownership. No helper may silently point a held lock at a new file.
    if (priorSessionFile && this.byFile.get(path.resolve(priorSessionFile)) === record.sessionId) {
      this.byFile.delete(path.resolve(priorSessionFile));
    }
    record.sessionFile = lock.targetFile;
    this.byFile.set(lock.targetFile, record.sessionId);
    if (old && old !== lock.targetFile) this.unlockPath(old);
    record._transitionLock = undefined;
  }

  /** Transfer a search-validated file identity onto an existing cold record. */
  adoptConfinedSessionDescriptor(
    sessionId: SessionId,
    sessionFile: string,
    descriptor: number,
    confinementRoot: string,
  ): boolean {
    const record = this.sessions.get(sessionId);
    if (
      !record ||
      record.proc ||
      (record.status !== "cold" && record.status !== "starting") ||
      !record.sessionFile ||
      path.resolve(record.sessionFile) !== path.resolve(sessionFile)
    ) {
      return false;
    }
    this.releaseConfinedSource(record);
    record._confinedSessionDescriptor = descriptor;
    record._confinedSessionRoot = confinementRoot;
    return true;
  }

  getSession(sessionId: SessionId): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  isWorktreePathInUse(worktreePath: string, exceptSessionId?: SessionId): boolean {
    return [...this.sessions.values()].some(
      (record) =>
        record.sessionId !== exceptSessionId &&
        !record._dead &&
        record.worktreePath === worktreePath,
    );
  }

  getByFile(sessionFile: string): SessionRecord | undefined {
    const id = this.byFile.get(path.resolve(sessionFile));
    return id ? this.sessions.get(id) : undefined;
  }

  stopAll(): void {
    for (const record of [...this.sessions.values()]) this.closeSession(record.sessionId);
  }

  getAll(): SessionRecord[] {
    return [...this.sessions.values()];
  }
}
