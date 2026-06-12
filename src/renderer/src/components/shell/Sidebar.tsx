import React, { useCallback, useEffect, useRef } from "react";
import { persistOpenTabs, useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import "./Sidebar.css";

function StatusDot({ status, hasPendingDialog }: { status: SessionStatus; hasPendingDialog: boolean }): React.ReactElement {
  if (hasPendingDialog) return <span className="status-dot status-dot--attention" title="Needs attention">▲</span>;
  switch (status) {
    case "cold": return <span className="status-dot status-dot--cold" title="Not running">◌</span>;
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
    openSessionTab,
    closeSessionTab,
    setActiveSession,
    setActiveWorkspace,
  } = useSessionsStore();
  const { settings, loaded: settingsLoaded } = useSettingsStore();
  const sidebarRef = useRef<HTMLElement>(null);
  const isDragging = useRef(false);

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
    void openSessionTab(workspacePath);
  }, [openSessionTab]);

  const handleResumeSession = useCallback(async (workspacePath: string, filePath: string, makeActive = true) => {
    void openSessionTab(workspacePath, filePath, { focus: makeActive });
  }, [openSessionTab]);

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

  // Restore previously open tabs once both workspaces and settings are ready.
  // Cold-open each tab, then activate exactly one (the previously-active one)
  // — the rest stay cold until focused. Sequential await is deliberate: it
  // gives the byFile guard and renderer dedupe deterministic ordering, and
  // cold opens are cheap (no process spawn).
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (sessionRestoredRef.current) return;
    if (!settingsLoaded) return;
    if (workspaces.size === 0) return;
    // Wait until the openTabs snapshot has actually been loaded from disk.
    // Without this guard, the effect fires once with [] (default state),
    // sets the ref to true, and never re-fires when the real array lands.
    if (settings.openTabs.length === 0 && settings.activeSessionFile === null) return;
    sessionRestoredRef.current = true;

    const targetFile = settings.activeSessionFile;
    const workspacePaths = Array.from(workspaces.keys());
    const toRestore = (settings.openTabs ?? []).filter((t) =>
      workspacePaths.includes(t.workspacePath),
    );

    void (async () => {
      let targetId: SessionId | null = null;
      for (const t of toRestore) {
        const id = await openSessionTab(t.workspacePath, t.sessionFile, { focus: false, persist: false });
        if (id && t.sessionFile === targetFile) targetId = id;
      }
      if (targetId) setActiveSession(targetId);
      persistOpenTabs();
    })();
  }, [settingsLoaded, workspaces.size, settings.openTabs, settings.activeSessionFile, openSessionTab, setActiveSession]);

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
                    // The active tab is always visible. Cold tabs with a file
                    // are durable — they must appear even with no transcript.
                    // Otherwise hide empty transcripts.
                    if (s.sessionId === activeSessionId) return true;
                    if (s.sessionFile != null) return true;
                    return s.transcript.blocks.length > 0;
                  }).map((s) => (
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
                        <StatusDot status={s.status} hasPendingDialog={s.pendingDialogs.length > 0} />
                      )}
                      <span className="sidebar__session-name">
                        {s.sessionName ?? s.sessionTitle ?? "New session"}
                      </span>
                      <button
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
