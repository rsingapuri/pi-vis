// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import { defaultSettings } from "@shared/settings.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { Sidebar } from "./Sidebar.js";

const WS_A = "/tmp/workspace-a";
const WS_C = "/tmp/workspace-c";
const SESSION_C = "session-c" as SessionId;

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

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Sidebar boot workspace restore", () => {
  afterEach(() => {
    useSessionsStore.setState({
      workspaces: new Map(),
      sessions: new Map(),
      activeSessionId: null,
      activeWorkspacePath: null,
      expandedWorkspaces: [],
    });
    useSettingsStore.setState({ settings: defaultSettings, loaded: false });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = undefined;
    document.body.innerHTML = "";
  });

  it("persists the last active workspace when a live session row is selected", async () => {
    const invoke = vi.fn(async (channel: string, payload: { workspacePath?: string } = {}) => {
      switch (channel) {
        case "workspace.list":
          return [WS_A, WS_C];
        case "workspace.listSessions":
          return [];
        case "session.open":
          return {
            outcome: "opened",
            sessionId: `session:${payload.workspacePath}`,
            name: null,
            preview: null,
          };
        case "session.activate":
          return undefined;
        case "settings.set":
          return { ...defaultSettings, ...payload };
        default:
          throw new Error(`Unexpected IPC channel ${channel}`);
      }
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };

    useSettingsStore.setState({
      settings: { ...defaultSettings, lastActiveWorkspace: WS_A },
      loaded: true,
    });
    useSessionsStore.getState().addWorkspace(WS_A);
    useSessionsStore.getState().addWorkspace(WS_C);
    useSessionsStore.getState().setExpandedWorkspaces([WS_C]);
    useSessionsStore
      .getState()
      .createSession(SESSION_C, WS_C, "/tmp/session-c.jsonl", "Session C", undefined, "ready");

    const { container, unmount } = mount(<Sidebar onOpenSettings={() => {}} />);
    await flushEffects();

    const row = Array.from(container.querySelectorAll<HTMLElement>(".sidebar__session")).find(
      (el) => el.textContent?.includes("Session C"),
    );
    expect(row).toBeTruthy();
    act(() => row!.click());

    expect(useSessionsStore.getState().activeWorkspacePath).toBe(WS_C);
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("settings.set", { lastActiveWorkspace: WS_C });
    });
    unmount();
  });

  it("persists the last active workspace before opening a stored session", async () => {
    const invoke = vi.fn(async (channel: string, payload: { workspacePath?: string } = {}) => {
      switch (channel) {
        case "workspace.list":
          return [WS_A, WS_C];
        case "workspace.listSessions":
          return payload.workspacePath === WS_C
            ? [
                {
                  id: "stored-c",
                  cwd: WS_C,
                  filePath: "/tmp/session-c.jsonl",
                  name: "Stored Session C",
                  preview: "Stored Session C",
                  mtime: 1,
                  messageCount: 1,
                },
              ]
            : [];
        case "session.open":
          return {
            outcome: "opened",
            sessionId: `session:${payload.workspacePath}`,
            name: null,
            preview: null,
          };
        case "session.activate":
          return undefined;
        case "settings.set":
          return { ...defaultSettings, ...payload };
        default:
          throw new Error(`Unexpected IPC channel ${channel}`);
      }
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };

    useSettingsStore.setState({
      settings: { ...defaultSettings, lastActiveWorkspace: WS_A },
      loaded: true,
    });
    useSessionsStore.getState().addWorkspace(WS_A);
    useSessionsStore.getState().addWorkspace(WS_C);
    useSessionsStore.getState().setExpandedWorkspaces([WS_C]);
    useSessionsStore.getState().setWorkspaceSessions(WS_C, [
      {
        id: "stored-c",
        cwd: WS_C,
        filePath: "/tmp/session-c.jsonl",
        name: "Stored Session C",
        preview: "Stored Session C",
        mtime: 1,
        messageCount: 1,
      },
    ]);

    const { container, unmount } = mount(<Sidebar onOpenSettings={() => {}} />);
    await flushEffects();

    const row = Array.from(container.querySelectorAll<HTMLElement>(".sidebar__session")).find(
      (el) => el.textContent?.includes("Stored Session C"),
    );
    expect(row).toBeTruthy();
    act(() => row!.click());

    expect(useSessionsStore.getState().activeWorkspacePath).toBe(WS_C);
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("settings.set", { lastActiveWorkspace: WS_C });
    });
    expect(invoke).toHaveBeenCalledWith("session.open", {
      workspacePath: WS_C,
      sessionFile: "/tmp/session-c.jsonl",
    });
    unmount();
  });

  it("waits for the full workspace list before restoring the last active workspace", async () => {
    let resolveWorkspaceList!: (value: string[]) => void;
    const workspaceList = new Promise<string[]>((resolve) => {
      resolveWorkspaceList = resolve;
    });
    const invoke = vi.fn(async (channel: string, payload: { workspacePath?: string } = {}) => {
      switch (channel) {
        case "workspace.list":
          return workspaceList;
        case "workspace.listSessions":
          return [];
        case "session.open":
          return {
            outcome: "opened",
            sessionId: `session:${payload.workspacePath}`,
            name: null,
            preview: null,
          };
        case "session.activate":
          return undefined;
        case "settings.set":
          return { ...defaultSettings, ...payload };
        default:
          throw new Error(`Unexpected IPC channel ${channel}`);
      }
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };

    useSettingsStore.setState({
      settings: { ...defaultSettings, lastActiveWorkspace: WS_C },
      loaded: true,
    });
    // Simulates another workspace becoming visible before workspace.list has
    // finished adding the user's last-active workspace. Boot must not fall back
    // to this first entry and burn its one-shot restore.
    useSessionsStore.getState().addWorkspace(WS_A);

    const { unmount } = mount(<Sidebar onOpenSettings={() => {}} />);
    await flushEffects();

    expect(useSessionsStore.getState().activeWorkspacePath).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("session.open", expect.anything());

    await act(async () => {
      resolveWorkspaceList([WS_A, WS_C]);
      await workspaceList;
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(useSessionsStore.getState().activeWorkspacePath).toBe(WS_C);
    });
    expect(invoke).toHaveBeenCalledWith("session.open", {
      workspacePath: WS_C,
      sessionFile: undefined,
    });

    unmount();
  });
});
