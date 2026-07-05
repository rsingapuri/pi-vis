import path from "node:path";
import { newSessionId } from "@shared/ids.js";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import type { PiRpcCommand } from "@shared/pi-protocol/commands.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";
import lockfile from "proper-lockfile";
import { resolveHostExecPath } from "../pi/locate-node.js";
import { PiProcess } from "../pi/pi-process.js";
import { HostVersionTooLowError, SessionHost } from "../pi/session-host.js";

export type SessionCommandUiSurface = "composer" | "unified";

export interface SessionRecord {
  sessionId: SessionId;
  workspacePath: string;
  /** If set, the session's pi process runs in this worktree directory
   *  instead of workspacePath. Set at first-send time via
   *  setWorktreeAndRespawn. */
  worktreePath?: string | undefined;
  sessionFile?: string | undefined;
  status: SessionStatus;
  error?: string | undefined;
  proc?: PiProcess | SessionHost | undefined;
  /** Timestamp of last activity (open, command, or agent event). Used for LRU eviction. */
  lastActiveAt: number;
  /** True while the agent is actively processing a command (busy = ineligible for idle kill). */
  busy: boolean;
  /** Whether we hold the proper-lockfile advisory lock on the session file. */
  _hasLock?: boolean;
  /** True while activateSession() is mid-flight — guards re-entrant double-spawn. */
  _activating?: boolean;
  /** Resolves when the current activation attempt finishes (success, failure, or cancellation). */
  _activationDone?: Promise<void> | undefined;
  _resolveActivationDone?: (() => void) | undefined;
  /** Serializes reload/worktree respawn requests so overlapping restarts cannot race cwd/mode. */
  _restartChain?: Promise<void> | undefined;
  /** True while a restart is queued/running; commands should queue instead of hitting the old proc. */
  _restartInProgress?: boolean;
  /** Suppress one activation's pending-command flush because a restart is replacing that proc. */
  _suppressNextActivationFlush?: boolean;
  /**
   * Set by closeSession when it runs during activateSession's async window
   * (the lock-acquire / waitForReady awaits). activateSession checks this
   * after each await: if set, it tears down whatever it just spawned and
   * returns WITHOUT reviving the deleted record or spawning a fallback —
   * the close wins. See P1-e (close-during-activate) + P1-h (queue hang).
   */
  _dead?: boolean;
  /**
   * What the caller REQUESTED for host mode (the `useHost` arg to the first
   * activateSession). Unlike `_useHost` (which is overwritten to false on
   * fallback), this is sticky — it records intent, not outcome. /reload
   * re-tries the host iff this is true, so a session that fell back to rpc
   * can re-promote after a pi upgrade, while a session the caller never
   * wanted in host mode stays rpc. See P2-b.
   */
  _hostRequested?: boolean;
  /** Whether the session last ran in SDK-host mode (vs pi --mode rpc).
   *  Remembered across reload/respawn so a re-activation preserves the mode
   *  (without it, /reload and worktree-per-session silently reverted to
   *  --mode rpc and lost panel support). */
  _useHost?: boolean;
  /**
   * True once the proc is fully established and able to accept commands — i.e.
   * AFTER the host handshake (waitForReady) for host mode, or immediately for
   * the PiProcess/fallback branch. `proc` alone is NOT a readiness signal:
   * host mode assigns `record.proc = hostProc` BEFORE waitForReady (so the
   * init-time trust dialog can round-trip), and the host rejects every command
   * with "Not initialized" until its session finishes initializing. sendCommand
   * MUST gate on this flag, not on `proc` presence, or the renderer's init
   * commands (fired on "starting") race the handshake and bounce. See P1-i.
   */
  _procReady?: boolean;
  /** Commands queued while the proc was being established (activation in flight). */
  _pendingSend?:
    | Array<{
        command: PiRpcCommand;
        uiSurface?: SessionCommandUiSurface | undefined;
        resolve: (res: PiRpcResponse) => void;
        reject: (err: Error) => void;
      }>
    | undefined;
}

const MAX_IDLE_PROCESSES = 10;

type SessionEventCallback = (sessionId: SessionId, event: PiEvent) => void;
type UiRequestCallback = (sessionId: SessionId, req: ExtensionUiRequest) => void;
type StatusChangedCallback = (
  sessionId: SessionId,
  status: SessionStatus,
  error?: string,
  piVersion?: string,
) => void;
type PanelEventCallback = (sessionId: SessionId, event: PanelEvent) => void;
type UnifiedSubmitRequestCallback = (
  sessionId: SessionId,
  req: { id: string; text: string },
) => void;

export class SessionRegistry {
  private sessions = new Map<SessionId, SessionRecord>();
  private byFile = new Map<string, SessionId>(); // resolved file path → SessionId

  private onEvent: SessionEventCallback;
  private onUiRequest: UiRequestCallback;
  private onStatusChanged: StatusChangedCallback;
  private onPanelEvent: PanelEventCallback;
  private onUnifiedSubmitRequest: UnifiedSubmitRequestCallback;

  constructor(
    onEvent: SessionEventCallback,
    onUiRequest: UiRequestCallback,
    onStatusChanged: StatusChangedCallback,
    onPanelEvent: PanelEventCallback,
    onUnifiedSubmitRequest: UnifiedSubmitRequestCallback,
  ) {
    this.onEvent = onEvent;
    this.onUiRequest = onUiRequest;
    this.onStatusChanged = onStatusChanged;
    this.onPanelEvent = onPanelEvent;
    this.onUnifiedSubmitRequest = onUnifiedSubmitRequest;
  }

  /**
   * Create a cold record for a session. Does NOT spawn a process; the
   * renderer learns the id from the invoke result, and activation happens
   * on focus (see activateSession).
   */
  openSession(workspacePath: string, sessionFile?: string, worktreePath?: string): SessionId {
    if (sessionFile) {
      const resolved = path.resolve(sessionFile);
      const existing = this.byFile.get(resolved);
      if (existing) {
        const rec = this.sessions.get(existing);
        if (rec && rec.status !== "exited" && rec.status !== "failed") {
          throw new Error(`Session file already open: ${resolved}`);
        }
        this.byFile.delete(resolved);
        if (rec && (rec.status === "exited" || rec.status === "failed")) {
          this.sessions.delete(existing);
        }
      }
    }

    const sessionId = newSessionId();
    const record: SessionRecord = {
      sessionId,
      workspacePath,
      sessionFile,
      worktreePath,
      status: "cold",
      lastActiveAt: Date.now(),
      busy: false,
    };
    this.sessions.set(sessionId, record);

    if (sessionFile) {
      this.byFile.set(path.resolve(sessionFile), sessionId);
    }

    // No onStatusChanged emit — the renderer learns the id from the invoke result.
    return sessionId;
  }

  /**
   * Spawn the pi process for an existing cold record. Idempotent: a second
   * call while a process is alive is a no-op. Re-spawns after exit.
   */
  async activateSession(
    sessionId: SessionId,
    piPath: string,
    env?: Record<string, string>,
    useHost = false,
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    // Re-entrant guard. activateSession is async: it awaits the session-file
    // lock and, in host mode, the host's startup handshake. A second call
    // arriving mid-flight — e.g. the renderer re-firing session.activate
    // before the "starting" status has landed — must NOT spawn a second
    // process. The `record.proc &&` idempotency check below can't catch this,
    // because proc is still undefined during the async window (the old sync
    // activateSession set proc in the same tick as "starting", so this gap
    // didn't exist). The _activating flag closes it; reload/respawn paths
    // clear proc deliberately and call activateSession from a quiescent state,
    // so they're unaffected.
    if (record._activating) return record._activationDone;
    if (record.proc && (record.status === "starting" || record.status === "ready")) {
      return;
    }

    record._activating = true;
    record._activationDone = new Promise((resolve) => {
      record._resolveActivationDone = resolve;
    });
    // P2-b: remember what the caller REQUESTED (sticky across fallbacks) so
    // /reload can re-try the host after a prior fallback (user may have
    // upgraded pi). _useHost tracks the actual running mode; _hostRequested
    // tracks intent. Both are passed through activateSession.
    record._hostRequested = useHost;
    record.error = undefined;
    // Not ready until the proc is fully established (post-handshake in host
    // mode). Reset here so a re-activation (reload/respawn) re-queues until the
    // fresh proc is up rather than firing at a half-spawned host. See P1-i.
    record._procReady = false;
    record.status = "starting";
    this.onStatusChanged(sessionId, "starting");

    try {
      // Advisory file lock — warns if the session file is open elsewhere
      // (terminal pi). Non-blocking; if it fails we continue but emit a note.
      // Skip if we already hold the lock (e.g. reload/respawn reuses the same
      // session file) — otherwise proper-lockfile would see our own lockfile
      // and emit a false "open elsewhere" warning.
      if (record.sessionFile && !record._hasLock) {
        try {
          // proper-lockfile lock() is async and retries by default.
          // We use a 0-retry policy so we fail immediately if locked.
          // realpath:false must match the unlock() call in closeSession —
          // otherwise lock() tracks the lock under the realpath'd key while
          // unlock() looks up the raw path and throws ENOTACQUIRED, leaving
          // proper-lockfile's recurring update timer running (and the
          // lockfile on disk) forever.
          // P1-d: proper-lockfile's default onCompromised throws, which fires
          // from a recurring updateLock setTimeout when the lockfile mtime is
          // compromised (e.g. terminal pi touches the same <file>.lock). That
          // throw is an uncaught exception in the main process on a documented,
          // expected scenario — the advisory lock exists BECAUSE of this
          // contention. Override it to log + mark the lock lost (wrapped in
          // try/catch so the override itself can never throw either).
          await lockfile.lock(record.sessionFile, {
            retries: 0,
            realpath: false,
            lockfilePath: `${record.sessionFile}.lock`,
            onCompromised: (err: Error) => {
              try {
                console.warn(`[session-registry] Session lock compromised: ${err?.message ?? err}`);
                record._hasLock = false; // we no longer hold it; skip unlock
              } catch {
                /* never let the override itself throw from the timer */
              }
            },
          });
          record._hasLock = true;
        } catch {
          // Lock is held elsewhere (e.g., terminal pi)
          console.warn(`[session-registry] Session file is open elsewhere: ${record.sessionFile}`);
          record._hasLock = false;
          this.onPanelEvent(sessionId, {
            type: "session_warning",
            message: "Session file is open in another pi instance. Changes may conflict.",
          });
        }
      }

      // P1-e: if closeSession ran during the lock acquire above, bail out
      // immediately. Don't spawn a proc onto a deleted record.
      if (record._dead) {
        record._activating = false;
        return;
      }

      const cwd = record.worktreePath ?? record.workspacePath;

      let proc: PiProcess | SessionHost;
      let hostPiVersion: string | undefined;

      // Forward a proc's UI requests (dialogs) to the renderer. Attached
      // per-proc — and, for the host, BEFORE waitForReady — because the
      // project-trust confirm dialog fires DURING host startup (inside
      // resourceLoader.reload). If we waited until after readiness to attach
      // this, that prompt would be emitted with no listener and dropped,
      // deadlocking init. The generation guard (`record.proc !== p`) makes a
      // stale dead-host emission a no-op once we've swapped to the fallback.
      const attachUiRequest = (p: PiProcess | SessionHost) => {
        p.on("uiRequest", (req) => {
          if (record.proc !== p) return;
          this.onUiRequest(sessionId, req);
        });
      };

      // Try SessionHost first (progressive enhancement).
      // If the host fails to start, fall back to PiProcess (today's behavior).
      if (useHost) {
        record._useHost = true;
        // Retarget the host onto the user's system Node when it's newer than
        // Electron's bundled Node (e.g. user has Node 22.x, Electron 31 ships
        // 20.14). Without this, the host misses Node built-ins like
        // `node:sqlite` (Node ≥ 22.5) that extensions such as @cursor/sdk
        // require — they work in terminal pi (which runs under the user's
        // Node) but break in the forked host. Cached, so this is one
        // login-shell round-trip per app lifetime. See locate-node.ts.
        const { execPath: hostNodeExecPath } = await resolveHostExecPath();
        const hostProc = new SessionHost(piPath, cwd, record.sessionFile, env, hostNodeExecPath);
        // Set record.proc + attach forwarders NOW (pre-readiness) so the
        // init-time trust dialog round-trips. If the host fails below, the
        // fallback path reassigns record.proc and these become inert.
        record.proc = hostProc;
        attachUiRequest(hostProc);
        hostProc.on("panelOpen", (panelId, overlay, unified) => {
          if (record.proc !== hostProc) return;
          this.onPanelEvent(sessionId, {
            type: "panel_open",
            panelId,
            overlay,
            ...(unified ? { unified: true } : {}),
          });
        });
        hostProc.on("panelData", (panelId, data) => {
          if (record.proc !== hostProc) return;
          this.onPanelEvent(sessionId, { type: "panel_data", panelId, data });
        });
        hostProc.on("panelClose", (panelId) => {
          if (record.proc !== hostProc) return;
          this.onPanelEvent(sessionId, { type: "panel_close", panelId });
        });
        hostProc.on("panelMode", (panelId, mode) => {
          if (record.proc !== hostProc) return;
          this.onPanelEvent(sessionId, { type: "panel_mode", panelId, mode });
        });
        hostProc.on("panelClearAll", () => {
          if (record.proc !== hostProc) return;
          this.onPanelEvent(sessionId, { type: "panel_clear_all" });
        });
        hostProc.on("unifiedSubmitRequest", (id, text) => {
          if (record.proc !== hostProc) return;
          this.onUnifiedSubmitRequest(sessionId, { id, text });
        });

        try {
          await hostProc.waitForReady();
          // P1-e: closeSession may have run during waitForReady. The host was
          // killed (closeSession stopped it → exit → waitForReady reject) —
          // but waitForReady can also RESOLVE if ready raced the kill. Either
          // way, if the session is dead, don't proceed.
          if (record._dead) {
            hostProc.removeAllListeners();
            hostProc.stop();
            record._activating = false;
            return;
          }
          proc = hostProc;
          hostPiVersion = hostProc.piVersion;
        } catch (hostErr) {
          // P1-e: if closeSession ran during waitForReady, the host was killed
          // by the close — that's not a host failure, it's a cancellation.
          // Do NOT fall back to PiProcess onto the deleted record (that was
          // the orphan bug). Just tear down and return.
          if (record._dead) {
            hostProc.removeAllListeners();
            hostProc.stop();
            record._activating = false;
            return;
          }
          // Host failed — detach the dead host and fall back to pi --mode rpc.
          record.proc = undefined;
          hostProc.removeAllListeners();
          hostProc.stop();
          record._useHost = false;
          const reason = hostErr instanceof Error ? hostErr.message : String(hostErr);
          const isVersionTooLow = hostErr instanceof HostVersionTooLowError;
          console.warn(
            `[session-registry] SessionHost failed, falling back to pi --mode rpc: ${reason}`,
          );
          const fallbackProc = new PiProcess(piPath, cwd, record.sessionFile, env);
          proc = fallbackProc;
          attachUiRequest(fallbackProc);
          this.onPanelEvent(sessionId, {
            type: "host_fallback",
            reason: isVersionTooLow ? `${reason} — update pi for panel support` : reason,
          });
        }
      } else {
        proc = new PiProcess(piPath, cwd, record.sessionFile, env);
        attachUiRequest(proc);
      }
      // P1-e: final dead-check before assigning the proc and attaching
      // listeners. Covers the PiProcess branch (no waitForReady) and the
      // post-fallback window.
      if (record._dead) {
        proc.stop();
        record._activating = false;
        return;
      }
      record.proc = proc;

      const readyTimer = setTimeout(() => {
        if (record.proc !== proc) return;
        if (record.status === "starting") {
          record.status = "ready";
          this.onStatusChanged(sessionId, "ready", undefined, hostPiVersion);
        }
      }, 2000);
      readyTimer.unref?.();

      proc.on("event", (event) => {
        if (record.proc !== proc) return;
        record.lastActiveAt = Date.now();
        if (event.type === "agent_start") record.busy = true;
        else if (event.type === "agent_end") record.busy = false;
        if (record.status === "starting") {
          record.status = "ready";
          this.onStatusChanged(sessionId, "ready");
        }
        this.onEvent(sessionId, event);
      });

      // uiRequest is attached per-proc above (pre-readiness for the host) so
      // the init-time trust dialog isn't dropped — not re-attached here.

      proc.on("exit", (code) => {
        // The timer must never leak. Clear before the generation guard.
        clearTimeout(readyTimer);
        if (record.proc !== proc) return;
        record.status = "exited";
        record.proc = undefined;
        record._procReady = false;
        record.busy = false;
        if (code !== 0 && code !== null) {
          const tail = proc.stderrLog.slice(-5).join("").trim();
          record.error = tail
            ? `Exited with code ${code}: ${tail.slice(-400)}`
            : `Exited with code ${code}`;
        } else {
          record.error = undefined;
        }
        // P1-f: the proc is gone (exited) — release the advisory lock now if
        // we hold it, so the lockfile + recurring update timer don't leak on
        // a session whose process died (the sync catch can't see this; the
        // failure is async). closeSession would also release it, but a
        // dead-and-abandoned session otherwise leaks until then.
        this._releaseLockIfHeld(sessionId);
        // Emit unified_panel_reset so the renderer drops stale unified-panel state
        // (the dying host can't emit a reliable panel_close for the unified panel).
        this.onPanelEvent(sessionId, { type: "unified_panel_reset" });
        this.onStatusChanged(sessionId, "exited", record.error);
      });

      proc.on("error", (err) => {
        if (record.proc !== proc) return;
        record.status = "failed";
        record.proc = undefined;
        record._procReady = false;
        record.busy = false;
        record.error = err.message;
        // P1-f: same as exit — async failure must release the lock.
        this._releaseLockIfHeld(sessionId);
        this.onStatusChanged(sessionId, "failed", err.message);
      });

      // The proc is now fully established (host: post-handshake; PiProcess/
      // fallback: constructed). Mark it ready BEFORE flushing so the queued
      // commands — and any arriving during/after the flush — route to the live
      // proc instead of re-queuing. Until this point sendCommand MUST queue,
      // even though record.proc was set early in host mode. See P1-i.
      if (record._suppressNextActivationFlush) {
        record._suppressNextActivationFlush = false;
      } else {
        record._procReady = true;
        // Flush any commands that arrived while the proc was being established
        // (during the session-file lock await and, in host mode, the startup
        // handshake). They were queued by sendCommand(); now that proc is live
        // they can go out for real.
        this._flushPending(sessionId);
      }
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      // Suppression is scoped to the activation attempt used by a restart.
      // If that attempt fails, do not let the stale flag poison a later normal
      // activation by skipping _procReady/_flushPending on success.
      record._suppressNextActivationFlush = false;
      this._rejectPending(sessionId, record.error);
      this._releaseLockIfHeld(sessionId); // P1-f: sync-failure path.
      this.onStatusChanged(sessionId, "failed", record.error);
      return;
    } finally {
      record._activating = false;
      record._resolveActivationDone?.();
      record._activationDone = undefined;
      record._resolveActivationDone = undefined;
    }

    // After successful spawn, enforce the idle process limit
    this.enforceIdleLimit(sessionId);
  }

  /**
   * Send a command to the session's pi process. If the process is live, send
   * immediately. If activation is mid-flight (status "starting", proc not yet
   * assigned — during the session-file lock await or the host startup
   * handshake), queue the command and flush it once the proc is established.
   * Otherwise (cold/exited/failed with no activation pending) fail fast with
   * "No active process".
   *
   * The queue exists because activateSession is async: it emits "starting"
   * *before* the proc exists, and the renderer reacts to "starting" by firing
   * its init commands (get_state / get_available_models /
   * get_session_stats). Without buffering those would race the proc
   * assignment and fail with "No active process".
   */
  async sendCommand(
    sessionId: SessionId,
    command: PiRpcCommand,
    options: { uiSurface?: SessionCommandUiSurface | undefined } = {},
  ): Promise<PiRpcResponse> {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`Unknown session: ${sessionId}`);
    // Gate on readiness, NOT on proc presence: host mode assigns rec.proc
    // pre-handshake (for the trust dialog), but the host bounces commands with
    // "Not initialized" until init completes. _procReady flips true exactly
    // when the proc can accept commands. See P1-i.
    if (!rec._restartInProgress && rec.proc && rec._procReady) {
      return rec.proc.sendCommand(command, options);
    }
    if (rec.status === "starting" || rec._restartInProgress) {
      return new Promise<PiRpcResponse>((resolve, reject) => {
        if (!rec._pendingSend) rec._pendingSend = [];
        rec._pendingSend.push({ command, uiSurface: options.uiSurface, resolve, reject });
      });
    }
    throw new Error(`No active process for session ${sessionId}`);
  }

  /** Flush queued commands now that the proc is live (activation succeeded). */
  private _flushPending(sessionId: SessionId): void {
    const rec = this.sessions.get(sessionId);
    if (!rec?._pendingSend?.length) return;
    const pending = rec._pendingSend;
    rec._pendingSend = undefined;
    const proc = rec.proc;
    for (const item of pending) {
      if (!proc) {
        item.reject(new Error(`No active process for session ${sessionId}`));
        continue;
      }
      proc.sendCommand(item.command, { uiSurface: item.uiSurface }).then(item.resolve, item.reject);
    }
  }

  /**
   * Release the advisory session-file lock if we hold it (P1-f). Called from
   * the proc exit/error listeners (async failure), the sync catch, and
   * closeSession. No-op if we don't hold it (e.g. onCompromised already
   * cleared _hasLock). Swallows ENOTACQUIRED (lock already released by
   * onCompromised/setLockAsCompromised). Keeps the success path's lock
   * intact (only these terminal paths call it).
   */
  private _releaseLockIfHeld(sessionId: SessionId): void {
    const rec = this.sessions.get(sessionId);
    if (!rec?._hasLock || !rec.sessionFile) return;
    lockfile
      .unlock(rec.sessionFile, {
        lockfilePath: `${rec.sessionFile}.lock`,
        realpath: false,
      })
      .catch(() => {});
    rec._hasLock = false;
  }

  /** Wait for an in-flight activation to reach a quiescent state before restart operations. */
  private async _waitForActivationIfNeeded(record: SessionRecord): Promise<void> {
    if (record._activating && record._activationDone) {
      await record._activationDone;
    }
  }

  /** Serialize reload/worktree restarts for a record. */
  private async _runRestartExclusive(
    record: SessionRecord,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (record._activating) {
      record._suppressNextActivationFlush = true;
    }
    record._restartInProgress = true;
    const previous = record._restartChain ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(
      () => current,
      () => current,
    );
    record._restartChain = chained;

    await previous.catch(() => {});
    let restartError: unknown;
    try {
      await fn();
    } catch (err) {
      restartError = err;
      throw err;
    } finally {
      release();
      if (record._restartChain === chained) {
        record._restartChain = undefined;
        record._restartInProgress = false;
        if (record.proc && record._procReady) {
          this._flushPending(record.sessionId);
        } else {
          const reason =
            restartError instanceof Error
              ? restartError.message
              : (record.error ?? `Failed to activate session ${record.sessionId}`);
          this._rejectPending(record.sessionId, reason);
        }
      }
    }
  }

  /** Restart callers need activation failures as rejections, not only status events. */
  private async _throwIfRestartFailed(sessionId: SessionId): Promise<void> {
    // Give asynchronous spawn errors/exits a short window to reach the registry handlers.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`Unknown session: ${sessionId}`);
    const procExitCode = rec.proc?.exitCode;
    if (procExitCode !== undefined && procExitCode !== null) {
      throw new Error(rec.error ?? `Exited with code ${procExitCode}`);
    }
    if (rec.status === "failed" || rec.error || !rec.proc || !rec._procReady) {
      throw new Error(rec.error ?? `Failed to activate session ${sessionId}`);
    }
  }

  /** Reject all queued commands (activation failed). */
  private _rejectPending(sessionId: SessionId, reason: string): void {
    const rec = this.sessions.get(sessionId);
    if (!rec?._pendingSend?.length) return;
    const pending = rec._pendingSend;
    rec._pendingSend = undefined;
    for (const { reject } of pending) {
      reject(new Error(reason));
    }
  }

  /**
   * Note the session file for a record that didn't have one at open time.
   * No-op if the record is missing, already has a file, or byFile already
   * maps the path.
   */
  noteSessionFile(sessionId: SessionId, sessionFile: string): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    if (rec.sessionFile) return;
    const resolved = path.resolve(sessionFile);
    if (this.byFile.has(resolved)) return;
    rec.sessionFile = sessionFile;
    this.byFile.set(resolved, sessionId);
  }

  /**
   * Re-point a session to a new file (used after /new, /fork, /clone,
   * /switch_session). Always overrides the existing sessionFile (the
   * "only-if-unset" guard of `noteSessionFile` is bypassed because pi
   * has confirmed the new path is authoritative). `sessionFile` may be
   * `undefined` to clear it (lazy new_session doesn't have one yet;
   * the next harvest re-attaches).
   *
   * The byFile mapping is re-pointed: the old path is freed (if it
   * still belongs to this session) and the new path is claimed.
   */
  updateSessionFile(sessionId: SessionId, sessionFile: string | undefined): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    // Drop the old mapping if we still own it (resolves a real bug:
    // after /new, the byFile map would still point at the previous
    // file and block a switch back to it).
    if (rec.sessionFile) {
      const oldResolved = path.resolve(rec.sessionFile);
      if (this.byFile.get(oldResolved) === sessionId) {
        this.byFile.delete(oldResolved);
      }
      // Release the advisory lock on the OLD file if we held it. The lock is
      // per-file-path: after /new, /fork, or /clone the session moves to a NEW
      // file, so keeping `_hasLock=true` would make the next activation skip
      // locking the new file (it'd think it already holds it). Dropping it
      // here lets the next activateSession acquire a fresh lock on the new path.
      // P2-d (known limitation): the new file is NOT re-locked mid-session —
      // only a /reload re-activates (and re-locks). So after /new//fork//clone,
      // opening the new session file in terminal pi won't produce the "open
      // elsewhere" warning until the next /reload. This is defensible: the new
      // file may not exist on disk yet at swap time (so a lock acquire would
      // create a lockfile for a not-yet-written file), and pi's own
      // session-file writes don't need our advisory lock (we hold it only to
      // warn about terminal-pi contention). Documented, not fixed.
      this._releaseLockIfHeld(sessionId);
    }
    rec.sessionFile = sessionFile;
    if (sessionFile) {
      this.byFile.set(path.resolve(sessionFile), sessionId);
    }
  }

  /**
   * Tear down a session: detach the proc so the generation guards swallow
   * the upcoming exit event, then stop the process, then remove the record.
   */
  closeSession(sessionId: SessionId): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    // P1-e: mark the record dead so an in-flight activateSession (awaiting
    // the lock or waitForReady) tears down what it spawned instead of
    // reviving the record / spawning a fallback onto it.
    rec._dead = true;
    // P1-h: reject any commands queued during activation BEFORE deleting the
    // record. Without this, _pendingSend promises hang forever (the record is
    // gone, so _flushPending/_rejectPending can't find them to settle).
    this._rejectPending(sessionId, "Session closed");
    const proc = rec.proc;
    rec.proc = undefined;
    proc?.stop();

    // Release the session file lock if we hold it (P1-f shared path).
    this._releaseLockIfHeld(sessionId);

    this.sessions.delete(sessionId);
    if (rec.sessionFile) {
      const resolved = path.resolve(rec.sessionFile);
      if (this.byFile.get(resolved) === sessionId) {
        this.byFile.delete(resolved);
      }
    }
  }

  /**
   * Reload a session: restart its pi process so settings, keybindings,
   * extensions, skills, prompts, and themes are re-read from disk. The
   * session record (and its sessionFile) is preserved, so pi resumes the
   * same session; the renderer's transcript is untouched.
   *
   * pi's TUI `/reload` calls `session.reload()` in-process, but RPC mode
   * does not expose `reload` as a sendable command — restarting the
   * subprocess is the equivalent available over RPC. Refuses while the
   * session is mid-turn (mirrors pi's "Wait for the current response to
   * finish before reloading." guard).
   */
  async reloadSession(
    sessionId: SessionId,
    piPath: string,
    env?: Record<string, string>,
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    await this._runRestartExclusive(record, async () => {
      if (record.busy) {
        throw new Error("Wait for the current response to finish before reloading.");
      }
      await this._waitForActivationIfNeeded(record);
      if (!this.sessions.has(sessionId)) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      // Stop the current process. Clearing record.proc first means the
      // generation guard in the exit/error handlers swallows the upcoming
      // events, and activateSession sees no live proc and re-spawns.
      const proc = record.proc;
      record.proc = undefined;
      record._procReady = false;
      proc?.stop();
      // P2-b: re-try the host on /reload iff the caller originally requested
      // host mode. /reload re-reads everything from disk, and the user may have
      // just upgraded pi specifically to get panel support — a transient prior
      // failure shouldn't permanently disable the feature. A session the caller
      // never wanted in host mode (_hostRequested false) stays rpc.
      // (setWorktreeAndRespawn preserves the ACTUAL _useHost, since the pi
      // install hasn't changed across a worktree respawn.)
      record._suppressNextActivationFlush = true;
      await this.activateSession(sessionId, piPath, env, record._hostRequested ?? false);
      if (record.proc) record._procReady = true;
      await this._throwIfRestartFailed(sessionId);
    });
  }

  /**
   * Reload every running session. Used when a global input the host bakes in
   * at spawn changes — specifically the color scheme, which selects the pi
   * theme the host loads (PIVIS_PI_THEME). Respawning re-themes every
   * host-rendered surface (extension widgets/status, the unified TUI, custom
   * panels) and makes extensions re-emit their widgets with the new colors.
   *
   * Best-effort: a busy (mid-turn) session throws from reloadSession and is
   * skipped — it re-themes on its next reload/spawn — and one failure never
   * aborts the rest.
   */
  async reloadRunningSessions(piPath: string, env?: Record<string, string>): Promise<void> {
    const ids = [...this.sessions.entries()]
      .filter(([, rec]) => rec.proc && !rec.busy)
      .map(([id]) => id);
    for (const id of ids) {
      try {
        await this.reloadSession(id, piPath, env);
      } catch {
        // Busy or failed session — leave it; it re-themes on its next spawn.
      }
    }
  }

  /**
   * Re-point the session to a worktree and re-spawn its pi process.
   * Stops the current process (same guard pattern as reloadSession),
   * sets the worktree path, and re-activates (which spawns a fresh
   * process in the worktree cwd). Safe for fresh sessions (empty
   * transcript, no session file — so no data loss on kill).
   */
  async setWorktreeAndRespawn(
    sessionId: SessionId,
    worktreePath: string,
    piPath: string,
    env?: Record<string, string>,
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    await this._runRestartExclusive(record, async () => {
      await this._waitForActivationIfNeeded(record);
      if (!this.sessions.has(sessionId)) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      // Stop the current process with the generation guard.
      const proc = record.proc;
      const oldWorktreePath = record.worktreePath;
      record.proc = undefined;
      record._procReady = false;
      proc?.stop();
      record.worktreePath = worktreePath;
      try {
        // Preserve the ACTUAL running mode across a worktree respawn: the pi
        // install hasn't changed (same binary), so re-trying the host here would
        // just re-fail the same way. Use _useHost (the outcome), not _hostRequested
        // (the intent). Contrast with reloadSession, which re-tries the host via
        // _hostRequested because /reload implies a pi upgrade is possible. See P2-b.
        record._suppressNextActivationFlush = true;
        await this.activateSession(sessionId, piPath, env, record._useHost ?? false);
        if (record.proc) record._procReady = true;
        await this._throwIfRestartFailed(sessionId);
      } catch (err) {
        if (this.sessions.get(sessionId) === record) {
          record.worktreePath = oldWorktreePath;
        }
        throw err;
      }
    });
  }

  /**
   * Deactivate a session: stop its pi process and set status to "cold"
   * while keeping the record and byFile mapping intact so the session
   * stays resumable (re-activation spawns a fresh process).
   */
  deactivateSession(sessionId: SessionId): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    const proc = rec.proc;
    rec.proc = undefined;
    rec._procReady = false;
    proc?.stop();
    rec.status = "cold";
    rec.error = undefined;
    rec.busy = false;
    this.onStatusChanged(sessionId, "cold");
  }

  /**
   * Enforce the maximum number of idle (non-busy, live-proc) sessions.
   * Kills the oldest idle processes until at most MAX_IDLE_PROCESSES
   * remain. The session identified by `exceptId` is never killed.
   */
  enforceIdleLimit(exceptId: SessionId): void {
    const liveIdle: Array<{ id: SessionId; lastActiveAt: number }> = [];
    for (const [id, rec] of this.sessions) {
      if (id === exceptId) continue;
      if (rec.proc && (rec.status === "ready" || rec.status === "starting") && !rec.busy) {
        liveIdle.push({ id, lastActiveAt: rec.lastActiveAt });
      }
    }
    // Sort oldest-first so we kill the least-recently-used
    liveIdle.sort((a, b) => a.lastActiveAt - b.lastActiveAt);

    while (liveIdle.length > MAX_IDLE_PROCESSES) {
      const { id } = liveIdle.shift()!;
      this.deactivateSession(id);
    }
  }

  getSession(sessionId: SessionId): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getByFile(sessionFile: string): SessionRecord | undefined {
    const id = this.byFile.get(path.resolve(sessionFile));
    return id ? this.sessions.get(id) : undefined;
  }

  stopAll(): void {
    for (const rec of this.sessions.values()) {
      const proc = rec.proc;
      rec.proc = undefined;
      rec._procReady = false;
      rec.busy = false;
      proc?.stop();
      this._releaseLockIfHeld(rec.sessionId);
    }
  }

  getAll(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }
}
