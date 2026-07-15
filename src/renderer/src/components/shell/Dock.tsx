import type { SessionId } from "@shared/ids.js";
import type { ExtensionUpdate } from "@shared/updates.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { AnsiText } from "../../lib/ansi.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUpdatesStore } from "../../stores/updates-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconChevronDown, IconClose } from "../common/icons.js";
import "./Dock.css";

/**
 * Dock — the above-composer tray.
 *
 * Collects every above-composer notification/control into one bordered,
 * rounded card that connects to the composer's input box (they read as a
 * stacked pair of cards): extension `setWidget` text and the update
 * notification today, with a reserved trailing slot for a future
 * Input/Extension toggle. Items keep a stable order (widgets left, update
 * right) so nothing jumps position as siblings appear/disappear, and wrap to
 * additional rows when narrow.
 *
 * Returns `null` when it has no items, so there is never a phantom empty box
 * above the composer.
 *
 * Replaces the old full-width stacked boxes (the floating UpdateBanner card +
 * `.composer__widget-strip`) that carried independent hairline dividers and had
 * no shared design language.
 */
export function Dock({ sessionId }: { sessionId: SessionId }): React.ReactElement | null {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const widgets = session?.widgets;

  // Stable ordering: extension widget items by sorted key (left), then the
  // update item (right). A reserved trailing slot for the future
  // Input/Extension toggle keeps its position stable.
  const widgetKeys = widgets ? [...widgets.keys()].sort() : [];

  const showUpdate = useShowUpdate();

  if (widgetKeys.length === 0 && !showUpdate) return null;

  return (
    <div className="dock">
      {widgetKeys.map((key) => {
        const lines = widgets!.get(key) ?? [];
        if (lines.length === 0) return null;
        return <WidgetItem key={key} lines={lines} />;
      })}
      {showUpdate && <UpdateItem />}
    </div>
  );
}

/** An extension widget's lines (from `setWidget`), as plain text in the tray. */
function WidgetItem({ lines }: { lines: string[] }): React.ReactElement {
  return (
    <div className="dock__widget">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: widget lines are appended and stable per key
        <FadeText key={i} pre className="dock__widget-line">
          <AnsiText text={line} />
        </FadeText>
      ))}
    </div>
  );
}

/** Whether an update chip should be shown (mirrors UpdateBanner's guards). */
function useShowUpdate(): boolean {
  const status = useUpdatesStore((s) => s.status);
  const updateCheckEnabled = useSettingsStore((s) => s.settings.updateCheckEnabled);
  const lastDismissedPiVersion = useSettingsStore((s) => s.settings.lastDismissedPiVersion);

  if (!updateCheckEnabled) return false;
  if (!status) return false;
  if (status.pi.updateAvailable && status.pi.latest) {
    if (lastDismissedPiVersion === status.pi.latest) return false;
  }
  const hasPiUpdate = status.pi.updateAvailable;
  const extUpdates = status.extensions.filter((e) => e.updateAvailable);
  return hasPiUpdate || extUpdates.length > 0;
}

/** The update item: a collapsed summary line with an inline "Update now"
 * action and a disclosure affordance; expanded detail opens as a floating
 * popover anchored above the item (never reflows the tray height). */
function UpdateItem(): React.ReactElement {
  const status = useUpdatesStore((s) => s.status)!;
  const dismiss = useUpdatesStore((s) => s.dismiss);
  const updateSettings = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);

  const handleDismiss = useCallback(() => {
    if (status.pi.latest) {
      void updateSettings({ lastDismissedPiVersion: status.pi.latest });
    }
    dismiss();
  }, [dismiss, status.pi.latest, updateSettings]);

  const handleUpdateAll = useCallback(() => {
    window.dispatchEvent(new CustomEvent("pivis:run-update", { detail: { target: "all" } }));
  }, []);

  const handleUpdatePi = useCallback(() => {
    window.dispatchEvent(new CustomEvent("pivis:run-update", { detail: { target: "pi" } }));
  }, []);

  const handleUpdateExtension = useCallback((source: string) => {
    window.dispatchEvent(
      new CustomEvent("pivis:run-update", { detail: { target: { extension: source } } }),
    );
  }, []);

  const hasPiUpdate = status.pi.updateAvailable;
  const extUpdates = status.extensions.filter((e) => e.updateAvailable);
  // Only offer disclosure when there's something to expand beyond the pill
  // line (extension updates, whose names/versions are otherwise invisible).
  const hasDetails = extUpdates.length > 0;

  const summaryBits: string[] = [];
  if (hasPiUpdate && status.pi.latest) summaryBits.push(`↑ pi ${status.pi.latest}`);
  if (extUpdates.length > 0) summaryBits.push(`+${extUpdates.length} ext`);

  // Claim ESC + outside-click while the popover is open so a background
  // streaming session isn't aborted, and the popover closes cleanly.
  useEscapeClaim(open);
  const chipRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (chipRef.current && !chipRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="dock__update" ref={chipRef}>
      <span className="dock__update-text">{summaryBits.join(" · ")}</span>
      <button type="button" className="dock__btn" onClick={handleUpdateAll}>
        Update now
      </button>
      {hasDetails && (
        <button
          type="button"
          className="dock__btn dock__btn--secondary dock__chevron-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
        >
          <IconChevronDown className={`dock__chevron${open ? " dock__chevron--up" : ""}`} />
        </button>
      )}
      <button
        type="button"
        className="dock__dismiss icon-btn"
        onClick={handleDismiss}
        aria-label="Dismiss"
      >
        <IconClose />
      </button>
      {open && hasDetails && (
        <div className="dock__update-popover">
          <ul className="dock__update-details">
            {hasPiUpdate && status.pi.latest && (
              <li className="dock__update-detail-row">
                <FadeText className="dock__update-detail-name">pi</FadeText>
                <span className="dock__update-detail-version">
                  {status.pi.current} → {status.pi.latest}
                </span>
                <button
                  type="button"
                  className="dock__btn dock__btn--secondary dock__update-detail-btn"
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
        </div>
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
    <li className="dock__update-detail-row">
      <FadeText className="dock__update-detail-name" title={ext.source}>
        {ext.name}
      </FadeText>
      <span className="dock__update-detail-version">{version}</span>
      <button
        type="button"
        className="dock__btn dock__btn--secondary dock__update-detail-btn"
        onClick={() => onUpdate(ext.source)}
      >
        Update
      </button>
    </li>
  );
}
