import type { SessionId } from "@shared/ids.js";
import type { SearchTargetId } from "@shared/session-search.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ChangelogModal } from "./components/changelog/ChangelogModal.js";
import { ImageLightbox } from "./components/common/ImageLightbox.js";
import { Composer } from "./components/composer/Composer.js";
import { WorktreeBar } from "./components/composer/WorktreeBar.js";
import { DiffViewerHost } from "./components/diff/DiffViewerHost.js";
import {
  CUSTOM_PANEL_MAX_HEIGHT_FRACTION,
  CUSTOM_PANEL_MIN_HEIGHT_FRACTION,
  CustomPanelHost,
} from "./components/ext-ui/CustomPanelHost.js";
import { ExtensionDialogHost } from "./components/ext-ui/ExtensionDialogHost.js";
import { UnifiedTuiHost } from "./components/ext-ui/UnifiedTuiHost.js";
import { NotificationStack } from "./components/notifications/NotificationStack.js";
import { AppPickerHost } from "./components/pickers/AppPickerHost.js";
import { SessionSubBar } from "./components/session-header/SessionSubBar.js";
import { SessionSearchModal } from "./components/session-search/SessionSearchModal.js";
import { SettingsView } from "./components/settings/SettingsView.js";
import { PiNotFound } from "./components/setup/PiNotFound.js";
import { Dock } from "./components/shell/Dock.js";
import { Sidebar } from "./components/shell/Sidebar.js";
import { StatusBar } from "./components/shell/StatusBar.js";
import { TitleBar } from "./components/shell/TitleBar.js";
import { UpdateBanner } from "./components/shell/UpdateBanner.js";
import { TranscriptView } from "./components/transcript/TranscriptView.js";
import { TreeViewerHost } from "./components/tree/TreeViewerHost.js";
import { AppUpdatePrompt } from "./components/updates/AppUpdatePrompt.js";
import { UpdateProgress } from "./components/updates/UpdateProgress.js";
import { useEscapeClaim } from "./hooks/useEscapeClaim.js";
import { useGlobalEscapeInterrupt } from "./hooks/useGlobalEscapeInterrupt.js";
import { AuthorityAttachRetry } from "./lib/authority-attach-retry.js";
import { RENDERER_GENERATION } from "./lib/renderer-generation.js";
import { useAppUpdatesStore } from "./stores/app-updates-store.js";
import type { RendererAuthorityState } from "./stores/authority-reducer.js";
import { openDiffForSession, useDiffStore } from "./stores/diff-store.js";
import { sessionMatchesRuntime, useSessionsStore } from "./stores/sessions-store.js";
import { useSettingsStore } from "./stores/settings-store.js";
import { useUpdatesStore } from "./stores/updates-store.js";
import "./App.css";

function authorityNeedsBaseline(projection: RendererAuthorityState | undefined): boolean {
  const expectedPanelReconstruction = new Set([
    "panel_reset",
    "repaint_required",
    "repaint_ack_pending",
    "panel_keyframe_required",
  ]);
  return (
    projection?.semantic.state !== "following" ||
    projection?.transcript.state !== "following" ||
    projection?.extensionUi.state !== "following" ||
    [...(projection?.panels.values() ?? [])].some(
      (panel) =>
        panel.sync.state === "unavailable" ||
        (panel.sync.state === "synchronizing" &&
          !expectedPanelReconstruction.has(panel.sync.reason)),
    )
  );
}

export function App(): React.ReactElement {
  useGlobalEscapeInterrupt();
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const liveSessionIdsKey = useSessionsStore((s) => [...s.sessions.keys()].join("\u0000"));
  const setSessionStatus = useSessionsStore((s) => s.setSessionStatus);
  const applyRuntimeState = useSessionsStore((s) => s.applyRuntimeState);
  const applyEvents = useSessionsStore((s) => s.applyEvents);
  const applyAuthorityAttach = useSessionsStore((s) => s.applyAuthorityAttach);
  const applyAuthorityPublication = useSessionsStore((s) => s.applyAuthorityPublication);
  const markAuthorityUnavailable = useSessionsStore((s) => s.markAuthorityUnavailable);
  const applyRestoreDraft = useSessionsStore((s) => s.applyRestoreDraft);
  const applySubmissionDisposition = useSessionsStore((s) => s.applySubmissionDisposition);
  const applyWorktree = useSessionsStore((s) => s.applyWorktree);
  const applyWorkspace = useSessionsStore((s) => s.applyWorkspace);
  const addUiRequest = useSessionsStore((s) => s.addUiRequest);
  const dismissUiRequest = useSessionsStore((s) => s.dismissUiRequest);
  const compact = useSessionsStore((s) => s.headerCompact);
  const handlePanelEvent = useSessionsStore((s) => s.handlePanelEvent);
  const handleUnifiedSubmitRequest = useSessionsStore((s) => s.handleUnifiedSubmitRequest);
  const adoptSessionFileAndHydrate = useSessionsStore((s) => s.adoptSessionFileAndHydrate);
  const refreshCommands = useSessionsStore((s) => s.refreshCommands);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const openSessionTab = useSessionsStore((s) => s.openSessionTab);
  const loadSettings = useSettingsStore((s) => s.load);
  const statusBarVisible = useSettingsStore((s) => s.settings.statusBarVisible);
  const persistedSidebarWidth = useSettingsStore((s) => s.settings.sidebarWidth);
  const sidebarCollapsed = useSettingsStore((s) => s.settings.sidebarCollapsed);
  const updateSettings = useSettingsStore((s) => s.update);
  const [piFound, setPiFound] = useState<boolean | null>(null);
  const [sessionSearchAvailable, setSessionSearchAvailable] = useState(false);
  const authorityAttachRetryRef = useRef<AuthorityAttachRetry | null>(null);
  if (!authorityAttachRetryRef.current) {
    authorityAttachRetryRef.current = new AuthorityAttachRetry({
      sessionExists: (sessionId) => useSessionsStore.getState().sessions.has(sessionId),
      needsAttach: (sessionId) => {
        const projection = useSessionsStore.getState().sessions.get(sessionId)?.authorityProjection;
        return (
          projection?.rendererGeneration !== RENDERER_GENERATION ||
          authorityNeedsBaseline(projection)
        );
      },
      rendererAttach: (sessionId) =>
        window.pivis.invoke("session.rendererAttach", {
          sessionId,
          rendererGeneration: RENDERER_GENERATION,
        }),
      authorityAttach: (sessionId) =>
        window.pivis.invoke("session.authorityAttach", {
          sessionId,
          rendererGeneration: RENDERER_GENERATION,
        }),
      onReady: (sessionId, response) => applyAuthorityAttach(sessionId, response),
      onUnavailable: (sessionId) => markAuthorityUnavailable(sessionId, "attach_unavailable"),
    });
  }
  const requestAttach = useCallback(
    (sessionId: SessionId): Promise<void> => authorityAttachRetryRef.current!.request(sessionId),
    [],
  );

  // Session removal is synchronous in the store, whereas a React effect for
  // the changed session list runs later. Subscribe directly so a close stops
  // an in-flight transition and clears its timer/count bookkeeping immediately.
  useEffect(() => {
    const unsubscribe = useSessionsStore.subscribe((state, previousState) => {
      for (const sessionId of previousState.sessions.keys()) {
        if (!state.sessions.has(sessionId)) authorityAttachRetryRef.current?.cancel(sessionId);
      }
    });
    return () => {
      unsubscribe();
      authorityAttachRetryRef.current?.cancelAll();
    };
  }, []);
  // onClose	SettingsView handler
  const [showSettings, setShowSettings] = useState(false);
  // Claim ESC while Settings is open so a background streaming session isn't
  // aborted when the user presses ESC to close Settings.
  useEscapeClaim(showSettings);
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

  // Whether the window is in macOS fullscreen. In fullscreen the native
  // traffic-light buttons disappear, so the title bar (and the
  // sidebar-collapsed pill) can drop the 80px left clearance they reserve
  // for them and reclaim that space. Initial state is synced from the main
  // process on ready-to-show.
  const [fullscreen, setFullscreen] = useState(false);

  // Sidebar resize drag. Mirrors the original Sidebar.tsx handler: clamp to
  // the 160–500px range, update live width per mousemove (jank-free, no disk
  // writes), persist on mouseup. Lives here because the drag handle was
  // hoisted out of `.sidebar` (clipped by its `overflow: hidden` when pushed
  // into the canvas gap to meet the content card's left edge).
  const sidebarDragRef = useRef(false);
  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      sidebarDragRef.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // Capture the cursor's offset from the sidebar's right edge at grab time.
      // The drag sets the sidebar width so this offset stays constant as the
      // cursor moves — the edge tracks the grab point and there's no jump when
      // grabbing toward the right side of the strip. Without this, a grab near
      // the strip's right edge (inside the card) would set the sidebar width to
      // the raw clientX, snapping the edge leftward by the gap on the first
      // move and shrinking the card.
      const sidebarEl = document.querySelector(".sidebar");
      const sidebarRight = sidebarEl ? sidebarEl.getBoundingClientRect().right : e.clientX;
      const grabOffset = e.clientX - sidebarRight; // >= 0 (cursor is right of sidebar edge)
      const compute = (clientX: number) => Math.max(160, Math.min(500, clientX - grabOffset));
      let latest = compute(e.clientX);
      const onMove = (ev: MouseEvent) => {
        if (!sidebarDragRef.current) return;
        latest = compute(ev.clientX);
        setSidebarWidth(latest);
      };
      const onUp = () => {
        sidebarDragRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        void updateSettings({ sidebarWidth: latest });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [updateSettings],
  );

  // Custom-panel resize drag. The grab strip lives at the top of the dock /
  // widget tray (rather than on the custom panel's top edge) so the whole
  // above-composer stack reads as the resizable region. The grab offset keeps
  // the panel from jumping even though the handle is visually above the panel.
  const handleCustomPanelResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const session = (e.currentTarget as HTMLElement).closest(
        ".app__session",
      ) as HTMLElement | null;
      const card = session?.querySelector(".custom-panel") as HTMLElement | null;
      if (!session || !card) return;

      const rect = card.getBoundingClientRect();
      const panelBottom = rect.bottom;
      const grabOffset = e.clientY - rect.top;
      const sessionH = session.clientHeight;
      const clamp = (f: number): number =>
        Math.min(CUSTOM_PANEL_MAX_HEIGHT_FRACTION, Math.max(CUSTOM_PANEL_MIN_HEIGHT_FRACTION, f));
      let latest = clamp((panelBottom - rect.top) / sessionH);

      const emit = (fraction: number): void => {
        window.dispatchEvent(
          new CustomEvent("pivis:custom-panel-resize", { detail: { fraction } }),
        );
      };
      const onMove = (ev: MouseEvent): void => {
        const desiredTop = ev.clientY - grabOffset;
        latest = clamp((panelBottom - desiredTop) / sessionH);
        emit(latest);
      };
      const onUp = (): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        void updateSettings({ customPanelHeightFraction: latest });
      };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [updateSettings],
  );

  const handleCustomPanelResizeReset = useCallback(() => {
    window.dispatchEvent(new CustomEvent("pivis:custom-panel-resize-reset"));
    void updateSettings({ customPanelHeightFraction: null });
  }, [updateSettings]);

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

  // Persistent unified-TUI panel from a factory `setWidget` — shares the
  // Composer's flex slot with a view switcher (UnifiedViewToggle) so the
  // user can flip between the extension's TUI and the native Composer
  // without closing the widget. Priority below custom() overlay panels and
  // extension dialogs. Default surface is the unified TUI (parity-correct
  // when a factory widget is live); `unifiedPanelHidden` flips to Composer.
  const hasUnifiedPanel = useSessionsStore((s) => {
    const id = s.activeSessionId;
    if (!id) return false;
    return s.sessions.get(id)?.unifiedPanel !== undefined;
  });
  const unifiedPanelHidden = useSessionsStore((s) => {
    const id = s.activeSessionId;
    if (!id) return false;
    return s.sessions.get(id)?.unifiedPanelHidden ?? false;
  });

  // Built-in pickers (/model, /fork, /resume) also replace the Composer
  // in the flex slot — same in-place treatment as extension dialogs and
  // custom panels, instead of a modal scrim. Priority below extension
  // dialogs (which block pi) and panels, above the plain Composer.
  const hasPendingPicker = useSessionsStore((s) => {
    const id = s.activeSessionId;
    if (!id) return false;
    return s.sessions.get(id)?.pendingPicker !== undefined;
  });

  const customPanelSlotActive = hasOpenPanel && !hasPendingDialog;

  // Boot: load settings and check for pi
  useEffect(() => {
    loadSettings();
    window.pivis
      .invoke("pi.locate", undefined)
      .then((info) => {
        setPiFound(info !== null);
      })
      .catch(() => setPiFound(false));
    window.pivis
      .invoke("sessionSearch.available", undefined)
      .then(setSessionSearchAvailable)
      .catch(() => setSessionSearchAvailable(false));
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
      if (document.querySelector(".picker-overlay, .diff-overlay, .tree-overlay")) return;
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
      if (
        activeSessionId &&
        useSessionsStore.getState().sessions.get(activeSessionId)?.worktreeCreating
      )
        return;
      // Defer to overlay viewers — they consume Escape / Cmd+G themselves.
      if (document.querySelector(".picker-overlay, .diff-overlay, .tree-overlay")) return;
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
    const unsubEvent = window.pivis.on("session.events", ({ sessionId, events }) => {
      const projection = useSessionsStore
        .getState()
        .sessions.get(sessionId as SessionId)?.authorityProjection;
      // A legacy arrival is diagnostic only after a sequenced transcript plane
      // exists; it can never restore that plane to following.
      if (projection?.transcript.state === "following") return;
      applyEvents(sessionId as SessionId, events);
    });

    // Authority publications are the sole semantic projection. Compatibility
    // events below may rebuild presentation only; they never repair a frame.
    const unsubPublication = window.pivis.on("session.publication", (publication) => {
      const sid = publication.sessionId as SessionId;
      applyAuthorityPublication(publication);
      const session = useSessionsStore.getState().sessions.get(sid);
      // A publication can fence any plane (and a global routing gap fences
      // all of them). Only a serialized baseline can restore authority.
      if (session?.status === "ready" && authorityNeedsBaseline(session.authorityProjection)) {
        void requestAttach(sid);
      }
    });

    const unsubRuntime = window.pivis.on("session.runtimeState", ({ sessionId, state }) => {
      const sid = sessionId as SessionId;
      const current = useSessionsStore.getState().sessions.get(sid);
      // Availability is a main-owned transport fact. Apply transitions, but do
      // not churn renderer session objects for every compatibility heartbeat;
      // semantic snapshots arrive exclusively through authority frames.
      if (current?.availability !== state.availability) applyRuntimeState(sid, state);
      if (state.availability === "available") {
        const session = useSessionsStore.getState().sessions.get(sid);
        const projection = session?.authorityProjection;
        if (session?.status === "ready" && authorityNeedsBaseline(projection)) {
          void requestAttach(sid);
        }
        return;
      }
      // Runtime-state events are transport fences only. They never install or
      // mutate Pi semantic values; recovery requires a serialized baseline.
      markAuthorityUnavailable(sid, state.reason ?? state.availability);
    });

    const unsubRestoreDraft = window.pivis.on("session.restoreDraft", (restoration) => {
      applyRestoreDraft(restoration.sessionId as SessionId, restoration);
    });

    const unsubSubmissionDisposition = window.pivis.on(
      "session.submissionDisposition",
      ({ sessionId, result }) => {
        applySubmissionDisposition(sessionId as SessionId, result);
      },
    );

    const unsubUiReq = window.pivis.on("session.uiRequest", ({ sessionId, request }) => {
      const projection = useSessionsStore
        .getState()
        .sessions.get(sessionId as SessionId)?.authorityProjection;
      if (projection?.extensionUi.state === "following") return;
      addUiRequest(sessionId as SessionId, request);
    });
    const unsubUiAck = window.pivis.on("session.uiAcknowledged", ({ sessionId, operationId }) => {
      dismissUiRequest(sessionId as SessionId, operationId);
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
          void requestAttach(sid).then(() => {
            if (useSessionsStore.getState().sessions.has(sid)) void refreshCommands(sid);
          });
        }
      },
    );

    const unsubWorktreeOperation = window.pivis.on(
      "session.worktreeOperationChanged",
      ({ sessionId, active, error }) => {
        const store = useSessionsStore.getState();
        const sid = sessionId as SessionId;
        store.setWorktreeCreating(sid, active);
        if (error) store.setWorktreeError(sid, error);
      },
    );

    const unsubWorktree = window.pivis.on(
      "session.worktreeChanged",
      ({ sessionId, revision, worktree }) => {
        const sid = sessionId as SessionId;
        const currentRevision = useSessionsStore
          .getState()
          .sessions.get(sid)?.worktreeIdentityRevision;
        if (currentRevision !== undefined && revision < currentRevision) return;
        const diff = useDiffStore.getState();
        if (diff.open && diff.sessionId === sid) diff.closeViewer();
        if (worktree) {
          applyWorktree(
            sid,
            {
              worktreePath: worktree.path,
              branch: worktree.branch,
              name: worktree.name,
              base: worktree.base,
            },
            revision,
          );
        } else {
          applyWorkspace(sid, revision);
        }
      },
    );

    const unsubPanel = window.pivis.on("session.panelEvent", ({ sessionId, event }) => {
      const projection = useSessionsStore
        .getState()
        .sessions.get(sessionId as SessionId)?.authorityProjection;
      const panelKey = "panelId" in event ? `panel:${event.panelId}` : undefined;
      // A legacy ANSI/event cannot make a sequenced panel following again.
      if (panelKey ? projection?.panels.has(panelKey) : projection?.panels.size) return;
      handlePanelEvent(sessionId as SessionId, event);
    });

    // Unified-TUI editor submit: the host's editor.onSubmit sent the text to
    // the renderer; run it through the shared submit pipeline + reply so the
    // host can restore the editor on a guard bail.
    const unsubUnifiedSubmit = window.pivis.on(
      "session.unifiedSubmitRequest",
      ({
        sessionId,
        id,
        text,
        editorRevision,
        submissionIntentId,
        hostInstanceId,
        sessionEpoch,
      }) => {
        void handleUnifiedSubmitRequest(
          sessionId as SessionId,
          id,
          text,
          editorRevision,
          submissionIntentId,
          hostInstanceId,
          sessionEpoch,
        );
      },
    );

    // session.fileChanged: emitted after /new, /fork, /clone, /switch_session
    // when pi has confirmed the new authoritative sessionFile. The
    // renderer adopts the new file (overriding the only-if-unset guard),
    // reseeds the transcript, and refreshes the workspace session list.
    const unsubFileChanged = window.pivis.on(
      "session.fileChanged",
      ({ sessionId, hostInstanceId, sessionEpoch, sessionFile, sessionName }) => {
        void (async () => {
          const sid = sessionId as SessionId;
          let current = useSessionsStore.getState().sessions.get(sid);
          if (!sessionMatchesRuntime(current, { hostInstanceId, sessionEpoch })) {
            await requestAttach(sid);
            current = useSessionsStore.getState().sessions.get(sid);
          }
          // A predecessor attach may have been in flight when this replacement
          // event arrived. Once that serialized attempt retires, make one fresh
          // successor-baseline attempt before abandoning the event.
          if (!sessionMatchesRuntime(current, { hostInstanceId, sessionEpoch })) {
            await requestAttach(sid);
            current = useSessionsStore.getState().sessions.get(sid);
          }
          if (!sessionMatchesRuntime(current, { hostInstanceId, sessionEpoch })) return;
          // Re-assert the session as active. Same sessionId re-points to the new
          // file, so activeSessionId is usually already correct — but explicitly
          // setting it clears any stale unreadStatus on the previously-active
          // session and keeps the sidebar highlight in sync (mirrors the
          // pattern used by /resume's picker).
          setActiveSession(sid);
          // Adopt the new file + reseed the transcript + refresh the workspace
          // session list. The single shared helper keeps this identical to the
          // Composer and unified-TUI submit paths (no drift).
          await adoptSessionFileAndHydrate(sid, sessionFile, sessionName, {
            hostInstanceId,
            sessionEpoch,
          });
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

    const unsubAppUpdateStatus = window.pivis.on("appUpdate.status", (status) => {
      useAppUpdatesStore.getState().setStatus(status);
    });

    // Auth changed events
    const unsubAuthChanged = window.pivis.on("auth.changed", () => {
      // Auth changes are handled by the SettingsView component
    });

    // Fullscreen transitions: drop the title bar's traffic-light clearance
    // when the native buttons aren't shown (macOS fullscreen).
    const unsubFullscreen = window.pivis.on("window.fullscreenChange", ({ fullscreen: fs }) => {
      setFullscreen(fs);
    });

    return () => {
      unsubEvent();
      unsubPublication();
      unsubRuntime();
      unsubRestoreDraft();
      unsubSubmissionDisposition();
      unsubUiReq();
      unsubUiAck();
      unsubStatus();
      unsubWorktreeOperation();
      unsubWorktree();
      unsubFileChanged();
      unsubUpdateAvailable();
      unsubUpdateProgress();
      unsubUpdateDone();
      unsubAppUpdateStatus();
      unsubAuthChanged();
      unsubPanel();
      unsubUnifiedSubmit();
      unsubFullscreen();
    };
  }, [
    applyEvents,
    applyRuntimeState,
    applyAuthorityPublication,
    requestAttach,
    markAuthorityUnavailable,
    applyRestoreDraft,
    applySubmissionDisposition,
    applyWorktree,
    applyWorkspace,
    addUiRequest,
    dismissUiRequest,
    setSessionStatus,
    setActiveSession,
    adoptSessionFileAndHydrate,
    refreshCommands,
    handlePanelEvent,
    handleUnifiedSubmitRequest,
  ]);

  useEffect(() => {
    const sessionIds = liveSessionIdsKey
      ? liveSessionIdsKey.split("\u0000").map((id) => id as SessionId)
      : [];
    // Renderer generation is window-wide. Attach every ready live session so a
    // background dialog/panel cannot remain blocked on the renderer that died.
    // Starting sessions do not have a SessionHost baseline yet; attaching them
    // here can coalesce the later ready-time request into that doomed attempt.
    // The statusChanged("ready") path above performs their first attach.
    const attachReadySessions = (): void => {
      const sessions = useSessionsStore.getState().sessions;
      for (const sid of sessionIds) {
        if (sessions.get(sid)?.status === "ready") void requestAttach(sid);
      }
    };
    attachReadySessions();
    const onFocus = () => {
      attachReadySessions();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [liveSessionIdsKey, requestAttach]);

  const handlePiRecheck = useCallback(async () => {
    const info = await window.pivis.invoke("pi.locate", undefined);
    setPiFound(info !== null);
  }, []);

  const handleOpenSearchResult = useCallback(
    async (targetId: SearchTargetId): Promise<boolean> => {
      const resolved = await window.pivis.invoke("sessionSearch.open", {
        rendererGeneration: RENDERER_GENERATION,
        targetId,
      });
      if (!("sessionId" in resolved)) throw new Error(resolved.message);
      const opened = await openSessionTab(resolved.workspacePath, resolved.sessionFile, {
        focus: true,
        requestComposerFocus: true,
        preopened: resolved,
      });
      return opened !== null;
    },
    [openSessionTab],
  );

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
        <AppUpdatePrompt />
      </div>
    );
  }

  return (
    <div
      className={`app${sidebarCollapsed ? " app--sidebar-collapsed" : ""}${sidebarCollapsed && sidebarPeek ? " app--sidebar-peek" : ""}${fullscreen ? " app--fullscreen" : ""}`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      <TitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        onSidebarToggleMouseEnter={peekSidebar}
        onSidebarToggleMouseLeave={scheduleHideSidebar}
      />
      {sidebarCollapsed && (
        <div className="sidebar-trigger" onMouseEnter={peekSidebar} aria-hidden="true" />
      )}
      <Sidebar
        onOpenSettings={() => setShowSettings(true)}
        sessionSearchAvailable={sessionSearchAvailable}
        onMouseEnter={peekSidebar}
        onMouseLeave={scheduleHideSidebar}
      />
      {/* Sidebar resize handle. Rendered here (not inside `.sidebar`) so
          it isn't clipped by `.sidebar { overflow: hidden }` when positioned
          out in the canvas gap to meet the content card's left edge. The
          `.app` grid container is `position: relative`, so the handle anchors
          to the sidebar's right column edge and extends right across the
          `--space-2` canvas gap to the card — exactly on the seam between
          sidebar and transcript. Hidden in collapsed mode (the sidebar floats
          as an overlay pill; resizing it there is a different interaction). */}
      {!sidebarCollapsed && (
        <div className="app__sidebar-draghandle" onMouseDown={handleSidebarResizeStart} />
      )}
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
              <div className="transcript-region">
                <TranscriptView sessionId={activeSessionId} />
                <NotificationStack sessionId={activeSessionId} />
              </div>
              {/* Custom panel resize handle. It is visually attached to the
                  top of the dock / widget tray (rather than hidden on the
                  custom view edge below the tray), which makes the tray feel
                  like the grab point for the whole below-transcript stack. */}
              {customPanelSlotActive && (
                <div
                  className="custom-panel-dock-resize"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize custom view (drag; double-click to reset)"
                  onMouseDown={handleCustomPanelResizeStart}
                  onDoubleClick={handleCustomPanelResizeReset}
                />
              )}
              {/* Session dock — the rigid (non-shrinking) stack of bars that
                  sits between the scrolling transcript and the composer. The
                  WorktreeBar + Dock (above-composer tray) stack as ordered,
                  in-flow column rows here. See `.session-dock` in App.css. */}
              <div className="session-dock">
                {/* WorktreeBar — appears only in new sessions (first-send bar) */}
                <WorktreeBar sessionId={activeSessionId} />
                {/* Dock — the above-composer tray (extension widget items + the
                    update notice). Sits directly above the composer so the two
                    read as a connected stack of cards. Renders nothing when
                    empty, so there is never a phantom box. */}
                <Dock sessionId={activeSessionId} />
              </div>
              {/* Composer and the extension dialog share the same flex
                slot: the dialog replaces the composer when a question is
                pending, so they are never both visible. The dialog
                intentionally does not block the rest of the UI — the
                transcript above stays scrollable, the header (model +
                thinking level) stays clickable, and the diff viewer
                (Cmd+G) still works while the question is open. */}
              {/* Composer, extension dialogs, custom panels, and built-in
                  pickers all share the same flex slot: whichever is active
                  replaces the composer, so they are never both visible.
                  Priority: extension dialogs (block pi) > custom panels >
                  built-in pickers (/model, /fork, /resume) > composer.
                  None block the rest of the UI — the transcript above
                  stays scrollable, the header stays clickable, and the
                  diff viewer (Cmd+G) still works while any is open. */}
              {/* Composer, extension dialogs, custom panels, the unified-TUI
                  panel, and built-in pickers all share the same flex slot:
                  whichever is active replaces the composer, so they are never
                  both visible. Priority: extension dialogs (block pi) > custom
                  panels > unified TUI (factory setWidget, live — unless the
                  user has flipped the header's UnifiedViewToggle to "Chat",
                  in which case the Composer shows while the TUI stays ready) >
                  built-in pickers (/model, /fork, /resume) > composer. */}
              {hasPendingDialog ? (
                <ExtensionDialogHost sessionId={activeSessionId} />
              ) : hasOpenPanel ? (
                <CustomPanelHost sessionId={activeSessionId} />
              ) : hasUnifiedPanel ? (
                <>
                  {/* Keep xterm mounted while native Input is selected. A
                      toggle must not force authority repaint reconstruction
                      and drop the first keys typed on returning to Extension. */}
                  <UnifiedTuiHost sessionId={activeSessionId} visible={!unifiedPanelHidden} />
                  {unifiedPanelHidden && <Composer sessionId={activeSessionId} />}
                </>
              ) : hasPendingPicker ? (
                <AppPickerHost sessionId={activeSessionId} />
              ) : (
                <Composer sessionId={activeSessionId} />
              )}
              {statusBarVisible && <StatusBar sessionId={activeSessionId} />}
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
      {activeSessionId && <TreeViewerHost sessionId={activeSessionId} />}
      {showSettings && (
        <SettingsView
          onClose={() => {
            setShowSettings(false);
            setSettingsInitialSection(undefined);
          }}
          initialSection={settingsInitialSection}
        />
      )}
      {sessionSearchAvailable && <SessionSearchModal onOpenResult={handleOpenSearchResult} />}
      <UpdateProgress />
      <AppUpdatePrompt />
      <ChangelogModal />
      <ImageLightbox />
    </div>
  );
}
