import * as crypto from "node:crypto";
/**
 * FakeHostProcess — a test double for the ChildProcess that
 * `SessionHost` (via child_process.fork) creates. Drives the host wire protocol
 * deterministically without forking a real `host.mjs` (which needs a real pi
 * install and is slow/flaky).
 *
 * Wire protocol (host → main), mirrored from `host.mjs`:
 *   { type: "spawned" }                                 // alive signal
 *   { type: "ready", piVersion? }                        // init complete
 *   { type: "error", message?, versionTooLow? }          // init failed
 *   { type: "event", event }                             // forwarded AgentSessionEvent
 *   { type: "extension_ui_request", ... }                // dialog/notify/etc
 *   { type: "response", id, success, data?, error? }     // command response
 *   { type: "panel_open", panelId, overlay }
 *   { type: "panel_data", panelId, data }
 *   { type: "panel_close", panelId }
 *   { type: "panel_clear_all" }
 *
 * Wire protocol (main → host):
 *   { type: "init", piPath, cwd, sessionFile? }
 *   { type: "command", id, command }
 *   { type: "dialog_response", response }
 *   { type: "interrupt" }
 *   { type: "panel_input", panelId, data }
 *   { type: "panel_resize", panelId, cols, rows }
 *   { type: "panel_close_request", panelId }
 *
 * A test asserts against the messages it receives (via `.sent`) and emits host
 * messages by calling `.emitMessage(...)`. `.kill()` records the signal so a
 * test can assert teardown. `.stdout`/`.stderr` are EventEmitters so stderr-tail
 * error folding can be exercised.
 *
 * Install via the SessionHost test seam (see session-host.test.ts).
 */
import { EventEmitter } from "node:events";

export class FakeHostProcess extends EventEmitter {
  /** Messages received from main (via `.send`). @type {any[]} */
  sent = [];
  /** True after kill() is called. */
  killed = false;
  /** Set on exit(); tests can read for assertion. */
  exitCode = null;
  /** Signal passed to kill(). */
  killSignal = undefined;
  pid = 42_000 + Math.floor(Math.random() * 1000);
  /**
   * Mirrors the REAL host: handleCommand is unset until handleInit finishes,
   * so commands that arrive before `ready` are bounced with "Not initialized"
   * (host.mjs:340). Flipped true by emitReady(). Without this, the fake was too
   * cooperative — it silently buffered pre-init commands, so it never
   * reproduced the "Not initialized" failure the real host emits when the
   * registry routes a command to a host mid-handshake (P1-i).
   */
  initialized = false;

  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new EventEmitter();
  connected = true;
  hostInstanceId = crypto.randomUUID();
  transportSequence = 0;
  sessionEpoch = 0;
  snapshotSequence = 0;
  editor = { revision: 0, text: "", attachments: [] };
  beforeEditorPatch = undefined;
  autoRespondToStateRequests = true;
  runtime = {
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    retryAttempt: 0,
    isBashRunning: false,
  };

  snapshot() {
    return {
      hostInstanceId: this.hostInstanceId,
      sessionEpoch: this.sessionEpoch,
      snapshotSequence: ++this.snapshotSequence,
      capturedAt: Date.now(),
      ...this.runtime,
      model: { id: "fake-model", provider: "fake" },
      thinkingLevel: "off",
      sessionId: "fake-session",
      pendingMessageCount: 0,
      steering: [],
      followUp: [],
      hostFacts: {
        submitting: false,
        actualCompaction: false,
        navigation: false,
        pendingDialogs: 0,
        custodyCount: 0,
      },
      catalog: {
        notifications: [],
        statuses: {},
        widgets: {},
        toolsExpanded: false,
        capabilityDiagnostics: [],
      },
      editor: structuredClone(this.editor),
    };
  }

  emitWire(msg) {
    this.emitMessage({
      ...msg,
      hostInstanceId: this.hostInstanceId,
      sessionEpoch: this.sessionEpoch,
      transportSequence: ++this.transportSequence,
    });
  }

  emitControl(payload) {
    this.emitWire({ type: "control", payload });
  }

  /** Main → host message. Records it (tests assert on `.sent`) and emits "message". */
  send(msg, cb) {
    // Faithful to a real ChildProcess: once the process exits, the IPC channel
    // is closed and `.send()` errors (ERR_IPC_CHANNEL_CLOSED). SessionHost's
    // send-callback rejects the pending command on that error — so a command
    // dispatched after the host dies fails fast instead of hanging.
    if (!this.connected) {
      if (typeof cb === "function") {
        queueMicrotask(() => cb(new Error("Host process IPC channel closed")));
      }
      return false;
    }
    this.sent.push(msg);
    this.emit("message", msg);
    // Faithful to host.mjs:340 — a command received before init completes is
    // rejected with "Not initialized". A correct registry never lets this
    // happen (it queues until the proc is ready); this guard turns a routing
    // regression into a visible test failure instead of a silent buffer.
    if (msg?.type === "command" && !this.initialized) {
      queueMicrotask(() => {
        this.emitWire({ type: "response", id: msg.id, success: false, error: "Not initialized" });
      });
    } else if (
      msg?.type === "state_request" &&
      this.initialized &&
      this.autoRespondToStateRequests
    ) {
      queueMicrotask(() => {
        this.emitControl({ type: "snapshot", snapshot: this.snapshot(), full: true });
        this.emitWire({ type: "response", id: msg.id, success: true, data: this.snapshot() });
      });
    } else if (msg?.type === "lifecycle_permit" && this.initialized) {
      queueMicrotask(() => {
        const allowed =
          this.runtime.isIdle === true &&
          this.runtime.isStreaming !== true &&
          this.runtime.isCompacting !== true &&
          this.runtime.isRetrying !== true &&
          this.runtime.isBashRunning !== true &&
          (msg.operation !== "activation_visit_release" ||
            (this.editor.text === "" && this.editor.attachments.length === 0));
        this.emitWire({
          type: "response",
          id: msg.id,
          success: true,
          data: { allowed, reason: allowed ? "allowed" : "active" },
        });
      });
    } else if (msg?.type === "submit" && this.initialized) {
      queueMicrotask(() => {
        this.emitWire({
          type: "response",
          id: msg.id,
          success: true,
          data: {
            intentId: msg.submission.intentId,
            hostInstanceId: this.hostInstanceId,
            sessionEpoch: this.sessionEpoch,
            editorRevision: msg.submission.editorRevision,
            disposition: "consumed",
            queued: this.runtime.isStreaming,
          },
        });
      });
    } else if (msg?.type === "prepare_close" && this.initialized) {
      this.closeToken = `fake-close-${this.transportSequence}`;
      queueMicrotask(() => {
        this.emitWire({
          type: "response",
          id: msg.id,
          success: true,
          data: { token: this.closeToken },
        });
      });
    } else if (msg?.type === "confirm_close" && this.initialized) {
      queueMicrotask(() => {
        this.emitWire({
          type: "response",
          id: msg.id,
          success: true,
          data: { valid: msg.token === this.closeToken },
        });
      });
    } else if (msg?.type === "panel_input" && this.initialized) {
      queueMicrotask(() => {
        this.emitWire({
          type: "response",
          id: msg.id,
          success: true,
          data: { acknowledgedThrough: msg.sequence },
        });
      });
    } else if (msg?.type === "escape" && this.initialized) {
      queueMicrotask(() => {
        this.emitWire({
          type: "response",
          id: msg.id,
          success: true,
          data: {
            requestId: msg.requestId,
            hostInstanceId: this.hostInstanceId,
            sessionEpoch: this.sessionEpoch,
            disposition: this.runtime.isIdle ? "already_inactive" : "abort_requested",
          },
        });
      });
    } else if ((msg?.type === "reload" || msg?.type === "editor_patch") && this.initialized) {
      queueMicrotask(() => {
        let data;
        if (msg.type === "editor_patch") {
          this.beforeEditorPatch?.(msg.patch);
          const accepted =
            msg.patch.baseRevision === this.editor.revision &&
            msg.patch.revision > this.editor.revision;
          if (accepted) {
            this.editor = {
              revision: msg.patch.revision,
              text: msg.patch.text,
              attachments: structuredClone(msg.patch.attachments ?? []),
            };
          } else {
            this.editor = {
              ...this.editor,
              conflictText: msg.patch.text,
              conflictAttachments: structuredClone(msg.patch.attachments ?? []),
              ...(msg.patch.alternateConflictText !== undefined
                ? {
                    alternateConflictText: msg.patch.alternateConflictText,
                    alternateConflictAttachments: structuredClone(
                      msg.patch.alternateConflictAttachments ?? [],
                    ),
                  }
                : {}),
              ...(msg.patch.additionalConflictCandidates?.length
                ? {
                    additionalConflictCandidates: structuredClone(
                      msg.patch.additionalConflictCandidates,
                    ),
                  }
                : {}),
            };
          }
          const snapshot = this.snapshot();
          this.emitControl({ type: "snapshot", snapshot });
          data = { accepted, ...structuredClone(this.editor) };
        }
        this.emitWire({
          type: "response",
          id: msg.id,
          success: true,
          ...(data ? { data } : {}),
        });
      });
    }
    return true;
  }

  /**
   * Host → main message. A test calls this to drive the protocol
   * (emit ready / error / event / response / panel_* / spawned).
   */
  emitMessage(msg) {
    this.emit("message", msg);
  }

  /** Write to stderr (SessionHost folds the tail into error messages). */
  emitStderr(text) {
    this.stderr.emit("data", Buffer.from(text));
  }

  /** Emit the spawned-alive signal (host.mjs sends this on boot). */
  emitSpawned() {
    this.emitMessage({ type: "spawned" });
  }

  /** Emit `{type:"ready", piVersion}` — resolves waitForReady. */
  emitReady(piVersion) {
    this.initialized = true;
    this.emitControl({ type: "ready", piVersion, snapshot: this.snapshot() });
  }

  /** Emit `{type:"error", message, versionTooLow?}` — rejects waitForReady. */
  emitError(message, opts) {
    this.emitMessage({
      type: "error",
      message,
      ...(opts?.versionTooLow ? { versionTooLow: true } : {}),
    });
  }

  /** Emit the process "exit" event (SessionHost treats it as host death). */
  emitExit(code) {
    this.exitCode = code;
    this.connected = false; // IPC channel closes on exit (post-exit send fails)
    this.emit("exit", code, null);
  }

  /**
   * Record teardown. Emits the "exit" event (a real ChildProcess emits exit on
   * SIGTERM), so SessionHost's exit listener fires and waitForReady rejects —
   * otherwise tests that closeSession a held-open host would hang forever.
   * Tests that want to control exit timing separately can set a flag first.
   */
  kill(signal) {
    this.killed = true;
    this.killSignal = signal ?? "SIGTERM";
    // Emit exit so SessionHost's exit listener fires (rejects waitForReady,
    // rejectAllPending). A real process exits asynchronously; a microtask
    // delay keeps ordering realistic without hanging a test.
    queueMicrotask(() => {
      this.exitCode = 128 + 15; // SIGTERM convention
      this.connected = false; // IPC channel closes on exit
      this.emit("exit", this.exitCode, this.killSignal);
    });
    return true;
  }
}
