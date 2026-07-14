import { describe, expect, it } from "vitest";
import { createPanelReconstruction } from "./panel-reconstruction.mjs";

describe("panel reconstruction fence", () => {
  it("requires a repaint after reload/reattach before panel input", () => {
    const panels = createPanelReconstruction();
    expect(panels.open(4)).toEqual({ revision: 1, repaintRequired: true });
    expect(panels.acceptsInput(4, 1)).toBe(false);

    // A new renderer has no terminal framebuffer. A new baseline deliberately
    // remains repaint-required rather than pretending an ANSI tail is one.
    const baseline = panels.requireRepaint(4);
    expect(baseline).toEqual({ revision: 2, repaintRequired: true });
    expect(panels.acceptsInput(4, 1)).toBe(false);
    expect(panels.acceptsInput(4, 2)).toBe(false);
  });

  it("releases an acknowledged capture and captures a fresh later repaint", () => {
    const panels = createPanelReconstruction();
    panels.open(9);
    const repaint = panels.requireRepaint(9);
    panels.write(9, "first frame");

    expect(panels.keyframe(9)).toBeUndefined();
    expect(panels.seal(9)).toEqual({ ansi: "first frame", revision: repaint.revision });
    // Ordinary output before acknowledgement extends the complete image, but
    // remains subject to the same hard capture bound.
    const laterDelta = "bounded later delta".repeat(100);
    panels.write(9, laterDelta);
    expect(panels.keyframe(9)).toEqual({
      ansi: `first frame${laterDelta}`,
      revision: repaint.revision,
    });
    expect(panels.pendingKeyframe(9)).toEqual({
      ansi: `first frame${laterDelta}`,
      revision: repaint.revision,
    });
    expect(panels.acknowledge(9, repaint.revision - 1)).toBe(false);
    expect(panels.acknowledge(9, repaint.revision)).toBe(true);
    expect(panels.acceptsInput(9, repaint.revision)).toBe(true);
    // The acknowledged frame belongs to the authority publication, not a
    // retained host framebuffer. A later remount must capture fresh bytes.
    expect(panels.keyframe(9)).toBeUndefined();

    const later = panels.requireRepaint(9);
    panels.write(9, "second frame");
    expect(panels.seal(9)).toEqual({ ansi: "second frame", revision: later.revision });
    expect(panels.acceptsInput(9, repaint.revision)).toBe(false);
  });

  it("discards an overflowing repaint instead of retaining a truncated keyframe", () => {
    const panels = createPanelReconstruction({ maxRepaintBytes: 16 });
    panels.open(3);
    const repaint = panels.requireRepaint(3);
    panels.write(3, "x".repeat(17));

    expect(panels.seal(3)).toBeUndefined();
    expect(panels.keyframe(3)).toBeUndefined();
    expect(panels.acknowledge(3, repaint.revision)).toBe(false);
    expect(panels.acceptsInput(3, repaint.revision)).toBe(false);

    const retry = panels.requireRepaint(3);
    panels.write(3, "bounded");
    expect(panels.seal(3)).toEqual({ ansi: "bounded", revision: retry.revision });
  });
});
