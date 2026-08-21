import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { IconStop } from "../common/icons.js";
import "./SessionStopButton.css";

/**
 * SessionStopButton — the desktop answer to Ctrl+C / Esc.
 *
 * A labeled stop pill shown above the composer whenever the session's main
 * turn is streaming, whether or not any subagents are running. Uses the same
 * host escape path as Esc (`abortSession`), never fakes local state, and
 * disappears when the authoritative snapshot says streaming ended.
 */
export function SessionStopButton({ sessionId }: { sessionId: SessionId }): React.ReactElement | null {
  const isStreaming = useSessionsStore(
    (s) =>
      s.sessions.get(sessionId)?.authorityProjection?.authoritativeSnapshot?.sdk.isStreaming ??
      false,
  );

  if (!isStreaming) return null;

  return (
    <div className="session-stop">
      <button
        type="button"
        className="session-stop__btn"
        aria-label="Stop generating"
        title="Interrupt the current response (same as Esc)"
        onClick={() => useSessionsStore.getState().abortSession(sessionId)}
      >
        <IconStop size="0.75em" />
        <span>Stop generating</span>
      </button>
    </div>
  );
}
