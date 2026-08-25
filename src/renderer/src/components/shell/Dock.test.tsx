// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { Dock } from "./Dock.js";

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

function seedSession(sessionId: SessionId, widgets: Map<string, string[]>): void {
  useSessionsStore.setState({
    sessions: new Map([
      [
        sessionId,
        {
          ...(useSessionsStore.getState().sessions.get(sessionId) ?? {}),
          widgets,
        } as unknown as import("../../stores/sessions-store.js").SessionViewState,
      ],
    ]),
    activeSessionId: sessionId,
  });
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

describe("Dock", () => {
  afterEach(() => {
    useSessionsStore.setState({
      workspaces: new Map(),
      sessions: new Map(),
      activeSessionId: null,
      activeWorkspacePath: null,
      expandedWorkspaces: [],
    });
    document.body.innerHTML = "";
  });

  it("renders the SubagentsFleet card for the subagent-async widget", () => {
    const sessionId = "session-a" as SessionId;
    const widgets = new Map<string, string[]>([
      [
        "subagent-async",
        [
          snapshotLine({
            ...baseSnapshot(),
            runs: [{ id: "run-a", kind: "subagent", label: "researcher", state: "running" }],
          }),
        ],
      ],
    ]);
    seedSession(sessionId, widgets);

    const { container, unmount } = mount(<Dock sessionId={sessionId} />);
    expect(container.textContent).toContain("Subagents");
    expect(container.textContent).toContain("run-a");
    expect(container.textContent).toContain("researcher");
    expect(container.textContent).toContain("running");
    unmount();
  });

  it("switches to a different session's widget state and resets the fleet", () => {
    const sessionA = "session-a" as SessionId;
    const sessionB = "session-b" as SessionId;

    useSessionsStore.setState({
      sessions: new Map([
        [
          sessionA,
          {
            ...(useSessionsStore.getState().sessions.get(sessionA) ?? {}),
            widgets: new Map<string, string[]>([
              [
                "subagent-async",
                [
                  snapshotLine({
                    ...baseSnapshot(),
                    runs: [
                      { id: "run-a", kind: "subagent", label: "researcher", state: "running" },
                    ],
                  }),
                ],
              ],
            ]),
          } as unknown as import("../../stores/sessions-store.js").SessionViewState,
        ],
        [
          sessionB,
          {
            ...(useSessionsStore.getState().sessions.get(sessionB) ?? {}),
            widgets: new Map(),
          } as unknown as import("../../stores/sessions-store.js").SessionViewState,
        ],
      ]),
      activeSessionId: sessionA,
    });

    const { container, rerender, unmount } = mount(<Dock sessionId={sessionA} />);
    expect(container.textContent).toContain("run-a");

    rerender(<Dock sessionId={sessionB} />);
    expect(container.firstChild).toBeNull();
    expect(container.textContent).not.toContain("run-a");

    unmount();
  });

  it("falls back to plain text widgets for other widget keys", () => {
    const sessionId = "session-b" as SessionId;
    const widgets = new Map<string, string[]>([["other-widget", ["hello world"]]]);
    seedSession(sessionId, widgets);

    const { container, unmount } = mount(<Dock sessionId={sessionId} />);
    expect(container.textContent).toContain("hello world");
    expect(container.querySelector(".dock__widget")).not.toBeNull();
    unmount();
  });

  it("returns null when there are no widgets", () => {
    const sessionId = "session-c" as SessionId;
    seedSession(sessionId, new Map());
    const { container, unmount } = mount(<Dock sessionId={sessionId} />);
    expect(container.firstChild).toBeNull();
    unmount();
  });
});
