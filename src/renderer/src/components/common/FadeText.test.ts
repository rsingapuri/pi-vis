import { afterEach, describe, expect, it, vi } from "vitest";
import { queueFadeTextMeasurement } from "./FadeText.js";

function fakeSpan(
  name: string,
  width: number,
  events: string[],
  initiallyOverflowing = false,
): HTMLSpanElement {
  const dataset: Record<string, string> = initiallyOverflowing ? { overflow: "true" } : {};
  const styles = new Map<string, string>();
  return {
    dataset,
    getBoundingClientRect: () => {
      events.push(`read:${name}`);
      return { width } as DOMRect;
    },
    style: {
      setProperty: (property: string, value: string) => {
        events.push(`write:${name}:${property}:${value}`);
        styles.set(property, value);
      },
      removeProperty: (property: string) => {
        events.push(`write:${name}:remove:${property}`);
        const previous = styles.get(property) ?? "";
        styles.delete(property);
        return previous;
      },
    },
  } as unknown as HTMLSpanElement;
}

describe("FadeText measurement batching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads every queued width before applying any style writes", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const events: string[] = [];
    const outerA = fakeSpan("outer-a", 100, events);
    const innerA = fakeSpan("inner-a", 180, events);
    const outerB = fakeSpan("outer-b", 100, events, true);
    const innerB = fakeSpan("inner-b", 80, events);

    queueFadeTextMeasurement(outerA, innerA);
    queueFadeTextMeasurement(outerB, innerB);

    expect(frames).toHaveLength(1);
    frames[0]?.(0);

    expect(events.slice(0, 4)).toEqual([
      "read:inner-a",
      "read:outer-a",
      "read:inner-b",
      "read:outer-b",
    ]);
    expect(events.slice(4).every((event) => event.startsWith("write:"))).toBe(true);
    expect(outerA.dataset.overflow).toBe("true");
    expect(outerB.dataset.overflow).toBeUndefined();
  });
});
