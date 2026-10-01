// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { UnifiedViewToggle } from "./UnifiedViewToggle.js";

const SESSION_ID = "unified-toggle-session" as SessionId;

describe("UnifiedViewToggle focus ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: SESSION_ID,
      composerFocusRequest: undefined,
    });
    useSessionsStore.getState().createSession(SESSION_ID, "/tmp/unified-toggle");
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      const session = sessions.get(SESSION_ID)!;
      sessions.set(SESSION_ID, {
        ...session,
        unifiedPanel: {
          id: 7,
          hostInstanceId: "host-1",
          sessionEpoch: 1,
          buffer: [],
        },
        unifiedPanelHidden: false,
      });
      return { sessions };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("requests terminal focus when the already-selected Extension tab is clicked", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<UnifiedViewToggle sessionId={SESSION_ID} />));

    const extension = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    );
    expect(extension?.textContent).toBe("Extension");
    extension?.focus();
    expect(document.activeElement).toBe(extension);

    act(() => extension?.click());

    expect(useSessionsStore.getState().composerFocusRequest).toMatchObject({
      sessionId: SESSION_ID,
      nonce: expect.any(Number),
    });
    act(() => root.unmount());
  });
});
