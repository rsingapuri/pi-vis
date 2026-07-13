import { describe, expect, it } from "vitest";
import {
  PanelEventSchema,
  PanelOpenEventSchema,
  UnifiedPanelResetEventSchema,
} from "./panel-events.js";

// Pins the wire shapes the unified-TUI feature added: a `unified` flag on
// panel_open (persistent panel vs custom overlay) and a dedicated
// `unified_panel_reset` event for the host-gone-on-/reload teardown path
// (distinct from panel_clear_all so each is handled independently).

describe("PanelOpenEventSchema", () => {
  it("parses a custom-overlay panel_open (no unified flag)", () => {
    const parsed = PanelOpenEventSchema.parse({
      type: "panel_open",
      panelId: 3,
      overlay: true,
    });
    expect(parsed.unified).toBeUndefined();
  });

  it("parses a unified panel_open (factory setWidget)", () => {
    const parsed = PanelOpenEventSchema.parse({
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
      baseline: { revision: 3, repaintRequired: true },
    });
    expect(parsed.unified).toBe(true);
    expect(parsed.baseline).toEqual({ revision: 3, repaintRequired: true });
  });
});

describe("UnifiedPanelResetEventSchema", () => {
  it("parses a unified_panel_reset event", () => {
    expect(UnifiedPanelResetEventSchema.parse({ type: "unified_panel_reset" })).toEqual({
      type: "unified_panel_reset",
    });
  });
});

describe("PanelEventSchema (discriminated union)", () => {
  it("routes panel_open (custom) and panel_open (unified) to the open variant", () => {
    expect(PanelEventSchema.parse({ type: "panel_open", panelId: 1, overlay: false }).type).toBe(
      "panel_open",
    );
    expect(
      PanelEventSchema.parse({ type: "panel_open", panelId: 1, overlay: false, unified: true })
        .type,
    ).toBe("panel_open");
  });

  it("routes panel_data / panel_close / panel_clear_all to their variants", () => {
    expect(PanelEventSchema.parse({ type: "panel_data", panelId: 1, data: "x" }).type).toBe(
      "panel_data",
    );
    expect(PanelEventSchema.parse({ type: "panel_close", panelId: 1 }).type).toBe("panel_close");
    expect(PanelEventSchema.parse({ type: "panel_repaint", panelId: 1, revision: 2 }).type).toBe(
      "panel_repaint",
    );
    expect(PanelEventSchema.parse({ type: "panel_clear_all" }).type).toBe("panel_clear_all");
  });

  it("routes panel_mode (viewport/content) to its variant", () => {
    expect(PanelEventSchema.parse({ type: "panel_mode", panelId: 1, mode: "viewport" }).type).toBe(
      "panel_mode",
    );
    expect(PanelEventSchema.parse({ type: "panel_mode", panelId: 1, mode: "content" }).type).toBe(
      "panel_mode",
    );
    // Only the two known modes are accepted.
    expect(() =>
      PanelEventSchema.parse({ type: "panel_mode", panelId: 1, mode: "weird" }),
    ).toThrow();
  });

  it("routes unified_panel_reset distinctly from panel_clear_all", () => {
    const evt = PanelEventSchema.parse({ type: "unified_panel_reset" });
    expect(evt.type).toBe("unified_panel_reset");
    expect(evt.type).not.toBe("panel_clear_all");
  });

  it("accepts session warnings and rejects the deleted host event", () => {
    expect(PanelEventSchema.parse({ type: "session_warning", message: "locked" }).type).toBe(
      "session_warning",
    );
    expect(() => PanelEventSchema.parse({ type: "host_fallback", reason: "deleted" })).toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => PanelEventSchema.parse({ type: "panel_something_new" })).toThrow();
  });
});
