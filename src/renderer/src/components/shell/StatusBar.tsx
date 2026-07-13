import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { AnsiText } from "../../lib/ansi.js";
import { authoritySnapshotFor, useSessionsStore } from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";
import "./StatusBar.css";

interface StatusBarProps {
  sessionId: SessionId | null;
}

function abbreviateHome(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

// Per-session status footer rendered directly under the composer. One quiet
// line: workspace path (left) + active model (right), then one line per
// extension status segment (ANSI-colored). The raw token/cost/context sigils
// that used to live here (`↑3.2K ↓290 R2.2K …`) moved into the title bar's
// ContextMeter dropdown — the footer no longer duplicates them.
export function StatusBar({ sessionId }: StatusBarProps): React.ReactElement | null {
  const session = useSessionsStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));

  const snapshot = authoritySnapshotFor(session);
  if (!session || !snapshot) return null;

  const segmentLines: { key: string; text: string }[] = [];
  for (const [key, text] of Object.entries(snapshot.catalog.statuses)) {
    text.split("\n").forEach((line, i) => {
      segmentLines.push({ key: `${key}:${i}`, text: line });
    });
  }

  return (
    <div className="statusbar">
      <div className="statusbar__line statusbar__line--split">
        <FadeText head className="statusbar__path">
          {abbreviateHome(session.workspacePath)}
        </FadeText>
        {snapshot.model && (
          <FadeText className="statusbar__model">
            {snapshot.model.id}
            {snapshot.model.provider ? ` [${snapshot.model.provider}]` : ""}
          </FadeText>
        )}
      </div>
      {segmentLines.map(({ key, text }) => (
        <div key={key} className="statusbar__line">
          <AnsiText text={text} />
        </div>
      ))}
    </div>
  );
}
