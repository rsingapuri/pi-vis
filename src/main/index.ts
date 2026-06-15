import path from "node:path";
import { BrowserWindow, app, session } from "electron";
import { initIpc, stopAllSessions, triggerBackgroundUpdateCheck } from "./ipc.js";
import { loadSettings, saveSettings } from "./settings-store.js";

app.setName("Pi-Vis");

function createWindow(): BrowserWindow {
  const settings = loadSettings();
  const bounds = settings.window;

  const winOpts = {
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    ...(bounds?.x !== undefined ? { x: bounds.x } : {}),
    ...(bounds?.y !== undefined ? { y: bounds.y } : {}),
    show: false,
  };
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

  win.once("ready-to-show", () => {
    win.show();
  });

  win.on("close", () => {
    const b = win.getBounds();
    saveSettings({ window: b });
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  createWindow();

  // Background update check (3s delay, non-blocking)
  triggerBackgroundUpdateCheck();

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
