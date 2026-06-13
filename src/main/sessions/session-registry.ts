import path from "node:path";
import { newSessionId } from "@shared/ids.js";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import { PiProcess } from "../pi/pi-process.js";

export interface SessionRecord {
  sessionId: SessionId;
  workspacePath: string;
  sessionFile?: string | undefined;
  status: SessionStatus;
  error?: string | undefined;
  proc?: PiProcess | undefined;
}

type SessionEventCallback = (sessionId: SessionId, event: PiEvent) => void;
type UiRequestCallback = (sessionId: SessionId, req: ExtensionUiRequest) => void;
type StatusChangedCallback = (sessionId: SessionId, status: SessionStatus, error?: string) => void;

export class SessionRegistry {
  private sessions = new Map<SessionId, SessionRecord>();
  private byFile = new Map<string, SessionId>(); // resolved file path → SessionId

  private onEvent: SessionEventCallback;
  private onUiRequest: UiRequestCallback;
  private onStatusChanged: StatusChangedCallback;

  constructor(
    onEvent: SessionEventCallback,
    onUiRequest: UiRequestCallback,
    onStatusChanged: StatusChangedCallback,
  ) {
    this.onEvent = onEvent;
    this.onUiRequest = onUiRequest;
    this.onStatusChanged = onStatusChanged;
  }

  /**
   * Create a cold record for a session. Does NOT spawn a process; the
   * renderer learns the id from the invoke result, and activation happens
   * on focus (see activateSession).
   */
  openSession(workspacePath: string, sessionFile?: string): SessionId {
    if (sessionFile) {
      const resolved = path.resolve(sessionFile);
      const existing = this.byFile.get(resolved);
      if (existing) {
        const rec = this.sessions.get(existing);
        if (rec && rec.status !== "exited" && rec.status !== "failed") {
          throw new Error(`Session file already open: ${resolved}`);
        }
        this.byFile.delete(resolved);
      }
    }

    const sessionId = newSessionId();
    const record: SessionRecord = {
      sessionId,
      workspacePath,
      sessionFile,
      status: "cold",
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
  activateSession(sessionId: SessionId, piPath: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    if (record.proc && (record.status === "starting" || record.status === "ready")) {
      return;
    }

    record.error = undefined;
    record.status = "starting";
    this.onStatusChanged(sessionId, "starting");

    try {
      const proc = new PiProcess(piPath, record.workspacePath, record.sessionFile);
      record.proc = proc;

      const readyTimer = setTimeout(() => {
        if (record.proc !== proc) return;
        if (record.status === "starting") {
          record.status = "ready";
          this.onStatusChanged(sessionId, "ready");
        }
      }, 2000);
      readyTimer.unref?.();

      proc.on("event", (event) => {
        if (record.proc !== proc) return;
        if (record.status === "starting") {
          record.status = "ready";
          this.onStatusChanged(sessionId, "ready");
        }
        this.onEvent(sessionId, event);
      });

      proc.on("uiRequest", (req) => {
        if (record.proc !== proc) return;
        this.onUiRequest(sessionId, req);
      });

      proc.on("exit", (code) => {
        // The timer must never leak. Clear before the generation guard.
        clearTimeout(readyTimer);
        if (record.proc !== proc) return;
        record.status = "exited";
        if (code !== 0 && code !== null) {
          const tail = proc.stderrLog.slice(-5).join("").trim();
          record.error = tail
            ? `Exited with code ${code}: ${tail.slice(-400)}`
            : `Exited with code ${code}`;
        } else {
          record.error = undefined;
        }
        this.onStatusChanged(sessionId, "exited", record.error);
      });

      proc.on("error", (err) => {
        if (record.proc !== proc) return;
        record.status = "failed";
        record.error = err.message;
        this.onStatusChanged(sessionId, "failed", err.message);
      });
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      this.onStatusChanged(sessionId, "failed", record.error);
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
    const proc = rec.proc;
    rec.proc = undefined;
    proc?.stop();
    this.sessions.delete(sessionId);
    if (rec.sessionFile) {
      const resolved = path.resolve(rec.sessionFile);
      if (this.byFile.get(resolved) === sessionId) {
        this.byFile.delete(resolved);
      }
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
      rec.proc?.stop();
    }
  }

  getAll(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }
}
