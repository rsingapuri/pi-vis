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
import { SessionControls } from "./SessionHeader.js";

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
    status: "exited",
    transcript: createTranscriptState(),
    isStreaming: false,
    promptsInFlight: 0,
    bashInFlight: 0,
    interruptible: false,
    retryPending: false,
    streamingEpoch: 0,
    queueEpoch: 0,
    identityEpoch: 0,
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
  } as SessionViewState;

  useSessionsStore.setState({ sessions: new Map([[sessionId, session]]) });
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

  it("supports keyboard selection when models are grouped by provider", async () => {
    setSession();
    useSettingsStore.setState({
      settings: { ...defaultSettings, groupModelsByProvider: true },
    });
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    const invoke = vi.fn(async (channel: string, payload: { command?: { type?: string } }) => {
      if (channel === "settings.set") {
        return { ...defaultSettings, ...payload };
      }
      if (payload.command?.type === "get_state") {
        return { success: true, data: { model: { id: "claude", provider: "anthropic" } } };
      }
      return { success: true, data: {} };
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };

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
      "session.sendCommand",
      expect.objectContaining({
        command: { type: "set_model", provider: "anthropic", modelId: "claude" },
      }),
    );
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "settings.set",
        expect.objectContaining({
          lastUsedModel: { provider: "anthropic", modelId: "claude" },
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unhandledRejection).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandledRejection);
    unmount();
  });
});
