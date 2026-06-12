import { ipcMain, app } from "electron";
import type { BrowserWindow } from "electron";
import fs from "fs";
import { locatePi, clearPiLocationCache } from "./pi/locate-pi.js";
import { SessionRegistry } from "./sessions/session-registry.js";
import { listSessionsForWorkspace, extractSessionMeta } from "./sessions/session-discovery.js";
import { loadHistory } from "./sessions/history-loader.js";
import { getSettings, saveSettings } from "./settings-store.js";
import { pickWorkspace, getRecentWorkspaces } from "./workspaces.js";
import type { SessionId } from "@shared/ids.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "@shared/pi-protocol/extension-ui.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import type { PiRpcCommand } from "@shared/pi-protocol/commands.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";

let registry: SessionRegistry | null = null;
let mainWindow: BrowserWindow | null = null;

export function initIpc(win: BrowserWindow): void {
  mainWindow = win;

  // During quit, pi processes are SIGTERMed and emit final events/exits after
  // the window is gone — sending to a destroyed webContents throws.
  const safeSend = (channel: string, payload: unknown): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  registry = new SessionRegistry(
    (sessionId: SessionId, event: PiEvent) => {
      safeSend("session.event", { sessionId, event });
    },
    (sessionId: SessionId, req: ExtensionUiRequest) => {
      safeSend("session.uiRequest", { sessionId, request: req });
    },
    (sessionId: SessionId, status: SessionStatus, error?: string) => {
      safeSend("session.statusChanged", { sessionId, status, error });
    },
  );

  ipcMain.handle("pi.locate", async () => {
    clearPiLocationCache();
    const settings = getSettings();
    return locatePi(settings.piBinaryPath);
  });

  ipcMain.handle("workspace.pick", async () => {
    return pickWorkspace();
  });

  ipcMain.handle("workspace.recents", async () => {
    return getRecentWorkspaces();
  });

  ipcMain.handle("workspace.listSessions", async (_evt, args: { workspacePath: string }) => {
    return listSessionsForWorkspace(args.workspacePath);
  });

  ipcMain.handle(
    "session.open",
    async (_evt, args: { workspacePath: string; sessionFile?: string }) => {
      if (!registry) throw new Error("Registry not initialized");
      let name: string | null = null;
      let preview: string | null = null;
      if (args.sessionFile) {
        if (!fs.existsSync(args.sessionFile)) {
          throw new Error(`Session file not found: ${args.sessionFile}`);
        }
        const meta = extractSessionMeta(args.sessionFile);
        name = meta.name;
        preview = meta.preview || null;
      }
      const sessionId = registry.openSession(args.workspacePath, args.sessionFile);
      return { sessionId, name, preview };
    },
  );

  ipcMain.handle("session.activate", async (_evt, args: { sessionId: SessionId }) => {
    const settings = getSettings();
    const piInfo = await locatePi(settings.piBinaryPath);
    if (!piInfo) throw new Error("pi binary not found. Please install pi or set the path in settings.");
    registry?.activateSession(args.sessionId, piInfo.path);
  });

  ipcMain.handle("session.close", async (_evt, args: { sessionId: SessionId }) => {
    registry?.closeSession(args.sessionId);
  });

  ipcMain.handle("session.loadHistory", async (_evt, args: { sessionId: SessionId }) => {
    const rec = registry?.getSession(args.sessionId);
    if (!rec?.sessionFile) return [];
    return loadHistory(rec.sessionFile);
  });

  ipcMain.handle(
    "session.sendCommand",
    async (_evt, args: { sessionId: SessionId; command: PiRpcCommand }): Promise<PiRpcResponse> => {
      const rec = registry?.getSession(args.sessionId);
      if (!rec?.proc) throw new Error(`No active process for session ${args.sessionId}`);
      const res = await rec.proc.sendCommand(args.command);

      // Harvest the session file from responses that carry it, so a brand-new
      // session's tab becomes durable the moment pi reports a path. This is
      // what makes the byFile double-open guard and loadHistory work later.
      if (
        (args.command.type === "get_session_stats" || args.command.type === "get_state") &&
        res.success && res.data && typeof res.data === "object" &&
        typeof (res.data as Record<string, unknown>)["sessionFile"] === "string"
      ) {
        registry?.noteSessionFile(
          args.sessionId,
          (res.data as Record<string, unknown>)["sessionFile"] as string,
        );
      }

      return res;
    },
  );

  ipcMain.handle(
    "session.respondToUiRequest",
    async (_evt, args: { sessionId: SessionId; response: ExtensionUiResponse }) => {
      const rec = registry?.getSession(args.sessionId);
      if (!rec?.proc) return;
      rec.proc.sendUiResponse(JSON.stringify(args.response));
    },
  );

  ipcMain.handle("settings.get", async () => {
    return getSettings();
  });

  ipcMain.handle("settings.set", async (_evt, updates: Partial<ReturnType<typeof getSettings>>) => {
    return saveSettings(updates);
  });

  ipcMain.handle("app.versions", async () => {
    return {
      app: app.getVersion(),
      electron: process.versions["electron"] ?? "",
      node: process.versions["node"] ?? "",
    };
  });
}

export function stopAllSessions(): void {
  registry?.stopAll();
}

export { mainWindow };
