import type React from "react";
import { useRef } from "react";

const SPINNER_PERIOD_MS = 800;

type SpinnerStyle = React.CSSProperties & { "--spinner-sync-delay": string };

function animationNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function getSyncedSpinnerStyle(now = animationNow()): SpinnerStyle {
  const phase = ((now % SPINNER_PERIOD_MS) + SPINNER_PERIOD_MS) % SPINNER_PERIOD_MS;
  return { "--spinner-sync-delay": `${-phase}ms` };
}

export function useSyncedSpinnerStyle(active = true): React.CSSProperties | undefined {
  const styleRef = useRef<SpinnerStyle | undefined>(undefined);
  const activeRef = useRef(false);

  if (active && (!activeRef.current || styleRef.current == null)) {
    styleRef.current = getSyncedSpinnerStyle();
  }
  activeRef.current = active;

  return active ? styleRef.current : undefined;
}

export function Spinner({
  className,
  style,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>): React.ReactElement {
  const syncedStyle = useSyncedSpinnerStyle();
  return (
    <span
      {...props}
      className={className ? `spinner ${className}` : "spinner"}
      style={{ ...syncedStyle, ...style }}
    />
  );
}
