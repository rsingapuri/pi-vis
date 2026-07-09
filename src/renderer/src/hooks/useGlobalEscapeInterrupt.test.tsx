import type { SessionId } from "@shared/ids.js";
// @vitest-environment jsdom
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOverlayStore } from "../stores/overlay-store.js";
import { useSessionsStore } from "../stores/sessions-store.js";
import { useGlobalEscapeInterrupt } from "./useGlobalEscapeInterrupt.js";

const SESSION_A = "session-a" as SessionId;

function mountHook(): { unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Comp(): React.ReactElement {
    useGlobalEscapeInterrupt();
    return <div />;
  }
  act(() => {
    flushSync(() => {
      root.render(<Comp />);
    });
  });
  return {
    unmount: () => {
      act(() => {
        flushSync(() => {
          root.unmount();
        });
      });
      document.body.removeChild(container);
    },
  };
}

/** Dispatch a bare-ish Escape and return whether default was prevented. */
function dispatchKey(overrides: Partial<KeyboardEventInit> & { capture?: "secondListener" } = {}): {
  defaultPrevented: boolean;
  secondListenerCalled: boolean;
} {
  let secondListenerCalled = false;
  const onSecond = (): void => {
    secondListenerCalled = true;
  };
  // Register AFTER the hook's listener (which is in capture). This listener
  // is also capture-phase so we can assert stopImmediatePropagation.
  window.addEventListener("keydown", onSecond, true);
  const ev = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  window.dispatchEvent(ev);
  window.removeEventListener("keydown", onSecond, true);
  return { defaultPrevented: ev.defaultPrevented, secondListenerCalled };
}

describe("useGlobalEscapeInterrupt — G1–G5", () => {
  let invokeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useOverlayStore.setState({ count: 0 });
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, "/tmp/ws");
    invokeSpy = vi.fn().mockResolvedValue({ success: true });
    // @ts-expect-error — stubbing the preload bridge
    globalThis.window.pivis = { invoke: invokeSpy };
  });

  afterEach(() => {
    // @ts-expect-error — cleanup
    delete globalThis.window.pivis;
  });

  function setStreaming(streaming: boolean): void {
    useSessionsStore.getState().setStreaming(SESSION_A, streaming);
  }
  function setActive(active: SessionId | null): void {
    useSessionsStore.setState({ activeSessionId: active });
  }

  it("G2: no claim + streaming -> abort called + default prevented + second listener blocked", () => {
    mountHook();
    setActive(SESSION_A);
    setStreaming(true);
    const { defaultPrevented, secondListenerCalled } = dispatchKey();
    expect(defaultPrevented).toBe(true);
    expect(secondListenerCalled).toBe(false); // stopImmediatePropagation
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const args = invokeSpy.mock.calls[0] as [string, { sessionId: SessionId }];
    expect(args[0]).toBe("session.interrupt");
    expect(args[1]).toEqual({ sessionId: SESSION_A });
  });

  it("G1: claim active + streaming -> NOT called, NOT prevented", () => {
    mountHook();
    setActive(SESSION_A);
    setStreaming(true);
    useOverlayStore.getState()._acquire();
    const { defaultPrevented, secondListenerCalled } = dispatchKey();
    expect(defaultPrevented).toBe(false);
    expect(secondListenerCalled).toBe(true); // event continues (claimant acts)
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("G3: no claim + idle -> NOT called, NOT prevented", () => {
    mountHook();
    setActive(SESSION_A);
    setStreaming(false);
    const { defaultPrevented, secondListenerCalled } = dispatchKey();
    expect(defaultPrevented).toBe(false);
    expect(secondListenerCalled).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("G2: no claim + runtime interruptible state -> interrupt called even if streaming flag is stale", () => {
    mountHook();
    setActive(SESSION_A);
    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "interrupt_state",
      interruptible: true,
      operation: "agent",
    });
    const { defaultPrevented, secondListenerCalled } = dispatchKey();
    expect(defaultPrevented).toBe(true);
    expect(secondListenerCalled).toBe(false);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const args = invokeSpy.mock.calls[0] as [string, { sessionId: SessionId }];
    expect(args[0]).toBe("session.interrupt");
    expect(args[1]).toEqual({ sessionId: SESSION_A });
  });

  it("G2: no claim + active standalone bash -> session.interrupt called", () => {
    mountHook();
    setActive(SESSION_A);
    useSessionsStore.getState().addBashCommand(SESSION_A, "sleep 100");
    const { defaultPrevented, secondListenerCalled } = dispatchKey();
    expect(defaultPrevented).toBe(true);
    expect(secondListenerCalled).toBe(false);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const args = invokeSpy.mock.calls[0] as [string, { sessionId: SessionId }];
    expect(args[0]).toBe("session.interrupt");
    expect(args[1]).toEqual({ sessionId: SESSION_A });
  });

  it("G4: modified ESC (meta/ctrl/alt/shift) -> NOT called", () => {
    mountHook();
    setActive(SESSION_A);
    setStreaming(true);
    for (const mods of [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      const { defaultPrevented } = dispatchKey(mods);
      expect(defaultPrevented).toBe(false);
    }
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("G4: IME composition ESC -> NOT called", () => {
    mountHook();
    setActive(SESSION_A);
    setStreaming(true);
    const a = dispatchKey({ isComposing: true } as KeyboardEventInit);
    const b = dispatchKey({ keyCode: 229 } as KeyboardEventInit);
    expect(a.defaultPrevented).toBe(false);
    expect(b.defaultPrevented).toBe(false);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("G5: no active session -> NOT called", () => {
    mountHook();
    setActive(null);
    setStreaming(true);
    const { defaultPrevented } = dispatchKey();
    expect(defaultPrevented).toBe(false);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("non-ESC key -> NOT called", () => {
    mountHook();
    setActive(SESSION_A);
    setStreaming(true);
    let secondCalled = false;
    const onSecond = (): void => {
      secondCalled = true;
    };
    window.addEventListener("keydown", onSecond, true);
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    window.removeEventListener("keydown", onSecond, true);
    expect(secondCalled).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("abortSession is a no-op when idle (S3) and rejection-safe", () => {
    mountHook();
    setActive(SESSION_A);
    setStreaming(false);
    useSessionsStore.getState().abortSession(SESSION_A);
    expect(invokeSpy).not.toHaveBeenCalled();
    // Streaming -> rejection swallowed
    setStreaming(true);
    invokeSpy.mockRejectedValueOnce(new Error("dead"));
    useSessionsStore.getState().abortSession(SESSION_A);
    expect(invokeSpy).toHaveBeenCalled();
  });
});
