import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { Markdown } from "../../lib/markdown.js";
import { useChangelogStore } from "../../stores/changelog-store.js";
import { IconClose } from "../common/icons.js";
import "./ChangelogModal.css";

export function ChangelogModal(): React.ReactElement | null {
  const open = useChangelogStore((s) => s.open);
  const markdown = useChangelogStore((s) => s.markdown);
  const closeChangelog = useChangelogStore((s) => s.closeChangelog);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Claim ESC while the changelog modal is open so a background streaming
  // session isn't aborted (ESC closes the modal).
  useEscapeClaim(open);

  const handleClose = useCallback(() => {
    closeChangelog();
  }, [closeChangelog]);

  // Close on Escape; autofocus the Close button so keyboard focus is on the
  // modal when it opens (Escape works without first clicking inside).
  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleClose]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by Escape listener above
    <div
      className="changelog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="changelog-modal" role="dialog" aria-modal="true" aria-label="Changelog">
        <div className="changelog-modal__header">
          <span className="changelog-modal__title">Changelog</span>
          <button
            ref={closeBtnRef}
            type="button"
            className="changelog-modal__close icon-btn"
            onClick={handleClose}
            aria-label="Close changelog"
          >
            <IconClose />
          </button>
        </div>
        <div className="changelog-modal__body">
          <Markdown>{markdown}</Markdown>
        </div>
        <div className="changelog-modal__footer">
          <button type="button" className="changelog-modal__btn" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
