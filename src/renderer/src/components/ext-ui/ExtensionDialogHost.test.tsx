// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type { ReactElement } from "react";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RENDERER_GENERATION } from "../../lib/renderer-generation.js";
import { useOverlayStore } from "../../stores/overlay-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { ExtensionDialogHost } from "./ExtensionDialogHost.js";

const SESSION_ID = "startup-trust-session" as SessionId;
const HOST_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

function mount(node: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => flushSync(() => root.render(node)));
  return {
    container,
    unmount: () => {
      act(() => flushSync(() => root.unmount()));
      container.remove();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installStartupTrustRequest(): void {
  useSessionsStore.setState({
    sessions: new Map(),
    workspaces: new Map(),
    activeSessionId: null,
    activeWorkspacePath: null,
  });
  useSessionsStore
    .getState()
    .createSession(SESSION_ID, "/workspace", "/session.jsonl", undefined, undefined, "starting");
  useSessionsStore.getState().addUiRequest(SESSION_ID, {
    type: "extension_ui_request",
    id: "startup-trust",
    operationId: "startup-trust",
    hostInstanceId: HOST_INSTANCE_ID,
    sessionEpoch: 0,
    method: "select",
    title: "Trust /workspace?",
    options: ["Trust this folder", "Do not trust"],
  });
}

describe("ExtensionDialogHost startup trust", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    useOverlayStore.setState({ claims: [], count: 0 });
    useSessionsStore.setState({
      sessions: new Map(),
      workspaces: new Map(),
      activeSessionId: null,
      activeWorkspacePath: null,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("submits a clicked startup choice with its pre-ready owner", async () => {
    installStartupTrustRequest();
    const invoke = vi.fn().mockResolvedValue({ acknowledged: true });
    Object.defineProperty(window, "pivis", {
      configurable: true,
      value: { invoke },
    });
    const view = mount(<ExtensionDialogHost sessionId={SESSION_ID} />);

    const choice = [...view.container.querySelectorAll<HTMLButtonElement>("[role=option]")].find(
      (button) => button.textContent === "Trust this folder",
    );
    expect(choice).toBeTruthy();
    await act(async () => choice!.click());
    await settle();

    expect(invoke).toHaveBeenCalledWith("session.respondToUiRequest", {
      sessionId: SESSION_ID,
      rendererGeneration: RENDERER_GENERATION,
      expectedHostInstanceId: HOST_INSTANCE_ID,
      expectedSessionEpoch: 0,
      operationId: "startup-trust",
      response: {
        type: "extension_ui_response",
        id: "startup-trust",
        value: "Trust this folder",
      },
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingDialogs).toEqual([]);
    view.unmount();
  });

  it("submits the highlighted startup choice on Enter", async () => {
    installStartupTrustRequest();
    const invoke = vi.fn().mockResolvedValue({ acknowledged: true });
    Object.defineProperty(window, "pivis", {
      configurable: true,
      value: { invoke },
    });
    const view = mount(<ExtensionDialogHost sessionId={SESSION_ID} />);
    const dialog = view.container.querySelector<HTMLElement>(".ext-dialog");
    expect(dialog).toBeTruthy();

    await act(async () => {
      dialog!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(invoke).toHaveBeenCalledWith(
      "session.respondToUiRequest",
      expect.objectContaining({
        sessionId: SESSION_ID,
        expectedHostInstanceId: HOST_INSTANCE_ID,
        expectedSessionEpoch: 0,
        operationId: "startup-trust",
        response: expect.objectContaining({ value: "Trust this folder" }),
      }),
    );
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.pendingDialogs).toEqual([]);
    view.unmount();
  });
});
