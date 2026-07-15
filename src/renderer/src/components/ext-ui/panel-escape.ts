/** Minimal terminal surface used only for routed Escape delivery. */
export interface EscapeInputTerminal {
  input(data: string, wasUserInput?: boolean): void;
}

export interface EscapePanelIdentity {
  id: number;
  hostInstanceId: string;
  sessionEpoch: number;
  authority?: boolean;
  inputEnabled?: boolean;
  renderRevision?: number;
  syncState?: "following" | "synchronizing" | "unavailable";
}

/** Authority panels accept input only after their acknowledged keyframe. */
export function isPanelEscapeReady(panel: EscapePanelIdentity | null): boolean {
  return (
    panel?.authority === true &&
    panel.syncState === "following" &&
    panel.inputEnabled === true &&
    panel.renderRevision !== undefined
  );
}

function samePanelIdentity(a: EscapePanelIdentity, b: EscapePanelIdentity): boolean {
  return (
    a.id === b.id && a.hostInstanceId === b.hostInstanceId && a.sessionEpoch === b.sessionEpoch
  );
}

/**
 * Deliver one consumed browser Escape through xterm's existing onData path.
 * Identity is required, but readiness is deliberately left to that path: a
 * same-owner fenced panel boundedly buffers Escape until its repaint follows.
 */
export function routePanelEscape(
  panel: EscapePanelIdentity | null,
  terminalPanel: EscapePanelIdentity | null,
  terminal: EscapeInputTerminal | null,
): boolean {
  if (!panel || !terminalPanel || !terminal) return false;
  if (!samePanelIdentity(panel, terminalPanel)) return false;
  terminal.input("\x1b", true);
  return true;
}
