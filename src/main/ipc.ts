import fs from "node:fs";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus, WorktreeIdentity } from "@shared/ipc-contract.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import type { SessionTreeEntry } from "@shared/pi-protocol/responses.js";
import type {
  CommandSettlement,
  ReloadRequest,
  RendererCommandRequest,
  SessionSubmission,
} from "@shared/pi-protocol/runtime-state.js";
import { resolveActiveColorScheme } from "@shared/settings.js";
import { app, clipboard, ipcMain, nativeTheme } from "electron";
import type { BrowserWindow } from "electron";
import {
  checkForAppUpdate,
  getAppUpdateStatus,
  initAppUpdates,
  installAppUpdate,
} from "./app-updates.js";
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
  inspectWorktree,
  writeWorkingFile,
} from "./git/git.js";
import { readPiChangelog } from "./pi-changelog.js";
import { mergeUserPiEnv } from "./pi-env.js";
import { clearPiLocationCache, locatePi } from "./pi/locate-pi.js";
import { initPty, killAllPtys, killPty, resizePty, startPty, writePty } from "./pty.js";
import { loadBoundHistory } from "./sessions/bound-history.js";
import { createEventBatcher } from "./sessions/event-batcher.js";
import { entriesToTranscript, loadHistoryPage } from "./sessions/history-loader.js";
import {
  extractSessionMeta,
  listSessionsForWorkspace,
  resolveWorktreeForFile,
} from "./sessions/session-discovery.js";
import { SessionRegistry } from "./sessions/session-registry.js";
import { getSettings, saveSettings } from "./settings-store.js";
import { createGistForSession } from "./share.js";
import {
  getUserThemes,
  getUserThemesDir,
  piThemeColorIndices,
  piThemeForSchemeId,
} from "./theme-loader.js";
import { checkForUpdates, startUpdate } from "./updates.js";
import {
  getOrderedWorkspaces,
  pickWorkspace,
  pickWorktreeDirectory,
  removeWorkspace,
} from "./workspaces.js";
import { respawnAndPersistWorktree } from "./worktree-persistence.js";

let registry: SessionRegistry | null = null;
let mainWindow: BrowserWindow | null = null;
let handlersRegistered = false;
let eventBatcher: ReturnType<typeof createEventBatcher> | null = null;

// Build the env for spawning a pi process/host. Adds the pi theme signals so
// every host-rendered terminal/ANSI surface resolves colors consistent with
// the active UI scheme:
//   - PIVIS_PI_THEME        — pi's built-in "dark"|"light" base theme. The
//                             host keeps it if indexed-theme installation fails.
//   - PIVIS_PI_THEME_COLORS — STABLE per-role ANSI palette INDICES (role →
//                             16–255), scheme-independent. The host installs
//                             these so pi emits role-identity bytes
//                             (`\x1b[38;5;N m`) rather than baked RGB; the
//                             renderer resolves each index against the active
//                             palette at paint time. Because this is
//                             color-agnostic, a scheme change does NOT need to
//                             respawn running sessions — the renderer's palette
//                             swap recolors them live.
async function getHostEnv(): Promise<Record<string, string>> {
  const env = await getLoginShellEnv();
  const settings = getSettings();
  const systemAppearance = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  const activeAppearance = settings.themeMode === "system" ? systemAppearance : settings.themeMode;
  return {
    ...mergeUserPiEnv(env, settings.piEnv),
    // Pi-Vis-owned variables are written last so user-configured env (or a
    // hand-edited settings.json) cannot override the host/theme control plane.
    PIVIS_PI_THEME: piThemeForSchemeId(
      resolveActiveColorScheme(settings, systemAppearance),
      activeAppearance,
    ),
    PIVIS_PI_THEME_COLORS: JSON.stringify(piThemeColorIndices()),
  };
}

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

  eventBatcher = createEventBatcher((payload) => safeSend("session.events", payload));
  const testUnifiedClaimTimeoutMs = Number.parseInt(
    process.env["PIVIS_TEST_UNIFIED_CLAIM_TIMEOUT_MS"] ?? "",
    10,
  );
  registry = new SessionRegistry(
    (sessionId: SessionId, event: PiEvent) => {
      eventBatcher?.push(sessionId, event);
    },
    (sessionId: SessionId, req: ExtensionUiRequest) => {
      eventBatcher?.flush(sessionId);
      safeSend("session.uiRequest", { sessionId, request: req });
    },
    (sessionId: SessionId, status: SessionStatus, error?: string, piVersion?: string) => {
      eventBatcher?.flush(sessionId);
      safeSend("session.statusChanged", { sessionId, status, error, piVersion });
    },
    (sessionId: SessionId, event: PanelEvent) => {
      eventBatcher?.flush(sessionId);
      safeSend("session.panelEvent", { sessionId, event });
    },
    (
      sessionId: SessionId,
      req: {
        id: string;
        text: string;
        editorRevision: number;
        submissionIntentId: string;
        hostInstanceId: string;
        sessionEpoch: number;
      },
    ) => {
      eventBatcher?.flush(sessionId);
      safeSend("session.unifiedSubmitRequest", { sessionId, ...req });
    },
    (sessionId, state) => {
      eventBatcher?.flush(sessionId);
      safeSend("session.runtimeState", { sessionId, state });
    },
    (sessionId, result) => {
      eventBatcher?.flush(sessionId);
      safeSend("session.submissionDisposition", { sessionId, result });
    },
    (sessionId, payload) => {
      eventBatcher?.flush(sessionId);
      safeSend("session.queueRestoration", { sessionId, ...(payload as object) });
    },
    (sessionId, operationId) => {
      safeSend("session.uiAcknowledged", { sessionId, operationId });
    },
    (sessionId, records, state) => {
      eventBatcher?.flush(sessionId);
      safeSend("session.transitionBatch", { sessionId, records, state });
    },
    {
      ...(Number.isFinite(testUnifiedClaimTimeoutMs) && testUnifiedClaimTimeoutMs > 0
        ? { unifiedClaimTimeoutMs: testUnifiedClaimTimeoutMs }
        : {}),
    },
  );

  // Init PTY and app-update support (must be after safeSend is wired)
  initPty(safeSend);
  initAppUpdates((status) => safeSend("appUpdate.status", status));

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
    const loginShellEnv = await getHostEnv();
    await registry?.activateSession(args.sessionId, piInfo.path, loginShellEnv);
  });

  // ── Worktree ───────────────────────────────────────────────────────

  ipcMain.handle(
    "session.createWorktree",
    async (_evt, args: { sessionId: SessionId; base: string }) => {
      const activeRegistry = registry;
      if (!activeRegistry) return { ok: false, error: "Session not found" };
      const rec = activeRegistry.getSession(args.sessionId);
      if (!rec) return { ok: false, error: "Session not found" };
      const settings = getSettings();
      const piInfo = await locatePi(settings.piBinaryPath);
      if (!piInfo) return { ok: false, error: "pi binary not found" };
      const loginShellEnv = await getHostEnv();
      try {
        const result = await createWorktree(rec.workspacePath, args.base);
        if (result.kind === "error") return { ok: false, error: result.message };
        // Persist only after the respawn succeeds, merging at the commit
        // point so overlapping worktree operations cannot drop each other.
        await respawnAndPersistWorktree({
          worktreePath: result.worktreePath,
          association: {
            workspacePath: rec.workspacePath,
            branch: result.branch,
            name: result.name,
            base: result.base,
          },
          respawn: () =>
            activeRegistry.setWorktreeAndRespawn(
              args.sessionId,
              result.worktreePath,
              piInfo.path,
              loginShellEnv,
            ),
        });
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

  // Attach an existing worktree on disk to a brand-new session. Mirrors
  // `session.createWorktree`: re-runs `inspectWorktree` server-side as the
  // authoritative gate (so a stale/edited live-validate result can never
  // persist a bad path), persists the worktree association, and respawns
  // pi into the worktree cwd. The renderer uses the same
  // `applyWorktree` plumbing on success.
  //
  // `base` for an attached worktree equals `branch` (no "cut from"
  // relationship). `resolveWorktreeForFile` matches by `cwd` byte-for-byte
  // against the persisted key, so we MUST key `settings.worktrees` by the
  // canonical toplevel `inspectWorktree` returned — never the user's raw
  // input.
  ipcMain.handle(
    "session.attachWorktree",
    async (_evt, args: { sessionId: SessionId; path: string }) => {
      const activeRegistry = registry;
      if (!activeRegistry) return { ok: false, error: "Session not found" };
      const rec = activeRegistry.getSession(args.sessionId);
      if (!rec) return { ok: false, error: "Session not found" };
      const settings = getSettings();
      const piInfo = await locatePi(settings.piBinaryPath);
      if (!piInfo) return { ok: false, error: "pi binary not found" };
      const loginShellEnv = await getHostEnv();
      try {
        const result = await inspectWorktree(rec.workspacePath, args.path);
        if (result.kind === "error") return { ok: false, error: result.message };
        // Key by the canonical toplevel, not the raw input — see the
        // `GitWorktreeInspect` doc and the `inspectWorktree` doc. Merge only
        // after respawn so concurrent operations retain both associations.
        await respawnAndPersistWorktree({
          worktreePath: result.path,
          association: {
            workspacePath: rec.workspacePath,
            branch: result.branch,
            name: result.name,
            base: result.branch, // attached: no "cut from" relationship
          },
          respawn: () =>
            activeRegistry.setWorktreeAndRespawn(
              args.sessionId,
              result.path,
              piInfo.path,
              loginShellEnv,
            ),
        });
        return {
          ok: true,
          worktreePath: result.path,
          branch: result.branch,
          name: result.name,
          base: result.branch,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Live-validate a candidate worktree path for the WorktreeBar's
  // "Existing" mode. The result drives the status line; it is advisory
  // only — the authoritative gate is `session.attachWorktree` above
  // re-running `inspectWorktree`.
  ipcMain.handle(
    "worktree.validate",
    async (_evt, args: { workspacePath: string; path: string }) => {
      try {
        const result = await inspectWorktree(args.workspacePath, args.path);
        if (result.kind === "error") return { ok: false, error: result.message };
        return { ok: true, branch: result.branch, name: result.name };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Open the OS directory picker for attaching to an existing worktree.
  ipcMain.handle("worktree.pickDirectory", async (_evt, args: { workspacePath: string }) => {
    return pickWorktreeDirectory(args.workspacePath);
  });

  ipcMain.handle(
    "session.reload",
    async (_evt, args: { sessionId: SessionId; request: ReloadRequest }) => {
      if (!registry) throw new Error("Session registry not initialized");
      return registry.executeReload(args.sessionId, args.request);
    },
  );

  // ── /share: export session to a secret GitHub gist ─────────────────
  // Implemented in main (see share.ts) because it shells out to `gh` and
  // writes a temp file; the HTML content comes from the host's export_html
  // bridge command, routed through the registry. Error strings match pi's
  // TUI verbatim for the gh-missing / gh-not-logged-in cases.
  ipcMain.handle(
    "session.share",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
        exportIntentId: string;
      },
    ) => {
      if (!registry) return { ok: false, error: "Session registry not initialized" };
      try {
        return await createGistForSession(
          args.sessionId,
          registry,
          {
            hostInstanceId: args.expectedHostInstanceId,
            sessionEpoch: args.expectedSessionEpoch,
          },
          args.exportIntentId,
        );
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ── /changelog: read pi's shipped CHANGELOG.md ──────────────────────
  // Locates the pi package dir from the cached pi binary path and reads
  // CHANGELOG.md from the package root. Returns raw markdown; the renderer
  // renders it as a custom_message block.
  ipcMain.handle("pi.changelog", async () => {
    const settings = getSettings();
    const piInfo = await locatePi(settings.piBinaryPath);
    if (!piInfo) return { ok: false, error: "pi binary not found" };
    return readPiChangelog(piInfo.path);
  });

  ipcMain.handle(
    "session.prepareClose",
    async (_evt, args: { sessionId: SessionId; force?: boolean }) => {
      if (!registry) throw new Error("Session registry not initialized");
      return registry.prepareClose(args.sessionId, args.force === true);
    },
  );

  ipcMain.handle(
    "session.cancelClose",
    async (_evt, args: { sessionId: SessionId; reviewToken: string }) => {
      if (!registry) throw new Error("Session registry not initialized");
      return registry.cancelClose(args.sessionId, args.reviewToken);
    },
  );

  ipcMain.handle(
    "session.confirmClose",
    async (_evt, args: { sessionId: SessionId; reviewToken: string }) => {
      if (!registry) throw new Error("Session registry not initialized");
      return registry.confirmClose(args.sessionId, args.reviewToken);
    },
  );

  ipcMain.handle(
    "session.loadHistory",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        expectedSessionFile: string;
        historyGeneration: number;
        expectedHostInstanceId: string | null;
        expectedSessionEpoch: number | null;
        limit?: number | undefined;
        before?: number | undefined;
      },
    ) => {
      if (!registry) {
        return { status: "stale" as const, historyGeneration: args.historyGeneration };
      }
      const testDelayMs = Number.parseInt(process.env["PIVIS_TEST_HISTORY_DELAY_MS"] ?? "", 10);
      const load = async (
        filePath: string,
        opts: { limit?: number | undefined; before?: number | undefined },
      ) => {
        if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, testDelayMs));
        }
        return loadHistoryPage(filePath, opts);
      };
      const result = await loadBoundHistory(
        args,
        (sessionId) => registry?.getSession(sessionId),
        load,
      );
      const historyLog = process.env["PIVIS_TEST_HISTORY_LOG"];
      if (historyLog) {
        fs.appendFileSync(
          historyLog,
          `${JSON.stringify({
            status: result.status,
            historyGeneration: args.historyGeneration,
            expectedSessionFile: args.expectedSessionFile,
            expectedHostInstanceId: args.expectedHostInstanceId,
            expectedSessionEpoch: args.expectedSessionEpoch,
          })}\n`,
        );
      }
      return result;
    },
  );

  // Convert an in-memory branch (root→leaf, as returned by the host's
  // getBranch() and shipped in navigate_tree's response data) into the
  // renderer-facing TranscriptBlock[] shape. The host is the source of
  // truth here — we deliberately do NOT re-read the session file, which
  // may be stale for freshly-appended entries (e.g. a just-generated
  // branch_summary).
  ipcMain.handle(
    "session.transcriptForEntries",
    (_evt, args: { sessionId: SessionId; entries: SessionTreeEntry[] }) => {
      return entriesToTranscript(args.entries);
    },
  );

  ipcMain.handle(
    "session.sendCommand",
    async (
      _evt,
      args: { sessionId: SessionId } & RendererCommandRequest,
    ): Promise<CommandSettlement> => {
      const reg = registry;
      if (!reg) throw new Error("Session registry not initialized");
      const res = await reg.executeRendererCommand(args.sessionId, {
        requestId: args.requestId,
        command: args.command,
        expectedHostInstanceId: args.expectedHostInstanceId,
        expectedSessionEpoch: args.expectedSessionEpoch,
        ...(args.intentId ? { intentId: args.intentId } : {}),
        ...(args.uiSurface ? { uiSurface: args.uiSurface } : {}),
        ...(args.sourceText !== undefined ? { sourceText: args.sourceText } : {}),
        ...(args.editorRevision !== undefined ? { editorRevision: args.editorRevision } : {}),
      });

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
        reg.noteSessionFile(
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
          const successor = res.successorIdentity;
          if (!successor) throw new Error("Replacement completed without successor identity");
          const stateRes = await reg.readInternalProbe(
            args.sessionId,
            { type: "get_state" },
            successor,
          );
          if (stateRes.success && stateRes.data && typeof stateRes.data === "object") {
            const data = stateRes.data as Record<string, unknown>;
            const sessionFile =
              typeof data["sessionFile"] === "string" ? (data["sessionFile"] as string) : undefined;
            const sessionName =
              typeof data["sessionName"] === "string" ? (data["sessionName"] as string) : undefined;
            reg.updateSessionFile(args.sessionId, sessionFile);
            eventBatcher?.flush(args.sessionId);
            safeSend("session.fileChanged", {
              sessionId: args.sessionId,
              hostInstanceId: successor.hostInstanceId,
              sessionEpoch: successor.sessionEpoch,
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
    "session.submit",
    async (_evt, args: { sessionId: SessionId; submission: SessionSubmission }) => {
      if (!registry) throw new Error("Session registry not initialized");
      return registry.submit(args.sessionId, args.submission);
    },
  );

  ipcMain.handle(
    "session.acknowledgeRestoration",
    async (_evt, args: { sessionId: SessionId; restorationId: string }) => {
      return {
        acknowledged: registry?.acknowledgeRestoration(args.sessionId, args.restorationId) ?? false,
      };
    },
  );

  ipcMain.handle(
    "session.escape",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        requestId: string;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
      },
    ) => {
      if (!registry) throw new Error("Session registry not initialized");
      return registry.escapeSession(args.sessionId, args.requestId, {
        hostInstanceId: args.expectedHostInstanceId,
        sessionEpoch: args.expectedSessionEpoch,
      });
    },
  );

  ipcMain.handle("session.runtimeResync", async (_evt, args: { sessionId: SessionId }) => {
    if (!registry) throw new Error("Session registry not initialized");
    return registry.resyncSession(args.sessionId);
  });

  ipcMain.handle(
    "session.rendererAttach",
    async (_evt, args: { sessionId: SessionId; rendererGeneration: number }) => {
      if (!registry) throw new Error("Session registry not initialized");
      return registry.rendererAttach(args.sessionId, args.rendererGeneration);
    },
  );

  ipcMain.handle(
    "session.editorPatch",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
        baseRevision: number;
        revision: number;
        text: string;
        attachments: unknown[];
      },
    ) => {
      if (!registry) throw new Error("Session registry not initialized");
      return registry.applyEditorPatch(
        args.sessionId,
        args.expectedHostInstanceId,
        args.expectedSessionEpoch,
        {
          baseRevision: args.baseRevision,
          revision: args.revision,
          text: args.text,
          attachments: args.attachments,
        },
      );
    },
  );

  ipcMain.handle(
    "session.respondToUiRequest",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        rendererGeneration: number;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
        operationId: string;
        response: ExtensionUiResponse;
      },
    ) => {
      const acknowledged =
        (await registry?.respondToUiRequest(
          args.sessionId,
          args.rendererGeneration,
          args.expectedHostInstanceId,
          args.expectedSessionEpoch,
          args.operationId,
          args.response,
        )) ?? false;
      return { acknowledged };
    },
  );

  // ── Panel I/O ────────────────────────────────────────────────────────
  // Panel input and resize are sequenced renderer-to-host transport records.
  // The registry reports acknowledgement/gaps and forwards accepted input to
  // the active SDK host.

  ipcMain.handle(
    "session.panelInput",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
        panelId: number;
        sequence: number;
        data: string;
      },
    ) => {
      return (
        registry?.sendPanelInput(
          args.sessionId,
          args.expectedHostInstanceId,
          args.expectedSessionEpoch,
          args.panelId,
          args.sequence,
          args.data,
        ) ?? {
          acknowledgedThrough: 0,
        }
      );
    },
  );

  ipcMain.handle(
    "session.panelResize",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
        panelId: number;
        cols: number;
        rows: number;
        force?: boolean;
      },
    ) => {
      registry?.resizePanel(
        args.sessionId,
        args.expectedHostInstanceId,
        args.expectedSessionEpoch,
        args.panelId,
        args.cols,
        args.rows,
        args.force === true,
      );
    },
  );

  ipcMain.handle(
    "session.panelClose",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
        panelId: number;
        operationId: string;
      },
    ) => {
      const acknowledged =
        (await registry?.closePanel(
          args.sessionId,
          args.expectedHostInstanceId,
          args.expectedSessionEpoch,
          args.panelId,
          args.operationId,
        )) ?? false;
      return { acknowledged };
    },
  );

  ipcMain.handle("settings.get", async () => {
    return getSettings();
  });

  ipcMain.handle("themes.listUser", async () => {
    return getUserThemes();
  });

  ipcMain.handle("themes.userDir", async () => {
    return getUserThemesDir();
  });

  ipcMain.handle("settings.set", async (_evt, updates: Partial<ReturnType<typeof getSettings>>) => {
    const next = saveSettings(updates);
    // Color-scheme changes are handled entirely renderer-side: the host emits
    // stable per-role ANSI INDICES (color-agnostic), and the renderer resolves
    // them against the active palette at paint time. So a scheme swap recolors
    // every running session's widgets/TUI live via `term.options.theme` — no
    // respawn needed (and no busy-session skip gap).
    return next;
  });

  ipcMain.handle("app.versions", async () => {
    return {
      app: app.getVersion(),
      electron: process.versions["electron"] ?? "",
      node: process.versions["node"] ?? "",
    };
  });

  ipcMain.handle("appUpdate.status", async () => getAppUpdateStatus());

  ipcMain.handle("appUpdate.check", async () => checkForAppUpdate());

  ipcMain.handle("appUpdate.install", async () => installAppUpdate());

  // ── Clipboard ────────────────────────────────────────────────────────
  // Electron's renderer `navigator.clipboard` API is unreliable (silently
  // no-ops when the window isn't focused / under some security contexts),
  // so clipboard writes go through the main process's clipboard module.
  ipcMain.handle("clipboard.writeText", async (_evt, args: { text: string }) => {
    clipboard.writeText(args.text);
    return { ok: true as const };
  });

  // ── Unified TUI panel responses ───────────────────────────────────────
  ipcMain.handle(
    "session.claimUnifiedSubmit",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        id: string;
        rendererGeneration: number;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
      },
    ) =>
      registry?.claimUnifiedSubmit(args.sessionId, args.id, args.rendererGeneration, {
        hostInstanceId: args.expectedHostInstanceId,
        sessionEpoch: args.expectedSessionEpoch,
      }) ?? { claimed: false },
  );

  ipcMain.handle(
    "session.unifiedSubmitResponse",
    async (
      _evt,
      args: {
        sessionId: SessionId;
        id: string;
        rendererGeneration: number;
        claimId: string;
        expectedHostInstanceId: string;
        expectedSessionEpoch: number;
        ok: boolean;
        bailed?: boolean;
        error?: string;
      },
    ) => {
      const result = registry?.respondToUnifiedSubmit(
        args.sessionId,
        args.id,
        { rendererGeneration: args.rendererGeneration, claimId: args.claimId },
        {
          hostInstanceId: args.expectedHostInstanceId,
          sessionEpoch: args.expectedSessionEpoch,
        },
        {
          ok: args.ok,
          ...(args.bailed !== undefined ? { bailed: args.bailed } : {}),
          ...(args.error !== undefined ? { error: args.error } : {}),
        },
      );
      return { ok: result?.accepted ?? false };
    },
  );

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
        const maxBytes = getSettings().diffMaxFileSizeMiB * 1024 * 1024;
        return await getFileDiff(args.root, payload, args.base, maxBytes);
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

  // Compare-and-swap write of a working-tree file from the diff editor. The
  // renderer sends the sha256 of the `newText` its buffer was derived from;
  // main refuses to write when the file on disk no longer matches (conflict).
  ipcMain.handle(
    "git.writeWorkingFile",
    async (_evt, args: { root: string; path: string; content: string; expectedHash: string }) => {
      try {
        return await writeWorkingFile(args.root, args.path, args.content, args.expectedHash);
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    },
  );

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
  try {
    stopAuthWatch();
  } catch {
    /* best effort */
  }
  eventBatcher?.dispose();
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

export function triggerBackgroundAppUpdateCheck(): void {
  setTimeout(() => {
    try {
      const settings = getSettings();
      if (!settings.appUpdateCheckEnabled) return;
      checkForAppUpdate();
    } catch {
      // silent — app updates are best-effort
    }
  }, 5000);
}
