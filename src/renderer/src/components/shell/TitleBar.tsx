import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { SessionHeader } from "../session-header/SessionHeader.js";
import "./TitleBar.css";

// Title bar — a fixed-height chrome strip spanning the full width of the
// window. Holds the OS drag region and (when a session is active) the
// SessionHeader. The height is a constant 3rem regardless of content;
// see TitleBar.css and App.css for the enforcing rules.
export function TitleBar(): React.ReactElement {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  return (
    <div className="titlebar">
      {activeSessionId ? <SessionHeader sessionId={activeSessionId as SessionId} /> : null}
    </div>
  );
}
