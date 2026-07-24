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

  it("hides saved-session search actions when unavailable for this launch", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "workspace.list") return [WS_A];
      if (channel === "workspace.listSessions") return [];
      if (channel === "session.open") {
        return {
          outcome: "opened",
          sessionId: "search-disabled-session",
          name: null,
          preview: null,
        };
      }
      if (channel === "session.activate") return undefined;
      if (channel === "settings.set") return defaultSettings;
      throw new Error(`Unexpected IPC channel ${channel}`);
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };
    useSettingsStore.setState({ settings: defaultSettings, loaded: true });
    useSessionsStore.getState().addWorkspace(WS_A);

    const { container, unmount } = mount(
      <Sidebar onOpenSettings={() => {}} sessionSearchAvailable={false} />,
    );
    await flushEffects();

    expect(container.querySelector(".sidebar__workspace-search")).toBeNull();
    unmount();
  });

  it("keeps workspace actions in stable trailing slots", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "workspace.list") return [];
      if (channel === "workspace.listSessions") return [];
      throw new Error(`Unexpected IPC channel ${channel}`);
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };
    useSessionsStore.getState().addWorkspace(WS_A);

    const { container, unmount } = mount(<Sidebar onOpenSettings={() => {}} />);
    await flushEffects();

    const actions = container.querySelector(".sidebar__workspace-actions");
    expect(actions).toBeTruthy();
    const actionButtons = actions!.querySelectorAll<HTMLButtonElement>("button");
    expect(actionButtons).toHaveLength(3);
    const [search, chevron, remove] = actionButtons;
    if (!search || !chevron || !remove) throw new Error("Missing workspace action button");
    expect(search.classList.contains("sidebar__workspace-search")).toBe(true);
    expect(search.getAttribute("aria-label")).toBe("Search sessions in workspace-a");
    expect(chevron.classList.contains("sidebar__workspace-chevron")).toBe(true);
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(remove.classList.contains("sidebar__remove-workspace")).toBe(true);
    expect(remove.getAttribute("title")).toBe("Remove workspace");
    unmount();
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
      settings: { ...defaultSettings, lastActiveWorkspace: WS_A, expandedWorkspaces: [WS_C] },
      loaded: true,
    });
    useSessionsStore.getState().addWorkspace(WS_A);
    useSessionsStore.getState().addWorkspace(WS_C);
    useSessionsStore.getState().setExpandedWorkspaces([WS_C]);
    useSessionsStore
      .getState()
      .createSession(SESSION_C, WS_C, "/tmp/session-c.jsonl", "Session C", undefined, "ready");
    useSessionsStore.getState().addUserMessage(SESSION_C, "hello", undefined, {
      registerEcho: false,
    });

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

  it("moves an older live session above unpinned peers after a delivered user message", async () => {
    const olderSessionId = "older-live" as SessionId;
    const olderFile = "/tmp/older-live.jsonl";
    const newerFile = "/tmp/newer-stored.jsonl";
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "workspace.list") return [];
      throw new Error(`Unexpected IPC channel ${channel}`);
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };

    useSettingsStore.setState({ settings: defaultSettings, loaded: false });
    useSessionsStore.getState().addWorkspace(WS_A);
    useSessionsStore.getState().setExpandedWorkspaces([WS_A]);
    useSessionsStore.getState().setWorkspaceSessions(WS_A, [
      {
        id: "older-live",
        cwd: WS_A,
        filePath: olderFile,
        name: "Older live session",
        preview: "older",
        mtime: 100,
        lastActiveAt: 100,
        messageCount: 1,
      },
      {
        id: "newer-stored",
        cwd: WS_A,
        filePath: newerFile,
        name: "Newer stored session",
        preview: "newer",
        mtime: 200,
        lastActiveAt: 200,
        messageCount: 1,
      },
    ]);
    useSessionsStore
      .getState()
      .createSession(olderSessionId, WS_A, olderFile, "Older live session", undefined, "ready");
    useSessionsStore.setState({ activeSessionId: olderSessionId, activeWorkspacePath: WS_A });

    const { container, unmount } = mount(<Sidebar onOpenSettings={() => {}} />);
    await flushEffects();
    const visibleNames = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".sidebar__session-name")).map(
        (row) => row.textContent,
      );
    expect(visibleNames()).toEqual(["Newer stored session", "Older live session"]);

    act(() => {
      useSessionsStore.getState().applyEvent(olderSessionId, {
        type: "message_start",
        message: {
          role: "user",
          content: "move this session to the top",
          timestamp: 300,
        },
        queueIntentId: "intent-promote-older",
      });
    });
    expect(visibleNames()).toEqual(["Older live session", "Newer stored session"]);

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
      settings: { ...defaultSettings, lastActiveWorkspace: WS_A, expandedWorkspaces: [WS_C] },
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

  it("requires confirmation before archiving a stored session", async () => {
    const filePath = "/tmp/archive-me.jsonl";
    const persistedSettings = { ...defaultSettings };
    const invoke = vi.fn(async (channel: string, payload: Record<string, unknown> = {}) => {
      switch (channel) {
        case "workspace.list":
          return [];
        case "workspace.listSessions":
          return [];
        case "settings.get":
          return persistedSettings;
        case "settings.set":
          Object.assign(persistedSettings, payload);
          return persistedSettings;
        default:
          throw new Error(`Unexpected IPC channel ${channel}`);
      }
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };

    useSessionsStore.getState().addWorkspace(WS_A);
    useSessionsStore.getState().setExpandedWorkspaces([WS_A]);
    useSessionsStore.getState().setWorkspaceSessions(WS_A, [
      {
        id: "archive-me",
        cwd: WS_A,
        filePath,
        name: "A carefully named session",
        preview: "Archive fixture",
        mtime: 1,
        messageCount: 1,
      },
    ]);

    const { container, unmount } = mount(<Sidebar onOpenSettings={() => {}} />);
    await flushEffects();

    const archiveButton = container.querySelector<HTMLButtonElement>(".sidebar__session-archive");
    expect(archiveButton).toBeTruthy();
    act(() => archiveButton!.click());

    const dialog = document.querySelector<HTMLElement>(".confirm-dialog");
    expect(dialog?.textContent).toContain("Archive session?");
    expect(dialog?.textContent).toContain("A carefully named session");
    expect(invoke).not.toHaveBeenCalledWith("settings.get", undefined);

    const cancelButton = Array.from(dialog!.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Cancel",
    );
    act(() => cancelButton!.click());
    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(container.querySelector(".sidebar__session")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("settings.get", undefined);

    act(() => archiveButton!.click());
    const confirmButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"),
    ).find((button) => button.textContent === "Archive");
    await act(async () => {
      confirmButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("settings.set", { archivedSessions: [filePath] });
    expect(document.querySelector(".confirm-dialog")).toBeNull();
    unmount();
  });

  it("preserves the live-session archive persistence, close, and refresh sequence", async () => {
    const sessionId = "archive-live" as SessionId;
    const filePath = "/tmp/archive-live.jsonl";
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case "workspace.list":
        case "workspace.listSessions":
          return [];
        case "settings.get":
          return defaultSettings;
        case "settings.set":
        case "session.close":
          return undefined;
        default:
          throw new Error(`Unexpected IPC channel ${channel}`);
      }
    });
    (globalThis.window as unknown as { pivis?: unknown }).pivis = { invoke };

    useSessionsStore.getState().addWorkspace(WS_A);
    useSessionsStore.getState().setExpandedWorkspaces([WS_A]);
    useSessionsStore
      .getState()
      .createSession(sessionId, WS_A, filePath, "Live archive fixture", undefined, "ready");
    useSessionsStore.getState().addUserMessage(sessionId, "keep this history", undefined, {
      registerEcho: false,
    });

    const { container, unmount } = mount(<Sidebar onOpenSettings={() => {}} />);
    await flushEffects();

    const archiveButton = container.querySelector<HTMLButtonElement>(".sidebar__session-archive");
    act(() => archiveButton!.click());
    expect(invoke).not.toHaveBeenCalledWith("settings.get", undefined);

    const confirmButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"),
    ).find((button) => button.textContent === "Archive");
    act(() => confirmButton!.click());

    await vi.waitFor(() => {
      expect(useSessionsStore.getState().sessions.has(sessionId)).toBe(false);
    });
    const archiveChannels = invoke.mock.calls
      .map(([channel]) => channel)
      .filter((channel) =>
        ["settings.get", "settings.set", "session.close", "workspace.listSessions"].includes(
          channel,
        ),
      );
    expect(archiveChannels).toEqual([
      "settings.get",
      "settings.set",
      "session.close",
      "workspace.listSessions",
    ]);
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
