// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type {
  IntentOutcome,
  RuntimeIdentity,
  SemanticSnapshot,
} from "@shared/pi-protocol/runtime-state.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionViewState, useSessionsStore } from "../../stores/sessions-store.js";
import { SubagentsFleet } from "./SubagentsFleet.js";

const SESSION_ID = "test-session" as SessionId;
const OWNER: RuntimeIdentity = { hostInstanceId: "host-1", sessionEpoch: 1 };
const CURSOR = { ...OWNER, transportSequence: 1, snapshotSequence: 1 };

function mount(node: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
  rerender: (node: React.ReactElement) => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => root.render(node));
  });
  return {
    container,
    unmount: () => {
      act(() => {
        flushSync(() => root.unmount());
      });
      document.body.removeChild(container);
    },
    rerender: (next) => {
      act(() => {
        flushSync(() => root.render(next));
      });
    },
  };
}

function snapshotLine(snapshot: unknown): string {
  return `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`;
}

function baseSnapshot(): Record<string, unknown> {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1704067200000,
    caps: {
      maxRuns: 20,
      maxChildrenPerNode: 8,
      maxDepth: 3,
      maxStringLength: 160,
      maxSerializedBytes: 32768,
    },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [],
  };
}

function makeSemanticSnapshot(): SemanticSnapshot {
  return {
    owner: OWNER,
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
  };
}

function installSession(overrides: Partial<SessionViewState> = {}): void {
  useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
  useSessionsStore.getState().createSession(SESSION_ID, "/workspace", "/session.jsonl");
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID)!;
    sessions.set(SESSION_ID, {
      ...session,
      editorRevision: 0,
      authorityProjection: {
        ...session.authorityProjection,
        owner: OWNER,
        semantic: { state: "following", cursor: CURSOR },
        authoritativeSnapshot: makeSemanticSnapshot(),
      },
      ...overrides,
    } as unknown as SessionViewState);
    return { sessions };
  });
}

function publishOutcome(
  intentId: string,
  state: "completed" | "failed" | "outcome_unknown",
  error?: string,
): void {
  useSessionsStore.setState((current) => {
    const sessions = new Map(current.sessions);
    const session = sessions.get(SESSION_ID);
    if (!session?.authorityProjection?.authoritativeSnapshot) return current;
    const snapshot = session.authorityProjection.authoritativeSnapshot;
    const outcome: IntentOutcome = {
      intentId,
      owner: snapshot.owner,
      state,
      kind: "invokeCommand",
      result: { commandType: "subagents-stop" },
      ...(error ? { error } : {}),
    };
    const nextSnapshot: SemanticSnapshot = {
      ...snapshot,
      recentIntentOutcomes: [...snapshot.recentIntentOutcomes, outcome],
    };
    sessions.set(SESSION_ID, {
      ...session,
      authorityProjection: {
        ...session.authorityProjection,
        authoritativeSnapshot: nextSnapshot,
      },
    } as unknown as SessionViewState);
    return { sessions };
  });
}

let lastInvokeCall: { channel: string; req: unknown } | undefined;

function installPivis(
  outcomeState: "completed" | "failed" | "outcome_unknown" = "completed",
  outcomeError?: string,
): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, req: unknown) => {
    lastInvokeCall = { channel, req };
    if (channel === "session.dispatchIntent") {
      const envelope = req as { intentId: string };
      // Publish the outcome in the next macrotask so the component's
      // awaitIntentOutcome subscription is set up before the store updates.
      setTimeout(() => publishOutcome(envelope.intentId, outcomeState, outcomeError), 0);
      return { status: "admitted", intentId: envelope.intentId, owner: OWNER };
    }
    return undefined;
  });
  Object.defineProperty(window, "pivis", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}) },
  });
  return invoke;
}

function fleetProps(lines: string[]): React.ComponentProps<typeof SubagentsFleet> {
  return { sessionId: SESSION_ID, lines };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("SubagentsFleet", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    installSession();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    lastInvokeCall = undefined;
  });

  it("renders the header and empty state when no snapshot line is present", () => {
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(["no prefix here"])} />);
    expect(container.textContent).toContain("Subagents");
    expect(container.textContent).toContain("No active subagent runs");
    unmount();
  });

  it("collapses to the header summary on click and expands again", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [
          {
            id: "r1",
            kind: "subagent",
            label: "dev",
            state: "running",
            startedAt: 1704067200000,
            updatedAt: 1704067260000,
          },
          { id: "r2", kind: "subagent", label: "qa", state: "queued" },
          {
            id: "r3",
            kind: "subagent",
            label: "scout",
            state: "complete",
            startedAt: 1704067200000,
            endedAt: 1704067230000,
          },
        ],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);
    const header = container.querySelector<HTMLButtonElement>(".subagents-fleet__header-toggle");
    expect(header).not.toBeNull();
    expect(header!.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("dev");

    act(() => {
      header!.click();
    });
    expect(header!.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".subagents-fleet__runs")).toBeNull();
    expect(container.textContent).toContain("2 active");
    expect(container.querySelector(".subagents-fleet__node-label")).toBeNull();

    act(() => {
      header!.click();
    });
    expect(header!.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("dev");
    unmount();
  });

  it("renders a run tree with label, state, current tool, and activity counters", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [
          {
            id: "parent-run",
            kind: "subagent",
            label: "researcher",
            state: "running",
            startedAt: 1704067200000,
            updatedAt: 1704067290000,
            activity: {
              currentTool: "search",
              turnCount: 5,
              toolCount: 3,
            },
            children: [
              {
                id: "child-step",
                kind: "step",
                label: "summarize",
                state: "complete",
                startedAt: 1704067201000,
                endedAt: 1704067203000,
              },
            ],
          },
        ],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Subagents");
    expect(text).toContain("researcher");
    expect(text).toContain("parent-run");
    expect(text).toContain("running");
    expect(text).toContain("search");
    expect(text).toContain("5 turns");
    expect(text).toContain("3 tools");
    expect(text).toContain("1m 30s");
    expect(text).toContain("summarize");
    expect(text).toContain("subagent");
    expect(text).toContain("step");
    expect(text).toContain("child-step");
    expect(text).toContain("complete");
    expect(text).toContain("2s");
    unmount();
  });

  it("renders distinct failed and paused badges", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [
          { id: "failed-run", kind: "subagent", label: "f", state: "failed" },
          { id: "paused-run", kind: "subagent", label: "p", state: "paused" },
        ],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);
    const badges = container.querySelectorAll(".subagents-fleet__badge");
    expect(badges).toHaveLength(2);
    expect(badges[0]?.classList.contains("subagents-fleet__badge--failed")).toBe(true);
    expect(badges[1]?.classList.contains("subagents-fleet__badge--paused")).toBe(true);
    unmount();
  });

  it("shows the byte-limit and omission notice when the snapshot is truncated", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        caps: {
          maxRuns: 20,
          maxChildrenPerNode: 8,
          maxDepth: 3,
          maxStringLength: 160,
          maxSerializedBytes: 4096,
        },
        omitted: { runs: 2, children: 5, byteLimitExceeded: true },
        runs: [{ id: "run-1", kind: "subagent", label: "kept", state: "running" }],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);
    const text = container.textContent ?? "";
    expect(text).toContain("truncated to 4.0 KiB budget");
    expect(text).toContain("2 runs omitted");
    expect(text).toContain("5 nested children omitted");
    expect(container.querySelector(".subagents-fleet__notice--warning")).not.toBeNull();
    unmount();
  });

  it("keeps the last valid snapshot after a malformed update", () => {
    const validLines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [{ id: "run-1", kind: "subagent", label: "kept", state: "running" }],
      }),
    ];
    const { container, rerender, unmount } = mount(<SubagentsFleet {...fleetProps(validLines)} />);
    expect(container.textContent).toContain("kept");

    rerender(<SubagentsFleet {...fleetProps(["PI_SUBAGENT_ASYNC_JSON:not valid json"])} />);
    expect(container.textContent).toContain("kept");
    expect(container.textContent).toContain("running");

    unmount();
  });

  it("clears the panel when the widget lines are retracted", () => {
    const validLines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [{ id: "run-1", kind: "subagent", label: "kept", state: "running" }],
      }),
    ];
    const { container, rerender, unmount } = mount(<SubagentsFleet {...fleetProps(validLines)} />);
    expect(container.textContent).toContain("kept");

    rerender(<SubagentsFleet {...fleetProps([])} />);
    expect(container.textContent).toContain("No active subagent runs");
    expect(container.textContent).not.toContain("kept");

    unmount();
  });

  it("ignores malformed snapshot lines gracefully", () => {
    const lines = ["PI_SUBAGENT_ASYNC_JSON:not valid json"];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);
    expect(container.textContent).toContain("Subagents");
    expect(container.textContent).toContain("No active subagent runs");
    unmount();
  });

  it("shows a stop button only for running or queued runs", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [
          { id: "running-run", kind: "subagent", label: "running", state: "running" },
          { id: "queued-run", kind: "subagent", label: "queued", state: "queued" },
          { id: "complete-run", kind: "subagent", label: "complete", state: "complete" },
          { id: "failed-run", kind: "subagent", label: "failed", state: "failed" },
          { id: "stopped-run", kind: "subagent", label: "stopped", state: "stopped" },
          { id: "paused-run", kind: "subagent", label: "paused", state: "paused" },
          { id: "rejected-run", kind: "subagent", label: "rejected", state: "rejected" },
        ],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);
    const buttons = container.querySelectorAll(".subagents-fleet__stop-btn");
    expect(buttons).toHaveLength(2);
    const labels = Array.from(buttons).map((btn) => btn.getAttribute("aria-label"));
    expect(labels).toContain("Stop running");
    expect(labels).toContain("Stop queued");
    unmount();
  });

  it("shows an inline confirm for a run stop and cancels it", () => {
    installPivis();
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [{ id: "r1", kind: "subagent", label: "worker", state: "running" }],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);

    act(() => {
      container.querySelector<HTMLButtonElement>(".subagents-fleet__stop-btn")!.click();
    });
    expect(container.querySelector(".subagents-fleet__stop-confirm")).not.toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>("[aria-label='Cancel']")!.click();
    });
    expect(container.querySelector(".subagents-fleet__stop-confirm")).toBeNull();
    unmount();
  });

  it("issues /subagents-stop <runId> when confirmed and clears the confirm", async () => {
    const invoke = installPivis();
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [{ id: "r1", kind: "subagent", label: "worker", state: "running" }],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);

    act(() => {
      container.querySelector<HTMLButtonElement>(".subagents-fleet__stop-btn")!.click();
    });
    expect(container.querySelector(".subagents-fleet__stop-confirm")).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Confirm stop']")!.click();
    });

    expect(container.querySelector(".subagents-fleet__stop-confirm")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "session.dispatchIntent",
      expect.objectContaining({
        intent: expect.objectContaining({
          kind: "invokeCommand",
          text: "/subagents-stop r1",
          editorRevision: 0,
        }),
      }),
    );
    expect(lastInvokeCall?.channel).toBe("session.dispatchIntent");
    unmount();
  });

  it("renders an error note when a stop fails", async () => {
    const invoke = installPivis("failed", "unknown run id");
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [{ id: "r1", kind: "subagent", label: "worker", state: "running" }],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);

    act(() => {
      container.querySelector<HTMLButtonElement>(".subagents-fleet__stop-btn")!.click();
    });

    act(() => {
      container.querySelector<HTMLButtonElement>("[aria-label='Confirm stop']")!.click();
    });
    await settle();

    const errorNode = container.querySelector(".subagents-fleet__stop-error");
    expect(errorNode).not.toBeNull();
    expect(errorNode!.textContent).toContain("unknown run id");
    unmount();
  });

  it("shows a 'Stop all' header control when the session is streaming", () => {
    installSession({
      authorityProjection: {
        ...useSessionsStore.getState().sessions.get(SESSION_ID)!.authorityProjection,
        authoritativeSnapshot: {
          ...makeSemanticSnapshot(),
          sdk: { ...makeSemanticSnapshot().sdk, isStreaming: true, isIdle: false },
        },
      },
    } as unknown as SessionViewState);
    const lines = [snapshotLine(baseSnapshot())];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);
    expect(container.querySelector(".subagents-fleet__stop-all")).not.toBeNull();
    expect(container.textContent).toContain("Stop all");
    unmount();
  });

  it("shows a 'Stop all' header control when active runs exist", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [
          { id: "r1", kind: "subagent", label: "worker", state: "running" },
          { id: "r2", kind: "subagent", label: "idle", state: "complete" },
        ],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet {...fleetProps(lines)} />);
    expect(container.querySelector(".subagents-fleet__stop-all")).not.toBeNull();
    unmount();
  });
});
