#!/usr/bin/env node
/**
 * pi-session-host: Entry point for the SDK-host subprocess.
 *
 * Spawned by Electron main via child_process.fork().
 * Communicates via process.send() / process.on("message").
 *
 * Protocol (main -> host):
 *   { type: "init", piPath, cwd, sessionFile? }
 *   { type: "command", id, command: PiRpcCommand }
 *   { type: "dialog_response", id, response: ExtensionUiResponse }
 *   { type: "interrupt" }
 *   { type: "panel_input", panelId, data }
 *   { type: "panel_resize", panelId, cols, rows, force? }
 *   { type: "panel_close_request", panelId }
 *
 * Protocol (host -> main):
 *   { type: "spawned" }
 *   { type: "ready", piVersion? }
 *   { type: "error", message?, versionTooLow? }
 *   { type: "event", event: AgentSessionEvent }
 *   { type: "extension_ui_request", ... }   (forwarded via sendUiRequest)
 *   { type: "panel_open", panelId, overlay }
 *   { type: "panel_data", panelId, data }
 *   { type: "panel_close", panelId }
 *   { type: "panel_mode", panelId, mode: "content"|"viewport" }
 *   { type: "panel_clear_all" }
 *   { type: "response", id, success, data?, error? }
 *
 * All imports are from the pinned pi bundled with the app (resolved via piPath), and
 * only its PUBLIC surface — zero non-exported pi imports (enforced by
 * src/main/pi/host-imports.test.ts).
 */

import * as crypto from "node:crypto";
import {
  applyPiVisTheme,
  configureHttpDispatcher,
  createTrustResolver,
  importPi,
  importPiTui,
  initHostTheme,
} from "./bootstrap.mjs";
import { assertHostCapabilities, setupCommandBridge } from "./bridge.mjs";
import { buildEditorTheme } from "./editor-theme.mjs";
import { createPanelReconstruction } from "./panel-reconstruction.mjs";
import { createDialogResolver, createUIContext } from "./ui-context.mjs";

// --- State ---

let runtime = null;
let session = null;
let handleCommand = null;
let handleSubmit = null;
let handleEscape = null;
let handleReload = null;
let dispatchIntent = null;
let publishSnapshot = null;
let requestAuthorityAttach = null;
let requestLifecyclePermit = null;
let applyEditorPatch = null;
let runtimeAuthority = null;
let interruptActiveOperation = null;
let dialogResolver = null;
// Unified-TUI controller { dispose, resolveSubmit, resolveClipboardImage } —
// assigned in handleInit (createUIContext returns it as the `unified` bundle)
// and read by the message handler below. Module-scoped like handleCommand
// because the message handler is a separate function, NOT globalThis (which
// would be an untyped, collision-prone bus).
let unifiedTuiController = null;
let panelCounter = 0;
const panels = new Map(); // panelId -> { inputHandler, resizeHandler }
const panelReconstruction = createPanelReconstruction();
const hostInstanceId = crypto.randomUUID();
let transportSequence = 0;
const activeEpoch = 0;
const transitionPermitWaiters = new Map();
let initialSessionFilePermit = null;

function requestInitialSessionFilePermit(sessionFile) {
  if (initialSessionFilePermit) return initialSessionFilePermit.promise;
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const timer = setTimeout(() => {
    if (initialSessionFilePermit?.promise !== promise) return;
    initialSessionFilePermit = null;
    resolve({ allowed: false, reason: "initial session-file lock permit lost" });
  }, 5_000);
  timer.unref?.();
  initialSessionFilePermit = { promise, resolve, timer };
  send({ type: "initial_session_file", sessionFile });
  return promise;
}

function requestMainTransitionPermit(request) {
  const transitionId = request?.transitionId;
  if (typeof transitionId !== "string" || transitionId.length === 0) {
    return Promise.reject(new Error("Transition permit requires a transition ID"));
  }
  const prior = transitionPermitWaiters.get(transitionId);
  if (prior) return prior.promise;
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const timer = setTimeout(() => {
    if (transitionPermitWaiters.get(transitionId)?.promise !== promise) return;
    transitionPermitWaiters.delete(transitionId);
    resolve({ allowed: false, reason: "transition permit lost" });
  }, 5_000);
  timer.unref?.();
  transitionPermitWaiters.set(transitionId, { promise, resolve, timer });
  send({ type: "transition_prepare", ...request });
  return promise;
}

function send(msg) {
  // Transition-sensitive records are retained by state-authority until its
  // terminal snapshot can be emitted atomically. Do this BEFORE allocating an
  // envelope so buffered records cannot create a transport-sequence gap.
  const captured = runtimeAuthority?.captureOutbound?.(msg);
  if (captured === true) return;
  const outbound = captured?.live ? { ...msg, provisionalEpoch: captured.provisionalEpoch } : msg;
  // Guard the channel state: during graceful shutdown the IPC channel can
  // close (parent disconnected / exited) while pi's extension shutdown hooks
  // are still firing (e.g. plan-mode's clearUi → setStatus → send). Writing to
  // a closed channel throws ERR_IPC_CHANNEL_CLOSED and, since these calls
  // originate deep inside pi's dispose(), would surface as an uncaught error
  // that crashes the host mid-teardown. `process.connected` is false once the
  // channel is gone, so this is a no-op in exactly that window.
  if (process.send && process.connected) {
    process.send({
      ...outbound,
      hostInstanceId,
      sessionEpoch: runtimeAuthority?.transportSessionEpoch ?? activeEpoch,
      transportSequence: ++transportSequence,
    });
  }
}

function sendControl(payload) {
  send({ type: "control", payload });
}

let extensionUiRequestSequence = 0;
function sendUiRequest(req) {
  // Extension UI has one canonical presentation route once authority exists.
  // The compatibility message remains available to older renderers but is not
  // used to restore a following authority projection.
  // Fire-and-forget UI methods do not receive a Pi dialog ID, but the typed
  // presentation contract still requires stable request identity for replay
  // and baseline overlap. Dialog requests retain their existing IDs.
  const request = {
    ...req,
    id: req.id ?? `extension-ui-${++extensionUiRequestSequence}`,
    // Presentation publications carry their owner in the envelope, but a
    // reconstructed dialog is later returned through the typed UI-response
    // contract itself. Keep that identity on the request so the renderer can
    // acknowledge the exact host/epoch instead of rendering an unanswerable
    // dialog after an authority attach.
    hostInstanceId,
    sessionEpoch: runtimeAuthority?.sessionEpoch ?? activeEpoch,
  };
  runtimeAuthority?.publishExtensionUi?.(request);
  send(request);
}

// --- Panel bridge (for custom() to ANSI output) ---

const panelBridge = {
  get activeCount() {
    return panels.size;
  },
  checkpoint() {
    return [...panels].map(([panelId, panel]) => ({
      panelId,
      overlay: panel.overlay,
      unified: panel.unified,
      baseline: panelReconstruction.baseline(panelId),
      ...(panel.mode ? { mode: panel.mode } : {}),
    }));
  },
  openPanel({ overlay, unified }) {
    const panelId = ++panelCounter;
    panels.set(panelId, {
      inputHandler: null,
      inputSequence: 0,
      overlay,
      unified: unified === true,
      mode: unified === true ? "content" : "viewport",
      cols: 0,
      rows: 0,
    });
    const baseline = panelReconstruction.open(panelId);
    runtimeAuthority?.publishPanel?.({
      kind: "reset",
      panelKey: `panel:${panelId}`,
      renderRevision: baseline.revision,
      panelId,
      overlay,
      unified: unified === true,
      mode: unified === true ? "content" : "viewport",
    });
    send({
      type: "panel_open",
      panelId,
      overlay,
      baseline,
      ...(unified ? { unified: true } : {}),
    });
    return panelId;
  },

  writePanel(panelId, data) {
    // Stream straight to the renderer (which keeps a bounded replay buffer).
    // The host retains NO copy — accumulating every ANSI frame here would be
    // an unbounded leak for the life of the host process.
    const panel = panels.get(panelId);
    if (panel) {
      panelReconstruction.write(panelId, data);
      // ANSI deltas are not a keyframe and are never retained as one. A fresh
      // xterm is rebuilt solely by the forced pi-tui repaint below.
      runtimeAuthority?.publishPanel?.({
        kind: "ansi_delta",
        panelKey: `panel:${panelId}`,
        data,
        renderRevision: panelReconstruction.baseline(panelId)?.revision ?? 0,
      });
      send({ type: "panel_data", panelId, data });
    }
  },

  closePanel(panelId) {
    const p = panels.get(panelId);
    if (p) {
      runtimeAuthority?.publishPanel?.({ kind: "close", panelKey: `panel:${panelId}` });
      send({ type: "panel_close", panelId });
      panelReconstruction.close(panelId);
      panels.delete(panelId);
    }
  },

  // Tell the renderer which sizing model to use for this panel. "viewport" =
  // a pi-tui overlay is up (its geometry tracks terminal rows), so the renderer
  // must pin a fixed grid instead of content-tracking (which would oscillate).
  // "content" = normal content-hugging mode. See panel-events.ts PanelModeEvent.
  setPanelMode(panelId, mode) {
    const panel = panels.get(panelId);
    if (panel) {
      panel.mode = mode;
      runtimeAuthority?.publishPanel?.({
        kind: "mode",
        panelKey: `panel:${panelId}`,
        mode,
      });
      // Compatibility-only fallback for renderers that have not installed an
      // authority panel projection yet.
      send({ type: "panel_mode", panelId, mode });
    }
  },

  setInputHandler(panelId, handler) {
    const p = panels.get(panelId);
    if (p) p.inputHandler = handler;
  },

  clearInputHandler(panelId) {
    const p = panels.get(panelId);
    if (p) p.inputHandler = null;
  },

  feedInput(panelId, revision, sequence, data) {
    const panel = panels.get(panelId);
    const acknowledgedThrough = panel?.inputSequence ?? 0;
    if (!panel || sequence <= acknowledgedThrough) return { acknowledgedThrough };
    const baseline = panelReconstruction.baseline(panelId);
    if (!panelReconstruction.acceptsInput(panelId, revision)) {
      return { acknowledgedThrough, repaintRequired: baseline };
    }
    const expected = acknowledgedThrough + 1;
    if (!panel.inputHandler) return { acknowledgedThrough };
    if (sequence !== expected) {
      return { acknowledgedThrough, gap: { expected, received: sequence } };
    }
    panel.inputHandler(data);
    panel.inputSequence = sequence;
    return { acknowledgedThrough: sequence };
  },

  acknowledgeRepaint(panelId, revision) {
    return { acknowledged: panelReconstruction.acknowledge(panelId, revision) };
  },

  setResizeHandler(panelId, handler) {
    const p = panels.get(panelId);
    if (p) p.resizeHandler = handler;
  },

  clearResizeHandler(panelId) {
    const p = panels.get(panelId);
    if (p) p.resizeHandler = null;
  },

  // custom() registers a canceller so the host can force-settle the panel
  // (resolve its promise + stop its TUI render loop) when the session is
  // replaced out from under it — see closeAll().
  setCanceller(panelId, cancel) {
    const p = panels.get(panelId);
    if (p) p.cancel = cancel;
  },

  // Force-close one panel from the UI (the renderer's Close button). Invokes
  // the canceller registered by custom(), which resolves the extension's
  // custom() promise with undefined and tears the panel down.
  cancel(panelId) {
    const p = panels.get(panelId);
    p?.cancel?.();
  },

  // P3-c: tear down EVERY open panel on the host side. Called from
  // setBeforeSessionInvalidate: if an extension swaps sessions while its
  // custom() panel is open, the panel's TUI render loop would otherwise run
  // forever and its custom() promise would never settle. Iterate a snapshot
  // (each cancel() deletes via closePanel()). Returns whether ANY panel was
  // open, so the caller can skip a no-op panel_clear_all emission.
  closeAll() {
    const hadAny = panels.size > 0;
    for (const [, p] of [...panels]) {
      try {
        p.cancel?.();
      } catch {
        /* ignore teardown errors */
      }
    }
    return hadAny;
  },

  // Called when the renderer reports a new xterm.js panel size — forwards to
  // the panel's resize handler (registered by custom()), which updates the
  // HostTerminal dimensions and asks the TUI to re-render.
  resize(panelId, cols, rows, force = false) {
    const p = panels.get(panelId);
    if (!p) return;
    p.cols = cols;
    p.rows = rows;
    if (force !== true) {
      p.resizeHandler?.(cols, rows, false);
      return;
    }
    // A renderer remount has no trustworthy terminal state. Reset it and use
    // pi-tui's public forced render; never mistake a bounded ANSI tail for a
    // reconstructable keyframe. The renderer acks only after applying all
    // preceding bytes, which fences input until that point.
    const baseline = panelReconstruction.requireRepaint(panelId);
    runtimeAuthority?.publishPanel?.({
      kind: "repaint_required",
      panelKey: `panel:${panelId}`,
      reason: "repaint_required",
      renderRevision: baseline.revision,
    });
    send({ type: "panel_data", panelId, data: "\u001bc" });
    p.resizeHandler?.(cols, rows, true);
    const keyframe = panelReconstruction.seal(panelId);
    if (keyframe) {
      runtimeAuthority?.publishPanel?.((cursor, owner) => ({
        kind: "keyframe",
        cursor,
        panel: {
          panelKey: `panel:${panelId}`,
          panelId,
          owner,
          sync: { state: "synchronizing", lastCursor: cursor, reason: "repaint_ack_pending" },
          overlay: p.overlay === true,
          unified: p.unified === true,
          mode: p.mode ?? (p.unified === true ? "content" : "viewport"),
          inputAcknowledgedThrough: p.inputSequence,
          keyframe: {
            kind: "keyframe",
            ansi: keyframe.ansi,
            renderRevision: keyframe.revision,
          },
        },
      }));
    }
    // Compatibility marker for renderers without a panel authority projection.
    send({ type: "panel_repaint", panelId, revision: baseline.revision });
  },

  fenceAll() {
    for (const [panelId, panel] of panels) {
      panel.inputSequence = 0;
      panelReconstruction.requireRepaint(panelId);
    }
  },
};

// --- Init ---

let initialized = false;

// Minimum pi version required for the SDK host.
// Below this, startup fails with an actionable compatibility error.
import { compareVersions } from "./version.mjs";

// preflightResult is a public AgentSession.prompt option in Pi 0.80.6.
// Keep the SDK host on that documented surface; no private pi imports.
const MIN_PI_VERSION = "0.80.6";

function checkMinVersion(pi, piPath) {
  const version = pi.VERSION;
  if (!version) {
    console.error(`[pi-session-host] Could not determine pi version at ${piPath}`);
    return false;
  }
  if (compareVersions(version, MIN_PI_VERSION) < 0) {
    console.error(
      `[pi-session-host] pi version ${version} < min ${MIN_PI_VERSION}. SDK host unavailable.`,
    );
    return false;
  }
  return true;
}

async function handleInit(msg) {
  if (initialized) return;
  initialized = true;

  // agentDir intentionally NOT read from the init message: pi.getAgentDir()
  // (below) is authoritative and honors PI_* env overrides, so the runtime,
  // the services, and the ProjectTrustStore all agree — and stay shared with
  // the user's terminal pi even under a custom agent dir.
  const { piPath, cwd, sessionFile } = msg;

  try {
    // Step 1: Import pi SDK
    const pi = await importPi(piPath);

    // Minimum version gate. versionTooLow is sent on the error wire message
    // and the exit code is 42 so main can report an actionable incompatibility.
    if (!checkMinVersion(pi, piPath)) {
      send({
        type: "error",
        message: `pi version ${pi.VERSION} is below minimum ${MIN_PI_VERSION}`,
        versionTooLow: true,
      });
      process.exit(42); // 42 = version-too-low
    }

    const piTui = await importPiTui(piPath);
    const tuiModules = {
      TUI: piTui.TUI,
      KeybindingsManager: piTui.KeybindingsManager,
      TUI_KEYBINDINGS: piTui.TUI_KEYBINDINGS,
      Container: piTui.Container,
      Editor: piTui.Editor,
      truncateToWidth: piTui.truncateToWidth,
      visibleWidth: piTui.visibleWidth,
      // Kitty keyboard protocol exports (pi-tui public index). Feature-detected
      // inside createUIContext: if absent (old pi-tui), the host performs no
      // negotiation and keeps legacy behavior. setKittyProtocolActive toggles
      // pi-tui's module-global legacy reinterpretation; StdinBuffer splits
      // batched stdin into single sequences; isKeyRelease filters the release
      // events kitty flag 2 surfaces to the host's paste-image listener.
      setKittyProtocolActive: piTui.setKittyProtocolActive,
      StdinBuffer: piTui.StdinBuffer,
      isKeyRelease: piTui.isKeyRelease,
    };

    // Step 2: Bootstrap
    configureHttpDispatcher(piPath);
    // Load the pi theme that matches pi-vis's active color scheme. Two layers:
    //  (1) PIVIS_PI_THEME loads pi's built-in dark/light as a base if the
    //      indexed custom install below cannot be applied.
    //  (2) PIVIS_PI_THEME_COLORS carries STABLE per-role ANSI palette INDICES
    //      (role → 16–255), scheme-independent. We build a public pi Theme for
    //      pi-vis-owned extension surfaces. If Pi's public root cannot install
    //      it globally, we keep the local theme and publish a visible
    //      capability diagnostic instead of reaching into private singleton
    //      symbols or claiming complete decorative parity.
    const baseTheme = initHostTheme(pi, process.env.PIVIS_PI_THEME || undefined);
    let theme = baseTheme;
    const capabilityDiagnostics = [];
    const paletteJson = process.env.PIVIS_PI_THEME_COLORS;
    if (paletteJson) {
      try {
        const { fg, bg } = JSON.parse(paletteJson);
        if (fg && bg) {
          const result = applyPiVisTheme(pi, fg, bg);
          theme = result.theme;
          if (!result.success && result.error) capabilityDiagnostics.push(result.error);
        }
      } catch (err) {
        console.error(
          "[pi-session-host] pi-vis theme install failed; using base pi theme:",
          err?.message ?? err,
        );
      }
    }
    const agentDir = pi.getAgentDir();

    // Step 3: Dialog resolver — created BEFORE the runtime because the
    // project-trust prompt fires DURING runtime creation (inside
    // createAgentSessionServices → resourceLoader.reload → resolveProjectTrust),
    // and that prompt round-trips to the renderer via createDialog. The
    // host-level `dialogResolver` must already be wired so the user's
    // `dialog_response` resolves the in-flight prompt.
    const resolver = createDialogResolver(sendUiRequest, (operationId) => {
      send({ type: "ui_ack", operationId });
    });
    const { createDialog, createProviderAuthSurface } = resolver;
    dialogResolver = resolver;

    // Trust prompt: a blocking select dialog offering pi's full choice set
    // (trust folder / trust parent / session-only / deny / deny-session-only).
    // select() resolves with { value } or { cancelled: true }; return the
    // chosen label (or null on cancel) for createTrustResolver to act on.
    const promptTrustChoice = async (labels) => {
      const resp = await createDialog(
        "select",
        `This folder has project-local pi extensions/settings that run with full access to your machine. Trust ${cwd}?`,
        { options: labels },
      );
      if (resp?.cancelled) return null;
      return typeof resp?.value === "string" ? resp.value : null;
    };

    // Step 4: Create runtime
    //
    // Resume vs. new: SessionManager.create(cwd) always starts a brand-new
    // session file, so to RESUME an existing one we must SessionManager.open()
    // the path. createAgentSessionRuntime itself takes no `sessionFile` — the
    // session identity lives on the SessionManager. Passing create() here when
    // a sessionFile was given would silently drop the user's history and
    // create a fresh session, which is the worst kind of data bug.
    const configuredSessionDir = process.env["PI_CODING_AGENT_SESSION_DIR"];
    const sessionManager = sessionFile
      ? pi.SessionManager.open(sessionFile, configuredSessionDir)
      : pi.SessionManager.create(cwd, configuredSessionDir);

    const createRuntime = async ({
      cwd: sc,
      agentDir: ad,
      sessionManager: sm,
      sessionStartEvent,
    }) => {
      // SECURITY: wire deny-by-default project trust. Built per-cwd because the
      // runtime can be recreated for a different cwd on session swap, and the
      // ProjectTrustStore is keyed by cwd. Without resolveProjectTrust, pi
      // loads project-local extensions UNGATED (projectTrusted defaults true).
      const { resolveTrust } = createTrustResolver(pi, ad, sc, promptTrustChoice);
      const services = await pi.createAgentSessionServices({
        cwd: sc,
        agentDir: ad,
        resourceLoaderReloadOptions: { resolveProjectTrust: resolveTrust },
      });
      // Model/thinking are NOT set here: pi-vis starts at the settings default
      // and the renderer switches via the set_model command after ready.
      const result = await pi.createAgentSessionFromServices({
        services,
        sessionManager: sm,
        sessionStartEvent,
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };

    runtime = await pi.createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager,
    });

    session = runtime.session;

    // A new SessionManager chooses the path, so main cannot reserve it until
    // the runtime reports it. Do that before binding extensions: their hooks
    // are mutable work and must never run while another Pi-Vis owns the file.
    if (!sessionFile && typeof session.sessionFile === "string" && session.sessionFile.length > 0) {
      const permit = await requestInitialSessionFilePermit(session.sessionFile);
      if (!permit.allowed) {
        throw new Error(`Session file lock contention prevented activation: ${permit.reason}`);
      }
    }

    // Fail fast if this pi version does not expose the SDK surface the bridge
    // relies on, instead of crashing later.
    assertHostCapabilities(session, runtime);

    // Step 5: Create ExtensionUIContext
    // pi-tui's base Editor needs an EditorTheme ({ borderColor, selectList }),
    // not pi's Theme singleton. Reconstruct pi's own getEditorTheme() from the
    // PUBLIC surface (theme.fg + getSelectListTheme) — see ui-context.mjs.
    const editorTheme = buildEditorTheme(pi, theme);
    // The bridge installs an AsyncLocalStorage-aware tracker below. UI context
    // calls through this stable object so lifecycle-owned dialogs/custom panels
    // can suspend only their own watchdog.
    const lifecycleUiTracker = { track: (promise) => promise };
    const {
      context: uiContext,
      runWithInvocationSurface,
      state: uiState,
      unified: unifiedCtrl,
    } = createUIContext({
      theme,
      editorTheme,
      panelBridge,
      createDialog,
      sendToMain: sendUiRequest,
      trackBlockingUi: (promise) => lifecycleUiTracker.track(promise),
      tuiModules,
    });
    unifiedTuiController = unifiedCtrl;
    for (const diagnostic of capabilityDiagnostics) uiState.addCapabilityDiagnostic(diagnostic);
    // NOTE: uiContext is cwd-independent (theme/dialog/panel/sendToMain don't
    // change with cwd). It's passed to bindExtensions below and reused across
    // rebinds via the bridge's setRebindSession — do NOT stash it on
    // runtime.services, which is REPLACED on every session swap and would
    // drop the reference.

    // Step 6: Setup command bridge (rebind + command handler + shared
    // bindExtensions used by both the initial bind and every rebind)
    const {
      handleCommand: handle,
      handleSubmit: submit,
      handleEscape: escapeRequest,
      handleReload: reload,
      dispatchIntent: dispatch,
      publishSnapshot: publish,
      requestAuthorityAttach: attachAuthority,
      requestLifecyclePermit: lifecyclePermit,
      applyEditorPatch: patchEditor,
      authority,
      bindExtensions: bindExt,
      interruptActiveOperation: interrupt,
    } = setupCommandBridge({
      runtime,
      session,
      uiContext,
      send,
      panelBridge,
      disposeUnifiedTui: unifiedCtrl.dispose,
      cancelDialogs: () => dialogResolver?.cancelAll(),
      createProviderAuthSurface,
      runWithInvocationSurface,
      pi,
      agentDir,
      cwd,
      hostInstanceId,
      sendControl,
      requestTransitionPermit: requestMainTransitionPermit,
      // Frames are opaque semantic commits. `send` envelopes the child frame
      // without re-emitting its records/snapshot on compatibility channels.
      sendFrame: (frame) => send({ type: "authority_frame", frame }),
      sendPresentation: (publication) => send({ type: "authority_publication", publication }),
      authorityPresentation: {
        dialogs: (rendererGeneration) =>
          dialogResolver?.pendingSnapshot?.(rendererGeneration) ?? [],
        panels: () =>
          [...panels].map(([panelId, panel]) => ({
            panelId,
            overlay: panel.overlay,
            unified: panel.unified,
            baseline: panelReconstruction.baseline(panelId),
            keyframe: panelReconstruction.keyframe(panelId),
            mode: panel.mode ?? (panel.unified === true ? "content" : "viewport"),
            inputAcknowledgedThrough: panel.inputSequence,
          })),
      },
      initialBinding: true,
      lifecycleUiTracker,
      uiState: {
        ...uiState,
        pendingDialogCount: () => dialogResolver?.pendingCount ?? 0,
      },
    });
    runtimeAuthority = authority;

    // Step 7: Bind extensions (initial session)
    await bindExt(session);

    // Step 8: Signal ready (include version so renderer can display it)
    handleCommand = handle;
    handleSubmit = submit;
    handleEscape = escapeRequest;
    handleReload = reload;
    dispatchIntent = dispatch;
    publishSnapshot = publish;
    requestAuthorityAttach = attachAuthority;
    requestLifecyclePermit = lifecyclePermit;
    applyEditorPatch = patchEditor;
    interruptActiveOperation = interrupt;
    const initialBatch = authority.commitInitialBinding();
    sendControl({
      type: "ready",
      piVersion: pi.VERSION,
      snapshot: initialBatch.terminalSnapshot,
      records: initialBatch.records,
    });
    console.error(`[pi-session-host] Ready (pi ${pi.VERSION}, cwd: ${cwd})`);
  } catch (err) {
    console.error("[pi-session-host] Init failed:", err);
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

// --- Message handler ---

process.on("message", async (msg) => {
  try {
    const closeAllowed = new Set(["prepare_close", "confirm_close"]);
    if (runtimeAuthority?.isClosing && msg.type !== "init" && !closeAllowed.has(msg.type)) {
      if (msg.type === "dispatch_intent") {
        send({
          type: "response",
          id: msg.id,
          success: true,
          data: {
            status: "not_admitted",
            intentId: typeof msg.envelope?.intentId === "string" ? msg.envelope.intentId : "",
            reason: "closing",
          },
        });
      } else if (typeof msg.id === "string") {
        send({
          type: "response",
          id: msg.id,
          success: false,
          error: "Session close preparation is in progress",
        });
      }
      return;
    }
    switch (msg.type) {
      case "init":
        await handleInit(msg);
        break;

      case "test_control": {
        // A real-Pi E2E can request an authority-owned replacement without
        // relying on a lazily persisted /new session file. This code path is
        // unreachable outside an explicitly inherited test environment.
        if (process.env.PIVIS_TEST_REAL_HOST_CONTROL !== "1" || msg.action !== "replacement") {
          send({ type: "response", id: msg.id, success: false, error: "Test control is disabled" });
          return;
        }
        if (!handleReload || !runtimeAuthority) {
          send({ type: "response", id: msg.id, success: false, error: "Host is not initialized" });
          return;
        }
        await handleReload();
        const successor = runtimeAuthority.snapshot();
        send({
          type: "response",
          id: msg.id,
          success: true,
          data: {
            hostInstanceId: successor.hostInstanceId,
            sessionEpoch: successor.sessionEpoch,
          },
        });
        break;
      }

      case "dispatch_intent": {
        if (!dispatchIntent) {
          send({
            type: "response",
            id: msg.id,
            success: true,
            data: {
              status: "not_admitted",
              intentId: typeof msg.envelope?.intentId === "string" ? msg.envelope.intentId : "",
              reason: "transport_unavailable",
            },
          });
          return;
        }
        const receipt = await dispatchIntent(msg.envelope);
        send({ type: "response", id: msg.id, success: true, data: receipt });
        break;
      }

      case "command":
        if (!handleCommand) {
          send({ type: "response", id: msg.id, success: false, error: "Not initialized" });
          return;
        }
        await handleCommand(msg);
        break;

      case "dialog_response":
        dialogResolver?.resolve(msg.response);
        break;

      case "interrupt":
        // Legacy callers are acknowledged through the direct ESC path now.
        await interruptActiveOperation?.();
        break;

      case "submit": {
        const result = await handleSubmit?.(msg);
        send({ type: "response", id: msg.id, success: true, data: result });
        break;
      }

      case "escape": {
        const result = await handleEscape?.(msg.requestId);
        send({ type: "response", id: msg.id, success: true, data: result });
        break;
      }

      case "state_request": {
        const snapshot = await runtimeAuthority?.requestFullSnapshot();
        send({ type: "response", id: msg.id, success: true, data: snapshot });
        break;
      }

      case "authority_attach": {
        const baseline = await requestAuthorityAttach?.(msg.rendererGeneration);
        send({ type: "response", id: msg.id, success: true, data: baseline });
        break;
      }

      case "lifecycle_permit": {
        const verdict = requestLifecyclePermit
          ? await requestLifecyclePermit(msg.operation)
          : { allowed: false, reason: "transport_unavailable" };
        send({ type: "response", id: msg.id, success: true, data: verdict });
        break;
      }

      case "transition_permit": {
        const waiter = transitionPermitWaiters.get(msg.transitionId);
        if (!waiter) break;
        clearTimeout(waiter.timer);
        transitionPermitWaiters.delete(msg.transitionId);
        waiter.resolve({
          allowed: msg.allowed === true,
          reason: typeof msg.reason === "string" ? msg.reason : "transition denied",
        });
        break;
      }

      case "initial_session_file_permit": {
        const waiter = initialSessionFilePermit;
        if (!waiter) break;
        clearTimeout(waiter.timer);
        initialSessionFilePermit = null;
        waiter.resolve({
          allowed: msg.allowed === true,
          reason: typeof msg.reason === "string" ? msg.reason : "initial session-file lock denied",
        });
        break;
      }

      case "reload": {
        await handleReload?.();
        send({ type: "response", id: msg.id, success: true });
        break;
      }

      case "editor_patch": {
        const result = applyEditorPatch?.(msg.patch);
        publishSnapshot?.();
        send({ type: "response", id: msg.id, success: true, data: result });
        break;
      }

      case "prepare_close": {
        const checkpoint = runtimeAuthority?.prepareClose(msg.force === true);
        send({ type: "response", id: msg.id, success: true, data: checkpoint });
        break;
      }

      case "confirm_close": {
        const result = runtimeAuthority?.confirmClose(msg.token) ?? { valid: false };
        send({
          type: "response",
          id: msg.id,
          success: true,
          data: result,
          closeConfirmation: true,
        });
        break;
      }

      case "restoration_ack":
        runtimeAuthority?.acknowledgeRestoration(msg.restorationId);
        break;

      case "renderer_detached":
        dialogResolver?.cancelAll?.();
        // Keep host-side public pi-tui instances alive across renderer reload.
        // Their terminals are fenced and must force-repaint before new input.
        panelBridge.fenceAll();
        send({ type: "renderer_cancelled", rendererGeneration: msg.rendererGeneration });
        publishSnapshot?.();
        break;

      case "panel_input": {
        const result = panelBridge.feedInput(msg.panelId, msg.revision, msg.sequence, msg.data);
        if (result.acknowledgedThrough === msg.sequence) runtimeAuthority?.noteMutation();
        send({ type: "response", id: msg.id, success: true, data: result });
        break;
      }

      case "panel_resize":
        panelBridge.resize(msg.panelId, msg.cols, msg.rows, msg.force === true);
        break;

      case "panel_repaint_ack": {
        const panel = panels.get(msg.panelId);
        // Read the bounded capture before acknowledgement releases it. The
        // following sequenced keyframe is the only authority transition that
        // enables renderer input.
        const keyframe = panelReconstruction.pendingKeyframe(msg.panelId);
        const result = { acknowledged: panelReconstruction.acknowledge(msg.panelId, msg.revision) };
        if (result.acknowledged) {
          if (panel && keyframe) {
            runtimeAuthority?.publishPanel?.((cursor, owner) => ({
              kind: "keyframe",
              cursor,
              panel: {
                panelKey: `panel:${msg.panelId}`,
                panelId: msg.panelId,
                owner,
                sync: { state: "following", cursor },
                overlay: panel.overlay === true,
                unified: panel.unified === true,
                mode: panel.mode ?? (panel.unified === true ? "content" : "viewport"),
                inputAcknowledgedThrough: panel.inputSequence,
                keyframe: {
                  kind: "keyframe",
                  ansi: keyframe.ansi,
                  renderRevision: keyframe.revision,
                },
              },
            }));
          }
        }
        send({ type: "response", id: msg.id, success: true, data: result });
        if (
          !result.acknowledged &&
          panel &&
          panelReconstruction.baseline(msg.panelId)?.revision === msg.revision &&
          !panelReconstruction.pendingKeyframe(msg.panelId)
        ) {
          // The bounded image overflowed (or was otherwise invalidated). Never
          // publish a stale following frame; advance the revision and ask the
          // public TUI renderer for a fresh complete repaint instead.
          queueMicrotask(() => {
            if (panels.get(msg.panelId) === panel)
              panelBridge.resize(msg.panelId, panel.cols, panel.rows, true);
          });
        }
        break;
      }

      case "panel_close_request":
        panelBridge.cancel(msg.panelId);
        send({ type: "ui_ack", operationId: msg.operationId });
        break;

      // Unified-TUI editor submit: the renderer ran the submit pipeline and
      // reports the outcome so the host can restore the editor text on a bail
      // (e.g. no-model guard). Resolved by ui-context's resolveUnifiedSubmit.
      case "unified_submit_response":
        unifiedTuiController?.resolveSubmit(msg.id, {
          ok: msg.ok,
          bailed: msg.bailed,
          error: msg.error,
        });
        publishSnapshot?.();
        break;

      // Clipboard image read (Ctrl+V paste in the unified editor): the main
      // process read electron.clipboard and returns the bytes. Resolved by
      // ui-context's resolveClipboardImage, which writes a temp file and
      // inserts the path at the cursor (pi parity).
      case "clipboard_read_image_response":
        unifiedTuiController?.resolveClipboardImage(msg.id, {
          bytes: msg.bytes,
          mimeType: msg.mimeType,
        });
        break;

      default:
        console.error("[pi-session-host] Unknown message type:", msg.type);
    }
  } catch (err) {
    console.error("[pi-session-host] Unhandled error:", err);
    send({
      type: "response",
      id: msg?.id || "unknown",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// --- Lifecycle ---

process.on("disconnect", () => {
  // dispose() flushes session state; await it before exiting so pi can write
  // the session file cleanly. `.finally` guarantees exit even on reject.
  // P2-c: if dispose() neither resolves nor rejects (a hung pi internals
  // promise), the `.finally` would never fire and the host would never exit
  // cleanly — SessionHost.stop() SIGKILLs after 3s (process recovered), but a
  // clean dispose may not have flushed the session file. Guard with a 2s
  // fallback exit (unref'd so it doesn't delay a clean exit on the happy path).
  const forceExit = setTimeout(() => process.exit(0), 2000);
  forceExit.unref?.();
  runtime
    ?.dispose?.()
    .catch(() => {})
    .finally(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
});

process.on("unhandledRejection", (reason) => {
  console.error("[pi-session-host] Unhandled rejection:", reason);
});

// Signal that we're alive
sendControl({ type: "spawned" });
