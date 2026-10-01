// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import { type ReactElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetPanelInputSession } from "../../lib/panel-input-sequence.js";
import { useSessionsStore } from "../../stores/sessions-store.js";

interface MockTerminalLike {
  emitData: (data: string) => void;
  disposed: boolean;
}

const xtermMock = vi.hoisted(() => ({
  instances: [] as MockTerminalLike[],
}));

vi.mock("@xterm/xterm", () => {
  class Terminal implements MockTerminalLike {
    options: Record<string, unknown>;
    rows = 8;
    cols = 80;
    disposed = false;
    buffer = {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        getLine: () => undefined,
      },
    };
    private dataListeners: Array<(data: string) => void> = [];

    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermMock.instances.push(this);
    }

    loadAddon(): void {}

    open(container: HTMLElement): void {
      container.appendChild(document.createElement("textarea"));
    }

    reset(): void {}

    clear(): void {}

    focus(): void {}

    write(_data: string, callback?: () => void): void {
      callback?.();
    }

    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }

    scrollToTop(): void {}

    onData(listener: (data: string) => void): { dispose: () => void } {
      this.dataListeners.push(listener);
      return {
        dispose: () => {
          const index = this.dataListeners.indexOf(listener);
          if (index >= 0) this.dataListeners.splice(index, 1);
        },
      };
    }

    dispose(): void {
      this.disposed = true;
      this.dataListeners = [];
    }

    emitData(data: string): void {
      for (const listener of this.dataListeners) listener(data);
    }
  }

  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 8 };
    }
  },
}));

import { UnifiedTuiHost } from "./UnifiedTuiHost.js";

const SESSION_A = "unified-input-a" as SessionId;
const SESSION_B = "unified-input-b" as SessionId;

const mounted: Array<() => void> = [];

type PanelInputResult = {
  acknowledgedThrough: number;
  rejection?: "runtime_unavailable" | "runtime_replaced";
  gap?: { expected: number; received: number };
};

type InvokeMock = ReturnType<typeof vi.fn>;

function installPanel(sessionId: SessionId, hostInstanceId: string, panelId: number): void {
  useSessionsStore.getState().createSession(sessionId, `/workspace/${sessionId}`);
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(sessionId);
    if (!session) return {};
    sessions.set(sessionId, {
      ...session,
      hostInstanceId,
      sessionEpoch: 1,
      unifiedPanel: {
        id: panelId,
        hostInstanceId,
        sessionEpoch: 1,
        buffer: [],
        authority: true,
        inputEnabled: true,
        renderRevision: 1,
        keyframeReady: true,
        outputSequence: 1,
        outputKind: "keyframe",
        outputAnsi: `panel-${panelId}`,
        inputAcknowledgedThrough: 0,
        syncState: "following",
      },
    });
    return { sessions };
  });
}

function replacePanelOwner(sessionId: SessionId, hostInstanceId: string): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(sessionId);
    if (!session?.unifiedPanel) return {};
    sessions.set(sessionId, {
      ...session,
      hostInstanceId,
      sessionEpoch: 2,
      unifiedPanel: {
        ...session.unifiedPanel,
        hostInstanceId,
        sessionEpoch: 2,
        inputAcknowledgedThrough: 0,
      },
    });
    return { sessions };
  });
}

function setPanelSynchronizing(sessionId: SessionId): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(sessionId);
    if (!session?.unifiedPanel) return {};
    sessions.set(sessionId, {
      ...session,
      unifiedPanel: {
        ...session.unifiedPanel,
        inputEnabled: false,
        keyframeReady: false,
        outputKind: "repaint_required",
        syncState: "synchronizing",
      },
    });
    return { sessions };
  });
}

function publishFollowingKeyframe(sessionId: SessionId): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(sessionId);
    if (!session?.unifiedPanel) return {};
    sessions.set(sessionId, {
      ...session,
      unifiedPanel: {
        ...session.unifiedPanel,
        inputEnabled: true,
        keyframeReady: true,
        outputKind: "keyframe",
        outputSequence: (session.unifiedPanel.outputSequence ?? 0) + 1,
        outputAnsi: "delayed complete keyframe",
        renderRevision: session.unifiedPanel.renderRevision ?? 0,
        syncState: "following",
      },
    });
    return { sessions };
  });
}

function publishSynchronizingPanelState(
  sessionId: SessionId,
  update: {
    keyframeReady: boolean;
    outputKind: "keyframe" | "repaint_required";
    renderRevision: number;
  },
): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(sessionId);
    if (!session?.unifiedPanel) return {};
    sessions.set(sessionId, {
      ...session,
      unifiedPanel: {
        ...session.unifiedPanel,
        inputEnabled: false,
        keyframeReady: update.keyframeReady,
        outputKind: update.outputKind,
        outputSequence: (session.unifiedPanel.outputSequence ?? 0) + 1,
        outputAnsi: update.keyframeReady ? `keyframe-${update.renderRevision}` : "",
        renderRevision: update.renderRevision,
        syncState: "synchronizing",
      },
    });
    return { sessions };
  });
}

function installPivis(
  panelInput: (input: Record<string, unknown>) => Promise<PanelInputResult>,
): InvokeMock {
  const invoke = vi.fn(async (channel: string, input: Record<string, unknown>) => {
    if (channel === "session.panelInput") return panelInput(input);
    if (channel === "session.panelRepaintAck") {
      return { acknowledged: true, inputAcknowledgedThrough: 0 };
    }
    return { acknowledged: true };
  });
  Object.defineProperty(window, "pivis", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}) },
  });
  return invoke;
}

function mount(element: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  const container = document.createElement("div");
  container.className = "app__session";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    rerender: (next) => {
      act(() => root.render(next));
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function panelInputCalls(invoke: InvokeMock): Array<Record<string, unknown>> {
  return invoke.mock.calls
    .filter(([channel]) => channel === "session.panelInput")
    .map(([, input]) => input as Record<string, unknown>);
}

function latestTerminal(): MockTerminalLike {
  const terminal = xtermMock.instances.at(-1);
  if (!terminal) throw new Error("Expected a mounted Unified terminal");
  return terminal;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  xtermMock.instances.length = 0;
  useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
  installPanel(SESSION_A, "host-a", 11);
  installPanel(SESSION_B, "host-b", 22);
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  forgetPanelInputSession(SESSION_A);
  forgetPanelInputSession(SESSION_B);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("UnifiedTuiHost input custody", () => {
  it("lets a delayed keyframe settle without a fixed-interval repaint livelock", async () => {
    vi.useFakeTimers();
    setPanelSynchronizing(SESSION_A);
    const invoke = installPivis(async (input) => ({
      acknowledgedThrough: input.sequence as number,
    }));
    mount(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    const forcedRepaints = (): Array<Record<string, unknown>> =>
      invoke.mock.calls
        .filter(
          ([channel, input]) =>
            channel === "session.panelResize" && (input as Record<string, unknown>).force === true,
        )
        .map(([, input]) => input as Record<string, unknown>);
    expect(forcedRepaints()).toHaveLength(0);

    // The old 500 ms watchdog invalidated this otherwise valid publication
    // before it could be applied and acknowledged.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(forcedRepaints()).toHaveLength(0);

    act(() => publishFollowingKeyframe(SESSION_A));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(forcedRepaints()).toHaveLength(0);
  });

  it("preserves repaint backoff across a slow keyframe and successor repaint fence", async () => {
    vi.useFakeTimers();
    setPanelSynchronizing(SESSION_A);
    const invoke = installPivis(async (input) => ({
      acknowledgedThrough: input.sequence as number,
    }));
    mount(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    const forcedRepaints = (): Array<Record<string, unknown>> =>
      invoke.mock.calls
        .filter(
          ([channel, input]) =>
            channel === "session.panelResize" && (input as Record<string, unknown>).force === true,
        )
        .map(([, input]) => input as Record<string, unknown>);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(forcedRepaints()).toHaveLength(1);

    // Model a 1.2 s host→renderer render: the predecessor keyframe briefly
    // makes keyframeReady true, then the already-sent force publishes its
    // successor repaint fence. Restarting the watchdog at 1 s here queues a
    // third revision before the successor keyframe can arrive at t=2.4 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() =>
      publishSynchronizingPanelState(SESSION_A, {
        keyframeReady: true,
        outputKind: "keyframe",
        renderRevision: 1,
      }),
    );
    await settle();
    act(() =>
      publishSynchronizingPanelState(SESSION_A, {
        keyframeReady: false,
        outputKind: "repaint_required",
        renderRevision: 2,
      }),
    );
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(forcedRepaints()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => publishFollowingKeyframe(SESSION_A));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(forcedRepaints()).toHaveLength(1);
  });

  it("does not run the repaint watchdog for a hidden terminal", async () => {
    vi.useFakeTimers();
    setPanelSynchronizing(SESSION_A);
    const invoke = installPivis(async (input) => ({
      acknowledgedThrough: input.sequence as number,
    }));
    mount(<UnifiedTuiHost sessionId={SESSION_A} visible={false} />);
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(
      invoke.mock.calls.filter(
        ([channel, input]) =>
          channel === "session.panelResize" && (input as Record<string, unknown>).force === true,
      ),
    ).toHaveLength(0);
  });

  it("delivers a key queued behind an in-flight predecessor after the component switches sessions", async () => {
    let resolveFirst: ((result: PanelInputResult) => void) | undefined;
    const first = new Promise<PanelInputResult>((resolve) => {
      resolveFirst = resolve;
    });
    const invoke = installPivis(async (input) => {
      if (input.sessionId === SESSION_A && input.data === "a") return first;
      return { acknowledgedThrough: input.sequence as number };
    });
    const view = mount(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    act(() => {
      latestTerminal().emitData("a");
      latestTerminal().emitData("b");
    });
    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(1));

    view.rerender(<UnifiedTuiHost sessionId={SESSION_B} />);
    await settle();
    await act(async () => {
      resolveFirst?.({ acknowledgedThrough: 1 });
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(2));
    expect(panelInputCalls(invoke)).toEqual([
      expect.objectContaining({ sessionId: SESSION_A, sequence: 1, data: "a" }),
      expect.objectContaining({ sessionId: SESSION_A, sequence: 2, data: "b" }),
    ]);
  });

  it("retains delivery-uncertain bytes across a session switch and replays them on remount", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const first = new Promise<PanelInputResult>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let attempts = 0;
    const invoke = installPivis(async (input) => {
      if (input.sessionId === SESSION_A && input.data === "x" && attempts++ === 0) return first;
      return { acknowledgedThrough: input.sequence as number };
    });
    const view = mount(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    act(() => latestTerminal().emitData("x"));
    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(1));
    view.rerender(<UnifiedTuiHost sessionId={SESSION_B} />);
    await settle();
    await act(async () => {
      rejectFirst?.(new Error("renderer reply lost"));
      await Promise.resolve();
    });

    expect(
      panelInputCalls(invoke).filter(
        (input) => input.sessionId === SESSION_A && input.data === "x",
      ),
    ).toHaveLength(1);
    view.rerender(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    await vi.waitFor(() => {
      expect(
        panelInputCalls(invoke).filter(
          (input) => input.sessionId === SESSION_A && input.data === "x",
        ),
      ).toHaveLength(2);
    });
    expect(
      panelInputCalls(invoke).filter(
        (input) => input.sessionId === SESSION_A && input.data === "x",
      ),
    ).toEqual([expect.objectContaining({ sequence: 1 }), expect.objectContaining({ sequence: 1 })]);
  });

  it("rebases a stale local sequence after switching sessions without losing its bytes", async () => {
    let resolveFirst: ((result: PanelInputResult) => void) | undefined;
    const first = new Promise<PanelInputResult>((resolve) => {
      resolveFirst = resolve;
    });
    const invoke = installPivis(async (input) => {
      if (input.sessionId === SESSION_A && input.sequence === 1) return first;
      return { acknowledgedThrough: input.sequence as number };
    });
    const view = mount(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    act(() => latestTerminal().emitData("z"));
    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(1));
    view.rerender(<UnifiedTuiHost sessionId={SESSION_B} />);
    await settle();
    await act(async () => {
      resolveFirst?.({ acknowledgedThrough: 5 });
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(2));
    expect(panelInputCalls(invoke)).toEqual([
      expect.objectContaining({ sessionId: SESSION_A, sequence: 1, data: "z" }),
      expect.objectContaining({ sessionId: SESSION_A, sequence: 6, data: "z" }),
    ]);
  });

  it("retains a gap-rejected key across a session switch until the same panel remounts", async () => {
    let resolveFirst: ((result: PanelInputResult) => void) | undefined;
    const first = new Promise<PanelInputResult>((resolve) => {
      resolveFirst = resolve;
    });
    let attempts = 0;
    const invoke = installPivis(async (input) => {
      if (input.sessionId === SESSION_A && input.data === "g" && attempts++ === 0) return first;
      return { acknowledgedThrough: input.sequence as number };
    });
    const view = mount(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    act(() => latestTerminal().emitData("g"));
    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(1));
    view.rerender(<UnifiedTuiHost sessionId={SESSION_B} />);
    await settle();
    await act(async () => {
      resolveFirst?.({ acknowledgedThrough: 0, gap: { expected: 1, received: 1 } });
      await Promise.resolve();
    });

    expect(
      panelInputCalls(invoke).filter(
        (input) => input.sessionId === SESSION_A && input.data === "g",
      ),
    ).toHaveLength(1);
    view.rerender(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    await vi.waitFor(() => {
      expect(
        panelInputCalls(invoke).filter(
          (input) => input.sessionId === SESSION_A && input.data === "g",
        ),
      ).toHaveLength(2);
    });
    expect(
      panelInputCalls(invoke).filter(
        (input) => input.sessionId === SESSION_A && input.data === "g",
      ),
    ).toEqual([expect.objectContaining({ sequence: 1 }), expect.objectContaining({ sequence: 1 })]);
  });

  it("retains a same-owner unavailable key and its FIFO successor for reconstruction", async () => {
    let resolveFirst: ((result: PanelInputResult) => void) | undefined;
    const first = new Promise<PanelInputResult>((resolve) => {
      resolveFirst = resolve;
    });
    let firstAttempt = true;
    const invoke = installPivis(async (input) => {
      if (input.sessionId === SESSION_A && input.data === "u" && firstAttempt) {
        firstAttempt = false;
        return first;
      }
      return { acknowledgedThrough: input.sequence as number };
    });
    const view = mount(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    act(() => {
      latestTerminal().emitData("u");
      latestTerminal().emitData("v");
    });
    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(1));
    view.rerender(<UnifiedTuiHost sessionId={SESSION_B} />);
    await settle();
    await act(async () => {
      resolveFirst?.({ acknowledgedThrough: 0, rejection: "runtime_unavailable" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(panelInputCalls(invoke)).toHaveLength(1);
    view.rerender(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(3));
    expect(panelInputCalls(invoke)).toEqual([
      expect.objectContaining({ sessionId: SESSION_A, sequence: 1, data: "u" }),
      expect.objectContaining({ sessionId: SESSION_A, sequence: 1, data: "u" }),
      expect.objectContaining({ sessionId: SESSION_A, sequence: 2, data: "v" }),
    ]);
  });

  it("retires queued predecessor bytes when their panel owner is replaced", async () => {
    let resolveFirst: ((result: PanelInputResult) => void) | undefined;
    const first = new Promise<PanelInputResult>((resolve) => {
      resolveFirst = resolve;
    });
    const invoke = installPivis(async (input) => {
      if (input.sessionId === SESSION_A && input.data === "old-1") return first;
      return { acknowledgedThrough: input.sequence as number };
    });
    const view = mount(<UnifiedTuiHost sessionId={SESSION_A} />);
    await settle();

    act(() => {
      latestTerminal().emitData("old-1");
      latestTerminal().emitData("old-2");
    });
    await vi.waitFor(() => expect(panelInputCalls(invoke)).toHaveLength(1));
    act(() => replacePanelOwner(SESSION_A, "host-a-successor"));
    view.rerender(<UnifiedTuiHost sessionId={SESSION_B} />);
    await settle();
    await act(async () => {
      resolveFirst?.({ acknowledgedThrough: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(panelInputCalls(invoke)).toEqual([
      expect.objectContaining({ sessionId: SESSION_A, sequence: 1, data: "old-1" }),
    ]);
  });
});
