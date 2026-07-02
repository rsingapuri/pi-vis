import type { ExtensionUpdate } from "@shared/updates.js";
import type React from "react";
import { useCallback, useState } from "react";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUpdatesStore } from "../../stores/updates-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconChevronDown, IconClose } from "../common/icons.js";
import "./UpdateBanner.css";

export function UpdateBanner({
  floating = false,
}: {
  floating?: boolean;
}): React.ReactElement | null {
  const status = useUpdatesStore((s) => s.status);
  const dismiss = useUpdatesStore((s) => s.dismiss);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const [showDetails, setShowDetails] = useState(false);

  // NOTE: all hooks (including useCallbacks) have to live above the
  // guards below — they short-circuit on most renders, and a hook
  // count change between renders throws "Rendered more hooks than
  // during the previous render" (white-screens the banner, which is
  // outside the session ErrorBoundary).
  const handleDismiss = useCallback(() => {
    if (status?.pi.latest) {
      void updateSettings({ lastDismissedPiVersion: status.pi.latest });
    }
    dismiss();
  }, [dismiss, status?.pi.latest, updateSettings]);

  const handleUpdateAll = useCallback(() => {
    window.dispatchEvent(new CustomEvent("pivis:run-update", { detail: { target: "all" } }));
  }, []);

  const handleUpdatePi = useCallback(() => {
    window.dispatchEvent(new CustomEvent("pivis:run-update", { detail: { target: "pi" } }));
  }, []);

  const handleUpdateExtension = useCallback((source: string) => {
    window.dispatchEvent(
      new CustomEvent("pivis:run-update", {
        detail: { target: { extension: source } },
      }),
    );
  }, []);

  if (!settings.updateCheckEnabled) return null;

  if (!status) return null;

  if (status.pi.updateAvailable && status.pi.latest) {
    if (settings.lastDismissedPiVersion === status.pi.latest) return null;
  }

  const hasPiUpdate = status.pi.updateAvailable;
  const extUpdates = status.extensions.filter((e) => e.updateAvailable);

  if (!hasPiUpdate && extUpdates.length === 0) return null;

  // Only offer a Details disclosure when there's something to expand
  // beyond what the banner line already says (i.e. extension updates,
  // whose names/versions are otherwise invisible). A lone pi update is
  // fully described by the banner text.
  const hasDetails = extUpdates.length > 0;

  const parts: string[] = [];
  if (hasPiUpdate && status.pi.latest) {
    parts.push(`pi ${status.pi.latest} available`);
  }
  if (extUpdates.length > 0) {
    parts.push(
      extUpdates.length === 1 ? "1 extension update" : `${extUpdates.length} extension updates`,
    );
  }

  return (
    <div className={`update-banner${floating ? " update-banner--floating" : ""}`}>
      <div className="update-banner__row">
        <FadeText className="update-banner__text">{parts.join(" — ")}</FadeText>
        <div className="update-banner__actions">
          <button type="button" className="update-banner__btn" onClick={handleUpdateAll}>
            Update now
          </button>
          {hasDetails && (
            <button
              type="button"
              className="update-banner__btn update-banner__btn--secondary update-banner__chevron-btn"
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
              aria-controls="update-banner-details"
              aria-label={showDetails ? "Hide details" : "Show details"}
            >
              <IconChevronDown
                className={`update-banner__chevron${showDetails ? " update-banner__chevron--up" : ""}`}
              />
            </button>
          )}
        </div>
        <button
          type="button"
          className="update-banner__close icon-btn"
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          <IconClose />
        </button>
      </div>
      {showDetails && hasDetails && (
        <ul id="update-banner-details" className="update-banner__details">
          {hasPiUpdate && status.pi.latest && (
            <li className="update-banner__detail-row">
              <FadeText className="update-banner__detail-name">pi</FadeText>
              <span className="update-banner__detail-version">
                {status.pi.current} → {status.pi.latest}
              </span>
              <button
                type="button"
                className="update-banner__btn update-banner__btn--secondary update-banner__detail-btn"
                onClick={handleUpdatePi}
              >
                Update
              </button>
            </li>
          )}
          {extUpdates.map((ext) => (
            <ExtensionRow key={ext.source} ext={ext} onUpdate={handleUpdateExtension} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExtensionRow({
  ext,
  onUpdate,
}: {
  ext: ExtensionUpdate;
  onUpdate: (source: string) => void;
}): React.ReactElement {
  const version =
    ext.current && ext.latest
      ? `${ext.current} → ${ext.latest}`
      : ext.latest
        ? `→ ${ext.latest}`
        : ext.current
          ? ext.current
          : ext.kind;
  return (
    <li className="update-banner__detail-row">
      <FadeText className="update-banner__detail-name" title={ext.source}>
        {ext.name}
      </FadeText>
      <span className="update-banner__detail-version">{version}</span>
      <button
        type="button"
        className="update-banner__btn update-banner__btn--secondary update-banner__detail-btn"
        onClick={() => onUpdate(ext.source)}
      >
        Update
      </button>
    </li>
  );
}
