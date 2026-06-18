import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import "./Sidebar.css";

const VISIBLE_PAGE_SIZE = 30;

function StatusDot({
  status,
  hasPendingDialog,
}: { status: SessionStatus; hasPendingDialog: boolean }): React.ReactElement {
  if (hasPendingDialog)
    return <span className="status-dot status-dot--attention" title="Needs attention" />;
  switch (status) {
    case "cold":
      return <span className="status-dot status-dot--cold" title="Not running" />;
    case "starting":
      return <span className="status-dot status-dot--starting" title="Starting" />;
    case "ready":
      return <span className="status-dot status-dot--idle" title="Idle" />;
    case "exited":
      return <span className="status-dot status-dot--exited" title="Exited" />;
    case "failed":
      return <span className="status-dot status-dot--failed" title="Failed" />;
  }
}

interface StreamingDotProps {
  isStreaming: boolean;
}

function ArchiveIcon(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="12" height="3" rx="0.75" />
      <path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6" />
      <path d="M6.5 9h3" />
    </svg>
  );
}

function StreamingIndicator({ isStreaming }: StreamingDotProps): React.ReactElement | null {
  if (!isStreaming) return null;
  return <span className="status-dot status-dot--streaming" title="Streaming" />;
}

interface ArchiveConfirmState {
  sessionId: SessionId | undefined;
  filePath: string;
  workspacePath: string;
  sessionName: string;
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
  const archiveSession = useSessionsStore((s) => s.archiveSession);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const setActiveWorkspace = useSessionsStore((s) => s.setActiveWorkspace);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const statusBarVisible = useSettingsStore((s) => s.settings.statusBarVisible);
  const updateSettings = useSettingsStore((s) => s.update);
  const lastActiveWorkspace = useSettingsStore((s) => s.settings.lastActiveWorkspace);
  const sidebarRef = useRef<HTMLElement>(null);
  const isDragging = useRef(false);

  // Pagination: visible count per workspace
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  // Archive confirm dialog state
  const [archiveTarget, setArchiveTarget] = useState<ArchiveConfirmState | null>(null);

  const getVisibleCount = useCallback(
    (wsPath: string) => visibleCounts[wsPath] ?? VISIBLE_PAGE_SIZE,
    [visibleCounts],
  );

  const handleShowMore = useCallback((wsPath: string) => {
    setVisibleCounts((prev) => ({
      ...prev,
      [wsPath]: (prev[wsPath] ?? VISIBLE_PAGE_SIZE) + VISIBLE_PAGE_SIZE,
    }));
  }, []);

  // Build the unified, deduped session list for a workspace
  const getUnifiedSessions = useCallback(
    (wsPath: string) => {
      const activeSessionsForWs = Array.from(sessions.values()).filter(
        (s) => s.workspacePath === wsPath,
      );
      const ws = workspaces.get(wsPath);
      if (!ws) return [];

      // Build mtime lookup: filePath → mtime for stored sessions
      const mtimeByFile = new Map((ws.sessions ?? []).map((s) => [s.filePath, s.mtime]));

      // Live sessions: those with content or the active one
      const liveSessions = activeSessionsForWs.filter((s) => {
        if (s.sessionId === activeSessionId) return true;
        return s.transcript.blocks.length > 0;
      });

      // Stored sessions: dedupe against live (by filePath) and include only
      // those with messageCount > 0
      const liveFilePaths = new Set(
        liveSessions.map((s) => s.sessionFile).filter(Boolean) as string[],
      );
      const storedSessions = (ws.sessions ?? []).filter(
        (s) => s.messageCount > 0 && !liveFilePaths.has(s.filePath),
      );

      // Merge: every row gets a sortKey based on activity timestamp
      // (bumped on prompt submit) or file mtime — live sessions that
      // have never had a prompt submitted fall back to their file mtime
      // so clicking them doesn't reorder the list.
      const merged: Array<
        | {
            kind: "live";
            sessionId: SessionId;
            name: string;
            filePath: string | undefined;
            sortKey: number;
          }
        | {
            kind: "stored";
            filePath: string;
            name: string;
            preview: string;
            mtime: number;
            messageCount: number;
            sortKey: number;
          }
      > = [];

      for (const s of liveSessions) {
        merged.push({
          kind: "live",
          sessionId: s.sessionId,
          name: s.sessionName ?? s.sessionTitle ?? "Untitled session",
          filePath: s.sessionFile ?? undefined,
          sortKey: s.lastActivityAt ?? mtimeByFile.get(s.sessionFile ?? "") ?? 0,
        });
      }
      for (const s of storedSessions) {
        merged.push({
          kind: "stored",
          filePath: s.filePath,
          name: s.name ?? s.preview ?? "Session",
          preview: s.preview ?? "",
          mtime: s.mtime,
          messageCount: s.messageCount,
          sortKey: s.mtime,
        });
      }

      // Sort by activity timestamp descending (most recent first)
      merged.sort((a, b) => b.sortKey - a.sortKey);

      return merged;
    },
    [sessions, workspaces, activeSessionId],
  );

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
  // workspace collapses it (same as before).
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

  const handleArchiveConfirm = useCallback(() => {
    if (!archiveTarget) return;
    void archiveSession(
      archiveTarget.sessionId,
      archiveTarget.filePath,
      archiveTarget.workspacePath,
    );
    setArchiveTarget(null);
  }, [archiveTarget, archiveSession]);

  const handleArchiveCancel = useCallback(() => {
    setArchiveTarget(null);
  }, []);

  // Load recents on mount
  // NOTE: This effect MUST NOT select any workspace, even when one is not yet
  // active. The stale-closure guard (!activeWorkspacePath) always passes under
  // StrictMode's double-invoke, causing it to clobber the boot effect's restore.
  // Selection is the sole responsibility of the boot effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once boot effect
  useEffect(() => {
    window.pivis
      .invoke("workspace.recents", undefined)
      .then((recents) => {
        for (const path of recents) {
          addWorkspace(path);
          void refreshWorkspaceSessions(path);
        }
      })
      .catch(console.error);
  }, []);

  // One-shot boot: restore the last-active workspace
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
        : undefined) ?? Array.from(workspaces.keys())[0];
    if (target) {
      setActiveWorkspace(target);
      void openSessionTab(target);
    }
  }, [settingsLoaded, workspaces.size, lastActiveWorkspace, openSessionTab, setActiveWorkspace]);

  return (
    <aside className="sidebar" ref={sidebarRef}>
      {archiveTarget && (
        <ConfirmDialog
          title="Archive session"
          message={`Archive "${archiveTarget.sessionName}"? It will be hidden permanently from the sidebar, but its file will remain on disk.`}
          confirmLabel="Archive"
          cancelLabel="Cancel"
          onConfirm={handleArchiveConfirm}
          onCancel={handleArchiveCancel}
        />
      )}

      <div className="sidebar__draghandle" onMouseDown={handleResizeStart} />
      <div className="sidebar__workspaces">
        {Array.from(workspaces.values()).map((ws) => {
          const isActiveWs = activeWorkspacePath === ws.path;
          const unifiedSessions = getUnifiedSessions(ws.path);
          const visibleCount = getVisibleCount(ws.path);
          const visibleSessions = unifiedSessions.slice(0, visibleCount);
          const hasMore = unifiedSessions.length > visibleCount;

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
                    <svg className="sidebar__add-icon" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 5v14" />
                      <path d="M5 12h14" />
                    </svg>
                    <span>New session</span>
                  </button>

                  {/* Unified session list (live + stored, paginated) */}
                  {visibleSessions.map((entry) => {
                    if (entry.kind === "live") {
                      const liveSession = sessions.get(entry.sessionId);
                      return (
                        <div
                          key={entry.sessionId}
                          role="button"
                          tabIndex={0}
                          className={`sidebar__session ${activeSessionId === entry.sessionId ? "sidebar__session--active" : ""}`}
                          onClick={() => setActiveSession(entry.sessionId)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setActiveSession(entry.sessionId);
                            }
                          }}
                        >
                          {liveSession?.isStreaming ? (
                            <StreamingIndicator isStreaming />
                          ) : (
                            <StatusDot
                              status={liveSession?.status ?? "cold"}
                              hasPendingDialog={(liveSession?.pendingDialogs.length ?? 0) > 0}
                            />
                          )}
                          <span className="sidebar__session-name">{entry.name}</span>
                          <button
                            type="button"
                            className="sidebar__session-archive"
                            title="Archive session"
                            onClick={(e) => {
                              e.stopPropagation();
                              setArchiveTarget({
                                sessionId: entry.sessionId,
                                filePath: entry.filePath ?? "",
                                workspacePath: ws.path,
                                sessionName: entry.name,
                              });
                            }}
                          >
                            <ArchiveIcon />
                          </button>
                        </div>
                      );
                    }

                    // Stored session row
                    return (
                      <div
                        key={entry.filePath}
                        role="button"
                        tabIndex={0}
                        className="sidebar__session"
                        onClick={() => handleResumeSession(ws.path, entry.filePath)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleResumeSession(ws.path, entry.filePath);
                          }
                        }}
                      >
                        <span className="status-dot status-dot--cold" title="Not running" />
                        <span className="sidebar__session-name">{entry.name}</span>
                        <button
                          type="button"
                          className="sidebar__session-archive"
                          title="Archive session"
                          onClick={(e) => {
                            e.stopPropagation();
                            setArchiveTarget({
                              sessionId: undefined,
                              filePath: entry.filePath,
                              workspacePath: ws.path,
                              sessionName: entry.name,
                            });
                          }}
                        >
                          <ArchiveIcon />
                        </button>
                      </div>
                    );
                  })}

                  {hasMore && (
                    <button
                      type="button"
                      className="sidebar__show-more"
                      onClick={() => handleShowMore(ws.path)}
                    >
                      + Show more ({unifiedSessions.length - visibleCount} remaining)
                    </button>
                  )}
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
                <svg
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      <div className="sidebar__footer">
        <button type="button" className="sidebar__add-workspace" onClick={handleAddWorkspace}>
          <svg className="sidebar__add-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          <span>Add workspace</span>
        </button>
        <button
          type="button"
          className="sidebar__settings-btn"
          onClick={onOpenSettings}
          title="Settings"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <button
          type="button"
          className="sidebar__status-toggle"
          onClick={() => updateSettings({ statusBarVisible: !statusBarVisible })}
          title={statusBarVisible ? "Hide status bar" : "Show status bar"}
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          >
            <rect x="2" y="3" width="12" height="10" rx="1" />
            <path d="M2 10.5h12" />
            {statusBarVisible && (
              <rect x="2.75" y="11" width="10.5" height="1.5" fill="currentColor" stroke="none" />
            )}
          </svg>
        </button>
      </div>
    </aside>
  );
}
