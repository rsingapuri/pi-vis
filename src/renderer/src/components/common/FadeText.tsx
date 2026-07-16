// Shared single-line truncation treatment: instead of an ellipsis, text that
// doesn't fit fades out at the trailing edge, and hovering it (or a parent
// marked `.fade-scope`) glides the text sideways to reveal the tail, then
// glides back on leave. Non-overflowing text renders untouched — the mask and
// the marquee only engage when the measured content is wider than the box.
//
// Usage: replace `<span className="x">{text}</span>` (where .x ellipsized)
// with `<FadeText className="x">{text}</FadeText>`; the site class keeps its
// layout/color duties (flex, min-width: 0, color) and FadeText owns clipping.

import { useLayoutEffect, useRef } from "react";
import "./FadeText.css";

interface FadeTextProps {
  children: React.ReactNode;
  className?: string;
  /** Preserve whitespace runs (pre-formatted content, e.g. widget lines). */
  pre?: boolean;
  /**
   * Truncate the head instead of the tail: at rest the END of the text is
   * visible and the leading edge fades (for values whose tail matters, e.g.
   * long directory paths); hovering reveals the head. Replaces the old
   * `direction: rtl` left-ellipsis hack.
   */
  head?: boolean;
  title?: string;
}

// Reveal glide pacing: proportional to the hidden distance so short and long
// overflows both read at roughly the same readable speed. Do not clamp the
// maximum duration: doing so makes very long labels accelerate dramatically.
const REVEAL_PX_PER_SECOND = 48;
const REVEAL_MIN_MS = 450;

type FadeTextMeasurement = {
  outer: HTMLSpanElement;
  inner: HTMLSpanElement;
};

// A large transcript can mount thousands of FadeTexts in one React commit.
// Measuring and then styling each instance from its own layout effect causes
// read/write/read layout thrashing over the entire transcript. Queue every
// instance into one frame, read all widths first, and only then write styles.
const pendingMeasurements = new Map<HTMLSpanElement, FadeTextMeasurement>();
let measurementFramePending = false;

function applyMeasurement(outer: HTMLSpanElement, overflow: number): void {
  if (overflow > 1) {
    outer.dataset.overflow = "true";
    outer.style.setProperty("--fade-shift", `${-overflow}px`);
    const ms = Math.max(REVEAL_MIN_MS, (overflow / REVEAL_PX_PER_SECOND) * 1000);
    outer.style.setProperty("--fade-dur", `${ms}ms`);
  } else if (outer.dataset.overflow) {
    delete outer.dataset.overflow;
    outer.style.removeProperty("--fade-shift");
    outer.style.removeProperty("--fade-dur");
  }
}

/** Flush the shared read-then-write measurement batch. Exported for a
 * deterministic regression test; production calls it from one animation frame. */
export function flushFadeTextMeasurements(): void {
  measurementFramePending = false;
  const targets = [...pendingMeasurements.values()];
  pendingMeasurements.clear();

  // Do not interleave these loops. One style write before the next rect read
  // would reintroduce the forced-layout cascade this batch exists to prevent.
  const measured = targets.map(({ outer, inner }) => ({
    outer,
    overflow: inner.getBoundingClientRect().width - outer.getBoundingClientRect().width,
  }));
  for (const { outer, overflow } of measured) applyMeasurement(outer, overflow);
}

export function queueFadeTextMeasurement(outer: HTMLSpanElement, inner: HTMLSpanElement): void {
  pendingMeasurements.set(outer, { outer, inner });
  if (measurementFramePending) return;
  measurementFramePending = true;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flushFadeTextMeasurements);
  } else {
    // Tests/non-browser renderers still get one coalesced measurement without
    // requiring a ResizeObserver or animation-frame shim.
    queueMicrotask(flushFadeTextMeasurements);
  }
}

function cancelFadeTextMeasurement(outer: HTMLSpanElement): void {
  pendingMeasurements.delete(outer);
}

export function FadeText({ children, className, pre = false, head = false, title }: FadeTextProps) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = (): void => queueFadeTextMeasurement(outer, inner);

    // jsdom (unit tests) has no ResizeObserver — degrade to one queued measure
    // so many instances still preserve the production batching invariant.
    if (typeof ResizeObserver === "undefined") {
      measure();
      return () => cancelFadeTextMeasurement(outer);
    }

    // Observing both catches container resizes (outer) and content changes —
    // new text, font swap — (inner) without effect re-runs.
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    measure();
    return () => {
      ro.disconnect();
      cancelFadeTextMeasurement(outer);
    };
  }, []);

  return (
    <span
      ref={outerRef}
      className={`fade-text${pre ? " fade-text--pre" : ""}${head ? " fade-text--head" : ""}${className ? ` ${className}` : ""}`}
      title={title}
    >
      <span ref={innerRef} className="fade-text__inner">
        {children}
      </span>
    </span>
  );
}
