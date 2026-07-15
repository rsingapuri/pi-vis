import { describe, expect, it, vi } from "vitest";
import { isPanelEscapeReady, routePanelEscape } from "./panel-escape.js";

const readyPanel = {
  id: 7,
  hostInstanceId: "host-a",
  sessionEpoch: 3,
  authority: true,
  syncState: "following" as const,
  inputEnabled: true,
  renderRevision: 12,
};

describe("routePanelEscape", () => {
  it("feeds one ready, identity-bound Escape through terminal input", () => {
    const input = vi.fn();
    expect(routePanelEscape(readyPanel, readyPanel, { input })).toBe(true);
    expect(input).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledWith("\x1b", true);
  });

  it("routes same-owner fenced Escape for bounded replay", () => {
    const input = vi.fn();
    const synchronizing = { ...readyPanel, syncState: "synchronizing" as const };
    expect(isPanelEscapeReady(synchronizing)).toBe(false);
    expect(routePanelEscape(synchronizing, readyPanel, { input })).toBe(true);
    expect(input).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledWith("\x1b", true);
  });

  it("consumes no terminal input for replaced or missing terminals", () => {
    const input = vi.fn();
    expect(routePanelEscape(readyPanel, { ...readyPanel, sessionEpoch: 4 }, { input })).toBe(false);
    expect(routePanelEscape(readyPanel, readyPanel, null)).toBe(false);
    expect(input).not.toHaveBeenCalled();
  });
});
