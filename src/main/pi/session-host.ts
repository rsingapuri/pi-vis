/**
 * SessionHost — Child-IPC wrapper around the SDK-host subprocess.
 *
 * Presents the same EventEmitter shape as PiProcess:
 *   - Events: event(PiEvent), uiRequest(ExtensionUiRequest), exit, error
 *   - Methods: sendCommand(PiRpcCommand): Promise<PiRpcResponse>, sendUiResponse(string), stop()
 *
 * Additional events for panels:
 *   - panelOpen(panelId, overlay), panelData(panelId, data), panelClose(panelId)
 *
 * The host subprocess is forked from resources/pi-session-host/host.mjs.
 * Communication uses child_process.fork IPC (process.send / process.on("message")).
 * All messages use structured clone (NOT JSON.stringify), verified safe for AgentSessionEvent.
 */

import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionId } from "@shared/ids.js";
import { newRpcRequestId } from "@shared/ids.js";
import type { PiRpcCommand } from "@shared/pi-protocol/commands.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the host subprocess entry point.
//
// The host is plain ESM (.mjs) and child_process.fork() must execute it from a
// real on-disk path — files INSIDE app.asar can't be forked (Node's loader
// can't stat the asar virtual FS for an entry point). So in production the
// host scripts are asarUnpacked (see electron-builder.yml asarUnpack), which
// places them at:
//   <resourcesPath>/app.asar.unpacked/out/resources/pi-session-host/host.mjs
//
// Resolution order:
//   1. Dev: source tree (resources/pi-session-host/host.mjs, reached from
//      out/main via ../../..).
//   2. Production: process.resourcesPath/app.asar.unpacked/out/resources/...
//      (the unpacked mirror of the asar path). app.getAppPath() returns the
//      asar root; we substitute the .unpacked sibling for the fork target.
function resolveHostScript(): string {
  // Dev path: source resources/pi-session-host/host.mjs (two `..` from
  // out/main → <repo>). This is authoritative in `npm run dev` — edits to the
  // source .mjs files are picked up without a rebuild. NOTE: a stale
  // out/resources/pi-session-host/ copy from a prior `npm run build` exists on
  // disk but is NOT used in dev (the devPath check returns the source first).
  // That out/resources copy is a build artifact (kept for production asar-unpack
  // via copy-host + electron-builder.yml asarUnpack); it is gitignored (out/).
  const devPath = path.join(__dirname, "..", "..", "resources", "pi-session-host", "host.mjs");
  if (existsSync(devPath)) return devPath;

  // Production path. app.getAppPath() points at app.asar (or the dev out dir
  // when running unbundled); app.isPackaged distinguishes the two.
  let asarRoot: string;
  try {
    // Lazily import Electron's app — only available in the main process.
    const { app } = require("electron");
    asarRoot = app.getAppPath();
  } catch {
    // Fallback for tests / non-Electron contexts: resolve relative to the
    // compiled main bundle's location (out/main → ../resources).
    asarRoot = path.join(__dirname, "..", "..");
  }
  // asarRoot is .../app.asar; the unpacked mirror is .../app.asar.unpacked.
  // If asarRoot doesn't contain "app.asar" (dev/preview), fall back to the
  // relative out/resources path so preview builds still work.
  const unpackedRoot = asarRoot.includes("app.asar")
    ? asarRoot.replace(/app\.asar(?=$|\/)/, "app.asar.unpacked")
    : asarRoot;
  return path.join(unpackedRoot, "out", "resources", "pi-session-host", "host.mjs");
}

const HOST_SCRIPT = resolveHostScript();

/**
 * Test seam: when set, `SessionHost` constructs its ChildProcess by calling
 * this override instead of `child_process.fork`. Production code leaves it
 * `null`. Tests install a fake that returns a {@link FakeHostProcess} so the
 * ready/error/exit/timeout/panel/fallback/pending-queue lifecycle can be driven
 * deterministically without forking a real `host.mjs` (which would require a
 * real pi install and be slow/flaky).
 *
 * Static on the class (not a ctor arg) so the registry — which constructs
 * `SessionHost` deep inside `activateSession` — doesn't need a test-only
 * parameter threaded through its public surface.
 */
/**
 * Mutable test seam. Production code never touches this; tests set `.fn` to a
 * fake that returns a `FakeHostProcess` so the host lifecycle can be driven
 * deterministically (see `session-host.test.ts`). Wrapped in an object so a
 * test can mutate the `fn` field without rebinding a module export.
 */
export const __forkOverride: {
  fn: ((hostPath: string, args: string[], opts: object) => ChildProcess) | null;
} = { fn: null };

// Per-command timeout. 0 = no timer (the only termination is process exit,
// which rejectAllPending handles). Mirrors PiProcess.COMMAND_TIMEOUTS_MS.
// prompt/compact block on user interaction / long-running summarisation;
// bash can run for minutes. The prior version used `COMMAND_NO_TIMEOUT` with
// a ternary that was always 0 — i.e. NO command ever timed out, including
// bash, so a hung bash command would leave its promise pending forever.
const COMMAND_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  prompt: 0,
  compact: 0,
  bash: 600_000,
};

/**
 * Thrown by SessionHost.waitForReady() when the installed pi is older than
 * MIN_PI_VERSION. Carries the `versionTooLow` flag as a typed field so the
 * registry can branch on it without `any`-casting the error.
 */
export class HostVersionTooLowError extends Error {
  readonly versionTooLow = true;
}

// Maximum time to wait for host to start
const STARTUP_TIMEOUT_MS = 30_000;

/**
 * Runtime type guard: is this proc a SessionHost (vs a PiProcess)?
 *
 * Panel I/O (input/resize/close) is meaningful only for the SDK host; the
 * `pi --mode rpc` fallback has no panel bridge. We duck-type on a host-only
 * method rather than `instanceof` so the IPC layer needn't import the class,
 * and so the check survives the proc being a structural stand-in in tests.
 */
export function isSessionHost(proc: unknown): proc is SessionHost {
  return typeof (proc as SessionHost | null)?.sendPanelInput === "function";
}

interface PendingRequest {
  resolve: (res: PiRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SessionHostEvents {
  event: (event: PiEvent) => void;
  uiRequest: (req: ExtensionUiRequest) => void;
  exit: (code: number | null, signal: string | null) => void;
  error: (err: Error) => void;
  /** Panel events for custom() rendering */
  panelOpen: (panelId: number, overlay: boolean, unified: boolean) => void;
  panelData: (panelId: number, data: string) => void;
  panelClose: (panelId: number) => void;
  panelMode: (panelId: number, mode: "content" | "viewport") => void;
  panelClearAll: () => void;
  /** Unified TUI panel events */
  unifiedSubmitRequest: (id: string, text: string) => void;
}

interface InitMessage {
  type: "init";
  piPath: string;
  cwd: string;
  // agentDir is intentionally NOT sent: the host derives it via
  // pi.getAgentDir() so the runtime, services, and ProjectTrustStore agree and
  // honor PI_* env overrides (staying shared with the user's terminal pi).
  sessionFile?: string;
}

/** Wire messages sent from the host subprocess to the main process.
 * Tagged union so handleMessage is exhaustively type-checked (no `any`). */
type HostWireMessage =
  | { type: "spawned" }
  | { type: "ready"; piVersion?: string }
  | { type: "error"; message?: string; versionTooLow?: boolean }
  | { type: "event"; event: PiEvent }
  | ExtensionUiRequest
  | { type: "response"; id: string; success: boolean; data?: unknown; error?: string }
  | { type: "panel_open"; panelId: number; overlay: boolean; unified?: boolean }
  | { type: "panel_data"; panelId: number; data: string }
  | { type: "panel_close"; panelId: number }
  | { type: "panel_mode"; panelId: number; mode: "content" | "viewport" }
  | { type: "panel_clear_all" }
  | { type: "unified_submit_request"; id: string; text: string }
  | { type: "clipboard_read_image_request"; id: string };

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: typed EventEmitter
export class SessionHost extends EventEmitter {
  private proc: ChildProcess;
  private pending = new Map<string, PendingRequest>();
  public stderrLog: string[] = [];
  public readonly sessionFile?: string | undefined;
  private ready = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private startupReject: ((err: Error) => void) | null = null;
  /**
   * Dialog-outstanding timer: when a pre-ready dialog pauses the startup
   * watchdog (see handleMessage "extension_ui_request"), this is armed so
   * that a dialog the user NEVER answers can't hang the host forever.
   * Re-arming the startup watchdog in sendUiResponse clears this. If it
   * fires, waitForReady rejects with a dialog-timeout error so the registry
   * falls back to pi --mode rpc instead of wedging indefinitely.
   */
  private dialogTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long a pre-ready dialog may stay unanswered before we give up. */
  private static readonly DIALOG_TIMEOUT_MS = 5 * 60_000; // 5 min
  /** Test seam: override DIALOG_TIMEOUT_MS for fast tests (null = use default). */
  static __dialogTimeoutMsForTests: number | null = null;

  private get dialogTimeoutMs(): number {
    return SessionHost.__dialogTimeoutMsForTests ?? SessionHost.DIALOG_TIMEOUT_MS;
  }
  /** Exit code from the host process, if it exited. */
  public exitCode: number | null = null;
  /** True if host exited due to pi version below minimum. */
  public versionTooLow = false;
  /** pi version reported by the host on ready. */
  public piVersion?: string | undefined;

  constructor(
    piPath: string,
    workspacePath: string,
    sessionFile?: string,
    env?: Record<string, string>,
    /**
     * Optional override for the executable that runs this host subprocess.
     *
     * By default `child_process.fork()` uses `process.execPath` = the Electron
     * binary, so the host runs under Electron's bundled Node (e.g. Electron 31
     * → Node 20.14). Passing the user's system `node` here retargets the host
     * onto the same Node that `pi` itself runs under, which restores parity
     * for extensions relying on Node built-ins newer than Electron's bundled
     * version (notably `@cursor/sdk`'s `SqliteLocalAgentStore`, which needs
     * `node:sqlite`, added in Node v22.5.0). See `locate-node.ts`.
     *
     * `undefined` = today's behavior (Electron's bundled Node). The registry
     * computes this once via `resolveHostExecPath()` and only passes a value
     * when the system Node is strictly newer than Electron's.
     */
    nodeExecPath?: string,
  ) {
    super();
    this.sessionFile = sessionFile;

    // E2E seam: when PIVIS_TEST_HOST_SCRIPT is set, fork that script instead of
    // the real host.mjs. Lets the unified-panel Playwright test drive the
    // factory-setWidget flow through the REAL app (registry → IPC → store →
    // UnifiedTuiHost) with a deterministic fake host — no real pi/SDK needed.
    // Production never sets this env var.
    const hostPath = process.env.PIVIS_TEST_HOST_SCRIPT ?? HOST_SCRIPT;

    // Test seam: if a fork override is installed (unit tests only), use it.
    // Otherwise fork the real host.mjs subprocess.
    const forkFn = __forkOverride.fn ?? fork;
    this.proc = forkFn(hostPath, [], {
      cwd: workspacePath,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: [], // Don't pass --inspect-brk etc.
      // When the registry resolved a newer system Node, run the host under it
      // instead of Electron's bundled Node (see locate-node.ts). `fork()`
      // still sets up the IPC channel (fd 3) regardless of execPath, and the
      // host's process.send/on("message") wire is unchanged — plain Node and
      // Electron share the same fork IPC protocol. Omitting execPath keeps
      // the default (process.execPath = Electron) for the fallback case.
      ...(nodeExecPath ? { execPath: nodeExecPath } : {}),
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      // Host stdout is used by pi's console.log
      const line = chunk.toString("utf8");
      this.stderrLog.push(`[host stdout] ${line}`);
      if (this.stderrLog.length > 500) this.stderrLog.shift();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8");
      this.stderrLog.push(line);
      if (this.stderrLog.length > 500) this.stderrLog.shift();
    });

    this.proc.on("message", (msg: HostWireMessage) => {
      this.handleMessage(msg);
    });

    this.proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitCode = code;
      this.versionTooLow = code === 42;
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      if (this.dialogTimer) {
        clearTimeout(this.dialogTimer);
        this.dialogTimer = null;
      }
      // Reject startup if we never got 'ready'. A crash during module load
      // (SyntaxError, ERR_MODULE_NOT_FOUND) sends no {type:"error"} message —
      // the process just dies — so the exit handler is the only signal. Fold
      // in the captured stderr tail so the real cause is visible instead of
      // the inscrutable "exited with code 1 before ready".
      if (!this.ready && this.startupReject) {
        this.startupReject(this.startupExitError(code));
        this.startupReject = null;
      }
      this.rejectAllPending(new Error(`Host process exited with code ${code}`));
      this.emit("exit", code, signal);
    });

    this.proc.on("error", (err) => {
      if (this.startupReject) {
        this.startupReject(err);
        this.startupReject = null;
      }
      this.rejectAllPending(err);
      this.emitError(err);
    });

    // Send init message
    const initMsg: InitMessage = {
      type: "init",
      piPath,
      cwd: workspacePath,
    };
    if (sessionFile) initMsg.sessionFile = sessionFile;

    this.proc.send(initMsg);

    this.armStartupTimer();
  }

  /**
   * (Re)arm the startup watchdog. Fires once if the host neither reaches
   * 'ready' nor exits within STARTUP_TIMEOUT_MS — guarding against a host that
   * hangs during module load or runtime creation. It does NOT kill the process
   * (it may still come up); it just stops waiting so the registry can fall back.
   *
   * It is intentionally PAUSED while a pre-ready dialog is outstanding (see
   * handleMessage): the project-trust prompt fires during startup and blocks on
   * a human, which is not a hang. The timer is re-armed when we send the user's
   * response, bounding any genuine hang in the post-answer work.
   */
  private armStartupTimer(): void {
    if (this.ready) return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      const err = new Error("Host process startup timed out");
      if (this.startupReject) {
        this.startupReject(err);
        this.startupReject = null;
      }
      console.error("[SessionHost] Startup timed out");
    }, STARTUP_TIMEOUT_MS);
    this.startupTimer.unref?.();
  }

  /**
   * Returns a promise that resolves when the host signals 'ready',
   * or rejects on 'error' / timeout.
   */
  waitForReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(this.startupExitError(code));
      };
      const cleanup = () => {
        this.off("ready", onReady);
        this.off("error", onError);
        this.off("exit", onExit);
        this.startupReject = null;
      };

      // If we already had a startupReject, replace it
      this.startupReject = onError;

      this.once("ready", onReady);
      this.once("error", onError);
      this.once("exit", onExit);
    });
  }

  /**
   * Emit 'error' only when someone is listening. An 'error' emission with no
   * listeners throws as an uncaughtException — which in Electron's main
   * process pops a BLOCKING native error dialog and freezes the entire event
   * loop (renderer IPC, quit handling, everything). This fires in practice on
   * every startup failure: the host's {type:"error"} message consumes
   * startupReject, whose cleanup removes waitForReady's once("error")
   * listener, so the follow-up emit finds zero listeners. Latent on
   * Electron 31 / Node 20 (the child usually died before its IPC error
   * message was delivered, so only the safe 'exit' path ran); guaranteed on
   * Electron 43 / Node 24, which delivers the message reliably.
   */
  private emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    } else {
      console.error("[SessionHost] error (no listener):", err.message);
    }
  }

  /**
   * Build an error whose message includes the host's captured stderr tail.
   * The host subprocess prints the real cause of a startup failure (module
   * load errors, SyntaxErrors, init exceptions) to stderr, but the rejection
   * used to surface only a generic "exited with code 1 before ready". Folding
   * in the last few stderr lines makes the cause visible in the console.warn
   * the registry logs on fallback, and in the onPanelEvent host_fallback.
   */
  private diagnosticError(prefix: string): Error {
    const tail = this.stderrLog
      .filter((line) => !line.startsWith("[host stdout]"))
      .slice(-8)
      .join("\n  ");
    return tail ? new Error(`${prefix}\n  ${tail}`) : new Error(prefix);
  }

  /**
   * Build the rejection for a startup-time exit. Exit code 42 means the host
   * detected an under-minimum pi version (host.mjs MIN_PI_VERSION) and exited
   * deliberately. The host also sends a typed {type:"error", versionTooLow}
   * message, but that races the "exit" event — if exit wins, we must STILL
   * reject with HostVersionTooLowError so the registry shows the "update pi"
   * fallback wording rather than a generic crash message.
   */
  private startupExitError(code: number | null): Error {
    if (code === 42) {
      // Clean, user-facing message (no stderr tail): this is a deliberate
      // version gate, not a crash. The registry turns it into a toast.
      return new HostVersionTooLowError("Installed pi is too old for inline extension panels");
    }
    return this.diagnosticError(`Host process exited with code ${code} before ready`);
  }

  // ─── Message handling ──────────────────────────────────────────────────

  private handleMessage(msg: HostWireMessage) {
    switch (msg.type) {
      case "spawned": {
        // Ignore — just means the process started
        break;
      }

      case "ready": {
        this.ready = true;
        this.piVersion = msg.piVersion;
        if (this.startupTimer) {
          clearTimeout(this.startupTimer);
          this.startupTimer = null;
        }
        if (this.dialogTimer) {
          clearTimeout(this.dialogTimer);
          this.dialogTimer = null;
        }
        this.startupReject = null;
        this.emit("ready");
        break;
      }

      case "error": {
        // versionTooLow is a deliberate gate, not a crash: use the host's
        // clean message verbatim (no stderr tail) and a typed error so the
        // registry can craft the "update pi" fallback toast without
        // `any`-casting. Other errors fold in the stderr tail for diagnosis.
        const err = msg.versionTooLow
          ? new HostVersionTooLowError(msg.message ?? "Installed pi is too old for inline panels")
          : this.diagnosticError(msg.message ?? "Unknown host error");
        if (!this.ready && this.startupReject) {
          this.startupReject(err);
          this.startupReject = null;
        }
        this.emitError(err);
        break;
      }

      case "event": {
        this.emit("event", msg.event as PiEvent);
        break;
      }

      case "extension_ui_request": {
        // Pause the startup watchdog while a pre-ready dialog (the project-trust
        // prompt) is outstanding — it blocks on a human, not on a hang. Re-armed
        // in sendUiResponse once the answer is on its way back.
        if (!this.ready && this.startupTimer) {
          clearTimeout(this.startupTimer);
          this.startupTimer = null;
        }
        // W1: if the user never answers (closes the window, dialog errors, IPC
        // lost), sendUiResponse is never called and the startup watchdog was
        // just cleared above — waitForReady would hang forever. Arm a separate,
        // longer dialog-outstanding timer that rejects so the registry can fall
        // back to pi --mode rpc. Cleared in sendUiResponse (happy path) and in
        // the ready/error/exit paths.
        if (!this.ready && !this.dialogTimer) {
          this.dialogTimer = setTimeout(() => {
            this.dialogTimer = null;
            const err = new Error(
              "Host startup timed out waiting for a dialog response (trust prompt unanswered)",
            );
            if (this.startupReject) {
              this.startupReject(err);
              this.startupReject = null;
            }
          }, this.dialogTimeoutMs);
          this.dialogTimer.unref?.();
        }
        this.emit("uiRequest", msg as ExtensionUiRequest);
        break;
      }

      case "response": {
        const id = msg.id;
        if (id) {
          const pending = this.pending.get(id);
          if (pending) {
            if (pending.timer) clearTimeout(pending.timer);
            this.pending.delete(id);
            if (msg.success) {
              pending.resolve({ success: true, data: msg.data } as PiRpcResponse);
            } else {
              pending.reject(new Error(msg.error || "Host command failed"));
            }
            return;
          }
        }
        console.warn("[SessionHost] unmatched response", msg);
        break;
      }

      case "panel_open": {
        this.emit("panelOpen", msg.panelId, msg.overlay, msg.unified === true);
        break;
      }

      case "panel_data": {
        this.emit("panelData", msg.panelId, msg.data);
        break;
      }

      case "panel_close": {
        this.emit("panelClose", msg.panelId);
        break;
      }

      case "panel_mode": {
        this.emit("panelMode", msg.panelId, msg.mode);
        break;
      }

      case "panel_clear_all": {
        this.emit("panelClearAll");
        break;
      }

      case "unified_submit_request": {
        this.emit("unifiedSubmitRequest", msg.id, msg.text);
        break;
      }

      case "clipboard_read_image_request": {
        this.replyClipboardImage(msg.id);
        break;
      }

      // No default: the HostWireMessage union is exhaustive (every member is
      // a `case` above), so an unhandled wire type is a compile-time error
      // rather than a silent runtime drop. This is the whole point of the
      // tagged union — adding a new host message forces a handler here.
    }
  }

  /** Reply to a clipboard read image request from the host. */
  private replyClipboardImage(id: string): void {
    let bytes: string | undefined;
    let mimeType: string | undefined;
    try {
      // Lazy-require: a static `import { clipboard } from "electron"` would be
      // evaluated when this module is loaded by the SessionHost unit tests
      // (which run outside Electron), where `electron` has no `clipboard`.
      // Requiring at call time keeps the module import-safe in tests; the
      // clipboard path only runs inside the real Electron main process.
      const { clipboard } = require("electron");
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        // Prefer PNG; pi accepts PNG.
        const png = img.toPNG();
        bytes = png.toString("base64");
        mimeType = "image/png";
      }
      // else: clipboard is empty → reply with bytes: undefined
    } catch (err) {
      // On error, reply with bytes: undefined (fallback behavior)
      console.error("[SessionHost] Clipboard read error:", err);
    }
    this.sendToHost({
      type: "clipboard_read_image_response",
      id,
      bytes,
      mimeType,
    });
  }

  /** Send a unified submit response back to the host. */
  sendUnifiedSubmitResponse(id: string, ok: boolean, bailed?: boolean, error?: string): void {
    this.sendToHost({ type: "unified_submit_response", id, ok, bailed, error });
  }

  /** Send a message to the host child unless its IPC channel is already gone.
   *
   *  `ChildProcess.send` after the channel closes returns false AND emits an
   *  'error' event (no throw), which logs a noisy "channel closed" stack. These
   *  two callers (clipboard/submit replies) are best-effort responses to an
   *  async host request; if the host has already exited there is nothing to
   *  reply to, so drop silently rather than spamming the log. */
  private sendToHost(
    msg:
      | {
          type: "unified_submit_response";
          id: string;
          ok: boolean;
          bailed?: boolean | undefined;
          error?: string | undefined;
        }
      | {
          type: "clipboard_read_image_response";
          id: string;
          bytes?: string | undefined;
          mimeType?: string | undefined;
        }
      | { type: "dialog_response"; response: unknown }
      | { type: "panel_input"; panelId: number; data: string }
      | { type: "panel_resize"; panelId: number; cols: number; rows: number; force?: true }
      | { type: "panel_close_request"; panelId: number },
  ): void {
    if (this.proc.exitCode !== null || this.proc.killed || !this.proc.connected) return;
    try {
      this.proc.send(msg, () => {
        // Best-effort post-exit/channel-closed response; ignore async send errors.
      });
    } catch {
      /* channel closed between the check and the send — nothing to do */
    }
  }

  // ─── Public interface (same shape as PiProcess) ────────────────────────

  async sendCommand(
    command: PiRpcCommand,
    options: { uiSurface?: "composer" | "unified" | undefined } = {},
  ): Promise<PiRpcResponse> {
    const id = newRpcRequestId() as string;
    const timeoutMs = COMMAND_TIMEOUTS_MS[command.type] ?? 0;

    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Host command timeout for ${command.type} (id=${id})`));
            }, timeoutMs)
          : null;

      this.pending.set(id, { resolve, reject, timer });

      this.proc.send({ type: "command", id, command, uiSurface: options.uiSurface }, (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  sendUiResponse(responseJson: string): void {
    // The preload already produces a typed ExtensionUiResponse object; the
    // RPC path stringifies it for the JSONL wire. The host uses child-IPC
    // (structured clone), so we parse-then-restringify only to stay shape-
    // compatible with the RPC-mode `ExtensionUiResponse` the host expects.
    // `unknown` (not `any`) forces the type-checker to validate every access.
    let response: unknown;
    try {
      response = JSON.parse(responseJson);
    } catch {
      console.error("[SessionHost] Failed to parse UI response:", responseJson);
      return;
    }
    this.sendToHost({ type: "dialog_response", response });
    // The dialog was answered — clear the dialog-outstanding timer (W1) and
    // re-arm the startup watchdog so the host finishes coming up within
    // STARTUP_TIMEOUT_MS. If already ready, armStartupTimer is a no-op.
    if (this.dialogTimer) {
      clearTimeout(this.dialogTimer);
      this.dialogTimer = null;
    }
    this.armStartupTimer();
  }

  sendPanelInput(panelId: number, data: string): void {
    this.sendToHost({ type: "panel_input", panelId, data });
  }

  sendPanelResize(panelId: number, cols: number, rows: number, force = false): void {
    this.sendToHost({
      type: "panel_resize",
      panelId,
      cols,
      rows,
      ...(force ? { force: true } : {}),
    });
  }

  /** Force-close a custom panel from the UI (escape hatch). The host resolves
   *  the extension's custom() promise with undefined and tears it down. */
  sendPanelClose(panelId: number): void {
    this.sendToHost({ type: "panel_close_request", panelId });
  }

  private killTimer: ReturnType<typeof setTimeout> | null = null;

  stop(): void {
    if (this.killTimer) return;
    // Clear startup/dialog timers so a pending waitForReady doesn't fire its
    // timeout after an explicit stop (and so the timers don't leak).
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.dialogTimer) {
      clearTimeout(this.dialogTimer);
      this.dialogTimer = null;
    }
    this.proc.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      if (this.proc.exitCode === null && !this.proc.killed) {
        this.proc.kill("SIGKILL");
      }
    }, 3000);
    this.killTimer.unref?.();
    this.proc.once("exit", () => {
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

// Typed overloads for EventEmitter
export interface SessionHost {
  on(event: "event", listener: (event: PiEvent) => void): this;
  on(event: "uiRequest", listener: (req: ExtensionUiRequest) => void): this;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "ready", listener: () => void): this;
  on(
    event: "panelOpen",
    listener: (panelId: number, overlay: boolean, unified: boolean) => void,
  ): this;
  on(event: "panelData", listener: (panelId: number, data: string) => void): this;
  on(event: "panelClose", listener: (panelId: number) => void): this;
  on(event: "panelMode", listener: (panelId: number, mode: "content" | "viewport") => void): this;
  on(event: "panelClearAll", listener: () => void): this;
  on(event: "unifiedSubmitRequest", listener: (id: string, text: string) => void): this;
  emit(event: "event", data: PiEvent): boolean;
  emit(event: "uiRequest", data: ExtensionUiRequest): boolean;
  emit(event: "exit", code: number | null, signal: string | null): boolean;
  emit(event: "error", err: Error): boolean;
  emit(event: "ready"): boolean;
  emit(event: "panelOpen", panelId: number, overlay: boolean, unified: boolean): boolean;
  emit(event: "panelData", panelId: number, data: string): boolean;
  emit(event: "panelClose", panelId: number): boolean;
  emit(event: "panelMode", panelId: number, mode: "content" | "viewport"): boolean;
  emit(event: "panelClearAll"): boolean;
  emit(event: "unifiedSubmitRequest", id: string, text: string): boolean;
}
