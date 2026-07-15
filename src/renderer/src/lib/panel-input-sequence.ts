import type { SessionId } from "@shared/ids.js";

interface PanelSequenceState {
  next: number;
  acknowledgedThrough: number;
}

const sequences = new Map<string, PanelSequenceState>();

function key(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
): string {
  return `${sessionId}:${hostInstanceId}:${sessionEpoch}:${panelId}`;
}

/** Monotonic for one host-bound panel identity across React remounts. */
export function nextPanelInputSequence(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
): number {
  const identity = key(sessionId, hostInstanceId, sessionEpoch, panelId);
  const state = sequences.get(identity) ?? { next: 0, acknowledgedThrough: 0 };
  state.next += 1;
  sequences.set(identity, state);
  return state.next;
}

/** Apply a cumulative host acknowledgement. Regressions are ignored. */
export function acknowledgePanelInput(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
  acknowledgedThrough: number,
): number {
  const identity = key(sessionId, hostInstanceId, sessionEpoch, panelId);
  const state = sequences.get(identity) ?? { next: 0, acknowledgedThrough: 0 };
  state.acknowledgedThrough = Math.max(state.acknowledgedThrough, acknowledgedThrough);
  sequences.set(identity, state);
  return state.acknowledgedThrough;
}

export function panelAcknowledgedThrough(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
): number {
  return (
    sequences.get(key(sessionId, hostInstanceId, sessionEpoch, panelId))?.acknowledgedThrough ?? 0
  );
}

/** A definitely unconsumed repaint-fenced input may reuse the host's next sequence. */
export function resetPanelInputSequenceToAcknowledged(
  sessionId: SessionId,
  hostInstanceId: string,
  sessionEpoch: number,
  panelId: number,
  acknowledgedThrough: number,
): void {
  const identity = key(sessionId, hostInstanceId, sessionEpoch, panelId);
  const state = sequences.get(identity) ?? { next: 0, acknowledgedThrough: 0 };
  state.acknowledgedThrough = Math.max(state.acknowledgedThrough, acknowledgedThrough);
  state.next = state.acknowledgedThrough;
  sequences.set(identity, state);
}

/** A host gap is explicit: keep the local sequence and let the panel resend only after review. */
export function panelInputGapMessage(gap: { expected: number; received: number }): string {
  return `Panel input gap (expected ${gap.expected}, received ${gap.received}). Input was not replayed.`;
}

/** Retire every old identity for this numeric panel. */
export function forgetPanelInputSequence(sessionId: SessionId, panelId: number): void {
  const prefix = `${sessionId}:`;
  const suffix = `:${panelId}`;
  for (const identity of sequences.keys()) {
    if (identity.startsWith(prefix) && identity.endsWith(suffix)) sequences.delete(identity);
  }
}
