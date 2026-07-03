import type React from "react";
import { useCallback, useEffect } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { readyPromptKey, useAppUpdatesStore } from "../../stores/app-updates-store.js";
import { IconClose } from "../common/icons.js";
import "./AppUpdatePrompt.css";

export function AppUpdatePrompt(): React.ReactElement | null {
  const status = useAppUpdatesStore((s) => s.status);
  const dismissedReadyFor = useAppUpdatesStore((s) => s.dismissedReadyFor);
  const dismissReadyPrompt = useAppUpdatesStore((s) => s.dismissReadyPrompt);

  const promptKey = readyPromptKey(status);
  const ready = promptKey !== null && dismissedReadyFor !== promptKey;
  useEscapeClaim(ready);

  const handleInstall = useCallback(() => {
    void window.pivis.invoke("appUpdate.install", undefined);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      dismissReadyPrompt();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dismissReadyPrompt, ready]);

  if (!ready || !status) return null;

  const version = status.releaseName ?? "a new version";

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard Escape is claimed globally while the prompt is open
    <div
      className="app-update-prompt-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) dismissReadyPrompt();
      }}
    >
      <div
        className="app-update-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-title"
      >
        <div className="app-update-prompt__header">
          <h2 id="app-update-title" className="app-update-prompt__title">
            Pi-Vis update ready
          </h2>
          <button
            type="button"
            className="app-update-prompt__close icon-btn"
            onClick={dismissReadyPrompt}
            aria-label="Close"
          >
            <IconClose />
          </button>
        </div>
        <p className="app-update-prompt__body">
          {version} has been downloaded. Restart Pi-Vis to finish installing it.
        </p>
        <div className="app-update-prompt__actions">
          <button
            type="button"
            className="app-update-prompt__btn app-update-prompt__btn--secondary"
            onClick={dismissReadyPrompt}
          >
            Later
          </button>
          <button type="button" className="app-update-prompt__btn" onClick={handleInstall}>
            Restart and install
          </button>
        </div>
      </div>
    </div>
  );
}
