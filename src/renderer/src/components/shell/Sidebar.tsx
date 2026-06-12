import React, { useCallback, useEffect, useRef } from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import { SessionStatsSchema } from "@shared/pi-protocol/responses.js";
import "./Sidebar.css";

function StatusDot({ status, hasPendingDialog }: { status: SessionStatus; hasPendingDialog: boolean }): React.ReactElement {
  if (hasPendingDialog) return <span className="status-dot status-dot--attention" title="Needs attention">▲</span>;
  switch (status) {
    case "starting": return <span className="status-dot status-dot--starting" title="Starting">◌</span>;
    case "ready": return <span className="status-dot status-dot--idle" title="Idle">◌</span>;
    case "exited": return <span className="status-dot status-dot--exited" title="Exited">✕</span>;
    case "failed": return <span className="status-dot status-dot--failed" title="Failed">✕</span>;
  }
}

interface StreamingDotProps {
  isStreaming: boolean;
}

function StreamingIndicator({ isStreaming }: StreamingDotProps): React.ReactElement | null {
  if (!isStreaming) return null;
  return <span className="status-dot status-dot--streaming" title="Streaming">●</span>;
}

export function Sidebar({ onOpenSettings, width, onResize }: { onOpenSettings: () => void; width: number; onResize: (width: number) => void }): React.ReactElement {
  const {
    workspaces,
    sessions,
    activeSessionId,
    activeWorkspacePath,
    addWorkspace,
    removeWorkspace,
    refreshWorkspaceSessions,
    createSession,
    setActiveSession,
    setActiveWorkspace,
    seedHistory,
  } = useSessionsStore();
  const { settings, loaded: settingsLoaded, update: updateSettings } = useSettingsStore();
  const openSessionsRef = useRef(settings.openSessions);
  const sidebarRef = useRef<HTMLElement>(null);
  const isDragging = useRef(false);
  useEffect(() => { openSessionsRef.current = settings.openSessions; }, [settings.openSessions]);

  // Sidebar resize via drag handle
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
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
  }, [onResize]);

  const handleAddWorkspace = useCallback(async () => {
    const path = await window.pivis.invoke("workspace.pick", undefined);
    if (path) {
      addWorkspace(path);
      setActiveWorkspace(path);
      void refreshWorkspaceSessions(path);
    }
  }, [addWorkspace, setActiveWorkspace, refreshWorkspaceSessions]);

  const handleNewSession = useCallback(async (workspacePath: string) => {
    try {
      const sessionId = await window.pivis.invoke("session.start", { workspacePath });
      createSession(sessionId, workspacePath);
      setActiveSession(sessionId);

      // Persist newly created sessions: poll get_session_stats until the
      // sessionFile is known, then register it in openSessions.
      let attempts = 0;
      const registerFile = () => {
        window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: { type: "get_session_stats" },
        }).then((res) => {
          if (!res.success || !res.data) return;
          const parsed = SessionStatsSchema.safeParse(res.data);
          if (!parsed.success || !parsed.data.sessionFile) {
            if (++attempts < 6) setTimeout(registerFile, 2000);
            return;
          }
          void updateSettings({
            openSessions: [
              { workspacePath, sessionFile: parsed.data.sessionFile },
              ...(openSessionsRef.current ?? []).filter(
                (s) => !(s.workspacePath === workspacePath && s.sessionFile === parsed.data.sessionFile),
              ),
            ],
          });
        }).catch(() => {
          if (++attempts < 6) setTimeout(registerFile, 2000);
        });
      };
      setTimeout(registerFile, 2000);
    } catch (err) {
      console.error("Failed to start session:", err);
    }
  }, [createSession, setActiveSession, updateSettings]);

  const handleResumeSession = useCallback(async (workspacePath: string, filePath: string, makeActive = true) => {
    try {
      const sessionId = await window.pivis.invoke("session.start", { workspacePath, resumeFile: filePath });
      createSession(sessionId, workspacePath, filePath);
      if (makeActive) setActiveSession(sessionId);

      // Load history
      const history = await window.pivis.invoke("session.loadHistory", { sessionId });
      if (history.length > 0) {
        seedHistory(sessionId, history);
      }

      // Persist so this session is restored on next launch
      void updateSettings({
        openSessions: [
          { workspacePath, sessionFile: filePath },
          ...(openSessionsRef.current ?? []).filter(
            (s) => !(s.workspacePath === workspacePath && s.sessionFile === filePath),
          ),
        ],
      });
    } catch (err) {
      console.error("Failed to resume session:", err);
    }
  }, [createSession, setActiveSession, seedHistory, updateSettings]);

  // Load recents on mount
  useEffect(() => {
    window.pivis.invoke("workspace.recents", undefined).then((recents) => {
      for (const path of recents) {
        addWorkspace(path);
        void refreshWorkspaceSessions(path);
      }
      if (recents.length > 0 && !activeWorkspacePath) {
        setActiveWorkspace(recents[0] ?? null);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore previously open sessions once both workspaces and settings are ready.
  // Uses a ref so this runs at most once per app session regardless of re-renders.
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (sessionRestoredRef.current) return;
    if (!settingsLoaded) return;
    if (workspaces.size === 0) return;

    sessionRestoredRef.current = true;

    const workspacePaths = Array.from(workspaces.keys());
    const toRestore = (settings.openSessions ?? []).filter((s) =>
      workspacePaths.includes(s.workspacePath),
    );

    let first = true;
    for (const { workspacePath, sessionFile } of toRestore) {
      void handleResumeSession(workspacePath, sessionFile, first);
      first = false;
    }
  }, [settingsLoaded, workspaces.size, handleResumeSession, settings.openSessions]);

  return (
    <aside className="sidebar" ref={sidebarRef} style={{ width }}>
      <div className="sidebar__draghandle" onMouseDown={handleResizeStart} />
      <div className="sidebar__workspaces">
        {Array.from(workspaces.values()).map((ws) => {
          const isActiveWs = activeWorkspacePath === ws.path;
          const activeSessionsForWs = Array.from(sessions.values()).filter(
            (s) => s.workspacePath === ws.path,
          );

          return (
            <div key={ws.path} className={`sidebar__workspace ${isActiveWs ? "sidebar__workspace--active" : ""}`}>
              <button
                className="sidebar__workspace-header"
                onClick={() => setActiveWorkspace(isActiveWs ? null : ws.path)}
                title={ws.path}
              >
                <span className="sidebar__workspace-name">{ws.path.split("/").pop() ?? ws.path}</span>
                <span className="sidebar__workspace-path">{ws.path}</span>
              </button>

              {isActiveWs && (
                <div className="sidebar__sessions">
                  {/* Live sessions pinned on top */}
                  {activeSessionsForWs.filter((s) => {
                    // Hide empty sessions unless they are the active one
                    if (s.sessionId === activeSessionId) return true;
                    return s.transcript.blocks.length > 0;
                  }).map((s) => (
                    <button
                      key={s.sessionId}
                      className={`sidebar__session sidebar__session--live ${activeSessionId === s.sessionId ? "sidebar__session--active" : ""}`}
                      onClick={() => setActiveSession(s.sessionId)}
                    >
                      {s.isStreaming ? (
                        <StreamingIndicator isStreaming />
                      ) : (
                        <StatusDot status={s.status} hasPendingDialog={s.pendingDialogs.length > 0} />
                      )}
                      <span className="sidebar__session-name">
                        {s.sessionName ?? s.sessionTitle ?? "New session"}
                      </span>
                    </button>
                  ))}

                  {/* Stored sessions */}
                  {ws.sessions.filter((s) => s.messageCount > 0).map((stored) => {
                    const alreadyLive = activeSessionsForWs.some(
                      (s) => s.sessionFile === stored.filePath,
                    );
                    if (alreadyLive) return null;
                    return (
                      <button
                        key={stored.filePath}
                        className="sidebar__session sidebar__session--stored"
                        onClick={() => handleResumeSession(ws.path, stored.filePath)}
                        title={`Resume: ${stored.filePath}`}
                      >
                        <span className="sidebar__session-preview">
                          {stored.name ?? stored.preview ?? "Session"}
                        </span>
                        <span className="sidebar__session-meta">
                          {stored.messageCount}msg
                        </span>
                      </button>
                    );
                  })}

                  <button
                    className="sidebar__new-session"
                    onClick={() => handleNewSession(ws.path)}
                  >
                    + New session
                  </button>
                </div>
              )}

              <button
                className="sidebar__remove-workspace"
                onClick={() => removeWorkspace(ws.path)}
                title="Remove workspace"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="sidebar__footer">
        <button className="sidebar__add-workspace" onClick={handleAddWorkspace}>
          + Add workspace
        </button>
        <button className="sidebar__settings-btn" onClick={onOpenSettings} title="Settings">
          ⚙
        </button>
      </div>
    </aside>
  );
}
