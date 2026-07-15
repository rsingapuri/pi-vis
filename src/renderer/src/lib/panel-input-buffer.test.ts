import { describe, expect, it } from "vitest";
import {
  type PanelInputIdentity,
  bufferPanelInput,
  reconcilePanelInputBuffer,
} from "./panel-input-buffer.js";

const OWNER_A: PanelInputIdentity = {
  hostInstanceId: "host-a",
  sessionEpoch: 1,
  panelId: 7,
};
const OWNER_B: PanelInputIdentity = {
  hostInstanceId: "host-b",
  sessionEpoch: 2,
  panelId: 7,
};

describe("panel input repaint buffer", () => {
  it("retains multi-byte rejected input and releases it when the same owner follows", () => {
    const pending = bufferPanelInput(null, OWNER_A, "\u001b[13;2u");
    const fenced = reconcilePanelInputBuffer(OWNER_A, false, OWNER_A, pending);
    expect(fenced.blocked).toEqual(OWNER_A);
    expect(fenced.replay).toEqual([]);

    const following = reconcilePanelInputBuffer(OWNER_A, true, fenced.blocked, fenced.pending);
    expect(following.blocked).toBeNull();
    expect(following.pending).toBeNull();
    expect(following.replay).toEqual(["\u001b[13;2u"]);
  });

  it("discards predecessor input and blocked state for a successor owner", () => {
    const pending = bufferPanelInput(null, OWNER_A, "\u001b");
    const successor = reconcilePanelInputBuffer(OWNER_B, true, OWNER_A, pending);
    expect(successor).toEqual({ blocked: null, pending: null, replay: [] });
  });

  it("preserves complete input chunks in order while fenced", () => {
    let pending = bufferPanelInput(null, OWNER_A, "first");
    pending = bufferPanelInput(pending, OWNER_A, "\u001b[1;5A");
    const following = reconcilePanelInputBuffer(OWNER_A, true, OWNER_A, pending);
    expect(following.replay).toEqual(["first", "\u001b[1;5A"]);
  });
});
