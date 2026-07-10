import path from "node:path";
import { BrowserWindow, app, screen, session, shell } from "electron";
import {
  initIpc,
  stopAllSessions,
  triggerBackgroundAppUpdateCheck,
  triggerBackgroundUpdateCheck,
} from "./ipc.js";
import { loadSettings, saveSettings } from "./settings-store.js";

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

// Single-instance lock: prevent multiple main processes
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
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
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
    // Prevent the app window from ever navigating away from the renderer.
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== win.webContents.getURL()) {
        event.preventDefault();
        if (url.startsWith("http://") || url.startsWith("https://")) {
          void shell.openExternal(url);
        }
      }
    });

    win.once("ready-to-show", () => {
      if (!hideWindowForTests) {
        win.show();
      }
      // Sync the initial fullscreen state so the title bar reserves
      // (or reclaims) the traffic-light clearance correctly if the app
      // launches already in fullscreen (e.g. relaunch while fullscreen).
      win.webContents.send("window.fullscreenChange", {
        fullscreen: win.isFullScreen(),
      });
    });

    // Forward macOS fullscreen transitions. In fullscreen the native
    // traffic-light buttons are gone, so the renderer drops the 80px left
    // clearance the title bar reserves for them — the title bar and the
    // sidebar-collapsed pill both stretch back to the window edge.
    const sendFullscreen = () =>
      win.webContents.send("window.fullscreenChange", {
        fullscreen: win.isFullScreen(),
      });
    win.on("enter-full-screen", sendFullscreen);
    win.on("leave-full-screen", sendFullscreen);

    win.on("close", () => {
      const b = win.getBounds();
      saveSettings({ window: b });
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

    // Background update checks (delayed, non-blocking)
    triggerBackgroundUpdateCheck();
    triggerBackgroundAppUpdateCheck();

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
    stopAllSessions();
  });
}
