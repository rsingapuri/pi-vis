import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Composer } from "./components/composer/Composer.js";
import { WorktreeBar } from "./components/composer/WorktreeBar.js";
import { DiffViewerHost } from "./components/diff/DiffViewerHost.js";
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
  const adoptSessionFile = useSessionsStore((s) => s.adoptSessionFile);
  const refreshCommands = useSessionsStore((s) => s.refreshCommands);
  const seedHistory = useSessionsStore((s) => s.seedHistory);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const loadSettings = useSettingsStore((s) => s.load);
  const statusBarVisible = useSettingsStore((s) => s.settings.statusBarVisible);
  const [piFound, setPiFound] = useState<boolean | null>(null);
  // onClose	SettingsView handler
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<"account" | undefined>(
    undefined,
  );
  const [sidebarWidth, setSidebarWidth] = useState(220);

  // Whether the active session has an unanswered extension_ui_request.
  // When true, the dialog replaces the Composer in the flex slot below.
  // Subscribed via a hook so the App re-renders when a dialog opens or
  // closes; the ExtensionDialogHost still owns the form UI.
  const hasPendingDialog = useSessionsStore((s) => {
    const id = s.activeSessionId;
    if (!id) return false;
    return (s.sessions.get(id)?.pendingDialogs.length ?? 0) > 0;
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

  // Subscribe to IPC events
  useEffect(() => {
    const unsubEvent = window.pivis.on("session.event", ({ sessionId, event }) => {
      applyEvent(sessionId as SessionId, event);
    });

    const unsubUiReq = window.pivis.on("session.uiRequest", ({ sessionId, request }) => {
      addUiRequest(sessionId as SessionId, request);
    });

    const unsubStatus = window.pivis.on("session.statusChanged", ({ sessionId, status, error }) => {
      const sid = sessionId as SessionId;
      setSessionStatus(sid, status, error);
      // Ready = pi has started and accepted commands. This is the right
      // moment to ask for the discovered command list (extension / prompt
      // template / skill) — pi exposes them via get_commands at any time,
      // but a cold start is when the Composer's suggestions are empty
      // and the user is about to type `/`.
      if (status === "ready") {
        void refreshCommands(sid);
      }
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
    };
  }, [
    applyEvent,
    addUiRequest,
    setSessionStatus,
    adoptSessionFile,
    refreshCommands,
    seedHistory,
    refreshWorkspaceSessions,
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
      className="app"
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      <TitleBar />
      <Sidebar
        onOpenSettings={() => setShowSettings(true)}
        width={sidebarWidth}
        onResize={setSidebarWidth}
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
              {/* WorktreeBar — appears only in new sessions (first-send bar) */}
              <WorktreeBar sessionId={activeSessionId} />
              {/* Update notification: a compact, right-aligned, dismissible
                  card that sits just above the composer (in-flow, so it never
                  overlaps the input or relies on fragile fixed offsets). */}
              <UpdateBanner />
              {/* Composer and the extension dialog share the same flex
                slot: the dialog replaces the composer when a question is
                pending, so they are never both visible. The dialog
                intentionally does not block the rest of the UI — the
                transcript above stays scrollable, the header (model +
                thinking level) stays clickable, and the diff viewer
                (Cmd+G) still works while the question is open. */}
              {hasPendingDialog ? (
                <ExtensionDialogHost sessionId={activeSessionId} />
              ) : (
                <Composer sessionId={activeSessionId} />
              )}
              {statusBarVisible && <StatusBar sessionId={activeSessionId} />}
              <AppPickerHost sessionId={activeSessionId} />
              <ToastHost sessionId={activeSessionId} />
              <DiffViewerHost sessionId={activeSessionId} />
            </ErrorBoundary>
          </div>
        ) : (
          <div className="app__empty">
            <div className="app__empty-hint">Select a workspace and open or resume a session</div>
            {/* No composer here to sit above, so the update notice floats in
                the bottom-right corner of the empty area instead. */}
            <UpdateBanner floating />
          </div>
        )}
      </main>
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
