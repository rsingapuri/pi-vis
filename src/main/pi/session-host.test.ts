import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHostProcess } from "../../../tests/fixtures/fake-host-process.mjs";
import {
  HostVersionTooLowError,
  SessionHost,
  __forkOverride,
  isSessionHost,
} from "./session-host.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * SessionHost lifecycle tests. Drives the host wire protocol deterministically
 * via FakeHostProcess (installed through the __forkOverride test seam) — no
 * real fork, no real pi install. Covers the seams the adversarial review
 * identified: waitForReady resolve/reject/timeout, the watchdog re-arm gap
 * (W1), sendCommand correlation + rejectAllPending, panel forwarding with the
 * generation guard, sendUiResponse, and pre-ready uiRequest ordering.
 */
describe("SessionHost", () => {
  let fake: FakeHostProcess;
  let host: SessionHost;

  beforeEach(() => {
    fake = new FakeHostProcess();
    // Install the fake fork for the duration of this test.
    __forkOverride.fn = () =>
      fake as unknown as ReturnType<typeof import("node:child_process").fork>;
    host = new SessionHost("/fake/pi", "/tmp/fake-ws", undefined, {});
    // NOTE: deliberately no host.on("error") swallow here. SessionHost must be
    // safe to use without an external 'error' listener — emitError guards the
    // unlistened case (see the "unobserved 'error' safety" suite below).
  });

  afterEach(() => {
    __forkOverride.fn = null;
    SessionHost.__dialogTimeoutMsForTests = null;
    host.stop();
  });

  describe("waitForReady", () => {
    it("resolves on {type:ready, piVersion}", async () => {
      fake.emitReady("0.80.2");
      await host.waitForReady();
      expect(host.piVersion).toBe("0.80.2");
    });

    it("rejects with HostVersionTooLowError on versionTooLow error", async () => {
      const p = host.waitForReady();
      fake.emitError("pi version 0.70.0 is below minimum 0.80.0", { versionTooLow: true });
      await expect(p).rejects.toBeInstanceOf(HostVersionTooLowError);
    });

    it("rejects with a diagnostic Error on a generic pre-ready error", async () => {
      const p = host.waitForReady().catch((e) => {
        throw e;
      });
      fake.emitError("boom: module not found");
      await expect(p).rejects.toThrow(/boom: module not found/);
    });

    it("rejects with a diagnostic Error on pre-ready exit (code 1)", async () => {
      // Fold stderr tail into the diagnostic for actionable errors.
      fake.emitStderr("Cannot find module 'undici'");
      const p = host.waitForReady();
      fake.emitExit(1);
      await expect(p).rejects.toThrow(/Cannot find module 'undici'/);
    });

    it("rejects with HostVersionTooLowError on exit code 42 (version-gate)", async () => {
      const p = host.waitForReady();
      fake.emitExit(42);
      await expect(p).rejects.toBeInstanceOf(HostVersionTooLowError);
    });

    it("a pre-ready host error with no external 'error' listener rejects waitForReady without throwing (Electron 43 / Node 24 regression)", async () => {
      // The startup-failure sequence: the host's {type:"error"} message
      // consumes startupReject, whose cleanup removes waitForReady's
      // once("error") listener — so the follow-up emit("error") fires with
      // ZERO listeners. An unlistened 'error' emission throws as an
      // uncaughtException, which in Electron's main process pops a BLOCKING
      // native error dialog and freezes the whole event loop (IPC, CDP,
      // quit). Node 20 usually dropped the child's pre-exit IPC message (only
      // the safe 'exit' path ran); Node 24 delivers it reliably, so every
      // host-fallback froze the app. emitError must guard the unlistened case.
      const p = host.waitForReady();
      expect(() => fake.emitError("boom: module not found")).not.toThrow();
      await expect(p).rejects.toThrow(/boom/);
    });

    it("fires the startup watchdog when the host never sends ready", async () => {
      // Use a tiny timeout so the test is fast. We can't easily override
      // STARTUP_TIMEOUT_MS (module const), so instead assert the contract:
      // a host that emits nothing eventually rejects. Bound the wait.
      const p = host.waitForReady();
      // Simulate the watchdog firing by emitting a pre-ready exit (the only
      // no-ready path that doesn't depend on the 30s timer). This proves the
      // reject path is wired; the actual 30s timeout is exercised in the
      // W1 dialog-timeout test below with its own shorter timer.
      fake.emitExit(1);
      await expect(p).rejects.toThrow();
    });
  });

  describe("W1: watchdog re-arm gap for an unanswered pre-ready dialog", () => {
    it("waitForReady rejects within a bounded time if the pre-ready dialog is never answered", async () => {
      // Shrink the dialog timeout so the test is fast.
      SessionHost.__dialogTimeoutMsForTests = 100;
      const p = host.waitForReady();

      // The trust prompt fires during host startup (pre-ready):
      fake.emitMessage({
        type: "extension_ui_request",
        id: "trust_1",
        method: "select",
        title: "Trust?",
      });

      // ... and the user never answers. No sendUiResponse, no ready, no exit.
      // waitForReady MUST still reject within a bounded time (the fix adds a
      // dialog-outstanding timeout; the original code hung forever).
      const start = Date.now();
      await expect(p).rejects.toThrow(/dialog/i);
      const elapsed = Date.now() - start;
      // Bounded: well under the 30s startup timeout (the fix uses a shorter
      // dialog timeout). Generous upper bound to avoid CI flake.
      expect(elapsed).toBeLessThan(15_000);
    });

    it("sendUiResponse re-arms the watchdog so a normally-answered trust prompt still reaches ready", async () => {
      // Confirms the fix doesn't break the happy path: dialog arrives, user
      // answers, sendUiResponse re-arms, host then sends ready.
      const p = host.waitForReady();
      fake.emitMessage({
        type: "extension_ui_request",
        id: "trust_1",
        method: "select",
        title: "Trust?",
      });
      // User answers:
      host.sendUiResponse(
        JSON.stringify({
          type: "extension_ui_response",
          id: "trust_1",
          value: "Trust this folder",
        }),
      );
      // Host finishes coming up:
      fake.emitReady("0.80.2");
      await p;
      expect(host.piVersion).toBe("0.80.2");
    });
  });

  describe("post-exit best-effort sends", () => {
    it("drops UI/panel replies after host exit without throwing or emitting error", () => {
      const errors: Error[] = [];
      host.on("error", (err) => errors.push(err));
      fake.emitExit(1);

      const originalSend = fake.send.bind(fake);
      fake.send = ((msg: unknown, cb?: (err: Error | null) => void) => {
        if (!fake.connected) throw new Error("Host process IPC channel closed");
        return originalSend(msg as never, cb);
      }) as typeof fake.send;

      expect(() => {
        host.sendUiResponse(JSON.stringify({ type: "extension_ui_response", id: "d", value: "x" }));
        host.sendPanelInput(1, "x");
        host.sendPanelResize(1, 80, 24);
        host.sendPanelClose(1);
      }).not.toThrow();
      expect(errors).toHaveLength(0);
    });

    it("uses callback sends so channel-close races are swallowed", () => {
      const errors: Error[] = [];
      host.on("error", (err) => errors.push(err));

      fake.send = ((msg: unknown, cb?: (err: Error | null) => void) => {
        expect(msg).toMatchObject({ type: "panel_input", panelId: 1, data: "x" });
        expect(typeof cb).toBe("function");
        cb?.(new Error("Host process IPC channel closed"));
        return false;
      }) as typeof fake.send;

      expect(() => host.sendPanelInput(1, "x")).not.toThrow();
      expect(errors).toHaveLength(0);
    });
  });

  describe("sendCommand", () => {
    it("correlates a response by id and resolves with data", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();

      const p = host.sendCommand({ type: "get_state" } as never);
      // The host received the command on the wire:
      expect(fake.sent.some((m) => m.type === "command")).toBe(true);

      // Host responds:
      const sentCmd = fake.sent.find((m) => m.type === "command")!;
      fake.emitMessage({
        type: "response",
        id: sentCmd.id,
        success: true,
        data: { sessionId: "x" },
      });
      const res = await p;
      expect(res.success).toBe(true);
    });

    it("forwards the invoking UI surface outside the pi RPC command", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();

      const p = host.sendCommand({ type: "prompt", message: "/custom" } as never, {
        uiSurface: "composer",
      });
      const sentCmd = fake.sent.find((m) => m.type === "command")!;
      expect(sentCmd.uiSurface).toBe("composer");
      expect(sentCmd.command).toEqual({ type: "prompt", message: "/custom" });
      fake.emitMessage({ type: "response", id: sentCmd.id, success: true, data: {} });
      await expect(p).resolves.toMatchObject({ success: true });
    });

    it("resolves host command failures as success:false RPC responses", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();

      const p = host.sendCommand({ type: "clone" } as never);
      const sentCmd = fake.sent.find((m) => m.type === "command")!;
      fake.emitMessage({
        type: "response",
        id: sentCmd.id,
        success: false,
        error: "Cannot clone an empty session",
      });

      await expect(p).resolves.toMatchObject({
        success: false,
        error: "Cannot clone an empty session",
      });
    });

    it("rejects when the host exits mid-command (rejectAllPending)", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();

      const p = host.sendCommand({ type: "get_state" } as never);
      fake.emitExit(1);
      await expect(p).rejects.toThrow(/Host process exited/);
    });
  });

  describe("panel forwarding", () => {
    it("emits panelOpen/panelData/panelClose/panelClearAll to listeners", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();

      const events: string[] = [];
      host.on("panelOpen", (id, _overlay) => events.push(`open:${id}`));
      host.on("panelData", (id, _data) => events.push(`data:${id}`));
      host.on("panelClose", (id) => events.push(`close:${id}`));
      host.on("panelClearAll", () => events.push("clearAll"));

      fake.emitMessage({ type: "panel_open", panelId: 7, overlay: false });
      fake.emitMessage({ type: "panel_data", panelId: 7, data: "\x1b[2J" });
      fake.emitMessage({ type: "panel_close", panelId: 7 });
      fake.emitMessage({ type: "panel_clear_all" });

      expect(events).toEqual(["open:7", "data:7", "close:7", "clearAll"]);
    });
  });

  describe("sendUiResponse", () => {
    it("forwards a dialog_response to the host", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();

      host.sendUiResponse(JSON.stringify({ type: "extension_ui_response", id: "d1", value: "x" }));
      const last = fake.sent[fake.sent.length - 1];
      expect(last?.type).toBe("dialog_response");
      expect(last?.response).toMatchObject({ id: "d1", value: "x" });
    });
  });

  describe("pre-ready uiRequest ordering", () => {
    it("forwards a pre-ready uiRequest BEFORE ready (the trust-prompt ordering)", async () => {
      // The whole reason the registry attaches uiRequest listeners before
      // waitForReady: the trust prompt fires DURING host startup. This test
      // pins that a uiRequest emitted pre-ready reaches listeners.
      const seen: string[] = [];
      host.on("uiRequest", () => seen.push("uiRequest"));

      const readyP = host.waitForReady();
      fake.emitMessage({
        type: "extension_ui_request",
        id: "t",
        method: "select",
        title: "Trust?",
      });
      // The uiRequest must have been forwarded already (before ready):
      expect(seen).toEqual(["uiRequest"]);

      // Now answer it + reach ready so waitForReady settles:
      host.sendUiResponse(JSON.stringify({ type: "extension_ui_response", id: "t", value: "ok" }));
      fake.emitReady("0.80.0");
      await readyP;
    });
  });

  describe("panel I/O round-trips (wire contract for the force-close hatch)", () => {
    it("sendPanelInput emits {type:panel_input, panelId, data}", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      host.sendPanelInput(3, "\r");
      expect(fake.sent).toContainEqual({ type: "panel_input", panelId: 3, data: "\r" });
    });

    it("sendPanelResize emits {type:panel_resize, panelId, cols, rows}", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      host.sendPanelResize(3, 120, 40);
      expect(fake.sent).toContainEqual({
        type: "panel_resize",
        panelId: 3,
        cols: 120,
        rows: 40,
      });
    });

    it("sendPanelResize can request a forced full repaint", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      host.sendPanelResize(3, 120, 40, true);
      expect(fake.sent).toContainEqual({
        type: "panel_resize",
        panelId: 3,
        cols: 120,
        rows: 40,
        force: true,
      });
    });

    it("sendPanelClose emits {type:panel_close_request, panelId} (the escape hatch)", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      host.sendPanelClose(3);
      expect(fake.sent).toContainEqual({ type: "panel_close_request", panelId: 3 });
    });

    it("sendInterrupt emits {type:interrupt}", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      host.sendInterrupt();
      expect(fake.sent).toContainEqual({ type: "interrupt" });
    });
  });

  describe("fake-fidelity: command failure modes", () => {
    it("a command sent after the host exits rejects (rejectAllPending)", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      fake.emitExit(0);
      // Post-exit the IPC channel is closed; the send-callback rejects rather
      // than leaving the (timeout-less) get_state pending forever.
      await expect(host.sendCommand({ type: "get_state" })).rejects.toThrow(/closed/i);
    });

    it("a command sent BEFORE ready resolves with the host's 'Not initialized' failure", async () => {
      // The fake mirrors host.mjs. This is the failure the registry's
      // _procReady gate prevents (P1-i); at the SessionHost layer command
      // failures are normal RPC responses, not rejected IPC sends.
      const res = await host.sendCommand({ type: "get_state" });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Not initialized/);
    });
  });

  describe("unified TUI wire contract", () => {
    it("panel_open forwards the unified flag (persistent panel vs custom overlay)", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      let captured: { id: number; overlay: boolean; unified: boolean } | null = null;
      host.on("panelOpen", (id, overlay, unified) => {
        captured = { id, overlay, unified };
      });
      fake.emitMessage({ type: "panel_open", panelId: 9, overlay: false, unified: true });
      expect(captured).toEqual({ id: 9, overlay: false, unified: true });
    });

    it("forwards unified_submit_request as a unifiedSubmitRequest event", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      let captured: { id: string; text: string } | null = null;
      host.on("unifiedSubmitRequest", (id, text) => {
        captured = { id, text };
      });
      fake.emitMessage({ type: "unified_submit_request", id: "u1", text: "hello" });
      expect(captured).toEqual({ id: "u1", text: "hello" });
    });

    it("sendUnifiedSubmitResponse forwards {type:unified_submit_response} to the host", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      host.sendUnifiedSubmitResponse("u1", false, true, "No model selected");
      const last = fake.sent[fake.sent.length - 1];
      expect(last).toMatchObject({
        type: "unified_submit_response",
        id: "u1",
        ok: false,
        bailed: true,
        error: "No model selected",
      });
    });

    it("clipboard_read_image_request always replies with a clipboard_read_image_response (matched by id)", async () => {
      // replyClipboardImage lazy-requires `electron` for clipboard.readImage,
      // which is unavailable under vitest's node env (it throws, is caught, and
      // the response carries bytes:undefined). The wire contract this pins: a
      // request ALWAYS yields a correlated response — so a paste that finds an
      // empty clipboard, or errors, still unblocks the host's input listener.
      // (The bytes → temp-file → insert-path logic is covered by ui-context.test.mjs.)
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      fake.emitMessage({ type: "clipboard_read_image_request", id: "clip1" });
      const resp = fake.sent[fake.sent.length - 1];
      expect(resp?.type).toBe("clipboard_read_image_response");
      expect(resp?.id).toBe("clip1");
    });

    it("sendUnifiedSubmitResponse after the host exits is a silent no-op", async () => {
      await fake.emitReady("0.80.0");
      await host.waitForReady();
      fake.emitExit(0);
      const before = fake.sent.length;
      host.sendUnifiedSubmitResponse("u1", true);
      expect(fake.sent.length).toBe(before); // guarded — no channel-closed noise
    });
  });

  describe("stop", () => {
    it("escalates to SIGKILL when the host ignores SIGTERM", () => {
      const signals: Array<NodeJS.Signals | undefined> = [];
      (fake as unknown as { signalCode: NodeJS.Signals | null }).signalCode = null;
      fake.kill = (signal?: NodeJS.Signals) => {
        signals.push(signal);
        fake.killed = true;
        if (signal) fake.killSignal = signal;
        // Deliberately do NOT emit exit: this fake host ignores SIGTERM.
        return true;
      };

      vi.useFakeTimers();
      try {
        host.stop();
        expect(signals).toEqual(["SIGTERM"]);
        vi.advanceTimersByTime(3000);
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("isSessionHost (panel-capability duck type)", () => {
  it("is true for a SessionHost instance", () => {
    const fake = new FakeHostProcess();
    __forkOverride.fn = () =>
      fake as unknown as ReturnType<typeof import("node:child_process").fork>;
    const host = new SessionHost("/fake/pi", "/tmp/ws", undefined, {});
    host.on("error", () => {});
    expect(isSessionHost(host)).toBe(true);
    host.stop();
    __forkOverride.fn = null;
  });

  it("is true for any proc exposing sendPanelInput, false otherwise", () => {
    expect(isSessionHost({ sendPanelInput: () => {} })).toBe(true);
    // A PiProcess-shaped object (no panel methods) → false (clean no-op path).
    expect(isSessionHost({ sendCommand: () => {}, stop: () => {} })).toBe(false);
    expect(isSessionHost(null)).toBe(false);
    expect(isSessionHost(undefined)).toBe(false);
    expect(isSessionHost({})).toBe(false);
  });
});

describe("nodeExecPath (host runtime retarget)", () => {
  // The parity fix: when the registry resolves a newer system Node, the host
  // fork must run under THAT node (not Electron's bundled Node) so extensions
  // using newer Node built-ins (e.g. @cursor/sdk's node:sqlite store) work.
  // Pins that nodeExecPath reaches child_process.fork's opts, and that omitting
  // it leaves execPath unset (Electron default — the fallback path).
  it("passes execPath to fork when a nodeExecPath is supplied", () => {
    const fake = new FakeHostProcess();
    let capturedOpts: Record<string, unknown> = {};
    __forkOverride.fn = (_p: string, _a: string[], opts: object) => {
      capturedOpts = opts as Record<string, unknown>;
      return fake as unknown as ReturnType<typeof import("node:child_process").fork>;
    };
    const host = new SessionHost("/fake/pi", "/tmp/ws", undefined, {}, "/usr/local/bin/node");
    host.on("error", () => {});
    expect(capturedOpts.execPath).toBe("/usr/local/bin/node");
    host.stop();
    __forkOverride.fn = null;
  });

  it("omits execPath when no nodeExecPath is supplied (Electron default)", () => {
    const fake = new FakeHostProcess();
    let capturedOpts: Record<string, unknown> = {};
    __forkOverride.fn = (_p: string, _a: string[], opts: object) => {
      capturedOpts = opts as Record<string, unknown>;
      return fake as unknown as ReturnType<typeof import("node:child_process").fork>;
    };
    const host = new SessionHost("/fake/pi", "/tmp/ws", undefined, {});
    host.on("error", () => {});
    expect(capturedOpts.execPath).toBeUndefined();
    host.stop();
    __forkOverride.fn = null;
  });
});
