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
 *   { type: "panel_input", panelId, data }
 *   { type: "panel_resize", panelId, cols, rows }
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
 * All imports are from the user's installed pi (resolved via piPath), and
 * only its PUBLIC surface — zero non-exported pi imports (enforced by
 * src/main/pi/host-imports.test.ts).
 */

import {
  configureHttpDispatcher,
  createTrustResolver,
  importPi,
  importPiTui,
  initHostTheme,
} from "./bootstrap.mjs";
import { assertHostCapabilities, setupCommandBridge } from "./bridge.mjs";
import { buildEditorTheme } from "./editor-theme.mjs";
import { createDialogResolver, createUIContext } from "./ui-context.mjs";

// --- State ---

let runtime = null;
let session = null;
let handleCommand = null;
let dialogResolver = null;
// Unified-TUI controller { dispose, resolveSubmit, resolveClipboardImage } —
// assigned in handleInit (createUIContext returns it as the `unified` bundle)
// and read by the message handler below. Module-scoped like handleCommand
// because the message handler is a separate function, NOT globalThis (which
// would be an untyped, collision-prone bus).
let unifiedTuiController = null;
let panelCounter = 0;
const panels = new Map(); // panelId -> { inputHandler, resizeHandler }

function send(msg) {
  // Guard the channel state: during graceful shutdown the IPC channel can
  // close (parent disconnected / exited) while pi's extension shutdown hooks
  // are still firing (e.g. plan-mode's clearUi → setStatus → send). Writing to
  // a closed channel throws ERR_IPC_CHANNEL_CLOSED and, since these calls
  // originate deep inside pi's dispose(), would surface as an uncaught error
  // that crashes the host mid-teardown. `process.connected` is false once the
  // channel is gone, so this is a no-op in exactly that window.
  if (process.send && process.connected) process.send(msg);
}

function sendUiRequest(req) {
  send(req);
}

// --- Panel bridge (for custom() to ANSI output) ---

const panelBridge = {
  openPanel({ overlay, unified }) {
    const panelId = ++panelCounter;
    panels.set(panelId, { inputHandler: null });
    send({ type: "panel_open", panelId, overlay, ...(unified ? { unified: true } : {}) });
    return panelId;
  },

  writePanel(panelId, data) {
    // Stream straight to the renderer (which keeps a bounded replay buffer).
    // The host retains NO copy — accumulating every ANSI frame here would be
    // an unbounded leak for the life of the host process.
    if (panels.has(panelId)) {
      send({ type: "panel_data", panelId, data });
    }
  },

  closePanel(panelId) {
    const p = panels.get(panelId);
    if (p) {
      send({ type: "panel_close", panelId });
      panels.delete(panelId);
    }
  },

  // Tell the renderer which sizing model to use for this panel. "viewport" =
  // a pi-tui overlay is up (its geometry tracks terminal rows), so the renderer
  // must pin a fixed grid instead of content-tracking (which would oscillate).
  // "content" = normal content-hugging mode. See panel-events.ts PanelModeEvent.
  setPanelMode(panelId, mode) {
    if (panels.has(panelId)) {
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

  feedInput(panelId, data) {
    const p = panels.get(panelId);
    if (p?.inputHandler) p.inputHandler(data);
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
  resize(panelId, cols, rows) {
    const p = panels.get(panelId);
    p?.resizeHandler?.(cols, rows);
  },
};

// --- Init ---

let initialized = false;

// Minimum pi version required for SDK-host (panels).
// Below this, fall back to pi --mode rpc (no panels).
import { compareVersions } from "./version.mjs";

const MIN_PI_VERSION = "0.80.0";

function checkMinVersion(pi, piPath) {
  const version = pi.VERSION;
  if (!version) {
    console.error(`[pi-session-host] Could not determine pi version at ${piPath}`);
    return false;
  }
  if (compareVersions(version, MIN_PI_VERSION) < 0) {
    console.error(
      `[pi-session-host] pi version ${version} < min ${MIN_PI_VERSION}. Falling back to --mode rpc.`,
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

    // Minimum version gate — exit with well-known code so main falls back to --mode rpc.
    // versionTooLow is sent on the error wire message AND the exit code is 42;
    // both signal "below min" so the registry can craft a "update pi" message.
    if (!checkMinVersion(pi, piPath)) {
      send({
        type: "error",
        message: `pi version ${pi.VERSION} is below minimum ${MIN_PI_VERSION}`,
        versionTooLow: true,
      });
      process.exit(42); // 42 = version-too-low (triggers fallback in SessionHost)
    }

    const piTui = await importPiTui(piPath);
    const tuiModules = {
      TUI: piTui.TUI,
      KeybindingsManager: piTui.KeybindingsManager,
      TUI_KEYBINDINGS: piTui.TUI_KEYBINDINGS,
      Container: piTui.Container,
      Editor: piTui.Editor,
    };

    // Step 2: Bootstrap
    configureHttpDispatcher(piPath);
    // Load the pi theme that matches pi-vis's active color scheme (passed as
    // PIVIS_PI_THEME = "dark" | "light" by the main process). This is what makes
    // every host-rendered surface — extension `theme.fg` widgets/status, the
    // unified TUI, and custom() panels — resolve colors that read correctly on
    // pi-vis's light/dark UI. Falls back to pi's default when unset (older main).
    const theme = initHostTheme(pi, process.env.PIVIS_PI_THEME || undefined);
    const agentDir = pi.getAgentDir();

    // Step 3: Dialog resolver — created BEFORE the runtime because the
    // project-trust prompt fires DURING runtime creation (inside
    // createAgentSessionServices → resourceLoader.reload → resolveProjectTrust),
    // and that prompt round-trips to the renderer via createDialog. The
    // host-level `dialogResolver` must already be wired so the user's
    // `dialog_response` resolves the in-flight prompt.
    const { resolve: resolveDialog, createDialog } = createDialogResolver(sendUiRequest);
    dialogResolver = { resolve: resolveDialog };

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
    const sessionManager = sessionFile
      ? pi.SessionManager.open(sessionFile)
      : pi.SessionManager.create(cwd);

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

    // Fail fast (→ clean fallback to pi --mode rpc) if this pi version doesn't
    // expose the SDK surface the bridge relies on, instead of crashing later.
    assertHostCapabilities(session, runtime);

    // Step 5: Create ExtensionUIContext
    // pi-tui's base Editor needs an EditorTheme ({ borderColor, selectList }),
    // not pi's Theme singleton. Reconstruct pi's own getEditorTheme() from the
    // PUBLIC surface (theme.fg + getSelectListTheme) — see ui-context.mjs.
    const editorTheme = buildEditorTheme(pi, theme);
    const { context: uiContext, unified: unifiedCtrl } = createUIContext({
      theme,
      editorTheme,
      panelBridge,
      createDialog,
      sendToMain: sendUiRequest,
      tuiModules,
    });
    unifiedTuiController = unifiedCtrl;
    // NOTE: uiContext is cwd-independent (theme/dialog/panel/sendToMain don't
    // change with cwd). It's passed to bindExtensions below and reused across
    // rebinds via the bridge's setRebindSession — do NOT stash it on
    // runtime.services, which is REPLACED on every session swap and would
    // drop the reference.

    // Step 6: Setup command bridge (rebind + command handler + shared
    // bindExtensions used by both the initial bind and every rebind)
    const { handleCommand: handle, bindExtensions: bindExt } = setupCommandBridge({
      runtime,
      session,
      uiContext,
      send,
      panelBridge,
      disposeUnifiedTui: unifiedCtrl.dispose,
      pi,
      agentDir,
      cwd,
    });

    // Step 7: Bind extensions (initial session)
    await bindExt(session);

    // Step 8: Signal ready (include version so renderer can display it)
    handleCommand = handle;
    send({ type: "ready", piVersion: pi.VERSION });
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
    switch (msg.type) {
      case "init":
        await handleInit(msg);
        break;

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

      case "panel_input":
        panelBridge.feedInput(msg.panelId, msg.data);
        break;

      case "panel_resize":
        panelBridge.resize(msg.panelId, msg.cols, msg.rows);
        break;

      case "panel_close_request":
        panelBridge.cancel(msg.panelId);
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
process.send?.({ type: "spawned" });
