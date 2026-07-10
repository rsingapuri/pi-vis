// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type { SessionStats } from "@shared/pi-protocol/responses.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionViewState, useSessionsStore } from "../../stores/sessions-store.js";
import { createTranscriptState } from "../../stores/transcript.js";
import { ContextMeter } from "./ContextMeter.js";

const sessionId = "s-context" as SessionId;

function mount(node: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
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
  };
}

function setStats(stats: SessionStats): void {
  const session = {
    sessionId,
    workspacePath: "/tmp/project",
    status: "ready",
    transcript: createTranscriptState(),
    isStreaming: false,
    promptsInFlight: 0,
    bashInFlight: 0,
    interruptible: false,
    retryPending: false,
    agentGeneration: 0,
    lastEndedAgentGeneration: 0,
    streamingEpoch: 0,
    queueEpoch: 0,
    identityEpoch: 0,
    turnErrored: false,
    pendingDialogs: [],
    statusSegments: new Map(),
    widgets: new Map(),
    toasts: [],
    availableModels: [],
    commands: [],
    resumed: false,
    modelInitialized: true,
    stats,
  } as SessionViewState;

  useSessionsStore.setState({ sessions: new Map([[sessionId, session]]) });
}

function openDropdown(container: HTMLElement): void {
  const button = container.querySelector<HTMLButtonElement>(".context-ring");
  expect(button).toBeTruthy();
  act(() => button!.click());
}

describe("ContextMeter", () => {
  afterEach(() => {
    useSessionsStore.setState({ sessions: new Map() });
    document.body.innerHTML = "";
  });

  it("shows cache rows only when the values are non-zero, in the expected order", () => {
    setStats({
      sessionId,
      tokens: { input: 100, output: 25, cacheRead: 50, cacheWrite: 0, total: 175 },
      contextUsage: { tokens: 175, contextWindow: 1000, percent: 17.5 },
    });

    const { container, unmount } = mount(<ContextMeter sessionId={sessionId} />);
    openDropdown(container);

    expect(
      [...container.querySelectorAll(".context-dropdown__row dt")].map((el) => el.textContent),
    ).toEqual(["Input", "Output", "Cache read", "Cache hit rate"]);
    expect(container.textContent).not.toContain("Cache write");
    unmount();
  });

  it("includes cache write when it is non-zero", () => {
    setStats({
      sessionId,
      tokens: { input: 100, output: 25, cacheRead: 0, cacheWrite: 40, total: 165 },
      contextUsage: { tokens: 165, contextWindow: 1000, percent: 16.5 },
    });

    const { container, unmount } = mount(<ContextMeter sessionId={sessionId} />);
    openDropdown(container);

    expect(
      [...container.querySelectorAll(".context-dropdown__row dt")].map((el) => el.textContent),
    ).toEqual(["Input", "Output", "Cache write"]);
    expect(container.textContent).not.toContain("Cache read");
    expect(container.textContent).not.toContain("Cache hit rate");
    unmount();
  });
});
