import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { AnsiText } from "../../lib/ansi.js";
import { useUpdatesStore } from "../../stores/updates-store.js";
import { IconClose } from "../common/icons.js";
import "./UpdateProgress.css";

export function UpdateProgress(): React.ReactElement | null {
  const activeRun = useUpdatesStore((s) => s.activeRun);
  const setActiveRun = useUpdatesStore((s) => s.setActiveRun);
  const status = useUpdatesStore((s) => s.status);
  const scrollRef = useRef<HTMLPreElement>(null);

  // Claim ESC while the update modal is up so a background streaming
  // session isn't aborted (ESC has no close handler here today — pre-
  // existing — but the claim still prevents the abort).
  useEscapeClaim(!!activeRun);

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (scrollRef.current && activeRun) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeRun]);

  const handleDone = useCallback(() => {
    setActiveRun(null);
  }, [setActiveRun]);

  if (!activeRun) return null;

  const isDone = activeRun.done === true;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by App
    <div
      className="update-progress-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && isDone) handleDone();
      }}
    >
      <div className="update-progress">
        <div className="update-progress__header">
          <span className="update-progress__title">{isDone ? "Update complete" : "Updating…"}</span>
          <button
            type="button"
            className="update-progress__close icon-btn"
            onClick={isDone ? handleDone : undefined}
            disabled={!isDone}
            aria-label="Close"
          >
            <IconClose />
          </button>
        </div>
        <pre ref={scrollRef} className="update-progress__output">
          {activeRun.lines.length > 0 ? (
            activeRun.lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static list, no reordering
              <AnsiText key={i} text={line} />
            ))
          ) : (
            <span className="update-progress__waiting">Waiting for output…</span>
          )}
        </pre>
        {isDone && (
          <div className="update-progress__footer">
            <span className="update-progress__success">
              Updated — new sessions will use the latest version. Reopen existing sessions to
              upgrade them.
            </span>
            <button type="button" className="update-progress__btn" onClick={handleDone}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
