import { describe, expect, it, vi } from "vitest";
import { type WindowMessageTarget, safeSendToWindow } from "./window-messaging.js";

function target(overrides: Partial<WindowMessageTarget> = {}): WindowMessageTarget {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: vi.fn(),
    },
    ...overrides,
  };
}

describe("safeSendToWindow", () => {
  it("delivers to a live renderer", () => {
    const window = target();

    expect(safeSendToWindow(window, "window.fullscreenChange", { fullscreen: true })).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith("window.fullscreenChange", {
      fullscreen: true,
    });
  });

  it("does not send to destroyed windows or renderers", () => {
    const destroyedWindow = target({ isDestroyed: () => true });
    const destroyedRenderer = target({
      webContents: {
        isDestroyed: () => true,
        send: vi.fn(),
      },
    });

    expect(safeSendToWindow(destroyedWindow, "event", {})).toBe(false);
    expect(safeSendToWindow(destroyedRenderer, "event", {})).toBe(false);
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
    expect(destroyedRenderer.webContents.send).not.toHaveBeenCalled();
  });

  it("contains destruction races at send time", () => {
    const error = new Error("Render frame was disposed");
    const onError = vi.fn();
    const window = target({
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(() => {
          throw error;
        }),
      },
    });

    expect(() => safeSendToWindow(window, "event", {}, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("contains failures in lifecycle checks and diagnostics", () => {
    const window = target({
      isDestroyed: () => {
        throw new Error("window teardown");
      },
    });

    expect(() =>
      safeSendToWindow(window, "event", {}, () => {
        throw new Error("diagnostic failure");
      }),
    ).not.toThrow();
  });
});
