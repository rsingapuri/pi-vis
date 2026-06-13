import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Composer } from "./components/composer/Composer.js";
import { DiffViewerHost } from "./components/diff/DiffViewerHost.js";
import { ExtensionDialogHost, ToastHost } from "./components/ext-ui/ExtensionDialogHost.js";
import { AppPickerHost } from "./components/pickers/AppPickerHost.js";
import { SessionHeader } from "./components/session-header/SessionHeader.js";
import { SettingsView } from "./components/settings/SettingsView.js";
import { PiNotFound } from "./components/setup/PiNotFound.js";
import { Sidebar } from "./components/shell/Sidebar.js";
import { StatusBar } from "./components/shell/StatusBar.js";
import { TitleBar } from "./components/shell/TitleBar.js";
import { TranscriptView } from "./components/transcript/TranscriptView.js";
import { openDiffForSession, useDiffStore } from "./stores/diff-store.js";
import { useSessionsStore } from "./stores/sessions-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import "./App.css";

export function App(): React.ReactElement {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setSessionStatus = useSessionsStore((s) => s.setSessionStatus);
  const applyEvent = useSessionsStore((s) => s.applyEvent);
  const addUiRequest = useSessionsStore((s) => s.addUiRequest);
  const adoptSessionFile = useSessionsStore((s) => s.adoptSessionFile);
  const refreshCommands = useSessionsStore((s) => s.refreshCommands);
  const seedHistory = useSessionsStore((s) => s.seedHistory);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const loadSettings = useSettingsStore((s) => s.load);
  const [piFound, setPiFound] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(220);

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
    return () => window.removeEventListener("pivis:open-settings", handler);
  }, []);

  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".ext-dialog-overlay, .picker-overlay, .diff-overlay")) return;
      setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

  // Cmd/Ctrl+G toggles the diff viewer (WP5c). Defer to dialogs and
  // pickers when they're on top — same defer-to-modal rule the viewer
  // itself uses. Defer to settings too so opening settings via the
  // shortcut works (settings is not a modal in the dialog sense but
  // it's a fullscreen panel and shouldn't get a stacked diff).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "g") return;
      e.preventDefault();
      if (showSettings) return;
      if (document.querySelector(".ext-dialog-overlay, .picker-overlay")) return;
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

    return () => {
      unsubEvent();
      unsubUiReq();
      unsubStatus();
      unsubFileChanged();
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
            <SessionHeader sessionId={activeSessionId} />
            <TranscriptView sessionId={activeSessionId} />
            <Composer sessionId={activeSessionId} />
            <StatusBar sessionId={activeSessionId} />
            <ExtensionDialogHost sessionId={activeSessionId} />
            <AppPickerHost sessionId={activeSessionId} />
            <ToastHost sessionId={activeSessionId} />
            <DiffViewerHost sessionId={activeSessionId} />
          </div>
        ) : (
          <div className="app__empty">
            <div className="app__empty-hint">Select a workspace and open or resume a session</div>
          </div>
        )}
      </main>
      {showSettings && <SettingsView onClose={() => setShowSettings(false)} />}
    </div>
  );
}
