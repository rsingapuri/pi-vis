// @vitest-environment jsdom
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { SessionStopButton } from "./SessionStopButton.js";

const SESSION_ID = "s1" as never;

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

function installSession(isStreaming: boolean): void {
  useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
  useSessionsStore.getState().createSession(SESSION_ID, "/workspace", "/session.jsonl");
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID)!;
    sessions.set(SESSION_ID, {
      ...session,
      authorityProjection: {
        ...session.authorityProjection,
        authoritativeSnapshot: {
          ...(session.authorityProjection?.authoritativeSnapshot ?? {}),
          sdk: { isStreaming },
        },
      },
    } as never);
    return { sessions };
  });
}

describe("SessionStopButton", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders nothing when the session is not streaming", () => {
    installSession(false);
    const { container, unmount } = mount(<SessionStopButton sessionId={SESSION_ID} />);
    expect(container.querySelector(".session-stop__btn")).toBeNull();
    unmount();
  });

  it("shows a labeled stop pill while streaming and aborts the session on click", () => {
    installSession(true);
    const abortSpy = vi.spyOn(useSessionsStore.getState(), "abortSession");
    const { container, unmount } = mount(<SessionStopButton sessionId={SESSION_ID} />);
    const btn = container.querySelector<HTMLButtonElement>(".session-stop__btn");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("Stop generating");
    act(() => {
      btn!.click();
    });
    expect(abortSpy).toHaveBeenCalledWith(SESSION_ID);
    unmount();
  });
});
