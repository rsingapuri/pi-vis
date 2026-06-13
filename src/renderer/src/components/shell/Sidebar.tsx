import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import "./Sidebar.css";

function StatusDot({
  status,
  hasPendingDialog,
}: { status: SessionStatus; hasPendingDialog: boolean }): React.ReactElement {
  if (hasPendingDialog)
    return (
      <span className="status-dot status-dot--attention" title="Needs attention">
        ▲
      </span>
    );
  switch (status) {
    case "cold":
      return (
        <span className="status-dot status-dot--cold" title="Not running">
          ◌
        </span>
      );
    case "starting":
      return (
        <span className="status-dot status-dot--starting" title="Starting">
          ◌
        </span>
      );
    case "ready":
      return (
        <span className="status-dot status-dot--idle" title="Idle">
          ◌
        </span>
      );
    case "exited":
      return (
        <span className="status-dot status-dot--exited" title="Exited">
          ✕
        </span>
      );
    case "failed":
      return (
        <span className="status-dot status-dot--failed" title="Failed">
          ✕
        </span>
      );
  }
}

interface StreamingDotProps {
  isStreaming: boolean;
}

function StreamingIndicator({ isStreaming }: StreamingDotProps): React.ReactElement | null {
  if (!isStreaming) return null;
  return (
    <span className="status-dot status-dot--streaming" title="Streaming">
      ●
    </span>
  );
}

export function Sidebar({
  onOpenSettings,
  width,
  onResize,
}: {
  onOpenSettings: () => void;
  width: number;
  onResize: (width: number) => void;
}): React.ReactElement {
  const workspaces = useSessionsStore((s) => s.workspaces);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const activeWorkspacePath = useSessionsStore((s) => s.activeWorkspacePath);
  const addWorkspace = useSessionsStore((s) => s.addWorkspace);
  const removeWorkspace = useSessionsStore((s) => s.removeWorkspace);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const openSessionTab = useSessionsStore((s) => s.openSessionTab);
  const closeSessionTab = useSessionsStore((s) => s.closeSessionTab);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const setActiveWorkspace = useSessionsStore((s) => s.setActiveWorkspace);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const updateSettings = useSettingsStore((s) => s.update);
  const lastActiveWorkspace = useSettingsStore((s) => s.settings.lastActiveWorkspace);
  const sidebarRef = useRef<HTMLElement>(null);
  const isDragging = useRef(false);

  // Sidebar resize via drag handle
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        onResize(Math.max(160, Math.min(500, ev.clientX)));
      };
      const onUp = () => {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onResize],
  );

  const handleAddWorkspace = useCallback(async () => {
    const path = await window.pivis.invoke("workspace.pick", undefined);
    if (path) {
      addWorkspace(path);
      setActiveWorkspace(path);
      void updateSettings({ lastActiveWorkspace: path });
      void refreshWorkspaceSessions(path);
    }
  }, [addWorkspace, setActiveWorkspace, refreshWorkspaceSessions, updateSettings]);

  const handleNewSession = useCallback(
    (workspacePath: string) => {
      void openSessionTab(workspacePath);
    },
    [openSessionTab],
  );

  // Selecting a different workspace should land you in a fresh session in
  // the target workspace — launch parity. Selecting the already-active
  // workspace collapses it (same as before). The empty session you leave
  // behind disappears from the sidebar via the live-session filter
  // (it has no transcript content), but its pi process keeps running
  // until the app quits — existing hide-not-close semantics.
  const handleSelectWorkspace = useCallback(
    (path: string) => {
      if (activeWorkspacePath === path) {
        setActiveWorkspace(null);
        void updateSettings({ lastActiveWorkspace: null });
        return;
      }
      setActiveWorkspace(path);
      void updateSettings({ lastActiveWorkspace: path });
      void openSessionTab(path);
    },
    [activeWorkspacePath, setActiveWorkspace, openSessionTab, updateSettings],
  );

  const handleResumeSession = useCallback(
    (workspacePath: string, filePath: string, makeActive = true) => {
      void openSessionTab(workspacePath, filePath, { focus: makeActive });
    },
    [openSessionTab],
  );

  // Load recents on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once boot effect
  useEffect(() => {
    window.pivis
      .invoke("workspace.recents", undefined)
      .then((recents) => {
        for (const path of recents) {
          addWorkspace(path);
          void refreshWorkspaceSessions(path);
        }
        if (recents.length > 0 && !activeWorkspacePath) {
          setActiveWorkspace(recents[0] ?? null);
        }
      })
      .catch(console.error);
  }, []);

  // One-shot boot: restore the last-active workspace if it exists in the
  // loaded workspaces, otherwise fall back to the most-recently-used one
  // (first entry in the workspaces Map, which mirrors recents[] order on
  // disk, kept most-recent-first).
  const bootSessionRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot boot effect gated by bootSessionRef
  useEffect(() => {
    if (bootSessionRef.current) return;
    if (!settingsLoaded) return;
    if (workspaces.size === 0) return;
    bootSessionRef.current = true;

    const target =
      (lastActiveWorkspace && workspaces.has(lastActiveWorkspace)
        ? lastActiveWorkspace
        : undefined) ??
      Array.from(workspaces.keys())[0];
    if (target) {
      setActiveWorkspace(target);
      void openSessionTab(target); // new cold session, focused + activated
    }
  }, [settingsLoaded, workspaces.size, lastActiveWorkspace, openSessionTab, setActiveWorkspace]);

  return (
    <aside className="sidebar" ref={sidebarRef}>
      <div className="sidebar__draghandle" onMouseDown={handleResizeStart} />
      <div className="sidebar__workspaces">
        {Array.from(workspaces.values()).map((ws) => {
          const isActiveWs = activeWorkspacePath === ws.path;
          const activeSessionsForWs = Array.from(sessions.values()).filter(
            (s) => s.workspacePath === ws.path,
          );

          return (
            <div
              key={ws.path}
              className={`sidebar__workspace ${isActiveWs ? "sidebar__workspace--active" : ""}`}
            >
              <button
                type="button"
                className="sidebar__workspace-header"
                onClick={() => handleSelectWorkspace(ws.path)}
                title={ws.path}
              >
                <span className="sidebar__workspace-name">
                  {ws.path.split("/").pop() ?? ws.path}
                </span>
                <span className="sidebar__workspace-path">{ws.path}</span>
              </button>

              {isActiveWs && (
                <div className="sidebar__sessions">
                  <button
                    type="button"
                    className="sidebar__new-session"
                    onClick={() => handleNewSession(ws.path)}
                  >
                    + New session
                  </button>

                  {/* Live sessions pinned on top, newest-opened first. */}
                  {activeSessionsForWs
                    .filter((s) => {
                      // The active tab is always visible. Otherwise show a row
                      // only if it has real transcript content — an empty
                      // session (no messages yet) disappears once you switch
                      // away, even after pi has assigned it a file. This is
                      // safe because resumed stored sessions always seed a
                      // transcript (blocks > 0) and open focused.
                      if (s.sessionId === activeSessionId) return true;
                      return s.transcript.blocks.length > 0;
                    })
                    .reverse() // newest-opened first
                    .map((s) => (
                      <div
                        key={s.sessionId}
                        role="button"
                        tabIndex={0}
                        className={`sidebar__session sidebar__session--live ${activeSessionId === s.sessionId ? "sidebar__session--active" : ""}`}
                        onClick={() => setActiveSession(s.sessionId)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setActiveSession(s.sessionId);
                          }
                        }}
                      >
                        {s.isStreaming ? (
                          <StreamingIndicator isStreaming />
                        ) : (
                          <StatusDot
                            status={s.status}
                            hasPendingDialog={s.pendingDialogs.length > 0}
                          />
                        )}
                        <span className="sidebar__session-name">
                          {s.sessionName ?? s.sessionTitle ?? "New session"}
                        </span>
                        <button
                          type="button"
                          className="sidebar__session-close"
                          title="Close tab"
                          onClick={(e) => {
                            e.stopPropagation();
                            void closeSessionTab(s.sessionId);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}

                  {/* Stored sessions */}
                  {ws.sessions
                    .filter((s) => s.messageCount > 0)
                    .map((stored) => {
                      const alreadyLive = activeSessionsForWs.some(
                        (s) => s.sessionFile === stored.filePath,
                      );
                      if (alreadyLive) return null;
                      return (
                        <button
                          type="button"
                          key={stored.filePath}
                          className="sidebar__session sidebar__session--stored"
                          onClick={() => handleResumeSession(ws.path, stored.filePath)}
                          title={`Resume: ${stored.filePath}`}
                        >
                          <span className="sidebar__session-preview">
                            {stored.name ?? stored.preview ?? "Session"}
                          </span>
                          <span className="sidebar__session-meta">{stored.messageCount}msg</span>
                        </button>
                      );
                    })}
                </div>
              )}

              <button
                type="button"
                className="sidebar__remove-workspace"
                onClick={() => {
                  for (const s of Array.from(sessions.values())) {
                    if (s.workspacePath === ws.path) void closeSessionTab(s.sessionId);
                  }
                  window.pivis
                    .invoke("workspace.remove", { workspacePath: ws.path })
                    .catch(console.error);
                  removeWorkspace(ws.path);
                }}
                title="Remove workspace"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="sidebar__footer">
        <button type="button" className="sidebar__add-workspace" onClick={handleAddWorkspace}>
          + Add workspace
        </button>
        <button
          type="button"
          className="sidebar__settings-btn"
          onClick={onOpenSettings}
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </aside>
  );
}
