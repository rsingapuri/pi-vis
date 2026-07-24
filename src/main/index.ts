import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, app, dialog, powerMonitor, screen, session, shell } from "electron";
import {
  initIpc,
  refreshBackgroundUpdateChecks,
  startBackgroundUpdateChecks,
  stopAllSessions,
  stopBackgroundUpdateChecks,
} from "./ipc.js";
import {
  RendererCrashRecovery,
  type RendererRecoveryDiagnostic,
} from "./renderer-crash-recovery.js";
import { isRendererReloadShortcut } from "./renderer-navigation.js";
import { loadSettings, saveSettings } from "./settings-store.js";
import { safeSendToWindow } from "./window-messaging.js";

// A forcibly interrupted E2E parent can close Electron's captured output pipes
// before global teardown runs. Without listeners, Node turns the resulting
// stream EPIPE into an uncaught main-process exception and macOS displays a
// blocking native error dialog for every orphaned test app.
if (process.env["PIVIS_TEST_REMOTE_DEBUGGING_PORT"]) {
  const ignoreBrokenTestPipe = (error: NodeJS.ErrnoException): void => {
    if (error.code !== "EPIPE") throw error;
  };
  process.stdout.on("error", ignoreBrokenTestPipe);
  process.stderr.on("error", ignoreBrokenTestPipe);
}

function boundsOnScreen(b: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return (
      b.x < wa.x + wa.width &&
      b.x + b.width > wa.x &&
      b.y < wa.y + wa.height &&
      b.y + b.height > wa.y
    );
  });
}

app.setName("Pi-Vis");

const hideWindowForTests = process.env["PIVIS_TEST_HIDE_WINDOW"] === "1";

function openExternalLink(url: string): void {
  void shell.openExternal(url).catch((error) => {
    console.error("Failed to open external link:", error);
  });
}

function logRendererRecovery(diagnostic: RendererRecoveryDiagnostic): void {
  console.error(`[Pi-Vis] ${diagnostic.event}`, {
    reason: diagnostic.reason,
    exitCode: diagnostic.exitCode,
    ...(diagnostic.message ? { message: diagnostic.message } : {}),
  });
  try {
    fs.appendFileSync(
      path.join(app.getPath("userData"), "diagnostics.log"),
      `[${new Date().toISOString()}] ${diagnostic.event} ${JSON.stringify({
        reason: diagnostic.reason,
        exitCode: diagnostic.exitCode,
        ...(diagnostic.message ? { message: diagnostic.message } : {}),
      })}\n`,
    );
  } catch {
    // Crash diagnostics are best effort and must never destabilize main.
  }
}

// Playwright's Electron launcher passes --remote-debugging-port=0 as a
// top-level Electron CLI argument, which Electron 43 rejects before app code
// runs. The e2e launcher sets this env var so tests can enable the same CDP
// endpoint through Electron's supported app.commandLine API instead.
if (process.env["PIVIS_TEST_REMOTE_DEBUGGING_PORT"]) {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env["PIVIS_TEST_REMOTE_DEBUGGING_PORT"],
  );
}

// Test isolation: PIVIS_SETTINGS_DIR (set by the e2e suites) redirects the
// whole userData dir, not just settings.json. The single-instance lock and
// Chromium's ProcessSingleton are both keyed on userData, so without this a
// test instance collides with a running production Pi-Vis (or with parallel
// test workers) and quits before creating a window. Must run before
// requestSingleInstanceLock().
if (process.env["PIVIS_SETTINGS_DIR"]) {
  app.setPath("userData", process.env["PIVIS_SETTINGS_DIR"]);
}

// Single-instance lock: prevent multiple main processes. Packaged E2E may run
// beside a developer instance and uses an isolated userData directory.
const hasSingleInstanceLock =
  process.env["PIVIS_TEST_ALLOW_MULTIPLE_INSTANCES"] === "1" || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let appQuitting = false;

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    } catch (error) {
      console.warn("Failed to focus the existing Pi-Vis window:", error);
    }
  });

  function createWindow(): BrowserWindow {
    const settings = loadSettings();
    const bounds = settings.window;

    const winOpts: Electron.BrowserWindowConstructorOptions = {
      width: bounds?.width ?? 1280,
      height: bounds?.height ?? 800,
      // Floor on the window size. The renderer is fully responsive below this
      // (collapsible sidebar, compact title bar, fluid transcript), but a
      // window narrower/shorter than this is unusable, so the OS won't let it
      // be dragged smaller.
      minWidth: 480,
      minHeight: 400,
      show: false,
    };
    // Only restore x/y if the saved position is visible on at least
    // one connected display; otherwise the OS centers the window.
    if (bounds?.x !== undefined && bounds.y !== undefined && boundsOnScreen(bounds)) {
      winOpts.x = bounds.x;
      winOpts.y = bounds.y;
    }
    const win = new BrowserWindow({
      ...winOpts,
      backgroundColor: "#1e1e2e",
      // `hiddenInset` (not `hidden`) — the traffic lights stay visible
      // and macOS positions them natively as part of the window frame,
      // so they remain perfectly centered regardless of the renderer's
      // font size, zoom, or layout. Requires `frame: true` (the default;
      // do NOT set frame: false, which would strip the frame architecture
      // that hiddenInset needs to position the lights). The
      // `trafficLightPosition` option is ignored under `hiddenInset` and
      // is therefore omitted.
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        sandbox: false,
        contextIsolation: true,
      },
    });

    // A renderer refresh abandons generation-fenced UI custody while the SDK
    // hosts continue running. Consume both Cmd/Ctrl+R and the shifted hard-
    // refresh variant before Chromium or an application-menu accelerator can
    // reload the document.
    win.webContents.on("before-input-event", (event, input) => {
      if (isRendererReloadShortcut(input)) event.preventDefault();
    });

    const rendererCrashRecovery = new RendererCrashRecovery({
      reload: () => {
        if (appQuitting || win.isDestroyed() || win.webContents.isDestroyed()) return;
        win.webContents.reload();
      },
      log: logRendererRecovery,
      onTerminal: (diagnostic) => {
        if (appQuitting) return;
        dialog.showErrorBox(
          "Pi-Vis could not recover its window",
          `${diagnostic.message ?? "The renderer exited repeatedly."}\n\nQuit and reopen Pi-Vis. Details were written to diagnostics.log in the Pi-Vis application-data directory.`,
        );
      },
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      if (appQuitting) {
        logRendererRecovery({ event: "render-process-gone", ...details });
        return;
      }
      rendererCrashRecovery.handle(details);
    });

    // Allow queryLocalFonts (permission name "local-fonts" may not be in Electron's typed union)
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(String(permission) === "local-fonts");
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return String(permission) === "local-fonts";
    });

    initIpc(win);

    // External links open in the OS browser; never open new Electron windows.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        openExternalLink(url);
      }
      return { action: "deny" };
    });
    // Prevent the app window from ever navigating away from the renderer.
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== win.webContents.getURL()) {
        event.preventDefault();
        if (url.startsWith("http://") || url.startsWith("https://")) {
          openExternalLink(url);
        }
      }
    });

    const sendFullscreen = (): void => {
      try {
        safeSendToWindow(
          win,
          "window.fullscreenChange",
          { fullscreen: win.isFullScreen() },
          (error) => {
            console.warn("Skipped fullscreen notification during window teardown:", error);
          },
        );
      } catch (error) {
        console.warn("Failed to read the Pi-Vis fullscreen state:", error);
      }
    };

    win.once("ready-to-show", () => {
      if (!hideWindowForTests) {
        win.show();
      }
      // Sync the initial fullscreen state so the title bar reserves
      // (or reclaims) the traffic-light clearance correctly if the app
      // launches already in fullscreen (e.g. relaunch while fullscreen).
      sendFullscreen();
    });

    // Forward macOS fullscreen transitions. In fullscreen the native
    // traffic-light buttons are gone, so the renderer drops the 80px left
    // clearance the title bar reserves for them — the title bar and the
    // sidebar-collapsed pill both stretch back to the window edge.
    win.on("enter-full-screen", sendFullscreen);
    win.on("leave-full-screen", sendFullscreen);

    win.on("close", () => {
      try {
        saveSettings({ window: win.getBounds() });
      } catch (error) {
        // A disk or teardown failure must not crash the main process while the
        // renderer and child hosts are already shutting down.
        console.error("Failed to save Pi-Vis window bounds:", error);
      }
    });

    if (process.env["ELECTRON_RENDERER_URL"]) {
      win
        .loadURL(process.env["ELECTRON_RENDERER_URL"])
        .catch((e) => console.error("Failed to load renderer:", e));
    } else {
      win
        .loadFile(path.join(__dirname, "../renderer/index.html"))
        .catch((e) => console.error("Failed to load renderer:", e));
    }

    return win;
  }

  app.whenReady().then(() => {
    if (hideWindowForTests && process.platform === "darwin") {
      app.dock?.hide();
    }

    // Strict CSP for the packaged (file://) app. Skipped in dev: the Vite dev
    // server needs inline/eval/websocket for HMR. 'wasm-unsafe-eval' is required
    // by Shiki's WASM highlighter; 'unsafe-inline' style is required by Shiki and
    // React inline styles.
    if (!process.env["ELECTRON_RENDERER_URL"]) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": [
              "default-src 'self'; " +
                "script-src 'self' 'wasm-unsafe-eval'; " +
                "worker-src 'self'; " +
                "style-src 'self' 'unsafe-inline'; " +
                "img-src 'self' data:; " +
                "font-src 'self' data:; " +
                "connect-src 'self'; " +
                "object-src 'none'; base-uri 'none'; frame-src 'none'",
            ],
          },
        });
      });
    }

    createWindow();

    // Background update checks are delayed, non-blocking, and remain active
    // for long-running app instances. Extension checks are package-only and
    // can never update the pinned Pi runtime.
    startBackgroundUpdateChecks();
    powerMonitor.on("resume", refreshBackgroundUpdateChecks);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    appQuitting = true;
    stopBackgroundUpdateChecks();
    stopAllSessions();
  });
}
