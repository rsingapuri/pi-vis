import type { SessionId } from "@shared/ids.js";
import {
  type PanelInputIdentity,
  type PendingPanelInput,
  bufferPanelInput,
  reconcilePanelInputBuffer,
} from "./panel-input-buffer.js";

interface PanelSequenceState {
  sessionId: SessionId;
  identity: PanelInputIdentity;
  generation: number;
  next: number;
  acknowledgedThrough: number;
  /**
   * One delivery chain per host-bound panel identity. Keeping the chain here,
   * rather than in a React component, preserves ordering while the panel is
   * unmounted during a session switch.
   */
  tail: Promise<void>;
  blocked: PanelInputIdentity | null;
  pending: PendingPanelInput | null;
  /**
   * Retirement is a tombstone while queued/in-flight attempts settle. Their
   * late acknowledgements must not recreate or mutate a successor stream.
   */
  retired: boolean;
  attempts: number;
}

const sequences = new Map<string, PanelSequenceState>();
let panelInputGeneration = 0;

export interface PanelInputGenerationHandle {
  readonly identityKey: string;
  readonly generation: number;
}

function key(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
): string {
  return JSON.stringify([sessionId, hostInstanceId, sessionEpoch, panelId]);
}

function stateFor(sessionId: SessionId, identity: PanelInputIdentity): PanelSequenceState | null {
  const identityKey = key(
    sessionId,
    identity.hostInstanceId,
    identity.sessionEpoch,
    identity.panelId,
  );
  const existing = sequences.get(identityKey);
  if (existing?.retired) return null;
  const state = existing ?? {
    sessionId,
    identity: { ...identity },
    generation: ++panelInputGeneration,
    next: 0,
    acknowledgedThrough: 0,
    tail: Promise.resolve(),
    blocked: null,
    pending: null,
    retired: false,
    attempts: 0,
  };
  sequences.set(identityKey, state);
  return state;
}

function stateForHandle(handle: PanelInputGenerationHandle): PanelSequenceState | null {
  const state = sequences.get(handle.identityKey);
  return state && !state.retired && state.generation === handle.generation ? state : null;
}

function handleFor(identityKey: string, state: PanelSequenceState): PanelInputGenerationHandle {
  return { identityKey, generation: state.generation };
}

/** Capture the currently active generation for post-await identity checks. */
export function capturePanelInputGeneration(
  sessionId: SessionId,
  identity: PanelInputIdentity,
): PanelInputGenerationHandle | null {
  const identityKey = key(
    sessionId,
    identity.hostInstanceId,
    identity.sessionEpoch,
    identity.panelId,
  );
  const state = stateFor(sessionId, identity);
  return state ? handleFor(identityKey, state) : null;
}

export function isPanelInputGenerationCurrent(handle: PanelInputGenerationHandle): boolean {
  return stateForHandle(handle) !== null;
}

/** Explicitly begin a new stream, even when the host reuses the exact tuple. */
export function activatePanelInputIdentity(
  sessionId: SessionId,
  identity: PanelInputIdentity,
): PanelInputGenerationHandle {
  const identityKey = key(
    sessionId,
    identity.hostInstanceId,
    identity.sessionEpoch,
    identity.panelId,
  );
  const previous = sequences.get(identityKey);
  if (previous) retireState(identityKey, previous);
  const state: PanelSequenceState = {
    sessionId,
    identity: { ...identity },
    generation: ++panelInputGeneration,
    next: 0,
    acknowledgedThrough: 0,
    tail: Promise.resolve(),
    blocked: null,
    pending: null,
    retired: false,
    attempts: 0,
  };
  sequences.set(identityKey, state);
  return handleFor(identityKey, state);
}

/**
 * Ensure a store-projected live panel has an input generation.
 *
 * A legacy panel event may retire an identity immediately before an authority
 * attach retains that same host/epoch/panel tuple.  `stateFor()` intentionally
 * does not revive tombstones because a late callback from the retired xterm
 * also reaches it.  The sessions store, however, has the authoritative live
 * projection and may explicitly establish the successor generation here.
 */
export function ensurePanelInputIdentity(
  sessionId: SessionId,
  identity: PanelInputIdentity,
): PanelInputGenerationHandle {
  const identityKey = key(
    sessionId,
    identity.hostInstanceId,
    identity.sessionEpoch,
    identity.panelId,
  );
  const existing = sequences.get(identityKey);
  if (existing && !existing.retired) return handleFor(identityKey, existing);
  return activatePanelInputIdentity(sessionId, identity);
}

/** Monotonic for one host-bound panel identity across React remounts. */
export function nextPanelInputSequence(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
  handle?: PanelInputGenerationHandle,
): number {
  const identity = { hostInstanceId, sessionEpoch, panelId };
  const state = handle ? stateForHandle(handle) : stateFor(sessionId, identity);
  if (!state) return 0;
  state.next += 1;
  return state.next;
}

/** Apply a cumulative host acknowledgement. Regressions are ignored. */
export function acknowledgePanelInput(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
  acknowledgedThrough: number,
  handle?: PanelInputGenerationHandle,
): number {
  const identity = { hostInstanceId, sessionEpoch, panelId };
  const state = handle ? stateForHandle(handle) : stateFor(sessionId, identity);
  if (!state) return acknowledgedThrough;
  state.acknowledgedThrough = Math.max(state.acknowledgedThrough, acknowledgedThrough);
  // An attach/keyframe acknowledgement may be the first sequence information
  // observed by this renderer. Never allocate below a cumulative host ack.
  state.next = Math.max(state.next, state.acknowledgedThrough);
  return state.acknowledgedThrough;
}

export function panelAcknowledgedThrough(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
): number {
  const state = sequences.get(key(sessionId, hostInstanceId, sessionEpoch, panelId));
  return state?.retired ? 0 : (state?.acknowledgedThrough ?? 0);
}

/** A definitely unconsumed repaint-fenced input may reuse the host's next sequence. */
export function resetPanelInputSequenceToAcknowledged(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
  acknowledgedThrough: number,
  handle?: PanelInputGenerationHandle,
): void {
  const identity = { hostInstanceId, sessionEpoch, panelId };
  const state = handle ? stateForHandle(handle) : stateFor(sessionId, identity);
  if (!state) return;
  // This is an explicit no-delivery rebase, not an ordinary cumulative ack.
  // Main resets its gate when a successor renderer attaches while the
  // long-lived host panel can retain a larger cumulative sequence. Allow the
  // caller to lower the local allocation point so it can probe main at the
  // advertised expected sequence; a later high ack then rebases to the host's
  // retained watermark without losing the current chunk.
  state.acknowledgedThrough = acknowledgedThrough;
  state.next = state.acknowledgedThrough;
}

/** Serialize one input attempt across React unmount/remount boundaries. */
export function enqueuePanelInputAttempt(
  sessionId: SessionId,
  identity: PanelInputIdentity,
  attempt: (handle: PanelInputGenerationHandle) => Promise<void>,
): void {
  const state = stateFor(sessionId, identity);
  if (!state) return;
  const identityKey = key(
    sessionId,
    identity.hostInstanceId,
    identity.sessionEpoch,
    identity.panelId,
  );
  const handle = handleFor(identityKey, state);
  state.attempts += 1;
  const next = state.tail
    .catch(() => {})
    .then(async () => {
      if (state.retired || sequences.get(identityKey) !== state) return;
      await attempt(handle);
    })
    .finally(() => {
      state.attempts -= 1;
      if (state.retired && state.attempts === 0 && sequences.get(identityKey) === state) {
        sequences.delete(identityKey);
      }
    });
  // Keep a settled tail even if a caller accidentally lets an exception escape;
  // one failed transport attempt must not poison all later keyboard input.
  state.tail = next.catch(() => {});
}

/** Fence and retain a complete xterm input chunk for this exact owner. */
export function queuePanelInput(
  sessionId: SessionId,
  identity: PanelInputIdentity,
  data: string,
  attemptedSequence?: number,
): void {
  const state = stateFor(sessionId, identity);
  if (!state) return;
  state.blocked = identity;
  state.pending = bufferPanelInput(state.pending, identity, data, attemptedSequence);
}

export function isPanelInputBlocked(sessionId: SessionId, identity: PanelInputIdentity): boolean {
  return stateFor(sessionId, identity)?.blocked != null;
}

/**
 * Release same-owner input only after the caller has reconstructed and drained
 * the terminal. Successor identities can never inherit predecessor keystrokes.
 */
export function releaseQueuedPanelInput(
  sessionId: SessionId,
  identity: PanelInputIdentity,
  ready: boolean,
  acknowledgedThrough?: number,
): readonly string[] {
  const state = stateFor(sessionId, identity);
  if (!state) return [];
  if (acknowledgedThrough !== undefined) {
    // The ready projection/keyframe is also the cumulative host input proof.
    // Rebase allocation before releasing retained bytes so a key arriving in
    // the render-to-effect gap is assigned watermark + 1, never replayed at a
    // sequence the host has already consumed.
    state.acknowledgedThrough = Math.max(state.acknowledgedThrough, acknowledgedThrough);
    state.next = Math.max(state.next, state.acknowledgedThrough);
  }
  const pending = state.pending;
  const reconciled = reconcilePanelInputBuffer(identity, ready, state.blocked, state.pending);
  state.blocked = reconciled.blocked;
  state.pending = reconciled.pending;
  if (acknowledgedThrough === undefined || !pending) return reconciled.replay;
  return reconciled.replay.filter((_, index) => {
    const attemptedSequence = pending.attemptedSequences[index];
    return attemptedSequence === undefined || acknowledgedThrough < attemptedSequence;
  });
}

/** A host gap is explicit: fence the panel and reconstruct before replaying input. */
export function panelInputGapMessage(gap: { expected: number; received: number }): string {
  return `Panel input gap (expected ${gap.expected}, received ${gap.received}). Input is waiting for panel reconstruction.`;
}

function retireState(identityKey: string, state: PanelSequenceState): void {
  if (state.retired) return;
  state.retired = true;
  state.blocked = null;
  state.pending = null;
  if (state.attempts === 0 && sequences.get(identityKey) === state) sequences.delete(identityKey);
}

/** Retire one exact host-bound stream without permitting late recreation. */
export function retirePanelInputIdentity(sessionId: SessionId, identity: PanelInputIdentity): void {
  const identityKey = key(
    sessionId,
    identity.hostInstanceId,
    identity.sessionEpoch,
    identity.panelId,
  );
  const state = sequences.get(identityKey);
  if (state) retireState(identityKey, state);
}

/** Retire every old identity for this numeric panel. */
export function forgetPanelInputSequence(sessionId: SessionId, panelId: number): void {
  for (const [identityKey, state] of sequences) {
    if (state.sessionId === sessionId && state.identity.panelId === panelId) {
      retireState(identityKey, state);
    }
  }
}

/** Retire every panel-input stream owned by a removed renderer session. */
export function forgetPanelInputSession(sessionId: SessionId): void {
  for (const [identityKey, state] of sequences) {
    if (state.sessionId === sessionId) retireState(identityKey, state);
  }
}
