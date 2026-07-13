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

  it("enables only the acknowledged repaint revision", () => {
    const panels = createPanelReconstruction();
    panels.open(9);
    const repaint = panels.requireRepaint(9);

    expect(panels.acknowledge(9, repaint.revision - 1)).toBe(false);
    expect(panels.acceptsInput(9, repaint.revision)).toBe(false);
    expect(panels.acknowledge(9, repaint.revision)).toBe(true);
    expect(panels.acceptsInput(9, repaint.revision)).toBe(true);
    expect(panels.acceptsInput(9, repaint.revision - 1)).toBe(false);
  });
});
