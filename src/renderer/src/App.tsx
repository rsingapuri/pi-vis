import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Composer } from "./components/composer/Composer.js";
import { WorktreeBar } from "./components/composer/WorktreeBar.js";
import { DiffViewerHost } from "./components/diff/DiffViewerHost.js";
import { CustomPanelHost } from "./components/ext-ui/CustomPanelHost.js";
import { ExtensionDialogHost, ToastHost } from "./components/ext-ui/ExtensionDialogHost.js";
import { AppPickerHost } from "./components/pickers/AppPickerHost.js";
import { SessionSubBar } from "./components/session-header/SessionSubBar.js";
import { SettingsView } from "./components/settings/SettingsView.js";
import { PiNotFound } from "./components/setup/PiNotFound.js";
import { Sidebar } from "./components/shell/Sidebar.js";
import { StatusBar } from "./components/shell/StatusBar.js";
import { TitleBar } from "./components/shell/TitleBar.js";
import { UpdateBanner } from "./components/shell/UpdateBanner.js";
import { TranscriptView } from "./components/transcript/TranscriptView.js";
import { UpdateProgress } from "./components/updates/UpdateProgress.js";
import { openDiffForSession, useDiffStore } from "./stores/diff-store.js";
import { useSessionsStore } from "./stores/sessions-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUpdatesStore } from "./stores/updates-store.js";
import "./App.css";

export function App(): React.ReactElement {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setSessionStatus = useSessionsStore((s) => s.setSessionStatus);
  const applyEvent = useSessionsStore((s) => s.applyEvent);
  const addUiRequest = useSessionsStore((s) => s.addUiRequest);
  const compact = useSessionsStore((s) => s.headerCompact);
  const handlePanelEvent = useSessionsStore((s) => s.handlePanelEvent);
  const adoptSessionFile = useSessionsStore((s) => s.adoptSessionFile);
  const refreshCommands = useSessionsStore((s) => s.refreshCommands);
  const seedHistory = useSessionsStore((s) => s.seedHistory);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const loadSettings = useSettingsStore((s) => s.load);
  const statusBarVisible = useSettingsStore((s) => s.settings.statusBarVisible);
  const persistedSidebarWidth = useSettingsStore((s) => s.settings.sidebarWidth);
  const sidebarCollapsed = useSettingsStore((s) => s.settings.sidebarCollapsed);
  const updateSettings = useSettingsStore((s) => s.update);
  const [piFound, setPiFound] = useState<boolean | null>(null);
  // onClose	SettingsView handler
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<"account" | undefined>(
    undefined,
  );
  // Live sidebar width for smooth dragging; the persisted value (which arrives
  // asynchronously once settings load, and updates again on each drag-end) is
  // mirrored into local state so the drag stays jank-free without writing to
  // disk on every mousemove. `?? 220` guards against a settings object that
  // predates this field (so the grid never gets `undefinedpx`).
  const [sidebarWidth, setSidebarWidth] = useState(persistedSidebarWidth ?? 220);
  useEffect(() => {
    setSidebarWidth(persistedSidebarWidth ?? 220);
  }, [persistedSidebarWidth]);

  const handleSidebarResizeEnd = useCallback(
    (width: number) => {
      void updateSettings({ sidebarWidth: width });
    },
    [updateSettings],
  );

  const toggleSidebar = useCallback(() => {
    void updateSettings({
      sidebarCollapsed: !useSettingsStore.getState().settings.sidebarCollapsed,
    });
  }, [updateSettings]);

  // Auto-reveal sidebar overlay (collapsed mode): when the sidebar is
  // collapsed, hovering the very left edge of the window slides it in as a
  // floating pill over the content. It slides back out when the mouse leaves
  // it (after a short delay, so the user can move between the trigger edge
  // and the sidebar without it snapping shut). This is the VS Code / macOS
  // Dock auto-reveal pattern — the collapsed state keeps the full-width
  // layout while still making the sidebar reachable without a click.
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peekSidebar = useCallback(() => {
    if (peekTimer.current) {
      clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
    setSidebarPeek(true);
  }, []);
  const scheduleHideSidebar = useCallback(() => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setSidebarPeek(false), 350);
  }, []);
  // When the sidebar is un-collapsed (toggle button), drop any lingering peek
  // state so it doesn't re-appear if the user collapses again without
  // hovering.
  useEffect(() => {
    if (!sidebarCollapsed) setSidebarPeek(false);
  }, [sidebarCollapsed]);
  useEffect(
    () => () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
    },
    [],
  );

  // Whether the active session has an unanswered extension_ui_request.
  // When true, the dialog replaces the Composer in the flex slot below.
  // Subscribed via a hook so the App re-renders when a dialog opens or
  // closes; the ExtensionDialogHost still owns the form UI.
  const hasPendingDialog = useSessionsStore((s) => {
    const id = s.activeSessionId;
    if (!id) return false;
    return (s.sessions.get(id)?.pendingDialogs.length ?? 0) > 0;
  });

  // Panel from ctx.ui.custom() -- replaces the composer while open
  const hasOpenPanel = useSessionsStore((s) => {
    const id = s.activeSessionId;
    if (!id) return false;
    return s.sessions.get(id)?.panel !== undefined;
  });

  // Boot: load settings and check for pi
  useEffect(() => {
    loadSettings();
    window.pivis
      .invoke("pi.locate", undefined)
      .then((info) => {
        setPiFound(info !== null);
      })
      .catch(() => setPiFound(false));
  }, [loadSettings]);

  // The Composer fires a custom DOM event rather than drilling a callback
  // prop through the App. This keeps the panel state owned by the App
  // (it controls the modal's keyboard escape behaviour) while letting
  // any descendant trigger it.
  useEffect(() => {
    const handler = (): void => setShowSettings(true);
    window.addEventListener("pivis:open-settings", handler);

    // /login command → open Settings at Account section
    const loginHandler = (): void => {
      setShowSettings(true);
      setSettingsInitialSection("account");
    };
    window.addEventListener("pivis:open-login", loginHandler);

    // pivis:run-update — trigger update from the UpdateBanner
    const runUpdateHandler = (e: Event) => {
      const target =
        (e as CustomEvent<{ target: "all" | "pi" | { extension: string } }>).detail?.target ??
        "all";
      void (async () => {
        const { runId } = await window.pivis.invoke("update.run", { target });
        useUpdatesStore.getState().setActiveRun({ runId, lines: [] });
      })();
    };
    window.addEventListener("pivis:run-update", runUpdateHandler);

    return () => {
      window.removeEventListener("pivis:open-settings", handler);
      window.removeEventListener("pivis:open-login", loginHandler);
      window.removeEventListener("pivis:run-update", runUpdateHandler);
    };
  }, []);

  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Defer to true modals (picker, diff viewer) only. Extension
      // dialogs no longer block the UI — they live in the Composer
      // slot — so Escape should still close settings when a question
      // is pending. The user can reopen the dialog (it's still in the
      // pendingDialogs queue) by clicking the session in the sidebar.
      if (document.querySelector(".picker-overlay, .diff-overlay")) return;
      setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

  // Cmd/Ctrl+G toggles the diff viewer (WP5c). The extension dialog is
  // no longer a modal — the diff viewer must remain usable while a
  // question is pending — so we only defer to the picker (which is
  // still a fullscreen modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "g") return;
      e.preventDefault();
      if (showSettings) return;
      if (document.querySelector(".picker-overlay")) return;
      const isOpen = useDiffStore.getState().open;
      if (isOpen) {
        useDiffStore.getState().closeViewer();
        return;
      }
      if (activeSessionId) openDiffForSession(activeSessionId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeSessionId, showSettings]);

  // Cmd/Ctrl+B toggles the sidebar (matches VS Code / common editors). This
  // is also the way to bring the sidebar back when it's collapsed, alongside
  // the title-bar toggle button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "b") return;
      // Don't hijack the shortcut while typing in a field.
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
        return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggleSidebar]);

  // Subscribe to IPC events
  useEffect(() => {
    const unsubEvent = window.pivis.on("session.event", ({ sessionId, event }) => {
      applyEvent(sessionId as SessionId, event);
    });

    const unsubUiReq = window.pivis.on("session.uiRequest", ({ sessionId, request }) => {
      addUiRequest(sessionId as SessionId, request);
    });

    const unsubStatus = window.pivis.on(
      "session.statusChanged",
      ({ sessionId, status, error, piVersion }) => {
        const sid = sessionId as SessionId;
        setSessionStatus(sid, status, error, piVersion);
        // Ready = pi has started and accepted commands. This is the right
        // moment to ask for the discovered command list (extension / prompt
        // template / skill) — pi exposes them via get_commands at any time,
        // but a cold start is when the Composer's suggestions are empty
        // and the user is about to type `/`.
        if (status === "ready") {
          void refreshCommands(sid);
        }
      },
    );

    const unsubPanel = window.pivis.on("session.panelEvent", ({ sessionId, event }) => {
      handlePanelEvent(sessionId as SessionId, event);
    });

    // session.fileChanged: emitted after /new, /fork, /clone, /switch_session
    // when pi has confirmed the new authoritative sessionFile. The
    // renderer adopts the new file (overriding the only-if-unset guard),
    // reseeds the transcript, and refreshes the workspace session list.
    const unsubFileChanged = window.pivis.on(
      "session.fileChanged",
      ({ sessionId, sessionFile, sessionName }) => {
        void (async () => {
          const sid = sessionId as SessionId;
          await adoptSessionFile(sid, sessionFile, sessionName);
          // Re-assert the session as active. Same sessionId re-points to the new
          // file, so activeSessionId is usually already correct — but explicitly
          // setting it clears any stale unreadStatus on the previously-active
          // session and keeps the sidebar highlight in sync (mirrors the
          // pattern used by /resume's picker).
          setActiveSession(sid);
          if (sessionFile) {
            const history = await window.pivis.invoke("session.loadHistory", { sessionId: sid });
            seedHistory(sid, history ?? []);
          }
          const workspacePath = useSessionsStore.getState().sessions.get(sid)?.workspacePath;
          if (workspacePath) {
            void refreshWorkspaceSessions(workspacePath);
          }
        })();
      },
    );

    // Update events
    const unsubUpdateAvailable = window.pivis.on("update.available", (status) => {
      useUpdatesStore.getState().setStatus(status);
    });

    const unsubUpdateProgress = window.pivis.on("update.progress", ({ runId, chunk }) => {
      const store = useUpdatesStore.getState();
      if (store.activeRun?.runId === runId) {
        store.appendOutput(runId, chunk);
      }
    });

    const unsubUpdateDone = window.pivis.on("update.done", ({ runId, exitCode, status }) => {
      const store = useUpdatesStore.getState();
      store.setStatus(status);
      store.markDone(runId, exitCode);
      if (store.activeRun?.runId === runId) {
        store.appendOutput(
          runId,
          `\n\n${exitCode === 0 ? "✓ Update complete" : "✗ Update failed"}\n`,
        );
      }
    });

    // Auth changed events
    const unsubAuthChanged = window.pivis.on("auth.changed", () => {
      // Auth changes are handled by the SettingsView component
    });

    return () => {
      unsubEvent();
      unsubUiReq();
      unsubStatus();
      unsubFileChanged();
      unsubUpdateAvailable();
      unsubUpdateProgress();
      unsubUpdateDone();
      unsubAuthChanged();
      unsubPanel();
    };
  }, [
    applyEvent,
    addUiRequest,
    setSessionStatus,
    adoptSessionFile,
    refreshCommands,
    seedHistory,
    refreshWorkspaceSessions,
    handlePanelEvent,
  ]);

  const handlePiRecheck = useCallback(async () => {
    const info = await window.pivis.invoke("pi.locate", undefined);
    setPiFound(info !== null);
  }, []);

  if (piFound === null) {
    return (
      <div className="app-loading">
        <span className="app-loading__text">Loading…</span>
      </div>
    );
  }

  if (piFound === false) {
    return (
      <div className="app app--setup">
        <PiNotFound onRecheck={handlePiRecheck} />
      </div>
    );
  }

  return (
    <div
      className={`app${sidebarCollapsed ? " app--sidebar-collapsed" : ""}${sidebarCollapsed && sidebarPeek ? " app--sidebar-peek" : ""}`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      <TitleBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      {sidebarCollapsed && (
        <div className="sidebar-trigger" onMouseEnter={peekSidebar} aria-hidden="true" />
      )}
      <Sidebar
        onOpenSettings={() => setShowSettings(true)}
        onResize={setSidebarWidth}
        onResizeEnd={handleSidebarResizeEnd}
        onMouseEnter={peekSidebar}
        onMouseLeave={scheduleHideSidebar}
      />
      <main className="app__main">
        {activeSessionId ? (
          <div className="app__session" style={{ position: "relative" }}>
            <ErrorBoundary key={activeSessionId}>
              {/* SessionHeader is rendered inside the TitleBar at the top of
                the window, not here. Keeping it out of the main column
                reclaims the previously wasted vertical space below the
                title bar. */}
              {/* Sub-bar for compact mode — secondary controls below the title bar */}
              {compact && <SessionSubBar sessionId={activeSessionId} />}
              <TranscriptView sessionId={activeSessionId} />
              {/* Session dock — the rigid (non-shrinking) stack of bars that
                  sits between the scrolling transcript and the composer. Both
                  children are in-flow column rows here, so the update banner
                  can never overlap or render beneath the WorktreeBar above it
                  (their boxes are sequential, not positioned siblings of the
                  flex column). See `.session-dock` in App.css. */}
              <div className="session-dock">
                {/* Update notification: a compact, right-aligned, dismissible
                    card. Sits ABOVE the WorktreeBar (and thus above the
                    composer) as an in-flow column row — never overlapping or
                    rendering beneath the bar below it. */}
                <UpdateBanner />
                {/* WorktreeBar — appears only in new sessions (first-send bar) */}
                <WorktreeBar sessionId={activeSessionId} />
              </div>
              {/* Composer and the extension dialog share the same flex
                slot: the dialog replaces the composer when a question is
                pending, so they are never both visible. The dialog
                intentionally does not block the rest of the UI — the
                transcript above stays scrollable, the header (model +
                thinking level) stays clickable, and the diff viewer
                (Cmd+G) still works while the question is open. */}
              {hasPendingDialog ? (
                <ExtensionDialogHost sessionId={activeSessionId} />
              ) : hasOpenPanel ? (
                <CustomPanelHost sessionId={activeSessionId} />
              ) : (
                <Composer sessionId={activeSessionId} />
              )}
              {statusBarVisible && <StatusBar sessionId={activeSessionId} />}
              <AppPickerHost sessionId={activeSessionId} />
              <ToastHost sessionId={activeSessionId} />
            </ErrorBoundary>
          </div>
        ) : (
          <div className="app__empty">
            <div className="app__empty-content">
              <div className="app__empty-mark" aria-hidden="true">
                π
              </div>
              <p className="app__empty-hint">
                Select a workspace in the sidebar, then open or resume a session to start working.
              </p>
            </div>
            {/* No composer here to sit above, so the update notice floats in
                the bottom-right corner of the empty area instead. */}
            <UpdateBanner floating />
          </div>
        )}
      </main>
      {/* Diff viewer overlay — rendered as a direct child of .app (sibling
        of <main> and <TitleBar>), not inside .app__session/.app__main.
        .app is `position: relative` and is the intended positioning
        ancestor for the overlay's `position: absolute; inset: 0`, so the
        scrim covers the full window — including the floating title-bar pill
        in sidebar-collapsed mode. (Inside .app__main, `overflow: hidden`
        would clip the overlay to the content card and the title pill would
        float above the scrim, unshadowed.) */}
      {activeSessionId && <DiffViewerHost sessionId={activeSessionId} />}
      {showSettings && (
        <SettingsView
          onClose={() => {
            setShowSettings(false);
            setSettingsInitialSection(undefined);
          }}
          initialSection={settingsInitialSection}
        />
      )}
      <UpdateProgress />
    </div>
  );
}
