import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isNewSessionPending,
  isPendingNewSessionActiveFor,
  isSessionWorking,
  sessionHasHistory,
  useSessionsStore,
} from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconChevronRight, IconClose, IconSearch } from "../common/icons.js";
import { openSessionSearch } from "../session-search/SessionSearchModal.js";
import "./Sidebar.css";

const VISIBLE_PAGE_SIZE = 30;
const STREAMING_DOT_ANIMATION_MS = 1000;

function useSyncedAnimationDelay(durationMs: number): string {
  const [delay] = useState(() => `-${Date.now() % durationMs}ms`);
  return delay;
}

function StatusDot({
  status,
  hasPendingDialog,
  unreadStatus,
}: {
  status: SessionStatus;
  hasPendingDialog: boolean;
  unreadStatus?: "done" | "error" | undefined;
}): React.ReactElement {
  if (hasPendingDialog)
    return <span className="status-dot status-dot--attention" title="Needs attention" />;
  if (unreadStatus === "error")
    return <span className="status-dot status-dot--error" title="Turn ended with an error" />;
  if (unreadStatus === "done")
    return <span className="status-dot status-dot--done" title="Turn complete" />;
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

function PinIcon({ filled }: { filled: boolean }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function StreamingIndicator({ isStreaming }: StreamingDotProps): React.ReactElement | null {
  const animationDelay = useSyncedAnimationDelay(STREAMING_DOT_ANIMATION_MS);
  if (!isStreaming) return null;
  return (
    <span
      className="status-dot status-dot--streaming"
      title="Streaming"
      style={{ "--status-dot-animation-delay": animationDelay } as React.CSSProperties}
    />
  );
}

export function Sidebar({
  onOpenSettings,
  sessionSearchAvailable = true,
  onMouseEnter,
  onMouseLeave,
}: {
  onOpenSettings: () => void;
  sessionSearchAvailable?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}): React.ReactElement {
  const workspaces = useSessionsStore((s) => s.workspaces);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const activeWorkspacePath = useSessionsStore((s) => s.activeWorkspacePath);
  const expandedWorkspaces = useSessionsStore((s) => s.expandedWorkspaces);
  const addWorkspace = useSessionsStore((s) => s.addWorkspace);
  const removeWorkspace = useSessionsStore((s) => s.removeWorkspace);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const openSessionTab = useSessionsStore((s) => s.openSessionTab);
  const closeSessionTab = useSessionsStore((s) => s.closeSessionTab);
  const archiveSession = useSessionsStore((s) => s.archiveSession);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const requestComposerFocus = useSessionsStore((s) => s.requestComposerFocus);
  const setActiveWorkspace = useSessionsStore((s) => s.setActiveWorkspace);
  const toggleWorkspaceExpanded = useSessionsStore((s) => s.toggleWorkspaceExpanded);
  const expandWorkspace = useSessionsStore((s) => s.expandWorkspace);
  const setExpandedWorkspaces = useSessionsStore((s) => s.setExpandedWorkspaces);
  const reorderWorkspaces = useSessionsStore((s) => s.reorderWorkspaces);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const updateSettings = useSettingsStore((s) => s.update);
  const pinnedSessions = useSettingsStore((s) => s.settings.pinnedSessions);
  const lastActiveWorkspace = useSettingsStore((s) => s.settings.lastActiveWorkspace);
  const savedExpandedWorkspaces = useSettingsStore((s) => s.settings.expandedWorkspaces);
  const statusBarVisible = useSettingsStore((s) => s.settings.statusBarVisible);
  const sidebarRef = useRef<HTMLElement>(null);
  const dragIndexRef = useRef<number | null>(null);
  const pinnedDragKeyRef = useRef<string | null>(null);

  // Pinned sessions (by file path) as a Set for O(1) lookup during render.
  const pinnedSet = useMemo(() => new Set(pinnedSessions), [pinnedSessions]);

  // Toggle a session's pin. Pinning APPENDS to the persisted array so a newly
  // pinned row lands at the bottom of the pinned group; unpinning removes it
  // and the row falls back to activity-sorted ordering among its peers.
  const togglePin = useCallback(
    (filePath: string) => {
      const next = pinnedSessions.includes(filePath)
        ? pinnedSessions.filter((k) => k !== filePath)
        : [...pinnedSessions, filePath];
      void updateSettings({ pinnedSessions: next });
    },
    [pinnedSessions, updateSettings],
  );

  // Drag-reorder within the pinned group. Moves the dragged key to the
  // target key's position in the persisted order array (durable across
  // relaunch). A no-op self-drop or unknown key skips the settings write.
  const handlePinnedDrop = useCallback(
    (targetKey: string) => {
      const dragged = pinnedDragKeyRef.current;
      pinnedDragKeyRef.current = null;
      if (!dragged || dragged === targetKey) return;
      const from = pinnedSessions.indexOf(dragged);
      const to = pinnedSessions.indexOf(targetKey);
      if (from === -1 || to === -1) return;
      const next = [...pinnedSessions];
      next.splice(from, 1);
      next.splice(to, 0, dragged);
      void updateSettings({ pinnedSessions: next });
    },
    [pinnedSessions, updateSettings],
  );

  // Pagination: visible count per workspace
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [workspaceListLoaded, setWorkspaceListLoaded] = useState(false);

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

      // Build lookups from stored-session summaries: filePath → mtime, and
      // filePath → last user-activity (prompts / `!bash`). The activity
      // timestamp is preferred for ordering because merely opening a session
      // bumps its file mtime (pi appends a `session_info` entry) without any
      // real user work, which previously let a session you only glanced at
      // leapfrog one you actively worked in.
      const mtimeByFile = new Map((ws.sessions ?? []).map((s) => [s.filePath, s.mtime]));
      const lastActiveByFile = new Map(
        (ws.sessions ?? [])
          .filter((s) => s.lastActiveAt !== undefined)
          .map((s) => [s.filePath, s.lastActiveAt as number]),
      );

      // Live sessions: those with transcript/tree history or the active one —
      // but a brand-new pending session is never shown as a row (the "+ New
      // session" button is shown as selected instead, and its unsent text lives
      // in `newSessionDrafts`). `/tree` can navigate a real session to the root
      // before any messages, leaving the visible transcript empty; `hasTreeHistory`
      // keeps that session visible when it is no longer active.
      const liveSessions = activeSessionsForWs.filter((s) => {
        if (isNewSessionPending(s)) {
          // Attachment-only pending composers are retention roots. Keep the
          // active one represented by the selected "+ New session" control,
          // but expose it as a row after switching away so it is recoverable.
          return (
            s.sessionId !== activeSessionId &&
            (s.editorAttachments.length > 0 || s.editorAttachmentReads > 0)
          );
        }
        if (s.sessionId === activeSessionId) return true;
        return sessionHasHistory(s);
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
          sortKey:
            s.lastActivityAt ??
            (s.sessionFile ? lastActiveByFile.get(s.sessionFile) : undefined) ??
            (s.sessionFile ? mtimeByFile.get(s.sessionFile) : undefined) ??
            0,
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
          sortKey: s.lastActiveAt ?? s.mtime,
        });
      }

      // Sort by activity timestamp descending (most recent first)
      merged.sort((a, b) => b.sortKey - a.sortKey);

      // Pinned sessions float to the top, in persisted pinned order. A newly
      // pinned session is appended to the end of `pinnedSessions` so it lands
      // at the bottom of the pinned group; drag-reorder rewrites that order.
      // Rows are keyed by file path (shared by a live row and its stored
      // counterpart, and stable across relaunch).
      // Reuse the memoized pinnedSet (component-scope) instead of rebuilding.
      const pinKey = (e: (typeof merged)[number]) => e.filePath ?? "";
      const pinned = pinnedSessions
        .map((key) => merged.find((e) => pinKey(e) === key))
        .filter((e): e is (typeof merged)[number] => e !== undefined);
      const unpinned = merged.filter((e) => !pinnedSet.has(pinKey(e)));
      return [...pinned, ...unpinned];
    },
    [sessions, workspaces, activeSessionId, pinnedSessions, pinnedSet],
  );

  // (Sidebar resize is handled in App.tsx — the drag handle lives there so
  // it isn't clipped by `.sidebar { overflow: hidden }` when positioned at the
  // content card's left edge.)

  const handleAddWorkspace = useCallback(async () => {
    const path = await window.pivis.invoke("workspace.pick", undefined);
    if (path) {
      addWorkspace(path);
      setActiveWorkspace(path);
      // Auto-expand the newly-picked workspace so its sessions are visible.
      // expandWorkspace is idempotent (re-picking an already-expanded
      // workspace won't collapse it); persist the resulting live set.
      expandWorkspace(path);
      void updateSettings({
        lastActiveWorkspace: path,
        expandedWorkspaces: useSessionsStore.getState().expandedWorkspaces,
      });
      void refreshWorkspaceSessions(path);
    }
  }, [addWorkspace, setActiveWorkspace, expandWorkspace, refreshWorkspaceSessions, updateSettings]);

  const handleNewSession = useCallback(
    (workspacePath: string) => {
      // "+ New session" is a no-op when it is already the selected
      // (active) element for this workspace — the pending new session
      // is already showing its composer and draft. Avoids spawning a
      // fresh pi process on a redundant click.
      if (isPendingNewSessionActiveFor(useSessionsStore.getState(), workspacePath)) {
        const active = useSessionsStore.getState().activeSessionId;
        if (active) requestComposerFocus(active);
        return;
      }
      setActiveWorkspace(workspacePath);
      void updateSettings({ lastActiveWorkspace: workspacePath });
      void openSessionTab(workspacePath, undefined, { requestComposerFocus: true });
    },
    [openSessionTab, requestComposerFocus, setActiveWorkspace, updateSettings],
  );

  // Clicking a workspace header activates it (sets focus + opens/switches
  // to a session in it). It never collapses — collapse is via the chevron
  // only, so an active workspace can stay expanded while the user works in
  // another expanded one.
  const handleSelectWorkspace = useCallback(
    (path: string) => {
      setActiveWorkspace(path);
      void updateSettings({ lastActiveWorkspace: path });
      void openSessionTab(path, undefined, { requestComposerFocus: true });
    },
    [setActiveWorkspace, openSessionTab, updateSettings],
  );

  // Chevron toggle: expand/collapse a workspace's session list without
  // changing the active workspace. Persisted to settings so it survives
  // restart. Multiple workspaces may be expanded at once.
  const handleToggleExpand = useCallback(
    (path: string) => {
      toggleWorkspaceExpanded(path);
      const next = expandedWorkspaces.includes(path)
        ? expandedWorkspaces.filter((p) => p !== path)
        : [...expandedWorkspaces, path];
      void updateSettings({ expandedWorkspaces: next });
    },
    [toggleWorkspaceExpanded, expandedWorkspaces, updateSettings],
  );

  // Drag-to-reorder: the store's reorderWorkspaces owns the move (bounds
  // check + splice); persist whatever order it settles on to
  // settings.workspaceOrder so it survives restart. The early self-drop
  // return avoids a redundant settings write on the common no-op case.
  const handleReorder = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      reorderWorkspaces(from, to);
      void updateSettings({
        workspaceOrder: Array.from(useSessionsStore.getState().workspaces.keys()),
      });
    },
    [reorderWorkspaces, updateSettings],
  );

  const handleResumeSession = useCallback(
    (workspacePath: string, filePath: string, makeActive = true) => {
      if (makeActive) {
        setActiveWorkspace(workspacePath);
        void updateSettings({ lastActiveWorkspace: workspacePath });
      }
      void openSessionTab(workspacePath, filePath, {
        focus: makeActive,
        requestComposerFocus: makeActive,
      });
    },
    [openSessionTab, setActiveWorkspace, updateSettings],
  );

  const handleSelectLiveSession = useCallback(
    (sessionId: SessionId, workspacePath: string) => {
      requestComposerFocus(sessionId);
      void setActiveSession(sessionId);
      void updateSettings({ lastActiveWorkspace: workspacePath });
    },
    [requestComposerFocus, setActiveSession, updateSettings],
  );

  // Load the ordered workspace list on mount. NOTE: This effect MUST NOT
  // select any workspace. Selection is the sole responsibility of the boot
  // effect below.
  useEffect(() => {
    let cancelled = false;
    window.pivis
      .invoke("workspace.list", undefined)
      .then((ordered) => {
        if (cancelled) return;
        for (const path of ordered) {
          addWorkspace(path);
          void refreshWorkspaceSessions(path);
        }
        setWorkspaceListLoaded(true);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setWorkspaceListLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [addWorkspace, refreshWorkspaceSessions]);

  // Sync persisted expansion state into the store once settings finish
  // loading. This MUST wait for `settingsLoaded`: settings load asynchronously
  // (App boot effect → IPC), so reading `savedExpandedWorkspaces` on mount
  // would capture the empty default and silently drop the user's restored
  // multi-expand set. Gated to run exactly once via a ref so later user
  // toggles aren't clobbered.
  const expandSyncedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot sync gated by expandSyncedRef
  useEffect(() => {
    if (expandSyncedRef.current || !settingsLoaded) return;
    expandSyncedRef.current = true;
    setExpandedWorkspaces(savedExpandedWorkspaces);
  }, [settingsLoaded]);

  // One-shot boot: restore the last-active workspace
  const bootSessionRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot boot effect gated by bootSessionRef
  useEffect(() => {
    if (bootSessionRef.current) return;
    if (!settingsLoaded) return;
    if (!workspaceListLoaded) return;
    if (workspaces.size === 0) return;
    bootSessionRef.current = true;

    const target =
      (lastActiveWorkspace && workspaces.has(lastActiveWorkspace)
        ? lastActiveWorkspace
        : undefined) ?? Array.from(workspaces.keys())[0];
    if (target) {
      setActiveWorkspace(target);
      // Ensure the boot workspace is expanded so its sessions are visible.
      // Read live store state (not a render snapshot) so this can't race the
      // settings-sync effect above: if the sync already expanded `target`,
      // this is a no-op and we skip the redundant settings write.
      if (!useSessionsStore.getState().expandedWorkspaces.includes(target)) {
        expandWorkspace(target);
        void updateSettings({
          expandedWorkspaces: useSessionsStore.getState().expandedWorkspaces,
        });
      }
      void openSessionTab(target);
    }
  }, [
    settingsLoaded,
    workspaceListLoaded,
    workspaces.size,
    lastActiveWorkspace,
    openSessionTab,
    setActiveWorkspace,
    expandWorkspace,
    updateSettings,
  ]);

  return (
    <aside
      className="sidebar"
      ref={sidebarRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* The drag handle lives in App.tsx, not inside `.sidebar`, so it
          isn't clipped by `.sidebar { overflow: hidden }` (and the fade
          mask) when pushed out into the canvas gap to meet the content card's
          left edge. */}
      <div className="sidebar__workspaces">
        {Array.from(workspaces.values()).map((ws, index) => {
          const isActiveWs = activeWorkspacePath === ws.path;
          const isExpanded = expandedWorkspaces.includes(ws.path);
          const unifiedSessions = getUnifiedSessions(ws.path);
          const visibleCount = getVisibleCount(ws.path);
          const visibleSessions = unifiedSessions.slice(0, visibleCount);
          const hasMore = unifiedSessions.length > visibleCount;

          return (
            <div
              key={ws.path}
              className={`sidebar__workspace ${isActiveWs ? "sidebar__workspace--active" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragIndexRef.current;
                if (from !== null) handleReorder(from, index);
                dragIndexRef.current = null;
              }}
            >
              <div className="sidebar__workspace-header">
                <span
                  className="sidebar__workspace-grip"
                  draggable
                  title="Drag to reorder"
                  onDragStart={(e) => {
                    dragIndexRef.current = index;
                    e.dataTransfer.effectAllowed = "move";
                    // Keep the drag image minimal; default is the grip itself.
                  }}
                  onDragEnd={() => {
                    dragIndexRef.current = null;
                  }}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
                    <circle cx="5" cy="4" r="1.4" />
                    <circle cx="11" cy="4" r="1.4" />
                    <circle cx="5" cy="8" r="1.4" />
                    <circle cx="11" cy="8" r="1.4" />
                    <circle cx="5" cy="12" r="1.4" />
                    <circle cx="11" cy="12" r="1.4" />
                  </svg>
                </span>
                <button
                  type="button"
                  className="sidebar__workspace-name fade-scope"
                  onClick={() => handleSelectWorkspace(ws.path)}
                  title={ws.path}
                >
                  <FadeText>{ws.path.split("/").pop() ?? ws.path}</FadeText>
                </button>

                <div className="sidebar__workspace-actions">
                  {sessionSearchAvailable && (
                    <button
                      type="button"
                      className="icon-btn sidebar__workspace-search"
                      onClick={(event) => {
                        event.stopPropagation();
                        openSessionSearch(ws.path, event.currentTarget);
                      }}
                      title={`Search sessions in ${ws.path.split("/").pop() ?? ws.path}`}
                      aria-label={`Search sessions in ${ws.path.split("/").pop() ?? ws.path}`}
                    >
                      <IconSearch />
                    </button>
                  )}
                  <button
                    type="button"
                    className={`icon-btn sidebar__workspace-chevron ${isExpanded ? "sidebar__workspace-chevron--expanded" : ""}`}
                    onClick={() => handleToggleExpand(ws.path)}
                    title={isExpanded ? "Collapse" : "Expand"}
                    aria-expanded={isExpanded}
                  >
                    <IconChevronRight />
                  </button>
                  <button
                    type="button"
                    className="icon-btn sidebar__remove-workspace"
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
                    <IconClose />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="sidebar__sessions">
                  {(() => {
                    const isNewButtonSelected = isPendingNewSessionActiveFor(
                      { sessions, activeSessionId },
                      ws.path,
                    );
                    return (
                      <>
                        <button
                          type="button"
                          className={`sidebar__new-session ${isNewButtonSelected ? "sidebar__new-session--selected" : ""}`}
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
                            const isPinned =
                              entry.filePath != null && pinnedSet.has(entry.filePath);
                            return (
                              <div
                                key={entry.sessionId}
                                role="button"
                                tabIndex={0}
                                className={`sidebar__session fade-scope ${activeSessionId === entry.sessionId ? "sidebar__session--active" : ""} ${isPinned ? "sidebar__session--pinned" : ""}`}
                                draggable={isPinned}
                                onDragStart={
                                  isPinned && entry.filePath
                                    ? (e) => {
                                        pinnedDragKeyRef.current = entry.filePath!;
                                        e.dataTransfer.effectAllowed = "move";
                                      }
                                    : undefined
                                }
                                onDragOver={
                                  isPinned
                                    ? (e) => {
                                        e.preventDefault();
                                        e.dataTransfer.dropEffect = "move";
                                      }
                                    : undefined
                                }
                                onDrop={
                                  isPinned && entry.filePath
                                    ? (e) => {
                                        e.preventDefault();
                                        handlePinnedDrop(entry.filePath!);
                                      }
                                    : undefined
                                }
                                onDragEnd={
                                  isPinned
                                    ? () => {
                                        pinnedDragKeyRef.current = null;
                                      }
                                    : undefined
                                }
                                onClick={() => handleSelectLiveSession(entry.sessionId, ws.path)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    handleSelectLiveSession(entry.sessionId, ws.path);
                                  }
                                }}
                              >
                                {isSessionWorking(liveSession) ? (
                                  <StreamingIndicator isStreaming />
                                ) : (
                                  <StatusDot
                                    status={liveSession?.status ?? "cold"}
                                    hasPendingDialog={(liveSession?.pendingDialogs.length ?? 0) > 0}
                                    unreadStatus={liveSession?.unreadStatus}
                                  />
                                )}
                                <FadeText className="sidebar__session-name">{entry.name}</FadeText>
                                <button
                                  type="button"
                                  className="sidebar__session-archive"
                                  title="Archive session"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void archiveSession(
                                      entry.sessionId,
                                      entry.filePath ?? "",
                                      ws.path,
                                    );
                                  }}
                                >
                                  <ArchiveIcon />
                                </button>
                                {entry.filePath && (
                                  <button
                                    type="button"
                                    className="sidebar__session-pin"
                                    title={isPinned ? "Unpin session" : "Pin session"}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      togglePin(entry.filePath!);
                                    }}
                                  >
                                    <PinIcon filled={isPinned} />
                                  </button>
                                )}
                              </div>
                            );
                          }

                          // Stored session row
                          const isPinned = entry.filePath != null && pinnedSet.has(entry.filePath);
                          return (
                            <div
                              key={entry.filePath}
                              role="button"
                              tabIndex={0}
                              className={`sidebar__session fade-scope ${isPinned ? "sidebar__session--pinned" : ""}`}
                              draggable={isPinned}
                              onDragStart={
                                isPinned
                                  ? (e) => {
                                      pinnedDragKeyRef.current = entry.filePath;
                                      e.dataTransfer.effectAllowed = "move";
                                    }
                                  : undefined
                              }
                              onDragOver={
                                isPinned
                                  ? (e) => {
                                      e.preventDefault();
                                      e.dataTransfer.dropEffect = "move";
                                    }
                                  : undefined
                              }
                              onDrop={
                                isPinned
                                  ? (e) => {
                                      e.preventDefault();
                                      handlePinnedDrop(entry.filePath);
                                    }
                                  : undefined
                              }
                              onDragEnd={
                                isPinned
                                  ? () => {
                                      pinnedDragKeyRef.current = null;
                                    }
                                  : undefined
                              }
                              onClick={() => handleResumeSession(ws.path, entry.filePath)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  handleResumeSession(ws.path, entry.filePath);
                                }
                              }}
                            >
                              <span className="status-dot status-dot--cold" title="Not running" />
                              <FadeText className="sidebar__session-name">{entry.name}</FadeText>
                              <button
                                type="button"
                                className="sidebar__session-archive"
                                title="Archive session"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void archiveSession(undefined, entry.filePath, ws.path);
                                }}
                              >
                                <ArchiveIcon />
                              </button>
                              <button
                                type="button"
                                className="sidebar__session-pin"
                                title={isPinned ? "Unpin session" : "Pin session"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePin(entry.filePath);
                                }}
                              >
                                <PinIcon filled={isPinned} />
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
                      </>
                    );
                  })()}
                </div>
              )}
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
          className="sidebar__statusbar-toggle"
          onClick={() => void updateSettings({ statusBarVisible: !statusBarVisible })}
          title={statusBarVisible ? "Hide status bar" : "Show status bar"}
          aria-pressed={statusBarVisible}
          aria-label={statusBarVisible ? "Hide status bar" : "Show status bar"}
        >
          <span className="sidebar__statusbar-icon" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
