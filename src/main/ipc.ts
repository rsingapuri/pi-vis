import fs from "node:fs";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus, WorktreeIdentity } from "@shared/ipc-contract.js";
import type { PiRpcCommand } from "@shared/pi-protocol/commands.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "@shared/pi-protocol/extension-ui.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";
import { app, clipboard, ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import {
  getAuthStatus,
  getLoginShellEnv,
  removeProvider,
  saveApiKey,
  startAuthWatch,
  stopAuthWatch,
} from "./auth.js";
import {
  createWorktree,
  getBranches,
  getChanges,
  getChangesCount,
  getFileDiff,
} from "./git/git.js";
import { clearPiLocationCache, locatePi } from "./pi/locate-pi.js";
import { initPty, killAllPtys, killPty, resizePty, startPty, writePty } from "./pty.js";
import { loadHistory } from "./sessions/history-loader.js";
import {
  extractSessionMeta,
  listSessionsForWorkspace,
  resolveWorktreeForFile,
} from "./sessions/session-discovery.js";
import { SessionRegistry } from "./sessions/session-registry.js";
import { getSettings, saveSettings } from "./settings-store.js";
import { checkForUpdates, startUpdate } from "./updates.js";
import { getOrderedWorkspaces, pickWorkspace, removeWorkspace } from "./workspaces.js";

let registry: SessionRegistry | null = null;
let mainWindow: BrowserWindow | null = null;
let handlersRegistered = false;

// During quit, pi processes are SIGTERMed and emit final events/exits after
// the window is gone — sending to a destroyed webContents throws.
const safeSend = (channel: string, payload: unknown): void => {
  const w = mainWindow;
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
  w.webContents.send(channel, payload);
};

export function initIpc(win: BrowserWindow): void {
  mainWindow = win;
  if (handlersRegistered) return;
  handlersRegistered = true;

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

  // Init PTY support (must be after safeSend is wired)
  initPty(safeSend);

  // Start watching auth.json for external changes
  startAuthWatch((providers) => {
    safeSend("auth.changed", { providers });
  });

  ipcMain.handle("pi.locate", async () => {
    clearPiLocationCache();
    const settings = getSettings();
    return locatePi(settings.piBinaryPath);
  });

  ipcMain.handle("workspace.pick", async () => {
    return pickWorkspace();
  });

  ipcMain.handle("workspace.list", async () => {
    return getOrderedWorkspaces();
  });

  ipcMain.handle("workspace.remove", async (_evt, args: { workspacePath: string }) => {
    return removeWorkspace(args.workspacePath);
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
      let worktree: WorktreeIdentity | undefined;
      if (args.sessionFile) {
        if (!fs.existsSync(args.sessionFile)) {
          return { outcome: "missing" as const };
        }
        const meta = extractSessionMeta(args.sessionFile);
        name = meta.name;
        preview = meta.preview || null;
        // Resolve worktree identity for resumed worktree sessions so the
        // renderer can show the chip and pi spawns in the worktree cwd.
        worktree = resolveWorktreeForFile(args.sessionFile, args.workspacePath);
        const existing = registry.getByFile(args.sessionFile);
        if (existing && existing.status !== "exited" && existing.status !== "failed") {
          return {
            outcome: "existing" as const,
            sessionId: existing.sessionId,
            name,
            preview,
            sessionStatus: existing.status,
            ...(worktree ? { worktree } : {}),
          };
        }
        // exited/failed records fall through: openSession clears the stale
        // byFile mapping and creates a fresh cold record (existing behavior).
      }
      const sessionId = registry.openSession(args.workspacePath, args.sessionFile, worktree?.path);
      return {
        outcome: "opened" as const,
        sessionId,
        name,
        preview,
        sessionStatus: "cold" as const,
        ...(worktree ? { worktree } : {}),
      };
    },
  );

  ipcMain.handle("session.activate", async (_evt, args: { sessionId: SessionId }) => {
    const settings = getSettings();
    const piInfo = await locatePi(settings.piBinaryPath);
    if (!piInfo)
      throw new Error("pi binary not found. Please install pi or set the path in settings.");
    const loginShellEnv = await getLoginShellEnv();
    registry?.activateSession(args.sessionId, piInfo.path, loginShellEnv);
  });

  // ── Worktree ───────────────────────────────────────────────────────

  ipcMain.handle(
    "session.createWorktree",
    async (_evt, args: { sessionId: SessionId; base: string }) => {
      const rec = registry?.getSession(args.sessionId);
      if (!rec) return { ok: false, error: "Session not found" };
      const settings = getSettings();
      const piInfo = await locatePi(settings.piBinaryPath);
      if (!piInfo) return { ok: false, error: "pi binary not found" };
      const loginShellEnv = await getLoginShellEnv();
      try {
        const result = await createWorktree(rec.workspacePath, args.base);
        if (result.kind === "error") return { ok: false, error: result.message };
        // Persist the worktree association so the session (and its chip)
        // survive an app relaunch: discovery re-attaches worktree-cwd
        // session files to this workspace, and session.open re-spawns
        // pi in the worktree directory.
        const worktrees = { ...getSettings().worktrees };
        worktrees[result.worktreePath] = {
          workspacePath: rec.workspacePath,
          branch: result.branch,
          name: result.name,
          base: result.base,
        };
        saveSettings({ worktrees });
        registry?.setWorktreeAndRespawn(
          args.sessionId,
          result.worktreePath,
          piInfo.path,
          loginShellEnv,
        );
        return {
          ok: true,
          worktreePath: result.worktreePath,
          branch: result.branch,
          name: result.name,
          base: result.base,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("session.reload", async (_evt, args: { sessionId: SessionId }) => {
    const settings = getSettings();
    const piInfo = await locatePi(settings.piBinaryPath);
    if (!piInfo) return { success: false, error: "pi binary not found" };
    const loginShellEnv = await getLoginShellEnv();
    try {
      registry?.reloadSession(args.sessionId, piInfo.path, loginShellEnv);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
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
        res.success &&
        res.data &&
        typeof res.data === "object" &&
        typeof (res.data as Record<string, unknown>)["sessionFile"] === "string"
      ) {
        registry?.noteSessionFile(
          args.sessionId,
          (res.data as Record<string, unknown>)["sessionFile"] as string,
        );
      }

      // File-mutating commands (new_session / switch_session / fork / clone)
      // re-point the session to a new file. We follow up with get_state to
      // read the authoritative sessionFile + sessionName, then emit
      // `session.fileChanged` so the renderer can adopt the new path and
      // reseed the transcript. Skipped on success:false (the user gets a
      // toast) and on data.cancelled: true (the operation was refused).
      if (
        res.success &&
        res.data &&
        typeof res.data === "object" &&
        (res.data as { cancelled?: boolean }).cancelled !== true &&
        (args.command.type === "new_session" ||
          args.command.type === "switch_session" ||
          args.command.type === "fork" ||
          args.command.type === "clone")
      ) {
        try {
          const stateRes = await rec.proc.sendCommand({ type: "get_state" });
          if (stateRes.success && stateRes.data && typeof stateRes.data === "object") {
            const data = stateRes.data as Record<string, unknown>;
            const sessionFile =
              typeof data["sessionFile"] === "string" ? (data["sessionFile"] as string) : undefined;
            const sessionName =
              typeof data["sessionName"] === "string" ? (data["sessionName"] as string) : undefined;
            registry?.updateSessionFile(args.sessionId, sessionFile);
            safeSend("session.fileChanged", {
              sessionId: args.sessionId,
              sessionFile,
              sessionName,
            });
          }
        } catch (err) {
          // get_state is best-effort; the original response is still returned.
          console.error("fileChanged follow-up failed:", err);
        }
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

  // ── Clipboard ────────────────────────────────────────────────────────
  // Electron's renderer `navigator.clipboard` API is unreliable (silently
  // no-ops when the window isn't focused / under some security contexts),
  // so clipboard writes go through the main process's clipboard module.
  ipcMain.handle("clipboard.writeText", async (_evt, args: { text: string }) => {
    clipboard.writeText(args.text);
    return { ok: true as const };
  });

  // ── Git diff viewer (WP1) ───────────────────────────────────────────
  // Both channels take an explicit `root` (worktree forward-compat). They
  // never participate in the session-registry; the renderer derives the
  // root in exactly one helper. Wrapped in try/catch → `{ kind: "error" }`
  // so a misbehaving main never throws across IPC.
  ipcMain.handle("git.changes", async (_evt, args: { root: string; base?: string }) => {
    try {
      return await getChanges(args.root, args.base);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("git.changesCount", async (_evt, args: { root: string }) => {
    try {
      return await getChangesCount(args.root);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    "git.fileDiff",
    async (
      _evt,
      args: {
        root: string;
        base?: string;
        path: string;
        oldPath?: string | undefined;
        status: import("@shared/git.js").GitFileStatus;
        untracked: boolean;
      },
    ) => {
      try {
        // exactOptionalPropertyTypes: omit oldPath when undefined.
        const payload =
          args.oldPath !== undefined
            ? {
                path: args.path,
                base: args.base,
                oldPath: args.oldPath,
                status: args.status,
                untracked: args.untracked,
              }
            : { path: args.path, base: args.base, status: args.status, untracked: args.untracked };
        return await getFileDiff(args.root, payload, args.base);
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle("git.branches", async (_evt, args: { root: string }) => {
    try {
      return await getBranches(args.root);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Auth IPC ──────────────────────────────────────────────────────────

  ipcMain.handle("auth.status", async () => {
    try {
      return await getAuthStatus();
    } catch {
      return [];
    }
  });

  ipcMain.handle("auth.saveApiKey", async (_evt, args: { provider: string; key: string }) => {
    return await saveApiKey(args.provider, args.key);
  });

  ipcMain.handle("auth.remove", async (_evt, args: { provider: string }) => {
    return await removeProvider(args.provider);
  });

  // ── PTY IPC ───────────────────────────────────────────────────────────

  ipcMain.handle(
    "pty.start",
    async (_evt, args: { cwd?: string; autoLogin?: boolean; cols?: number; rows?: number }) => {
      return startPty(args);
    },
  );

  ipcMain.handle("pty.write", async (_evt, args: { ptyId: string; data: string }) => {
    writePty(args.ptyId, args.data);
  });

  ipcMain.handle(
    "pty.resize",
    async (_evt, args: { ptyId: string; cols: number; rows: number }) => {
      resizePty(args.ptyId, args.cols, args.rows);
    },
  );

  ipcMain.handle("pty.kill", async (_evt, args: { ptyId: string }) => {
    killPty(args.ptyId);
  });

  // ── Update IPC ────────────────────────────────────────────────────────

  ipcMain.handle("update.check", async () => {
    try {
      return await checkForUpdates();
    } catch {
      return {
        pi: { current: "unknown", updateAvailable: false },
        extensions: [],
        checkedAt: Date.now(),
      };
    }
  });

  ipcMain.handle(
    "update.run",
    async (_evt, args: { target: "all" | "pi" | { extension: string } }) => {
      const { runId } = startUpdate(
        args.target,
        (id, chunk) => {
          safeSend("update.progress", { runId: id, chunk });
        },
        (id, exitCode, status) => {
          safeSend("update.done", { runId: id, exitCode, status });
        },
      );
      return { runId };
    },
  );
}

export function stopAllSessions(): void {
  // Kill all PTY sessions (embedded terminals for login)
  try {
    killAllPtys();
  } catch {
    /* best effort */
  }
  registry?.stopAll();
}

/**
 * Exported for background check at app start. Called from index.ts
 * after window is ready. Delays the check by 3s to let the UI settle.
 */
export function triggerBackgroundUpdateCheck(): void {
  setTimeout(async () => {
    try {
      const settings = getSettings();
      if (!settings.updateCheckEnabled) return;
      const status = await checkForUpdates();
      if (status.pi.updateAvailable || status.extensions.some((e) => e.updateAvailable)) {
        safeSend("update.available", status);
      }
    } catch {
      // silent — updates are best-effort
    }
  }, 3000);
}
