import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { formatTokens } from "../../lib/format.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import "./ContextMeter.css";

/**
 * Circular context-usage ring with a click-to-open details dropdown.
 *
 * Reads `get_session_stats` data from the store:
 *  - `contextUsage.{tokens, contextWindow, percent}` drives the ring.
 *  - `tokens.{input, output, cacheRead, cacheWrite}` populates the dropdown
 *    breakdown + a derived cache-hit rate.
 *
 * The dropdown is an in-flow card (not a modal) anchored under the ring,
 * right-aligned to the controls cluster edge. It claims ESC + closes on
 * outside click, matching the model/thinking dropdowns.
 */
export function ContextMeter({ sessionId }: { sessionId: SessionId }): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const stats = session?.stats;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEscapeClaim(open);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const pct = stats?.contextUsage?.percent != null ? Math.round(stats.contextUsage.percent) : null;
  const ring = pct ?? 0;
  const used = stats?.contextUsage?.tokens ?? null;
  const windowTok = stats?.contextUsage?.contextWindow ?? null;

  const cacheHitRate = useMemo(() => {
    const t = stats?.tokens;
    if (!t) return null;
    const reads = t.cacheRead ?? 0;
    const base = (t.input ?? 0) + reads;
    if (reads <= 0 || base <= 0) return null;
    return reads / base;
  }, [stats?.tokens]);

  const tokenRows = useMemo(() => {
    const t = stats?.tokens;
    if (!t) return [];
    return [
      { label: "Input", value: formatTokens(t.input ?? 0) },
      { label: "Output", value: formatTokens(t.output ?? 0) },
      t.cacheRead > 0 ? { label: "Cache read", value: formatTokens(t.cacheRead) } : null,
      t.cacheWrite > 0 ? { label: "Cache write", value: formatTokens(t.cacheWrite) } : null,
      cacheHitRate != null && cacheHitRate > 0
        ? { label: "Cache hit rate", value: `${Math.round(cacheHitRate * 100)}%` }
        : null,
    ].filter((row): row is { label: string; value: string } => row !== null);
  }, [cacheHitRate, stats?.tokens]);

  const danger = (pct ?? 0) >= 90;
  const warn = !danger && (pct ?? 0) >= 80;
  const tone = danger ? "context-ring--danger" : warn ? "context-ring--warn" : "";

  // Ring geometry
  const size = 16;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (ring / 100) * circ;

  return (
    <div className="context-meter-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`context-ring ${tone} ${open ? "context-ring--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={pct !== null ? `${pct}% context used` : "Context usage"}
        aria-label={pct !== null ? `${pct}% context used` : "Context usage"}
        aria-expanded={open}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
          focusable="false"
        >
          <circle
            className="context-ring__track"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
          />
          <circle
            className="context-ring__fill"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </button>

      {open && (
        <div className="context-dropdown" role="dialog" aria-label="Context usage details">
          {/* Context headline + linear meter (the ring, unrolled). */}
          <div className="context-dropdown__head">
            <span className="context-dropdown__label">Context</span>
            <span className="context-dropdown__value">
              {used != null ? formatTokens(used) : "—"}
              {windowTok != null && used != null && (
                <span className="context-dropdown__dim">
                  {" / "}
                  {formatTokens(windowTok)}
                </span>
              )}
              {pct !== null && (
                <span
                  className={`context-dropdown__pct${danger ? " context-dropdown__pct--danger" : warn ? " context-dropdown__pct--warn" : ""}`}
                >
                  {pct}%
                </span>
              )}
            </span>
          </div>
          <div
            className={`context-dropdown__meter${danger ? " context-dropdown__meter--danger" : warn ? " context-dropdown__meter--warn" : ""}`}
            aria-hidden
          >
            <div
              className="context-dropdown__meter-fill"
              style={{ width: `${Math.min(100, ring)}%` }}
            />
          </div>
          {tokenRows.length > 0 && (
            <dl className="context-dropdown__rows">
              {tokenRows.map((row) => (
                <Row key={row.label} label={row.label}>
                  {row.value}
                </Row>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="context-dropdown__row">
      <dt className="context-dropdown__label">{label}</dt>
      <dd className="context-dropdown__value">{children}</dd>
    </div>
  );
}
