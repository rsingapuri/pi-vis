// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type { ModelInfo } from "@shared/pi-protocol/responses.js";
import { defaultSettings } from "@shared/settings.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionViewState, useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { createTranscriptState } from "../../stores/transcript.js";
import { SessionControls, thinkingLevelsForModel } from "./SessionHeader.js";

const sessionId = "s-controls" as SessionId;

const models: ModelInfo[] = [
  { id: "glm-5", name: "GLM 5", provider: "zai", reasoning: true },
  { id: "claude", name: "Claude", provider: "anthropic", reasoning: true },
];

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

function setSession(): void {
  const session = {
    sessionId,
    workspacePath: "/tmp/project",
    status: "ready",
    transcript: createTranscriptState(),
    availability: "available",
    hostInstanceId: "host-controls",
    sessionEpoch: 1,
    editorRevision: 0,
    turnErrored: false,
    pendingDialogs: [],
    statusSegments: new Map(),
    widgets: new Map(),
    toasts: [],
    availableModels: models,
    currentModel: "glm-5",
    currentProvider: "zai",
    thinkingLevel: "medium",
    commands: [],
    resumed: false,
    modelInitialized: true,
    authorityProjection: {
      semantic: {
        state: "following",
        cursor: {
          hostInstanceId: "host-controls",
          sessionEpoch: 1,
          transportSequence: 1,
          snapshotSequence: 1,
        },
      },
      authoritativeSnapshot: {
        owner: { hostInstanceId: "host-controls", sessionEpoch: 1 },
        model: { id: "glm-5", provider: "zai" },
        thinkingLevel: "medium",
        recentIntentOutcomes: [],
      },
    },
  } as unknown as SessionViewState;

  useSessionsStore.setState({ sessions: new Map([[sessionId, session]]) });
  (globalThis.window as unknown as { pivis?: unknown }).pivis = {
    invoke: vi.fn(async () => ({ success: true, data: {} })),
    on: vi.fn(() => () => {}),
  };
  useSettingsStore.setState({
    settings: { ...defaultSettings, groupModelsByProvider: false },
  });
}

function pointerClick(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button.click();
  });
}

describe("thinkingLevelsForModel", () => {
  it("exposes max only for models that opt in and filters null mappings", () => {
    expect(
      thinkingLevelsForModel({
        id: "gpt-5.6",
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      }),
    ).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps legacy model records compatible without advertising opt-in levels", () => {
    expect(thinkingLevelsForModel({ id: "legacy", reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(thinkingLevelsForModel({ id: "plain", reasoning: false })).toEqual(["off"]);
  });
});

describe("SessionControls dropdown toggles", () => {
  afterEach(() => {
    useSessionsStore.setState({ sessions: new Map() });
    useSettingsStore.setState({ settings: defaultSettings });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = undefined;
    document.body.innerHTML = "";
  });

  it("closes the open model dropdown when its trigger is clicked again", () => {
    setSession();
    const { container, unmount } = mount(<SessionControls sessionId={sessionId} />);
    const button = container.querySelector<HTMLButtonElement>(".session-header__model-btn");
    expect(button).toBeTruthy();

    pointerClick(button!);
    expect(container.querySelector(".session-header__dropdown")).toBeTruthy();

    pointerClick(button!);
    expect(container.querySelector(".session-header__dropdown")).toBeNull();
    unmount();
  });

  it("closes the open thinking dropdown when its trigger is clicked again", () => {
    setSession();
    const { container, unmount } = mount(<SessionControls sessionId={sessionId} />);
    const button = container.querySelector<HTMLButtonElement>(".session-header__thinking button");
    expect(button).toBeTruthy();

    pointerClick(button!);
    expect(container.querySelector(".session-header__dropdown")).toBeTruthy();

    pointerClick(button!);
    expect(container.querySelector(".session-header__dropdown")).toBeNull();
    unmount();
  });

  it("retains labels but disables controls while semantic authority is fenced", () => {
    setSession();
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      const session = sessions.get(sessionId)!;
      sessions.set(sessionId, {
        ...session,
        authorityProjection: {
          ...session.authorityProjection!,
          semantic: { state: "unavailable", reason: "test" },
          authoritativeSnapshot: undefined,
        },
      });
      return { sessions };
    });

    const { container, unmount } = mount(<SessionControls sessionId={sessionId} />);
    const modelButton = container.querySelector<HTMLButtonElement>(".session-header__model-btn");
    const thinkingButton = container.querySelector<HTMLButtonElement>(
      ".session-header__thinking button",
    );
    expect(modelButton?.textContent).toContain("GLM 5");
    expect(thinkingButton?.textContent).toContain("medium");
    expect(modelButton?.disabled).toBe(true);
    expect(thinkingButton?.disabled).toBe(true);
    modelButton?.click();
    thinkingButton?.click();
    expect(
      (globalThis.window as unknown as { pivis: { invoke: ReturnType<typeof vi.fn> } }).pivis
        .invoke,
    ).not.toHaveBeenCalled();
    unmount();
  });

  it("supports keyboard selection when models are grouped by provider", async () => {
    setSession();
    useSettingsStore.setState({
      settings: { ...defaultSettings, groupModelsByProvider: true },
    });
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    const invoke = vi.fn(async (channel: string, payload: { query?: { type?: string } }) => {
      if (channel === "session.query") {
        return {
          queryId: "query",
          owner: { hostInstanceId: "host-controls", sessionEpoch: 1 },
          queryType: payload.query?.type,
          response: { success: true, command: payload.query?.type, data: { models } },
        };
      }
      if (channel === "session.dispatchIntent") {
        return {
          status: "admitted",
          intentId: "intent",
          owner: { hostInstanceId: "host-controls", sessionEpoch: 1 },
        };
      }
      return { success: true, data: {} };
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = {
      invoke,
      on: vi.fn(() => () => {}),
    };

    const { container, unmount } = mount(<SessionControls sessionId={sessionId} />);
    const button = container.querySelector<HTMLButtonElement>(".session-header__model-btn");
    expect(button).toBeTruthy();
    pointerClick(button!);

    const input = container.querySelector<HTMLInputElement>(
      ".session-header__dropdown-search-input",
    );
    expect(input).toBeTruthy();

    const arrowUp = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    act(() => input!.dispatchEvent(arrowUp));
    expect(arrowUp.defaultPrevented).toBe(true);
    expect(container.querySelector(".session-header__provider-model-list")).toBeTruthy();

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      input!.dispatchEvent(enter);
      await Promise.resolve();
    });

    expect(enter.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      "session.dispatchIntent",
      expect.objectContaining({
        expectedOwner: { hostInstanceId: "host-controls", sessionEpoch: 1 },
        observedCursor: expect.objectContaining({ transportSequence: 1, snapshotSequence: 1 }),
        intent: { kind: "setModel", provider: "anthropic", modelId: "claude" },
      }),
    );
    // Receipt admission is not canonical state: the old authority-frame model
    // remains rendered while the request is visibly pending.
    expect(container.querySelector(".session-header__model-btn")?.textContent).toContain("GLM 5");
    expect(container.textContent).toContain("Pending…");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unhandledRejection).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandledRejection);
    unmount();
  });
});
