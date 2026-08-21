import type { SessionId } from "@shared/ids.js";
import { SUBAGENT_ASYNC_WIDGET_KEY } from "@shared/pi-protocol/subagents.js";
import type React from "react";
import { AnsiText } from "../../lib/ansi.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";
import { SubagentsFleet } from "./SubagentsFleet.js";
import "./Dock.css";

/**
 * Dock — the above-composer tray.
 *
 * Collects every above-composer notification/control into one bordered,
 * rounded card that connects to the composer's input box (they read as a
 * stacked pair of cards): extension `setWidget` text today, with a reserved
 * trailing slot for a future Input/Extension toggle. Items keep a stable
 * order so nothing jumps position as siblings appear/disappear, and wrap to
 * additional rows when narrow.
 *
 * Returns `null` when it has no items, so there is never a phantom empty box
 * above the composer.
 */
export function Dock({ sessionId }: { sessionId: SessionId }): React.ReactElement | null {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const widgets = session?.widgets;

  // Stable ordering: extension widget items by sorted key.
  const widgetKeys = widgets ? [...widgets.keys()].sort() : [];

  if (widgetKeys.length === 0) return null;

  return (
    <div className="dock">
      {widgetKeys.map((key) => {
        const lines = widgets!.get(key) ?? [];
        if (key === SUBAGENT_ASYNC_WIDGET_KEY) {
          // Key by session so the fleet's last-good snapshot resets on session switch.
          return <SubagentsFleet key={`${sessionId}:${key}`} lines={lines} />;
        }
        if (lines.length === 0) return null;
        return <WidgetItem key={key} lines={lines} />;
      })}
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
