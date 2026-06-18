import type { SessionId } from "@shared/ids.js";
import { SessionControls } from "./SessionHeader.js";
import "./SessionSubBar.css";

interface SessionSubBarProps {
  sessionId: SessionId;
}

/**
 * A ~32px flex row below the title bar that carries the secondary
 * session controls (model picker, thinking level, changes badge,
 * context meter) when the session header is in compact mode.
 * Only the name + worktree chip stay in the 38px title bar.
 */
export function SessionSubBar({ sessionId }: SessionSubBarProps): React.ReactElement {
  return (
    <div className="session-sub-bar">
      <SessionControls sessionId={sessionId} />
    </div>
  );
}
