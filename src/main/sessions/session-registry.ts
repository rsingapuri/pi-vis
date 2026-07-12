import * as crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { newSessionId } from "@shared/ids.js";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import {
  type PiRpcCommand,
  commandNeedsIntent,
  commandPolicy,
} from "@shared/pi-protocol/commands.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";
import {
  type AgentSessionSnapshot,
  AgentSessionSnapshotSchema,
  type CommandSettlement,
  type EscapeResult,
  type ReloadRequest,
  ReloadRequestSchema,
  type ReloadSettlement,
  type RendererCommandRequest,
  RendererCommandRequestSchema,
  type RuntimeRecord,
  type RuntimeStateUpdate,
  type SessionSubmission,
  SessionSubmissionSchema,
  type SubmissionResult,
  SubmissionResultSchema,
  type TransitionBatch,
  TransitionBatchSchema,
} from "@shared/pi-protocol/runtime-state.js";
import lockfile from "proper-lockfile";
import { resolveHostExecPath } from "../pi/locate-node.js";
import { SessionHost } from "../pi/session-host.js";

interface RetainedIntent {
  payload: SessionSubmission;
  disposition: SubmissionResult["disposition"];
  updatedAt: number;
  recoveryPublished?: boolean | undefined;
  queuedAtAdmission?: boolean | undefined;
  result?: SubmissionResult | undefined;
}

interface RetainedCommandIntent {
  request: RendererCommandRequest;
  dispatched: boolean;
  recoveryPublished?: boolean | undefined;
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
  _hostTransition?: { transitionId: string; provisionalEpoch: number } | undefined;
  _retainedIntents: Map<string, RetainedIntent>;
  _pendingSubmissionPromises: Map<string, Promise<SubmissionResult>>;
  _expiredUnifiedIntents: Set<string>;
  _acknowledgedUnifiedIntents: Set<string>;
  _unifiedRestorationIntents: Map<string, string>;
  _retainedCommandIntents: Map<string, RetainedCommandIntent>;
  _restorations: Map<string, unknown>;
  _rendererGeneration: number;
  _mutationSequence: number;
  _closeToken?: { value: string; mutationSequence: number; force: boolean } | undefined;
  _closing?: boolean | undefined;
  _panelInputSequence: Map<number, number>;
  _panelInputChains: Map<
    number,
    Promise<{ acknowledgedThrough: number; gap?: { expected: number; received: number } }>
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
  _pendingRendererCancellation?:
    | {
        generation: number;
        resolve: (acknowledged: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
}

const RAPID_FAILURE_WINDOW_MS = 30_000;
/** A visit release is startup cancellation, never a later idle-host policy. */
const ACTIVATION_VISIT_RELEASE_WINDOW_MS = 2_000;
const DEFAULT_UNIFIED_CLAIM_TIMEOUT_MS = 60_000;

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
    private options: { unifiedClaimTimeoutMs?: number } = {},
  ) {}

  openSession(workspacePath: string, sessionFile?: string, worktreePath?: string): SessionId {
    if (sessionFile) {
      const resolved = path.resolve(sessionFile);
      const existing = this.byFile.get(resolved);
      if (existing) {
        const record = this.sessions.get(existing);
        if (record && record.status !== "exited" && record.status !== "failed") {
          throw new Error(`Session file already open: ${resolved}`);
        }
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
      _retainedCommandIntents: new Map(),
      _restorations: new Map(),
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
    env?: Record<string, string>,
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
    record._env = env;
    record.error = undefined;
    record.status = "starting";
    record.availability = "transitioning";
    this.onStatusChanged(sessionId, "starting");
    this.publishRuntime(record, "transitioning", "Host startup");

    try {
      await this.acquireLock(record);
      if (record._dead) return;
      const { execPath } = await resolveHostExecPath();
      if (record._dead) return;
      const proc = new SessionHost(
        piPath,
        record.worktreePath ?? record.workspacePath,
        record.sessionFile,
        env,
        execPath,
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
      // Keep the recovery budget across a successful ready handshake. A second
      // crash inside RAPID_FAILURE_WINDOW_MS must leave the session failed
      // rather than creating an endless crash/restart loop.
      this.onStatusChanged(sessionId, "ready", undefined, proc.piVersion);
      await this.resyncSession(sessionId);
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
        const leaseMs = record.snapshot.isIdle ? 5_000 : 1_000;
        record.leaseExpiresAt = Date.now() + leaseMs;
        this.armLease(record, leaseMs);
      }
      this.publishRuntime(record, record.availability);
    });
    proc.on("panelOpen", (panelId, overlay, unified, hostInstanceId, sessionEpoch) => {
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
      };
      record._openPanels.set(panelId, event);
      this.onPanelEvent(record.sessionId, event);
    });
    proc.on("panelData", (panelId, data) => {
      if (!current()) return;
      record._mutationSequence++;
      const checkpoint = record._panelCheckpoints.get(panelId) ?? {};
      record._panelCheckpoints.set(panelId, { ...checkpoint, lastData: data });
      this.onPanelEvent(record.sessionId, { type: "panel_data", panelId, data });
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
      this.onPanelEvent(record.sessionId, { type: "panel_mode", panelId, mode });
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
    proc.on("transitionCancelled", (transitionId) => {
      if (!current() || record._hostTransition?.transitionId !== transitionId) return;
      record._hostTransition = undefined;
      record.availability = "available";
      if (record.snapshot) {
        record.snapshotReceivedAt = Date.now();
        const leaseMs = record.snapshot.isIdle ? 5_000 : 1_000;
        record.leaseExpiresAt = record.snapshotReceivedAt + leaseMs;
        this.armLease(record, leaseMs);
      }
      this.publishRuntime(record, "available");
    });
    proc.on("snapshot", (snapshot) => {
      if (!current() || (record._editorRecovery && record._deferredInitialBatch)) return;
      this.installSnapshot(record, snapshot);
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
      this.onQueueRestoration(record.sessionId, payload);
      proc.acknowledgeRestoration(restorationId);
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
  ): void {
    const parsed = AgentSessionSnapshotSchema.safeParse(snapshotInput);
    if (!parsed.success) {
      this.publishUnavailable(record, `Invalid runtime snapshot: ${parsed.error.message}`);
      return;
    }
    const snapshot = parsed.data;
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
    if (snapshot.isIdle && snapshot.pendingMessageCount === 0) {
      for (const [intentId, retained] of record._retainedIntents) {
        if (["completed", "extension_error"].includes(retained.disposition)) {
          record._retainedIntents.delete(intentId);
        }
      }
    }
    record.snapshotReceivedAt = Date.now();
    const leaseMs = snapshot.isIdle ? 5_000 : 1_000;
    const transitionPending = record._hostTransition !== undefined;
    record.leaseExpiresAt = transitionPending ? undefined : record.snapshotReceivedAt + leaseMs;
    record.availability = transitionPending ? "transitioning" : "available";
    record.lastActiveAt = Date.now();
    if (snapshot.sessionFile) this.noteSessionFile(record.sessionId, snapshot.sessionFile);
    if (transitionPending) {
      if (record._leaseTimer) clearTimeout(record._leaseTimer);
      record._leaseTimer = undefined;
    } else {
      this.armLease(record, leaseMs);
    }
    if (publish) this.publishRuntime(record, record.availability);
  }

  private installTransitionBatch(
    record: SessionRecord,
    batchInput: TransitionBatch,
    options: {
      expectedTransition?: { transitionId: string; provisionalEpoch: number } | undefined;
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
    if (options.expectedTransition !== undefined) record._hostTransition = undefined;
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
          record.proc?.acknowledgeRestoration(item.restorationId);
        }
      }
      // Escape results are already correlated to their request. Keeping them in
      // this combined record stream preserves ordering without inventing state.
    }
    this.installSnapshot(record, terminal, false);
    const state = this.publishRuntime(record, "available", undefined, false);
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
        ? { sessionEpoch: record.snapshot.sessionEpoch, snapshot: record.snapshot }
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
          ? [{ text: editor.conflictText, attachments: editor.conflictAttachments ?? [] }]
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
            { text: replacementState.text, attachments: replacementState.attachments },
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
              additionalConflictCandidates?: Array<{ text: string; attachments: unknown[] }>;
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

  private handleRuntimeFailure(record: SessionRecord, proc: SessionHost, reason: string): void {
    if (record.proc !== proc) return;
    this.captureEditorRecovery(record);
    record.proc = undefined;
    this.retireHostUi(record);
    record._procReady = false;
    proc.stop();
    record.status = "failed";
    record.error = reason;
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
        steering: payload.requestedMode === "steer" ? [payload.text] : [],
        followUp: payload.requestedMode === "followUp" ? [payload.text] : [],
        originalAttachments: [{ intentId: payload.intentId, images: payload.images }],
        requiresReview: true,
      };
      if (!record._restorations.has(restoration.restorationId)) {
        record._restorations.set(restoration.restorationId, structuredClone(restoration));
        this.onQueueRestoration(record.sessionId, restoration);
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
    // Commands that crossed child IPC but lost their terminal response are
    // never replayed. Publish one durable review marker per intent.
    for (const [intentId, retained] of record._retainedCommandIntents) {
      if (!retained.dispatched || retained.recoveryPublished) continue;
      retained.recoveryPublished = true;
      const restorationId = `ambiguous-command:${intentId}`;
      const restoration: RuntimeRecord & { type: "queue_restoration" } = {
        type: "queue_restoration",
        restorationId,
        steering: [],
        followUp: [],
        originalAttachments: [],
        commandDescription: `${retained.request.command.type}${
          retained.request.sourceText?.trim() ? ` (${retained.request.sourceText.trim()})` : ""
        } may have completed before its acknowledgement was lost. Review before retrying.`,
        requiresReview: true,
      };
      record._restorations.set(restorationId, structuredClone(restoration));
      this.onQueueRestoration(record.sessionId, restoration);
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
        requiresReview: true,
      };
      record._restorations.set(restoration.restorationId, structuredClone(restoration));
      this.onQueueRestoration(record.sessionId, restoration);
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
          steering: submission.requestedMode === "steer" ? [submission.text] : [],
          followUp: submission.requestedMode === "followUp" ? [submission.text] : [],
          originalAttachments: [{ intentId: submission.intentId, images: submission.images }],
          requiresReview: true,
        };
        record._restorations.set(restorationId, structuredClone(restoration));
        this.onQueueRestoration(sessionId, restoration);
      }
      if (publishDisposition) this.onSubmission(sessionId, result);
      return result;
    };
    const operation = (async (): Promise<SubmissionResult> => {
      try {
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
      steering: retained.payload.requestedMode === "steer" ? [retained.payload.text] : [],
      followUp: retained.payload.requestedMode === "followUp" ? [retained.payload.text] : [],
      originalAttachments: [
        { intentId: retained.payload.intentId, images: retained.payload.images },
      ],
      requiresReview: true,
    };
    record._restorations.set(restorationId, structuredClone(restoration));
    this.onQueueRestoration(record.sessionId, restoration);
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
        throw new Error("Session lifecycle changed before runtime resynchronization completed");
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
        throw error;
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
        requiresReview: true,
      };
      record._restorations.set(restorationId, structuredClone(restoration));
      this.onQueueRestoration(record.sessionId, restoration);
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

  async rendererAttach(sessionId: SessionId, generation: number): Promise<RuntimeStateUpdate> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    if (generation > record._rendererGeneration) {
      const priorGeneration = record._rendererGeneration;
      record._rendererGeneration = generation;
      if (priorGeneration > 0 && record.proc) {
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
          record.proc?.sendRendererDetached(priorGeneration);
        });
        if (!acknowledged) {
          return this.publishUnavailable(record, "Renderer cancellation acknowledgement timed out");
        }
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
    for (const restoration of record._restorations.values()) {
      this.onQueueRestoration(sessionId, structuredClone(restoration));
    }
    return this.resyncSession(sessionId);
  }

  acknowledgeRestoration(sessionId: SessionId, restorationId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    this.markActivationVisitInteracted(record);
    const acknowledged = record._restorations.delete(restorationId);
    if (acknowledged) {
      const ambiguousIntentPrefix = "ambiguous-submission:";
      if (restorationId.startsWith(ambiguousIntentPrefix)) {
        record._retainedIntents.delete(restorationId.slice(ambiguousIntentPrefix.length));
      }
      const ambiguousCommandPrefix = "ambiguous-command:";
      if (restorationId.startsWith(ambiguousCommandPrefix)) {
        record._retainedCommandIntents.delete(restorationId.slice(ambiguousCommandPrefix.length));
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
    record._pendingUiAcks.set(operationId, { promise, resolve: resolvePromise, timer });
    sendOperation();
    return promise;
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
    patch: { baseRevision: number; revision: number; text: string; attachments: unknown[] },
  ): Promise<{
    accepted: boolean;
    revision: number;
    text: string;
    attachments: unknown[];
    conflictText?: string;
    conflictAttachments?: unknown[];
  }> {
    const record = this.sessions.get(sessionId);
    if (record?._closing) throw new Error("Session close preparation is in progress");
    this.markActivationVisitInteracted(record);
    if (
      !this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch) ||
      !record._procReady ||
      record.availability !== "available" ||
      record._hostTransition !== undefined
    )
      throw new Error("Runtime unavailable or replaced");
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
      throw new Error("Runtime replaced before editor patch acknowledgement");
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
    sequence: number,
    data: string,
  ): Promise<{ acknowledgedThrough: number; gap?: { expected: number; received: number } }> {
    const record = this.sessions.get(sessionId);
    if (record?._closing) throw new Error("Session close preparation is in progress");
    this.markActivationVisitInteracted(record);
    if (!this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch))
      return { acknowledgedThrough: 0 };
    const prior =
      record._panelInputChains.get(panelId) ?? Promise.resolve({ acknowledgedThrough: 0 });
    const current = prior
      .catch(() => ({ acknowledgedThrough: record._panelInputSequence.get(panelId) ?? 0 }))
      .then(() =>
        this.forwardPanelInput(
          record,
          expectedHostInstanceId,
          expectedSessionEpoch,
          panelId,
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
    sequence: number,
    data: string,
  ): Promise<{ acknowledgedThrough: number; gap?: { expected: number; received: number } }> {
    const acknowledged = record._panelInputSequence.get(panelId) ?? 0;
    const expected = acknowledged + 1;
    if (sequence > acknowledged && sequence !== expected) {
      return { acknowledgedThrough: acknowledged, gap: { expected, received: sequence } };
    }
    if (
      !this.matchesExpectedRuntime(record, expectedHostInstanceId, expectedSessionEpoch) ||
      sequence <= acknowledged
    )
      return { acknowledgedThrough: acknowledged };
    const proc = record.proc;
    const result = await proc.sendPanelInput(panelId, sequence, data);
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

  async readInternalProbe(
    sessionId: SessionId,
    command: PiRpcCommand,
    expected: { hostInstanceId: string; sessionEpoch: number },
  ): Promise<PiRpcResponse> {
    if (commandPolicy(command).class !== "read_only") {
      throw new Error(`Internal probe cannot execute ${command.type}`);
    }
    const record = this.sessions.get(sessionId);
    if (
      !record?.proc ||
      !record._procReady ||
      record.status !== "ready" ||
      record.availability !== "available" ||
      record._hostTransition ||
      !this.matchesExpectedRuntime(record, expected.hostInstanceId, expected.sessionEpoch)
    ) {
      throw new Error("Session changed before internal probe");
    }
    const proc = record.proc;
    const response = await proc.sendCommand(command);
    if (
      record.proc !== proc ||
      !this.matchesExpectedRuntime(record, expected.hostInstanceId, expected.sessionEpoch)
    ) {
      throw new Error("Session changed during internal probe");
    }
    return response;
  }

  /**
   * Sole renderer-command admission path. Every valid request settles with an
   * explicit disposition; malformed requests alone throw.
   */
  async executeRendererCommand(
    sessionId: SessionId,
    requestInput: RendererCommandRequest,
  ): Promise<CommandSettlement> {
    const parsed = RendererCommandRequestSchema.safeParse(requestInput);
    if (!parsed.success) throw new Error(`Invalid command request: ${parsed.error.message}`);
    const request = parsed.data;
    const policy = commandPolicy(request.command);
    const record = this.sessions.get(sessionId);
    // Automatic read probes do not turn a view-only visit into an
    // interaction. Every state-changing command does.
    if (policy.class !== "read_only") this.markActivationVisitInteracted(record);
    const base = {
      requestId: request.requestId,
      ...(request.intentId ? { intentId: request.intentId } : {}),
      commandType: request.command.type,
      commandClass: policy.class,
      hostInstanceId: request.expectedHostInstanceId,
      sessionEpoch: request.expectedSessionEpoch,
    } as const;
    const notExecuted = (message: string): CommandSettlement => ({
      type: "response",
      command: request.command.type,
      success: false,
      error: message,
      ...base,
      disposition: "not_executed",
    });

    if (policy.submissionOnly) return notExecuted("Text submissions must use session.submit");
    if (record?._closing) return notExecuted("Session close preparation is in progress");
    if (
      !record?.proc ||
      !record._procReady ||
      record.status !== "ready" ||
      record.availability !== "available" ||
      record._hostTransition
    ) {
      return notExecuted(`No available SDK host for session ${sessionId}`);
    }
    if (
      !this.matchesExpectedRuntime(
        record,
        request.expectedHostInstanceId,
        request.expectedSessionEpoch,
      )
    ) {
      return notExecuted("Session changed before command dispatch");
    }

    const proc = record.proc;
    const needsIntent = commandNeedsIntent(request.command);
    let dispatched = false;
    let retained: RetainedCommandIntent | undefined;
    if (needsIntent && request.intentId) {
      const duplicate = record._retainedCommandIntents.get(request.intentId);
      if (duplicate) {
        return {
          ...notExecuted("Command intent is already retained for review"),
          disposition: duplicate.dispatched ? "outcome_unknown" : "not_executed",
        };
      }
      retained = { request: structuredClone(request), dispatched: false };
      record._retainedCommandIntents.set(request.intentId, retained);
      record._mutationSequence++;
    }

    try {
      const response = await proc.sendCommand(request.command, {
        ...(request.uiSurface ? { uiSurface: request.uiSurface } : {}),
        onDispatched: () => {
          dispatched = true;
          if (retained) retained.dispatched = true;
        },
      });
      if (
        this.sessions.get(sessionId) !== record ||
        record._closing ||
        record._dead ||
        record.proc !== proc ||
        record.availability !== "available" ||
        record._hostTransition !== undefined
      ) {
        throw new Error("Session lifecycle changed before command settlement");
      }
      if (
        policy.class !== "replacement" &&
        !this.matchesExpectedRuntime(
          record,
          request.expectedHostInstanceId,
          request.expectedSessionEpoch,
        )
      ) {
        throw new Error("Session epoch changed before command settlement");
      }
      if (request.intentId && record._retainedCommandIntents.delete(request.intentId)) {
        record._mutationSequence++;
      }
      const currentIdentity = {
        hostInstanceId: proc.hostInstanceId ?? request.expectedHostInstanceId,
        sessionEpoch: proc.sessionEpoch,
      };
      return {
        ...response,
        command: request.command.type,
        ...base,
        disposition: "completed",
        hostInstanceId: request.expectedHostInstanceId,
        sessionEpoch: request.expectedSessionEpoch,
        ...(policy.class === "replacement" && response.success
          ? { successorIdentity: currentIdentity }
          : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!dispatched) {
        if (request.intentId && record._retainedCommandIntents.delete(request.intentId)) {
          record._mutationSequence++;
        }
        return notExecuted(message);
      }
      const lifecycleRetired =
        this.sessions.get(sessionId) !== record || record._closing || record._dead;
      if (lifecycleRetired) {
        return {
          type: "response",
          command: request.command.type,
          success: false,
          error: message,
          ...base,
          disposition: "outcome_unknown",
        };
      }
      if (!retained) {
        return {
          type: "response",
          command: request.command.type,
          success: false,
          error: message,
          ...base,
          disposition: "outcome_unknown",
        };
      }
      const restorationId = `ambiguous-command:${request.intentId}`;
      if (!retained.recoveryPublished) {
        retained.recoveryPublished = true;
        const restoration: RuntimeRecord & { type: "queue_restoration" } = {
          type: "queue_restoration",
          restorationId,
          steering: [],
          followUp: request.sourceText?.trim() ? [request.sourceText] : [],
          originalAttachments: [],
          commandDescription: `${request.command.type} may have completed before its acknowledgement was lost. Review before retrying.`,
          requiresReview: true,
        };
        record._restorations.set(restorationId, structuredClone(restoration));
        record._mutationSequence++;
        this.onQueueRestoration(sessionId, restoration);
      }
      return {
        type: "response",
        command: request.command.type,
        success: false,
        error: message,
        ...base,
        disposition: "outcome_unknown",
        restorationId,
      };
    }
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
          requiresReview: true,
        };
        record._restorations.set(restorationId, structuredClone(restoration));
        this.onQueueRestoration(sessionId, restoration);
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
    const freshSnapshot = await proc.requestSnapshot();
    if (record._closing) {
      throw new Error("Session close preparation began before reload dispatch");
    }
    if (
      this.sessions.get(sessionId) !== record ||
      record._closing ||
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
    this.installSnapshot(record, freshSnapshot);
    if (
      !freshSnapshot.isIdle ||
      freshSnapshot.hostFacts.submitting ||
      freshSnapshot.hostFacts.custodyCount > 0
    )
      throw new Error("Wait for the current response to finish before reloading.");
    if (record._closing || this.sessions.get(sessionId) !== record) {
      throw new Error("Session close preparation began before reload dispatch");
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

  private assertWorktreeRespawnEligible(record: SessionRecord): void {
    if (
      this.sessions.get(record.sessionId) !== record ||
      record._closing ||
      record._dead ||
      record.availability !== "available" ||
      record._hostTransition !== undefined ||
      record.snapshot?.isIdle === false ||
      record.snapshot?.hostFacts.submitting === true ||
      (record.snapshot?.hostFacts.custodyCount ?? 0) > 0 ||
      record._retainedIntents.size > 0 ||
      record._retainedCommandIntents.size > 0 ||
      record._pendingUnifiedSubmits.size > 0
    ) {
      throw new Error("Wait for active and retained work before moving the session to a worktree");
    }
  }

  async setWorktreeAndRespawn(
    sessionId: SessionId,
    worktreePath: string,
    piPath: string,
    env?: Record<string, string>,
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    this.markActivationVisitInteracted(record);
    this.assertWorktreeRespawnEligible(record);
    await this.runRestart(record, async () => {
      this.assertWorktreeRespawnEligible(record);
      const old = record.worktreePath;
      const proc = record.proc;
      if (proc && record._procReady) {
        const freshSnapshot = await proc.requestSnapshot();
        if (record.proc !== proc) throw new Error("Session changed before worktree respawn");
        this.assertWorktreeRespawnEligible(record);
        this.installSnapshot(record, freshSnapshot);
        this.assertWorktreeRespawnEligible(record);
      }
      this.assertWorktreeRespawnEligible(record);
      this.captureEditorRecovery(record);
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
        if (
          this.sessions.get(sessionId) !== record ||
          record._closing ||
          record._dead ||
          record.availability !== "available"
        ) {
          throw new Error("Session lifecycle changed while worktree respawn was activating");
        }
      } catch (error) {
        if (this.sessions.get(sessionId) === record && !record._closing) {
          record.worktreePath = old;
        }
        throw error;
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

  async prepareClose(
    sessionId: SessionId,
    force = false,
  ): Promise<{ reviewToken: string; checkpoint: unknown }> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    record._closing = true;
    if (!record.proc || !record._procReady) {
      // Failed/cold sessions have no live authority to freeze. A local token is
      // sufficient because every renderer ingress path is already fenced by
      // `_closing`; this keeps failed tabs explicitly closeable.
      const reviewToken = crypto.randomUUID();
      record._closeToken = {
        value: reviewToken,
        mutationSequence: record._mutationSequence,
        force,
      };
      return {
        reviewToken,
        checkpoint: {
          force,
          snapshot: record.snapshot,
          editor: record.snapshot?.editor,
          catalog: record.snapshot?.catalog,
          intents: [...record._retainedIntents.values()].map((item) => structuredClone(item)),
          commandIntents: [...record._retainedCommandIntents.values()].map((item) =>
            structuredClone(item),
          ),
          restorations: [...record._restorations.values()].map((item) => structuredClone(item)),
          dialogs: [...record._pendingUiRequests.values()].map((item) => structuredClone(item)),
          unifiedSubmissions: [...record._pendingUnifiedSubmits.values()].map((item) =>
            structuredClone(item),
          ),
          panels: [...record._openPanels.values()].map((item) => structuredClone(item)),
          rendererGeneration: record._rendererGeneration,
        },
      };
    }
    const closeProc = record.proc;
    let hostReviewToken: string | undefined;
    try {
      // Freeze ingress in both main and the authoritative host before exposing
      // review state. The host checkpoint is therefore the causal boundary.
      const hostCheckpoint = await closeProc.prepareClose(force);
      const reviewToken = hostCheckpoint["token"];
      if (typeof reviewToken !== "string") throw new Error("Invalid host close checkpoint");
      hostReviewToken = reviewToken;
      if (force) {
        for (const retained of record._retainedIntents.values()) {
          if (["in_custody", "consumed"].includes(retained.disposition)) {
            retained.disposition = "outcome_unknown";
            retained.updatedAt = Date.now();
          }
        }
      }
      record._closeToken = {
        value: reviewToken,
        mutationSequence: record._mutationSequence,
        force,
      };
      const panels = [...record._openPanels.values()].map((open) => {
        if (open.type !== "panel_open") return structuredClone(open);
        const panel = record._panelCheckpoints.get(open.panelId);
        return {
          ...structuredClone(open),
          ...(panel?.mode ? { mode: panel.mode } : {}),
          ...(panel?.lastData ? { lastData: panel.lastData } : {}),
        };
      });
      return {
        reviewToken,
        checkpoint: {
          force,
          host: structuredClone(hostCheckpoint),
          snapshot: record.snapshot,
          editor: record.snapshot?.editor,
          catalog: record.snapshot?.catalog,
          intents: [...record._retainedIntents.values()].map((item) => structuredClone(item)),
          commandIntents: [...record._retainedCommandIntents.values()].map((item) =>
            structuredClone(item),
          ),
          restorations: [...record._restorations.values()].map((item) => structuredClone(item)),
          dialogs: [...record._pendingUiRequests.values()].map((item) => structuredClone(item)),
          unifiedSubmissions: [...record._pendingUnifiedSubmits.values()].map((item) =>
            structuredClone(item),
          ),
          panels,
          rendererGeneration: record._rendererGeneration,
        },
      };
    } catch (error) {
      if (hostReviewToken) await closeProc.cancelClose(hostReviewToken).catch(() => false);
      record._closing = false;
      record._closeToken = undefined;
      throw error;
    }
  }

  async cancelClose(sessionId: SessionId, token: string): Promise<{ cancelled: boolean }> {
    const record = this.sessions.get(sessionId);
    if (!record?._closeToken || record._closeToken.value !== token) return { cancelled: false };
    const cancelled = record.proc ? await record.proc.cancelClose(token) : true;
    if (!cancelled) return { cancelled: false };
    record._closeToken = undefined;
    record._closing = false;
    return { cancelled: true };
  }

  async confirmClose(
    sessionId: SessionId,
    token: string,
  ): Promise<{ closed: boolean; reason?: string }> {
    const record = this.sessions.get(sessionId);
    if (!record) return { closed: true };
    if (!record._closeToken || record._closeToken.value !== token) {
      return { closed: false, reason: "Close checkpoint token is no longer current" };
    }
    if (record._closeToken.mutationSequence !== record._mutationSequence) {
      if (record.proc) await record.proc.cancelClose(token).catch(() => false);
      record._closeToken = undefined;
      record._closing = false;
      return { closed: false, reason: "Session changed after the close checkpoint" };
    }
    if (record.proc) {
      let confirmed: { valid: boolean };
      try {
        confirmed = await record.proc.confirmClose(token);
      } catch (error) {
        await record.proc.cancelClose(token).catch(() => false);
        record._closeToken = undefined;
        record._closing = false;
        return { closed: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (!confirmed.valid) {
        await record.proc.cancelClose(token).catch(() => false);
        record._closeToken = undefined;
        record._closing = false;
        return { closed: false, reason: "Host state changed after the close checkpoint" };
      }
    }
    this.closeSession(sessionId);
    return { closed: true };
  }

  closeSession(sessionId: SessionId): void {
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
    this.installSnapshot(record, freshSnapshot, false);
    const snapshot = record.snapshot;
    const editor = snapshot?.editor;
    const hasOpenPanel = [...record._openPanels.values()].some(
      (event) => event.type === "panel_open",
    );
    const safe =
      snapshot !== undefined &&
      editor !== undefined &&
      snapshot.hostInstanceId === proc.hostInstanceId &&
      snapshot.sessionEpoch === proc.sessionEpoch &&
      snapshot.isIdle &&
      !snapshot.isStreaming &&
      !snapshot.isCompacting &&
      !snapshot.isRetrying &&
      !snapshot.isBashRunning &&
      snapshot.pendingMessageCount === 0 &&
      snapshot.steering.length === 0 &&
      snapshot.followUp.length === 0 &&
      !snapshot.hostFacts.submitting &&
      !snapshot.hostFacts.actualCompaction &&
      !snapshot.hostFacts.navigation &&
      snapshot.hostFacts.pendingDialogs === 0 &&
      snapshot.hostFacts.custodyCount === 0 &&
      snapshot.catalog.notifications.length === 0 &&
      Object.keys(snapshot.catalog.statuses).length === 0 &&
      Object.keys(snapshot.catalog.widgets).length === 0 &&
      !snapshot.catalog.workingVisible &&
      snapshot.catalog.workingMessage === undefined &&
      editor.text === "" &&
      editor.attachments.length === 0 &&
      editor.conflictText === undefined &&
      editor.alternateConflictText === undefined &&
      (editor.additionalConflictCandidates?.length ?? 0) === 0 &&
      !record._closing &&
      !record._dead &&
      !record._hostTransition &&
      !record._restartChain &&
      !record._lifecycleUiLease &&
      !record._pendingRendererCancellation &&
      record._retainedIntents.size === 0 &&
      record._pendingSubmissionPromises.size === 0 &&
      record._retainedCommandIntents.size === 0 &&
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
          requiresReview: true,
        };
        record._restorations.set(restoration.restorationId, structuredClone(restoration));
        this.onQueueRestoration(sessionId, restoration);
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
    if (!record || record.sessionFile) return;
    const resolved = path.resolve(sessionFile);
    if (this.byFile.has(resolved)) return;
    record.sessionFile = sessionFile;
    this.byFile.set(resolved, sessionId);
  }

  updateSessionFile(sessionId: SessionId, sessionFile: string | undefined): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    if (record.sessionFile && this.byFile.get(path.resolve(record.sessionFile)) === sessionId) {
      this.byFile.delete(path.resolve(record.sessionFile));
    }
    record.sessionFile = sessionFile;
    if (sessionFile) this.byFile.set(path.resolve(sessionFile), sessionId);
  }

  private async acquireLock(record: SessionRecord): Promise<void> {
    if (!record.sessionFile || record._hasLock) return;
    try {
      await lockfile.lock(record.sessionFile, {
        retries: 0,
        realpath: false,
        lockfilePath: `${record.sessionFile}.lock`,
        onCompromised: (error: Error) => {
          console.warn(`[session-registry] Session lock compromised: ${error.message}`);
          record._hasLock = false;
        },
      });
      record._hasLock = true;
    } catch {
      record._hasLock = false;
      this.onPanelEvent(record.sessionId, {
        type: "session_warning",
        message: "Session file is open in another pi instance. Changes may conflict.",
      });
    }
  }

  private releaseLock(record: SessionRecord): void {
    if (!record._hasLock || !record.sessionFile) return;
    void lockfile
      .unlock(record.sessionFile, {
        lockfilePath: `${record.sessionFile}.lock`,
        realpath: false,
      })
      .catch(() => {});
    record._hasLock = false;
  }

  getSession(sessionId: SessionId): SessionRecord | undefined {
    return this.sessions.get(sessionId);
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
