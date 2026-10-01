export interface PanelInputIdentity {
  hostInstanceId: string;
  sessionEpoch: number;
  panelId: number;
}

export interface PendingPanelInput extends PanelInputIdentity {
  chunks: string[];
  /** Sequence used by a transport attempt whose reply was lost. A later
   * keyframe watermark at or above it proves that chunk already executed. */
  attemptedSequences: Array<number | undefined>;
  bytes: number;
}

export const MAX_PENDING_PANEL_INPUT_BYTES = 64 * 1024;

export function samePanelInputIdentity(
  left: PanelInputIdentity,
  right: PanelInputIdentity,
): boolean {
  return (
    left.hostInstanceId === right.hostInstanceId &&
    left.sessionEpoch === right.sessionEpoch &&
    left.panelId === right.panelId
  );
}

/** Append one complete xterm input chunk without ever crossing owner identity. */
export function bufferPanelInput(
  pending: PendingPanelInput | null,
  identity: PanelInputIdentity,
  data: string,
  attemptedSequence?: number,
): PendingPanelInput | null {
  const next =
    pending && samePanelInputIdentity(pending, identity)
      ? pending
      : { ...identity, chunks: [], attemptedSequences: [], bytes: 0 };
  if (next.bytes + data.length > MAX_PENDING_PANEL_INPUT_BYTES) {
    return next.bytes > 0 ? next : null;
  }
  return {
    ...next,
    chunks: [...next.chunks, data],
    attemptedSequences: [...next.attemptedSequences, attemptedSequence],
    bytes: next.bytes + data.length,
  };
}

/**
 * Fence stale owners and release a same-owner blocked queue only after input is
 * authoritative again. The caller dispatches `replay` through its sequencer.
 */
export function reconcilePanelInputBuffer(
  identity: PanelInputIdentity,
  ready: boolean,
  blocked: PanelInputIdentity | null,
  pending: PendingPanelInput | null,
): {
  blocked: PanelInputIdentity | null;
  pending: PendingPanelInput | null;
  replay: readonly string[];
} {
  const currentBlocked = blocked && samePanelInputIdentity(blocked, identity) ? blocked : null;
  const currentPending = pending && samePanelInputIdentity(pending, identity) ? pending : null;
  if (!ready) return { blocked: currentBlocked, pending: currentPending, replay: [] };
  return {
    blocked: null,
    pending: null,
    replay: currentPending?.chunks ?? [],
  };
}
