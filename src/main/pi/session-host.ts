/**
 * SessionHost — Child-IPC wrapper around the SDK-host subprocess.
 *
 * Exposes the main-process EventEmitter bridge for one SDK host:
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
import { PiEventSchema } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import { ExtensionUiRequestSchema } from "@shared/pi-protocol/extension-ui.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";
import {
  type AgentSessionSnapshot,
  AgentSessionSnapshotSchema,
  type AuthorityAttachBaseline,
  AuthorityAttachBaselineSchema,
  type AuthorityFrame,
  AuthorityFrameSchema,
  type EscapeResult,
  HostEnvelopeSchema,
  type SessionSubmission,
  type SubmissionResult,
  SubmissionResultSchema,
  type TransitionBatch,
} from "@shared/pi-protocol/runtime-state.js";
import { z } from "zod";

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
 * ready/error/exit/timeout/panel/pending-queue lifecycle can be driven
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
// which rejectAllPending handles.
// prompt/compact block on user interaction / long-running summarisation;
// bash can run for minutes. The prior version used `COMMAND_NO_TIMEOUT` with
// a ternary that was always 0 — i.e. NO command ever timed out, including
// bash, so a hung bash command would leave its promise pending forever.
const LIFECYCLE_COMMANDS = new Set(["new_session", "switch_session", "fork"]);

const COMMAND_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  prompt: 0,
  compact: 60_000,
  bash: 600_000,
  new_session: 60_000,
  switch_session: 60_000,
  fork: 60_000,
  reload: 60_000,
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
const STARTUP_TIMEOUT_MS = 60_000;

/**
 * Runtime type guard for structural test doubles and the active SDK host.
 * Panel I/O uses a host-only method rather than `instanceof`, so the IPC layer
 * need not import the class and tests can supply a structural stand-in.
 */
export function isSessionHost(proc: unknown): proc is SessionHost {
  return typeof (proc as SessionHost | null)?.sendPanelInput === "function";
}

export interface RuntimeOwner {
  hostInstanceId: string;
  sessionEpoch: number;
}

export interface IntentReceipt {
  status: "admitted" | "duplicate" | "not_admitted" | "delivery_unknown";
  intentId: string;
  owner?: RuntimeOwner;
  reason?: "stale_owner" | "transport_unavailable" | "closing" | "transitioning" | "invalid";
}

interface PendingRequest {
  resolve: (res: PiRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  timerStartedAt: number;
  timeoutMessage: string;
  suspendForLifecycleUi: boolean;
}

export interface SessionHostEvents {
  event: (event: PiEvent) => void;
  uiRequest: (req: ExtensionUiRequest) => void;
  exit: (code: number | null, signal: string | null, diagnostic: Error) => void;
  error: (err: Error) => void;
  /** Panel events for custom() rendering */
  panelOpen: (
    panelId: number,
    overlay: boolean,
    unified: boolean,
    hostInstanceId: string,
    sessionEpoch: number,
    baseline?: { revision: number; repaintRequired: boolean },
  ) => void;
  panelData: (panelId: number, data: string) => void;
  panelRepaint: (panelId: number, revision: number) => void;
  panelClose: (panelId: number) => void;
  panelMode: (panelId: number, mode: "content" | "viewport") => void;
  panelClearAll: () => void;
  /** Unified TUI panel events */
  unifiedSubmitRequest: (id: string, text: string, editorRevision: number) => void;
  snapshot: (snapshot: AgentSessionSnapshot, full: boolean) => void;
  transitionBatch: (batch: TransitionBatch) => void;
  transitionStarted: (transitionId: string, provisionalEpoch: number) => void;
  transitionCancelled: (transitionId: string) => void;
  transportGap: (expected: number, received: number) => void;
  controlSilence: () => void;
  submissionDisposition: (result: SubmissionResult) => void;
  queueRestoration: (payload: unknown) => void;
  uiAcknowledged: (operationId: string) => void;
  lifecycleUiLease: (active: boolean) => void;
  rendererCancelled: (rendererGeneration: number) => void;
  /** Terminal child-owned intent outcomes; receipts never emit this event. */
  intentOutcome: (outcome: unknown) => void;
  /** Opaque validated child semantic commit; main does not reduce it. */
  authorityFrame: (frame: AuthorityFrame) => void;
  unresponsive: () => void;
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
  | {
      type: "control";
      hostInstanceId: string;
      sessionEpoch: number;
      transportSequence: number;
      payload:
        | { type: "spawned" }
        | { type: "ready"; piVersion?: string; snapshot: AgentSessionSnapshot }
        | { type: "snapshot"; snapshot: AgentSessionSnapshot; full?: boolean }
        | { type: "transition_batch"; batch: TransitionBatch }
        | { type: "error"; message: string; versionTooLow?: boolean };
    }
  | { type: "spawned" }
  | { type: "ready"; piVersion?: string }
  | { type: "error"; message?: string; versionTooLow?: boolean }
  | { type: "event"; event: PiEvent }
  | ExtensionUiRequest
  | { type: "response"; id: string; success: boolean; data?: unknown; error?: string }
  | {
      type: "panel_open";
      panelId: number;
      overlay: boolean;
      unified?: boolean;
      baseline?: { revision: number; repaintRequired: boolean };
    }
  | { type: "panel_data"; panelId: number; data: string }
  | { type: "panel_repaint"; panelId: number; revision: number }
  | { type: "panel_close"; panelId: number }
  | { type: "panel_mode"; panelId: number; mode: "content" | "viewport" }
  | { type: "panel_clear_all" }
  | { type: "unified_submit_request"; id: string; text: string; editorRevision: number }
  | { type: "clipboard_read_image_request"; id: string }
  | { type: "submission_disposition"; result: SubmissionResult }
  | { type: "intent_outcome"; outcome: unknown }
  | { type: "authority_frame"; frame: unknown }
  | { type: "queue_restoration"; restorationId: string; [key: string]: unknown }
  | { type: "ui_ack"; operationId: string }
  | { type: "renderer_cancelled"; rendererGeneration: number }
  | { type: "fatal_transition_error"; message: string };

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: typed EventEmitter
export class SessionHost extends EventEmitter {
  private proc: ChildProcess;
  private pending = new Map<string, PendingRequest>();
  public stderrLog: string[] = [];
  public readonly sessionFile?: string | undefined;
  private ready = false;
  public hostInstanceId?: string;
  public sessionEpoch = 0;
  private lastTransportSequence = 0;
  private lastControlAt = Date.now();
  private controlGeneration = 0;
  /** A gap makes every ordinary frame untrustworthy until our state request
   * receives an explicit, validated full snapshot. */
  private transportFenced = false;
  private resyncRequestIds = new Set<string>();
  private controlWatchdog: ReturnType<typeof setInterval> | null = null;
  private silenceResyncPending = false;
  private silenceUnavailableEmitted = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private startupReject: ((err: Error) => void) | null = null;
  /** Pre-ready dialogs/custom panels that causally block initial binding. */
  private startupUiBlockers = new Set<string>();
  /** Provisional lifecycle UI intentionally suspends control-silence probing
   * until it settles or the transition batch commits. */
  private transitionUiBlockers = new Set<string>();
  private transitionDialogOperations = new Map<string, string>();
  /**
   * Human-UI-outstanding timer: correlated startup UI pauses the short module
   * watchdog, but remains bounded if the renderer/user never closes it.
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
    /**
     * Optional descriptor pinned by a validated search open. It is inherited as
     * child fd 4 so SessionManager opens the validated inode, not a pathname
     * that may have changed during the renderer activation IPC gap.
     */
    confinedSessionDescriptor?: number,
    /** Windows hard-link alias to the descriptor-pinned inode. */
    confinedSessionAlias?: string,
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
      stdio:
        confinedSessionDescriptor === undefined
          ? ["pipe", "pipe", "pipe", "ipc"]
          : ["pipe", "pipe", "pipe", "ipc", confinedSessionDescriptor],
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
      if (this.controlWatchdog) {
        clearInterval(this.controlWatchdog);
        this.controlWatchdog = null;
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
      const diagnostic = this.diagnosticError(
        `Host process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
      );
      this.rejectAllPending(diagnostic);
      this.emit("exit", code, signal, diagnostic);
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
    if (sessionFile) {
      initMsg.sessionFile = confinedSessionAlias
        ? confinedSessionAlias
        : confinedSessionDescriptor === undefined
          ? sessionFile
          : process.platform === "linux"
            ? "/proc/self/fd/4"
            : "/dev/fd/4";
    }

    this.proc.send(initMsg);

    this.armStartupTimer();
    this.controlWatchdog = setInterval(() => {
      if (!this.ready || this.transitionUiBlockers.size > 0) return;
      const silentFor = Date.now() - this.lastControlAt;
      if (silentFor > 8_000) {
        this.emit("unresponsive");
        this.stop();
        return;
      }
      if (this.silenceResyncPending || silentFor <= 2_000) return;
      // Silence is not evidence of a missing transport sequence. Probe once;
      // only a missed correlated full-snapshot deadline makes the host
      // unavailable. Sequence discontinuities are handled separately.
      this.silenceResyncPending = true;
      const probeControlGeneration = this.controlGeneration;
      void this.requestSnapshot()
        .catch(() => {
          if (probeControlGeneration !== this.controlGeneration) return;
          if (!this.silenceUnavailableEmitted) {
            this.silenceUnavailableEmitted = true;
            this.emit("controlSilence");
          }
        })
        .finally(() => {
          this.silenceResyncPending = false;
        });
    }, 500);
    this.controlWatchdog.unref?.();
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
  private armPendingTimeout(id: string, pending: PendingRequest): void {
    if (pending.remainingMs <= 0) {
      this.pending.delete(id);
      this.resyncRequestIds.delete(id);
      pending.reject(new Error(pending.timeoutMessage));
      return;
    }
    pending.timerStartedAt = Date.now();
    pending.timer = setTimeout(() => {
      pending.timer = null;
      this.pending.delete(id);
      this.resyncRequestIds.delete(id);
      pending.reject(new Error(pending.timeoutMessage));
    }, pending.remainingMs);
    pending.timer.unref?.();
  }

  private suspendLifecycleRequestTimers(): void {
    const now = Date.now();
    for (const pending of this.pending.values()) {
      if (!pending.suspendForLifecycleUi || !pending.timer) continue;
      clearTimeout(pending.timer);
      pending.timer = null;
      pending.remainingMs = Math.max(0, pending.remainingMs - (now - pending.timerStartedAt));
    }
  }

  private resumeLifecycleRequestTimers(): void {
    for (const [id, pending] of this.pending) {
      if (!pending.suspendForLifecycleUi || pending.timer) continue;
      this.armPendingTimeout(id, pending);
    }
  }

  private addTransitionUiBlocker(key: string): void {
    const wasEmpty = this.transitionUiBlockers.size === 0;
    this.transitionUiBlockers.add(key);
    if (wasEmpty) {
      this.suspendLifecycleRequestTimers();
      this.emit("lifecycleUiLease", true);
    }
  }

  private removeTransitionUiBlocker(key: string): void {
    if (!this.transitionUiBlockers.delete(key)) return;
    if (key.startsWith("dialog:")) this.transitionDialogOperations.delete(key.slice(7));
    if (this.transitionUiBlockers.size === 0) {
      this.resumeLifecycleRequestTimers();
      this.emit("lifecycleUiLease", false);
    }
  }

  private clearTransitionUiBlockers(): void {
    if (this.transitionUiBlockers.size === 0) return;
    this.transitionUiBlockers.clear();
    this.transitionDialogOperations.clear();
    this.resumeLifecycleRequestTimers();
    this.emit("lifecycleUiLease", false);
  }

  private pauseStartupForUi(key: string): void {
    if (this.ready) return;
    this.startupUiBlockers.add(key);
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.dialogTimer) return;
    this.dialogTimer = setTimeout(() => {
      this.dialogTimer = null;
      const err = new Error("Host startup timed out waiting for a dialog or custom panel");
      if (this.startupReject) {
        this.startupReject(err);
        this.startupReject = null;
      }
    }, this.dialogTimeoutMs);
    this.dialogTimer.unref?.();
  }

  private resumeStartupAfterUi(key: string): void {
    this.startupUiBlockers.delete(key);
    if (this.ready || this.startupUiBlockers.size > 0) return;
    if (this.dialogTimer) {
      clearTimeout(this.dialogTimer);
      this.dialogTimer = null;
    }
    this.armStartupTimer();
  }

  private armStartupTimer(): void {
    if (this.startupUiBlockers.size > 0) return;
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
   * the registry reports when activation fails.
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
   * reject with HostVersionTooLowError so the registry can show an actionable
   * compatibility message rather than a generic crash message.
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

  private handleMessage(raw: unknown): void {
    const root = z.object({ type: z.string() }).safeParse(raw);
    if (!root.success) return;
    const msg = raw as HostWireMessage;
    const meta = raw as Record<string, unknown>;
    const hasEnvelopeFields =
      typeof meta.hostInstanceId === "string" &&
      typeof meta.sessionEpoch === "number" &&
      typeof meta.transportSequence === "number";

    if (hasEnvelopeFields) {
      // Control envelopes carry state and transitions, and are the only frames
      // that can repair a transport fence. Parse before reading any nested
      // identity/epoch fields.
      if (msg.type === "control") {
        const envelope = HostEnvelopeSchema.safeParse(raw);
        if (!envelope.success) {
          this.emitError(new Error(`Invalid host envelope: ${envelope.error.message}`));
          return;
        }
        const value = envelope.data;
        if (this.hostInstanceId && value.hostInstanceId !== this.hostInstanceId) return;
        const expected = this.lastTransportSequence + 1;
        if (this.lastTransportSequence > 0 && value.transportSequence !== expected) {
          if (value.transportSequence <= this.lastTransportSequence) return;
          this.lastTransportSequence = value.transportSequence;
          this.transportFenced = true;
          this.emit("transportGap", expected, value.transportSequence);
          void this.requestSnapshot().catch(() => {});
          return;
        }
        if (
          this.transportFenced &&
          !(value.payload.type === "snapshot" && value.payload.full === true)
        ) {
          this.lastTransportSequence = value.transportSequence;
          return;
        }
        this.hostInstanceId ??= value.hostInstanceId;
        this.sessionEpoch = value.sessionEpoch;
        this.lastTransportSequence = value.transportSequence;
        this.lastControlAt = Date.now();
        this.controlGeneration++;
        this.silenceUnavailableEmitted = false;
        if (this.transportFenced) this.transportFenced = false;
      } else {
        // Non-control frames still must be structurally valid before dispatch.
        const base = z
          .object({
            hostInstanceId: z.string().uuid(),
            sessionEpoch: z.number().int().nonnegative(),
            transportSequence: z.number().int().positive(),
          })
          .safeParse(raw);
        if (!base.success) return;
        if (this.hostInstanceId && base.data.hostInstanceId !== this.hostInstanceId) return;
        if (this.transportFenced) {
          // The sole exception is the response matching the state request that
          // was made to repair the fence. It is parsed in the response branch.
          if (
            msg.type !== "response" ||
            typeof meta.id !== "string" ||
            !this.resyncRequestIds.has(meta.id)
          )
            return;
        }
        const expected = this.lastTransportSequence + 1;
        if (this.lastTransportSequence > 0 && base.data.transportSequence !== expected) {
          if (base.data.transportSequence <= this.lastTransportSequence) return;
          this.lastTransportSequence = base.data.transportSequence;
          this.transportFenced = true;
          this.emit("transportGap", expected, base.data.transportSequence);
          void this.requestSnapshot().catch(() => {});
          return;
        }
        this.hostInstanceId ??= base.data.hostInstanceId;
        this.lastTransportSequence = base.data.transportSequence;
      }
    }

    switch (msg.type) {
      case "control": {
        const parsedEnvelope = HostEnvelopeSchema.safeParse(raw);
        if (!parsedEnvelope.success) return;
        const { payload, hostInstanceId } = parsedEnvelope.data;
        if (payload.type === "spawned") break;
        if (payload.type === "transition_started") {
          this.emit("transitionStarted", payload.transitionId, payload.provisionalEpoch);
          break;
        }
        if (payload.type === "transition_cancelled") {
          this.emit("transitionCancelled", payload.transitionId);
          break;
        }
        if (payload.type === "ready") {
          this.ready = true;
          this.piVersion = payload.piVersion;
          this.clearTransitionUiBlockers();
          this.emit("transitionBatch", {
            transitionId: `initial-${hostInstanceId}`,
            provisionalEpoch: payload.snapshot.sessionEpoch,
            records: payload.records,
            terminalSnapshot: payload.snapshot,
          });
          if (this.startupTimer) clearTimeout(this.startupTimer);
          this.startupTimer = null;
          this.startupReject = null;
          this.emit("ready");
          break;
        }
        if (payload.type === "snapshot") {
          this.sessionEpoch = payload.snapshot.sessionEpoch;
          this.emit("snapshot", payload.snapshot, payload.full === true);
          break;
        }
        if (payload.type === "transition_batch") {
          this.clearTransitionUiBlockers();
          this.sessionEpoch = payload.batch.provisionalEpoch;
          this.emit("transitionBatch", payload.batch);
          break;
        }
        const err = payload.versionTooLow
          ? new HostVersionTooLowError(payload.message)
          : this.diagnosticError(payload.message);
        if (!this.ready && this.startupReject) {
          this.startupReject(err);
          this.startupReject = null;
        }
        this.emitError(err);
        break;
      }

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
        this.startupUiBlockers.clear();
        this.clearTransitionUiBlockers();
        this.startupReject = null;
        this.emit("ready");
        break;
      }

      case "error": {
        // versionTooLow is a deliberate gate, not a crash: use the host's
        // clean message verbatim (no stderr tail) and a typed error so the
        // registry can craft the update-pi compatibility toast without
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
        const parsed = PiEventSchema.safeParse(msg.event);
        if (parsed.success) this.emit("event", parsed.data);
        break;
      }

      case "extension_ui_request": {
        const request = ExtensionUiRequestSchema.safeParse(msg);
        if (!request.success) return;
        if (["select", "confirm", "input", "editor"].includes(request.data.method)) {
          const key = `dialog:${request.data.id}`;
          this.pauseStartupForUi(key);
          if (typeof meta.provisionalEpoch === "number") {
            this.transitionDialogOperations.set(
              request.data.id,
              request.data.operationId ?? request.data.id,
            );
            this.addTransitionUiBlocker(key);
          }
        }
        this.emit("uiRequest", request.data);
        break;
      }

      case "response": {
        const response = z
          .object({
            id: z.string(),
            success: z.boolean(),
            data: z.unknown().optional(),
            error: z.string().optional(),
          })
          .safeParse(msg);
        if (!response.success) return;
        const { id } = response.data;
        const pending = this.pending.get(id);
        if (pending) {
          const isResync = this.resyncRequestIds.has(id);
          if (
            String(meta.hostInstanceId) !== this.hostInstanceId ||
            (!isResync && Number(meta.sessionEpoch) !== this.sessionEpoch)
          ) {
            if (pending.timer) clearTimeout(pending.timer);
            this.pending.delete(id);
            this.resyncRequestIds.delete(id);
            pending.reject(new Error("Command response runtime identity mismatch"));
            return;
          }
          if (isResync) {
            const snapshot = AgentSessionSnapshotSchema.safeParse(response.data.data);
            if (
              response.data.success !== true ||
              !snapshot.success ||
              snapshot.data.hostInstanceId !== this.hostInstanceId ||
              snapshot.data.sessionEpoch !== Number(meta.sessionEpoch)
            ) {
              pending.reject(new Error("Invalid correlated full snapshot response"));
              this.pending.delete(id);
              this.resyncRequestIds.delete(id);
              return;
            }
            this.transportFenced = false;
            this.sessionEpoch = snapshot.data.sessionEpoch;
            this.lastControlAt = Date.now();
            this.controlGeneration++;
            this.silenceUnavailableEmitted = false;
          }
          if (pending.timer) clearTimeout(pending.timer);
          this.pending.delete(id);
          this.resyncRequestIds.delete(id);
          pending.resolve({
            type: "response",
            command: "host",
            id,
            success: response.data.success,
            data: response.data.data,
            error: response.data.error,
          } as PiRpcResponse);
          return;
        }
        break;
      }

      case "panel_open": {
        const key = `panel:${msg.panelId}`;
        this.pauseStartupForUi(key);
        if (typeof meta.provisionalEpoch === "number") this.addTransitionUiBlocker(key);
        this.emit(
          "panelOpen",
          msg.panelId,
          msg.overlay,
          msg.unified === true,
          String(meta.hostInstanceId),
          Number(meta.sessionEpoch),
          msg.baseline,
        );
        break;
      }

      case "panel_data": {
        this.emit("panelData", msg.panelId, msg.data);
        break;
      }

      case "panel_repaint": {
        this.emit("panelRepaint", msg.panelId, msg.revision);
        break;
      }

      case "panel_close": {
        this.removeTransitionUiBlocker(`panel:${msg.panelId}`);
        this.resumeStartupAfterUi(`panel:${msg.panelId}`);
        this.emit("panelClose", msg.panelId);
        break;
      }

      case "panel_mode": {
        this.emit("panelMode", msg.panelId, msg.mode);
        break;
      }

      case "panel_clear_all": {
        for (const key of [...this.transitionUiBlockers]) {
          if (key.startsWith("panel:")) this.removeTransitionUiBlocker(key);
        }
        for (const key of [...this.startupUiBlockers]) {
          if (key.startsWith("panel:")) this.resumeStartupAfterUi(key);
        }
        this.emit("panelClearAll");
        break;
      }

      case "unified_submit_request": {
        this.emit("unifiedSubmitRequest", msg.id, msg.text, msg.editorRevision);
        break;
      }

      case "clipboard_read_image_request": {
        this.replyClipboardImage(msg.id);
        break;
      }

      case "submission_disposition": {
        const result = SubmissionResultSchema.safeParse(msg.result);
        if (
          result.success &&
          result.data.hostInstanceId === this.hostInstanceId &&
          result.data.sessionEpoch === this.sessionEpoch
        ) {
          this.emit("submissionDisposition", result.data);
        }
        break;
      }

      case "intent_outcome": {
        // This is intentionally opaque at the compatibility boundary. The
        // child semantic frame/journal owns its meaning and terminal state.
        this.emit("intentOutcome", msg.outcome);
        break;
      }

      case "authority_frame": {
        const frame = AuthorityFrameSchema.safeParse(msg.frame);
        if (!frame.success) {
          this.emitError(new Error(`Invalid authority frame: ${frame.error.message}`));
          return;
        }
        if (
          frame.data.owner.hostInstanceId !== this.hostInstanceId ||
          frame.data.owner.sessionEpoch !== this.sessionEpoch
        ) {
          return;
        }
        this.emit("authorityFrame", frame.data);
        break;
      }

      case "queue_restoration": {
        this.emit("queueRestoration", msg);
        break;
      }

      case "ui_ack": {
        let acknowledgedDialogId = msg.operationId;
        for (const [dialogId, operationId] of this.transitionDialogOperations) {
          if (operationId === msg.operationId) {
            acknowledgedDialogId = dialogId;
            this.removeTransitionUiBlocker(`dialog:${dialogId}`);
            break;
          }
        }
        this.resumeStartupAfterUi(`dialog:${acknowledgedDialogId}`);
        this.emit("uiAcknowledged", msg.operationId);
        break;
      }

      case "renderer_cancelled": {
        const cancelled = z
          .object({ rendererGeneration: z.number().int().nonnegative() })
          .safeParse(msg);
        if (cancelled.success) this.emit("rendererCancelled", cancelled.data.rendererGeneration);
        break;
      }

      case "fatal_transition_error": {
        this.emitError(new Error(msg.message));
        this.stop();
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
      | { type: "interrupt" }
      | { type: "panel_resize"; panelId: number; cols: number; rows: number; force?: true }
      | { type: "panel_close_request"; panelId: number; operationId: string },
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

  // ─── Public SDK-host interface ─────────────────────────────────────────

  async sendCommand(
    command: PiRpcCommand,
    options: {
      uiSurface?: "composer" | "unified" | undefined;
      /** Called only after Node confirms the command crossed child IPC. */
      onDispatched?: (() => void) | undefined;
    } = {},
  ): Promise<PiRpcResponse> {
    const id = newRpcRequestId() as string;
    const timeoutMs = COMMAND_TIMEOUTS_MS[command.type] ?? 0;

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: null,
        remainingMs: timeoutMs,
        timerStartedAt: Date.now(),
        timeoutMessage: `Host command timeout for ${command.type} (id=${id})`,
        suspendForLifecycleUi: LIFECYCLE_COMMANDS.has(command.type),
      };
      this.pending.set(id, pending);
      if (timeoutMs > 0 && !(pending.suspendForLifecycleUi && this.transitionUiBlockers.size > 0)) {
        this.armPendingTimeout(id, pending);
      }

      try {
        this.proc.send({ type: "command", id, command, uiSurface: options.uiSurface }, (err) => {
          if (err) {
            if (pending.timer) clearTimeout(pending.timer);
            this.pending.delete(id);
            reject(err);
            return;
          }
          options.onDispatched?.();
        });
      } catch (error) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private requestHost(
    payload: Record<string, unknown>,
    timeoutMs = 2_000,
    correlatedResync = false,
    suspendForLifecycleUi = false,
  ): Promise<PiRpcResponse> {
    const id = newRpcRequestId() as string;
    if (correlatedResync) this.resyncRequestIds.add(id);
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: null,
        remainingMs: timeoutMs,
        timerStartedAt: Date.now(),
        timeoutMessage: `Host request timeout for ${String(payload["type"])} (id=${id})`,
        suspendForLifecycleUi,
      };
      this.pending.set(id, pending);
      if (!(suspendForLifecycleUi && this.transitionUiBlockers.size > 0)) {
        this.armPendingTimeout(id, pending);
      }
      this.proc.send({ ...payload, id }, (err) => {
        if (!err) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        this.resyncRequestIds.delete(id);
        reject(err);
      });
    });
  }

  async dispatchIntent(envelope: {
    intentId: string;
    expectedOwner: RuntimeOwner;
    observedCursor?: unknown;
    intent: Record<string, unknown>;
  }): Promise<IntentReceipt> {
    try {
      const response = await this.requestHost({ type: "dispatch_intent", envelope }, 10_000);
      if (!response.success || !response.data || typeof response.data !== "object") {
        return {
          status: "delivery_unknown",
          intentId: envelope.intentId,
          owner: envelope.expectedOwner,
        };
      }
      const receipt = response.data as Partial<IntentReceipt>;
      if (
        !["admitted", "duplicate", "not_admitted", "delivery_unknown"].includes(
          String(receipt.status),
        ) ||
        receipt.intentId !== envelope.intentId
      ) {
        return {
          status: "delivery_unknown",
          intentId: envelope.intentId,
          owner: envelope.expectedOwner,
        };
      }
      return receipt as IntentReceipt;
    } catch {
      // The child may have received the message before this process observed
      // transport loss. Do not retry it or infer completion on this path.
      return {
        status: "delivery_unknown",
        intentId: envelope.intentId,
        owner: envelope.expectedOwner,
      };
    }
  }

  async submit(submission: SessionSubmission): Promise<SubmissionResult> {
    const response = await this.requestHost({ type: "submit", submission }, 10_000);
    if (!response.success || !response.data) throw new Error(response.error ?? "Submission failed");
    return response.data as SubmissionResult;
  }

  async escape(requestId: string): Promise<EscapeResult> {
    const response = await this.requestHost({ type: "escape", requestId });
    if (!response.success || !response.data) throw new Error(response.error ?? "Escape failed");
    return response.data as EscapeResult;
  }

  async requestAuthorityAttach(rendererGeneration: number): Promise<AuthorityAttachBaseline> {
    const response = await this.requestHost(
      { type: "authority_attach", rendererGeneration },
      10_000,
    );
    if (!response.success || !response.data) {
      throw new Error(response.error ?? "Authority attach failed");
    }
    const baseline = AuthorityAttachBaselineSchema.safeParse(response.data);
    if (!baseline.success)
      throw new Error(`Invalid authority attach baseline: ${baseline.error.message}`);
    if (
      baseline.data.owner.hostInstanceId !== this.hostInstanceId ||
      baseline.data.owner.sessionEpoch !== this.sessionEpoch
    ) {
      throw new Error("Authority attach baseline runtime identity mismatch");
    }
    return baseline.data;
  }

  async requestSnapshot(): Promise<AgentSessionSnapshot> {
    const response = await this.requestHost({ type: "state_request" }, 2_000, true);
    if (!response.success || !response.data) throw new Error(response.error ?? "Snapshot failed");
    const snapshot = AgentSessionSnapshotSchema.safeParse(response.data);
    if (!snapshot.success) throw new Error(`Invalid snapshot response: ${snapshot.error.message}`);
    if (this.hostInstanceId && snapshot.data.hostInstanceId !== this.hostInstanceId)
      throw new Error("Snapshot host identity mismatch");
    if (snapshot.data.sessionEpoch !== this.sessionEpoch)
      throw new Error("Snapshot epoch mismatch");
    return snapshot.data;
  }

  async prepareClose(force = false): Promise<Record<string, unknown>> {
    const response = await this.requestHost({ type: "prepare_close", force }, 5_000);
    if (!response.success || !response.data) {
      throw new Error(response.error ?? "Host close preparation failed");
    }
    return response.data as Record<string, unknown>;
  }

  async confirmClose(token: string): Promise<{ valid: boolean; mutationSequence?: number }> {
    const response = await this.requestHost({ type: "confirm_close", token }, 5_000);
    if (!response.success || !response.data) {
      throw new Error(response.error ?? "Host close confirmation failed");
    }
    return response.data as { valid: boolean; mutationSequence?: number };
  }

  async cancelClose(token: string): Promise<boolean> {
    const response = await this.requestHost({ type: "cancel_close", token }, 5_000);
    if (!response.success || !response.data) {
      throw new Error(response.error ?? "Host close cancellation failed");
    }
    return (response.data as { cancelled?: boolean }).cancelled === true;
  }

  async reloadInPlace(): Promise<void> {
    const response = await this.requestHost({ type: "reload" }, 60_000, false, true);
    if (!response.success) throw new Error(response.error ?? "Reload failed");
  }

  sendRendererDetached(rendererGeneration: number): void {
    if (!this.proc.connected) return;
    this.proc.send({ type: "renderer_detached", rendererGeneration });
  }

  sendEditorPatch(patch: {
    baseRevision: number;
    revision: number;
    text: string;
    attachments: unknown[];
    alternateConflictText?: string;
    alternateConflictAttachments?: unknown[];
    additionalConflictCandidates?: Array<{ text: string; attachments: unknown[] }>;
  }): Promise<PiRpcResponse> {
    return this.requestHost({ type: "editor_patch", patch });
  }

  acknowledgeRestoration(restorationId: string): void {
    if (!this.proc.connected) return;
    this.proc.send({ type: "restoration_ack", restorationId });
  }

  sendUiResponse(responseJson: string): void {
    // Preload provides the typed response as JSON while the direct SDK host
    // uses child-IPC structured clone, so decode it at this boundary.
    // `unknown` (not `any`) forces the type-checker to validate every access.
    let response: unknown;
    try {
      response = JSON.parse(responseJson);
    } catch {
      console.error("[SessionHost] Failed to parse UI response:", responseJson);
      return;
    }
    this.sendToHost({ type: "dialog_response", response });
    // The host owns the acknowledgement boundary. Its correlated `ui_ack`
    // resumes lifecycle/startup leases only after it has processed the reply.
  }

  sendInterrupt(): void {
    this.sendToHost({ type: "interrupt" });
  }

  sendPanelInput(
    panelId: number,
    revision: number,
    sequence: number,
    data: string,
  ): Promise<{
    acknowledgedThrough: number;
    gap?: { expected: number; received: number };
    repaintRequired?: { revision: number; repaintRequired: boolean };
  }>;
  /** @deprecated Compatibility seam for older structural host tests. */
  sendPanelInput(
    panelId: number,
    sequence: number,
    data: string,
  ): Promise<{ acknowledgedThrough: number; gap?: { expected: number; received: number } }>;
  sendPanelInput(
    panelId: number,
    revisionOrSequence: number,
    sequenceOrData: number | string,
    data?: string,
  ): Promise<{
    acknowledgedThrough: number;
    gap?: { expected: number; received: number };
    repaintRequired?: { revision: number; repaintRequired: boolean };
  }> {
    const revision = data === undefined ? undefined : revisionOrSequence;
    const sequence = data === undefined ? revisionOrSequence : (sequenceOrData as number);
    const input = data === undefined ? (sequenceOrData as string) : data;
    return this.requestHost({ type: "panel_input", panelId, revision, sequence, data: input }).then(
      (response) => {
        if (!response.success || !response.data) {
          throw new Error(response.error ?? "Panel input was not acknowledged");
        }
        return response.data as {
          acknowledgedThrough: number;
          gap?: { expected: number; received: number };
          repaintRequired?: { revision: number; repaintRequired: boolean };
        };
      },
    );
  }

  acknowledgePanelRepaint(panelId: number, revision: number): Promise<boolean> {
    return this.requestHost({ type: "panel_repaint_ack", panelId, revision }).then((response) =>
      Boolean(
        response.success && (response.data as { acknowledged?: boolean } | undefined)?.acknowledged,
      ),
    );
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
  sendPanelClose(panelId: number, operationId: string): void {
    this.sendToHost({ type: "panel_close_request", panelId, operationId });
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
      // child.killed only means a signal was sent, not that the process exited.
      // Escalate whenever the child still has neither an exit code nor an exit
      // signal after the grace period.
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
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
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null, diagnostic: Error) => void,
  ): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "ready", listener: () => void): this;
  on(
    event: "panelOpen",
    listener: (
      panelId: number,
      overlay: boolean,
      unified: boolean,
      hostInstanceId: string,
      sessionEpoch: number,
      baseline?: { revision: number; repaintRequired: boolean },
    ) => void,
  ): this;
  on(event: "panelData", listener: (panelId: number, data: string) => void): this;
  on(event: "panelRepaint", listener: (panelId: number, revision: number) => void): this;
  on(event: "panelClose", listener: (panelId: number) => void): this;
  on(event: "panelMode", listener: (panelId: number, mode: "content" | "viewport") => void): this;
  on(event: "panelClearAll", listener: () => void): this;
  on(
    event: "unifiedSubmitRequest",
    listener: (id: string, text: string, editorRevision: number) => void,
  ): this;
  on(event: "snapshot", listener: (snapshot: AgentSessionSnapshot, full: boolean) => void): this;
  on(event: "transitionBatch", listener: (batch: TransitionBatch) => void): this;
  on(
    event: "transitionStarted",
    listener: (transitionId: string, provisionalEpoch: number) => void,
  ): this;
  on(event: "transitionCancelled", listener: (transitionId: string) => void): this;
  on(event: "transportGap", listener: (expected: number, received: number) => void): this;
  on(event: "controlSilence", listener: () => void): this;
  on(event: "submissionDisposition", listener: (result: SubmissionResult) => void): this;
  on(event: "intentOutcome", listener: (outcome: unknown) => void): this;
  on(event: "authorityFrame", listener: (frame: AuthorityFrame) => void): this;
  on(event: "queueRestoration", listener: (payload: unknown) => void): this;
  on(event: "uiAcknowledged", listener: (operationId: string) => void): this;
  on(event: "lifecycleUiLease", listener: (active: boolean) => void): this;
  on(event: "rendererCancelled", listener: (rendererGeneration: number) => void): this;
  on(event: "unresponsive", listener: () => void): this;
  emit(event: "event", data: PiEvent): boolean;
  emit(event: "uiRequest", data: ExtensionUiRequest): boolean;
  emit(event: "exit", code: number | null, signal: string | null, diagnostic: Error): boolean;
  emit(event: "error", err: Error): boolean;
  emit(event: "ready"): boolean;
  emit(
    event: "panelOpen",
    panelId: number,
    overlay: boolean,
    unified: boolean,
    hostInstanceId: string,
    sessionEpoch: number,
    baseline?: { revision: number; repaintRequired: boolean },
  ): boolean;
  emit(event: "panelData", panelId: number, data: string): boolean;
  emit(event: "panelRepaint", panelId: number, revision: number): boolean;
  emit(event: "panelClose", panelId: number): boolean;
  emit(event: "panelMode", panelId: number, mode: "content" | "viewport"): boolean;
  emit(event: "panelClearAll"): boolean;
  emit(event: "unifiedSubmitRequest", id: string, text: string, editorRevision: number): boolean;
  emit(event: "snapshot", snapshot: AgentSessionSnapshot, full: boolean): boolean;
  emit(event: "transitionBatch", batch: TransitionBatch): boolean;
  emit(event: "transitionStarted", transitionId: string, provisionalEpoch: number): boolean;
  emit(event: "transitionCancelled", transitionId: string): boolean;
  emit(event: "transportGap", expected: number, received: number): boolean;
  emit(event: "controlSilence"): boolean;
  emit(event: "submissionDisposition", result: SubmissionResult): boolean;
  emit(event: "intentOutcome", outcome: unknown): boolean;
  emit(event: "authorityFrame", frame: AuthorityFrame): boolean;
  emit(event: "queueRestoration", payload: unknown): boolean;
  emit(event: "uiAcknowledged", operationId: string): boolean;
  emit(event: "lifecycleUiLease", active: boolean): boolean;
  emit(event: "rendererCancelled", rendererGeneration: number): boolean;
  emit(event: "unresponsive"): boolean;
}
