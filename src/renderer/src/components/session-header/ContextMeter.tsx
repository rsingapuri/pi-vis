import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { formatCost, formatTokens } from "../../lib/format.js";
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

  const pct = stats?.contextUsage?.percent != null ? Math.round(stats.contextUsage.percent) : null;
  const ring = pct ?? 0;
  const used = stats?.contextUsage?.tokens ?? null;
  const windowTok = stats?.contextUsage?.contextWindow ?? null;

  const cacheHitRate = useMemo(() => {
    const t = stats?.tokens;
    if (!t) return null;
    const reads = t.cacheRead ?? 0;
    const base = (t.input ?? 0) + reads;
    if (base <= 0) return null;
    return reads / base;
  }, [stats?.tokens]);

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
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
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
                  {" "}
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
          {stats?.tokens && (
            <dl className="context-dropdown__rows">
              <Row label="Input">{formatTokens(stats.tokens.input)}</Row>
              <Row label="Output">{formatTokens(stats.tokens.output)}</Row>
              <Row label="Cache read">{formatTokens(stats.tokens.cacheRead)}</Row>
              <Row label="Cache hit rate">
                {cacheHitRate != null ? `${Math.round(cacheHitRate * 100)}%` : "—"}
              </Row>
            </dl>
          )}
          {stats?.cost != null && (
            <div className="context-dropdown__row context-dropdown__cost">
              <span className="context-dropdown__label">Cost</span>
              <span className="context-dropdown__value">{formatCost(stats.cost)}</span>
            </div>
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
