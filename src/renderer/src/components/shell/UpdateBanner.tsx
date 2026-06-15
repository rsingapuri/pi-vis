import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useUpdatesStore } from "../../stores/updates-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import "./UpdateBanner.css";

export function UpdateBanner(): React.ReactElement | null {
  const status = useUpdatesStore((s) => s.status);
  const dismiss = useUpdatesStore((s) => s.dismiss);
  const settings = useSettingsStore((s) => s.settings);
  const [showDetails, setShowDetails] = useState(false);

  // If update checking is disabled, never show
  if (!settings.updateCheckEnabled) return null;

  if (!status) return null;

  // Check if this version was already dismissed
  if (status.pi.updateAvailable && status.pi.latest) {
    if (settings.lastDismissedPiVersion === status.pi.latest) return null;
  }

  // Check if there are any updates at all
  const hasPiUpdate = status.pi.updateAvailable;
  const extUpdates = status.extensions.filter((e) => e.updateAvailable);
  const hasExtUpdates = extUpdates.length > 0;

  if (!hasPiUpdate && !hasExtUpdates) return null;

  const handleDismiss = useCallback(() => {
    dismiss();
  }, [dismiss]);

  const handleUpdateNow = useCallback(() => {
    // Open the update progress modal by triggering the update
    window.dispatchEvent(new CustomEvent("pivis:run-update", { detail: { target: "all" } }));
  }, []);

  const handleDetails = useCallback(() => {
    window.dispatchEvent(new CustomEvent("pivis:open-settings"));
    setShowDetails(true);
  }, []);

  // Build the message
  const parts: string[] = [];
  if (hasPiUpdate && status.pi.latest) {
    parts.push(`pi ${status.pi.latest} available`);
  }
  if (hasExtUpdates) {
    parts.push(`+${extUpdates.length} extension update${extUpdates.length > 1 ? "s" : ""}`);
  }

  return (
    <div className="update-banner">
      <span className="update-banner__text">{parts.join(" — ")}</span>
      <div className="update-banner__actions">
        <button type="button" className="update-banner__btn" onClick={handleUpdateNow}>
          Update now
        </button>
        <button
          type="button"
          className="update-banner__btn update-banner__btn--secondary"
          onClick={handleDetails}
        >
          Details
        </button>
        <button
          type="button"
          className="update-banner__close"
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
