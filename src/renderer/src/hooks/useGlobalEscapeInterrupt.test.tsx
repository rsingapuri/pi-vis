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
  act(() => flushSync(() => root.render(<Comp />)));
  return {
    unmount: () => {
      act(() => flushSync(() => root.unmount()));
      container.remove();
    },
  };
}

function dispatchKey(overrides: Partial<KeyboardEventInit> = {}): {
  defaultPrevented: boolean;
  secondListenerCalled: boolean;
} {
  let secondListenerCalled = false;
  const onSecond = (): void => {
    secondListenerCalled = true;
  };
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

describe("useGlobalEscapeInterrupt", () => {
  let invokeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useOverlayStore.setState({ count: 0, claims: [] });
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, "/tmp/ws");
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_A, {
        ...sessions.get(SESSION_A)!,
        status: "ready",
        availability: "available",
        hostInstanceId: "host-escape",
        sessionEpoch: 4,
        authorityProjection: {
          rendererGeneration: 1,
          publicationSequence: 0,
          owner: { hostInstanceId: "host-escape", sessionEpoch: 4 },
          semantic: {
            state: "following",
            cursor: {
              hostInstanceId: "host-escape",
              sessionEpoch: 4,
              transportSequence: 1,
              snapshotSequence: 1,
            },
          },
          transcript: { state: "synchronizing", reason: "test" },
          extensionUi: { state: "synchronizing", reason: "test" },
          panels: new Map(),
          recentRecords: [],
          authoritativeSnapshot: {
            owner: { hostInstanceId: "host-escape", sessionEpoch: 4 },
            snapshotSequence: 1,
            capturedAt: Date.now(),
            sdk: {
              isStreaming: false,
              isIdle: true,
              isCompacting: false,
              isRetrying: false,
              retryAttempt: 0,
              isBashRunning: false,
            },
            activity: {},
            queues: {
              steering: [],
              followUp: [],
              steeringIntentIds: [],
              followUpIntentIds: [],
            },
            custody: [],
            editor: { revision: 0, text: "", attachments: [] },
            activeIntents: [],
            recentIntentOutcomes: [],
            recentObservedOperations: [],
            operationJournalLowWatermark: 0,
            operationJournalHighWatermark: 0,
            operationJournalTruncated: false,
            model: null,
            thinkingLevel: "off",
            catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
          },
        },
      });
      return { sessions, activeSessionId: SESSION_A };
    });
    invokeSpy = vi.fn().mockResolvedValue({
      status: "admitted",
      intentId: "interrupt",
      owner: { hostInstanceId: "host-escape", sessionEpoch: 4 },
    });
    // @ts-expect-error test bridge
    window.pivis = { invoke: invokeSpy };
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete window.pivis;
  });

  it("unclaimed ESC always requests a host-authoritative escape", () => {
    const mounted = mountHook();
    const { defaultPrevented, secondListenerCalled } = dispatchKey();
    expect(defaultPrevented).toBe(true);
    expect(secondListenerCalled).toBe(false);
    expect(invokeSpy).toHaveBeenCalledWith(
      "session.dispatchIntent",
      expect.objectContaining({
        sessionId: SESSION_A,
        intentId: expect.any(String),
        expectedOwner: { hostInstanceId: "host-escape", sessionEpoch: 4 },
        intent: { kind: "interrupt" },
      }),
    );
    mounted.unmount();
  });

  it("a normal claim defers ESC to its DOM owner", () => {
    const mounted = mountHook();
    useOverlayStore.getState()._acquire();
    const { defaultPrevented, secondListenerCalled } = dispatchKey();
    expect(defaultPrevented).toBe(false);
    expect(secondListenerCalled).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("a routed top claim consumes and invokes its route exactly once", () => {
    const mounted = mountHook();
    const route = vi.fn();
    useOverlayStore.getState()._acquire(route);
    const { defaultPrevented, secondListenerCalled } = dispatchKey();
    expect(defaultPrevented).toBe(true);
    expect(secondListenerCalled).toBe(false);
    expect(route).toHaveBeenCalledOnce();
    expect(invokeSpy).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("a normal claim opened over a routed claim defers to DOM", () => {
    const mounted = mountHook();
    const route = vi.fn();
    useOverlayStore.getState()._acquire(route);
    useOverlayStore.getState()._acquire();
    const event = dispatchKey();
    expect(event.defaultPrevented).toBe(false);
    expect(event.secondListenerCalled).toBe(true);
    expect(route).not.toHaveBeenCalled();
    expect(invokeSpy).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("routes once the newer normal claim is released", () => {
    const mounted = mountHook();
    const route = vi.fn();
    useOverlayStore.getState()._acquire(route);
    const normal = useOverlayStore.getState()._acquire();
    useOverlayStore.getState()._release(normal);
    const event = dispatchKey();
    expect(event.defaultPrevented).toBe(true);
    expect(route).toHaveBeenCalledOnce();
    expect(invokeSpy).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("modified and IME Escape ignore even a routed claim", () => {
    const mounted = mountHook();
    const route = vi.fn();
    useOverlayStore.getState()._acquire(route);
    for (const init of [
      { metaKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ] as KeyboardEventInit[]) {
      const event = dispatchKey(init);
      expect(event.defaultPrevented).toBe(false);
      expect(event.secondListenerCalled).toBe(true);
    }
    expect(route).not.toHaveBeenCalled();
    expect(invokeSpy).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("a throwing route remains consumed and never becomes a global interrupt", () => {
    const mounted = mountHook();
    const route = vi.fn(() => {
      throw new Error("fenced route");
    });
    useOverlayStore.getState()._acquire(route);
    const event = dispatchKey();
    expect(event.defaultPrevented).toBe(true);
    expect(event.secondListenerCalled).toBe(false);
    expect(route).toHaveBeenCalledOnce();
    expect(invokeSpy).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("non-ESC and no-active-session keys are ignored", () => {
    const mounted = mountHook();
    expect(dispatchKey({ key: "Enter" }).defaultPrevented).toBe(false);
    useSessionsStore.setState({ activeSessionId: null });
    expect(dispatchKey().defaultPrevented).toBe(false);
    expect(invokeSpy).not.toHaveBeenCalled();
    mounted.unmount();
  });
});
