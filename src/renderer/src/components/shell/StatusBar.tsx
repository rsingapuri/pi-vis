import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { AnsiText } from "../../lib/ansi.js";
import { formatCost, formatTokens } from "../../lib/format.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import "./StatusBar.css";

interface StatusBarProps {
  sessionId: SessionId | null;
}

function abbreviateHome(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

// Per-session status footer rendered directly under the composer — the GUI
// equivalent of pi's terminal footer: workspace line, usage line (from
// polled session stats; pi's own TUI footer is not sent over RPC), then one
// line per extension status segment.  Segment text may contain ANSI colors.
export function StatusBar({ sessionId }: StatusBarProps): React.ReactElement | null {
  const session = useSessionsStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));

  if (!session) return null;

  const stats = session.stats;
  const usageParts: string[] = [];
  if (stats?.tokens) {
    usageParts.push(`↑${formatTokens(stats.tokens.input)}`);
    usageParts.push(`↓${formatTokens(stats.tokens.output)}`);
    if (stats.tokens.cacheRead > 0) usageParts.push(`R${formatTokens(stats.tokens.cacheRead)}`);
  }
  if (stats?.cost != null) usageParts.push(formatCost(stats.cost));
  if (stats?.contextUsage?.percent != null) {
    const pct = stats.contextUsage.percent.toFixed(1);
    usageParts.push(`${pct}%/${formatTokens(stats.contextUsage.contextWindow)}`);
  }

  const segmentLines: { key: string; text: string }[] = [];
  for (const [key, text] of session.statusSegments) {
    text.split("\n").forEach((line, i) => {
      segmentLines.push({ key: `${key}:${i}`, text: line });
    });
  }

  return (
    <div className="statusbar">
      <div className="statusbar__line">{abbreviateHome(session.workspacePath)}</div>
      {usageParts.length > 0 && (
        <div className="statusbar__line statusbar__line--split">
          <span>{usageParts.join(" ")}</span>
          {session.currentModel && <span className="statusbar__model">{session.currentModel}</span>}
        </div>
      )}
      {segmentLines.map(({ key, text }) => (
        <div key={key} className="statusbar__line">
          <AnsiText text={text} />
        </div>
      ))}
    </div>
  );
}
