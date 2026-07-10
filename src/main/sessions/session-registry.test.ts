import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionId } from "@shared/ids.js";
import type { SessionStatus } from "@shared/ipc-contract.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import lockfile from "proper-lockfile";
// Mock the node-execPath resolver so the registry tests don't shell out to the
// login shell on every activation (resolveHostExecPath would otherwise run a
// real `$SHELL -ilc 'command -v node'`, breaking the tight timing of the
// close-during-activate / pending-queue tests). The retarget DECISION itself is
// unit-tested in locate-node.test.ts; here we just exercise the fallback path
// (undefined execPath = Electron's bundled Node), which is what every lifecycle
// test already implicitly assumes.
vi.mock("../pi/locate-node.js", () => ({
  resolveHostExecPath: async () => ({ execPath: undefined, reason: "electron-node-no-system" }),
}));

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHostProcess } from "../../../tests/fixtures/fake-host-process.mjs";
import { SessionHost, __forkOverride } from "../pi/session-host.js";
import { SessionRegistry } from "./session-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../../../tests/fixtures/fake-pi.mjs");

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

describe("SessionRegistry", () => {
  let sessionsDir: string;
  let workspaceDir: string;
  let statusChanges: Array<{
    sessionId: SessionId;
    status: SessionStatus;
    error?: string | undefined;
  }>;
  let registry: SessionRegistry;

  beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
  });

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-reg-sessions-"));
    workspaceDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-reg-ws-")));
    process.env.FAKE_PI_SESSIONS_DIR = sessionsDir;

    statusChanges = [];
    registry = new SessionRegistry(
      (_sid: SessionId, _ev: PiEvent) => {},
      (_sid: SessionId, _req: ExtensionUiRequest) => {},
      (sessionId, status, error) => {
        statusChanges.push({ sessionId, status, error });
      },
      (_sid: SessionId, _ev: PanelEvent) => {
        // panel events — ignored in test
      },
      () => {
        // unified submit requests — ignored in test
      },
    );
  });

  afterEach(() => {
    delete process.env.FAKE_PI_SESSIONS_DIR;
    try {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("openSession creates a cold record without spawning", () => {
    const id = registry.openSession(workspaceDir);
    const rec = registry.getSession(id);
    expect(rec).toBeDefined();
    expect(rec?.status).toBe("cold");
    expect(rec?.proc).toBeUndefined();
    expect(statusChanges.filter((s) => s.sessionId === id)).toHaveLength(0);
  });

  it("openSession drops a superseded dead record for the same session file", () => {
    const fileA = join(sessionsDir, "test-dead.jsonl");
    fs.writeFileSync(fileA, "");
    const id1 = registry.openSession(workspaceDir, fileA);
    const rec1 = registry.getSession(id1);
    if (!rec1) throw new Error("expected record");
    rec1.status = "exited";

    const id2 = registry.openSession(workspaceDir, fileA);

    expect(id2).not.toBe(id1);
    expect(registry.getSession(id1)).toBeUndefined();
    expect(registry.getByFile(fileA)?.sessionId).toBe(id2);
  });

  it("double-open guard rejects opening the same file twice while cold", () => {
    // First create a file on disk via fake-pi so we can reference it.
    const fileA = join(sessionsDir, "test-a.jsonl");
    fs.writeFileSync(fileA, "");
    const id1 = registry.openSession(workspaceDir, fileA);
    expect(id1).toBeDefined();
    expect(() => registry.openSession(workspaceDir, fileA)).toThrow(/already open/);
  });

  it("activateSession transitions cold → starting → ready and exposes the proc", async () => {
    const id = registry.openSession(workspaceDir);
    await registry.activateSession(id, FAKE_PI);

    const rec = registry.getSession(id);
    expect(rec).toBeDefined();
    // We should have seen at least the "starting" event.
    const starting = statusChanges.find((s) => s.sessionId === id && s.status === "starting");
    expect(starting).toBeDefined();
    expect(rec?.proc).toBeDefined();

    // The proc is live — a get_state roundtrip should land.
    const proc = rec?.proc;
    expect(proc).toBeDefined();
    if (!proc) return;
    const res = await proc.sendCommand({ type: "get_state" });
    expect(res.success).toBe(true);

    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "ready"),
      5000,
      "ready status",
    );
    expect(statusChanges.some((s) => s.sessionId === id && s.status === "ready")).toBe(true);
  }, 15_000);

  it("marks the session busy during a turn, clears it on agent_end, and advances lastActiveAt", async () => {
    const id = registry.openSession(workspaceDir);
    const openedAt = registry.getSession(id)?.lastActiveAt ?? 0;
    await registry.activateSession(id, FAKE_PI);
    const proc = registry.getSession(id)?.proc;
    expect(proc).toBeDefined();
    if (!proc) return;

    // "hello" streams over ~200ms (50ms between deltas), giving a window
    // to observe busy === true before agent_end lands.
    void proc.sendCommand({ type: "prompt", message: "hello" });

    await waitFor(() => registry.getSession(id)?.busy === true, 5000, "busy=true (agent_start)");
    // Activity timestamp advances past the open time once events flow — the
    // bug was that lastActiveAt was only ever set at openSession.
    expect(registry.getSession(id)?.lastActiveAt ?? 0).toBeGreaterThan(openedAt);

    await waitFor(() => registry.getSession(id)?.busy === false, 5000, "busy=false (agent_end)");
    expect(registry.getSession(id)?.busy).toBe(false);
  }, 15_000);

  it("activateSession is idempotent while a process is alive", async () => {
    const id = registry.openSession(workspaceDir);
    await registry.activateSession(id, FAKE_PI);
    const first = registry.getSession(id)?.proc;
    expect(first).toBeDefined();
    await registry.activateSession(id, FAKE_PI);
    const second = registry.getSession(id)?.proc;
    expect(second).toBe(first);
  });

  it("activateSession guards against re-entrant double-spawn during the async window", async () => {
    // A session file makes activateSession await the advisory lock, yielding
    // before record.proc is assigned. A second activateSession arriving in
    // that window must no-op instead of spawning a second process.
    const file = join(sessionsDir, "reentrant.jsonl");
    fs.writeFileSync(file, "");
    const id = registry.openSession(workspaceDir, file);

    statusChanges.length = 0;
    // Kick off two activations concurrently — both before the first's lock
    // await resolves.
    const p1 = registry.activateSession(id, FAKE_PI);
    const p2 = registry.activateSession(id, FAKE_PI);
    await Promise.all([p1, p2]);

    // "starting" is emitted exactly once: the second call hit the _activating
    // guard and returned before emitting. Without the guard it would spawn a
    // second process and emit "starting" again.
    const startingCount = statusChanges.filter(
      (s) => s.sessionId === id && s.status === "starting",
    ).length;
    expect(startingCount).toBe(1);
    expect(registry.getSession(id)?.proc).toBeDefined();
    // closeSession releases the advisory lock (cancelling proper-lockfile's
    // recurring update timer) and stops the proc.
    registry.closeSession(id);
  }, 15_000);

  it("sendCommand buffers while the proc is being established, then flushes", async () => {
    // The session file makes activateSession await the advisory lock, which
    // yields before record.proc is assigned — the exact window the
    // renderer's init commands (get_state etc.) used to race and fail with
    // "No active process".
    const file = join(sessionsDir, "buffered.jsonl");
    fs.writeFileSync(file, "");
    const id = registry.openSession(workspaceDir, file);

    // Suspend activation at the lock await: status "starting", no proc yet.
    const activating = registry.activateSession(id, FAKE_PI);

    // A command arriving mid-activation must queue (not throw) ...
    const cmdPromise = registry.sendCommand(id, { type: "get_state" });

    // ... and resolve once the proc is live and the queue is flushed.
    const [res] = await Promise.all([cmdPromise, activating]);
    expect(res.success).toBe(true);
    // closeSession releases the advisory lock and stops the proc.
    registry.closeSession(id);
  }, 15_000);

  it("sendCommand fails fast with 'No active process' when no activation is pending", async () => {
    const id = registry.openSession(workspaceDir);
    // Cold session, no proc, not activating → fail immediately rather than
    // hang. (Only the "starting" window buffers.)
    await expect(registry.sendCommand(id, { type: "get_state" })).rejects.toThrow(
      /No active process/,
    );
  });

  it("clears RPC fallback interrupt state when a prompt completes without agent events", async () => {
    const id = registry.openSession(workspaceDir);
    await registry.activateSession(id, FAKE_PI);

    const res = await registry.sendCommand(id, { type: "prompt", message: "/widget-on" });

    expect(res.success).toBe(true);
    expect(registry.getSession(id)?.interruptible).toBe(false);
    expect(registry.getSession(id)?.interruptKind).toBeUndefined();
    expect(registry.getSession(id)?.busy).toBe(false);
  }, 15_000);

  it("marks RPC fallback synthetic interrupt operations busy until the command settles", async () => {
    const id = registry.openSession(workspaceDir);
    const rec = registry.getSession(id);
    expect(rec).toBeDefined();
    if (!rec) return;
    let resolveCommand!: (value: {
      success: true;
      data: { output: string; exitCode: number };
    }) => void;
    const commandPromise = new Promise<{
      success: true;
      data: { output: string; exitCode: number };
    }>((resolve) => {
      resolveCommand = resolve;
    });
    rec.proc = {
      sendCommand: async () => commandPromise,
      stop: () => {},
      stderrLog: [],
    } as never;
    rec._procReady = true;

    const send = registry.sendCommand(id, { type: "bash", command: "sleep 10" });

    expect(registry.getSession(id)?.interruptible).toBe(true);
    expect(registry.getSession(id)?.interruptKind).toBe("bash");
    expect(registry.getSession(id)?.busy).toBe(true);

    resolveCommand({ success: true, data: { output: "", exitCode: 0 } });
    await expect(send).resolves.toMatchObject({ success: true });
    expect(registry.getSession(id)?.interruptible).toBe(false);
    expect(registry.getSession(id)?.busy).toBe(false);
  });

  it("interruptSession cancels interruptible commands queued during startup", async () => {
    const id = registry.openSession(workspaceDir);
    const rec = registry.getSession(id);
    expect(rec).toBeDefined();
    if (!rec) return;
    const resolved: unknown[] = [];
    const queued = [
      { type: "prompt" as const, message: "queued" },
      { type: "steer" as const, message: "queued steer" },
      { type: "follow_up" as const, message: "queued follow-up" },
    ].map(
      (command) =>
        new Promise((resolve) => {
          const item = {
            command,
            resolve: (value: unknown) => {
              resolved.push(value);
              resolve(value);
            },
            reject: () => {},
          };
          rec._pendingSend = [...(rec._pendingSend ?? []), item];
        }),
    );

    await registry.interruptSession(id);

    await Promise.all(queued);
    expect(resolved).toEqual([
      {
        type: "response",
        command: "prompt",
        success: false,
        error: "Interrupted before session was ready",
      },
      {
        type: "response",
        command: "steer",
        success: false,
        error: "Interrupted before session was ready",
      },
      {
        type: "response",
        command: "follow_up",
        success: false,
        error: "Interrupted before session was ready",
      },
    ]);
    expect(rec._pendingSend).toBeUndefined();
  });

  it("interruptSession leaves non-interruptible startup commands queued", async () => {
    const id = registry.openSession(workspaceDir);
    const rec = registry.getSession(id);
    expect(rec).toBeDefined();
    if (!rec) return;
    const queued = {
      command: { type: "get_state" as const },
      resolve: () => {},
      reject: () => {},
    };
    rec._pendingSend = [queued];

    await registry.interruptSession(id);

    expect(rec._pendingSend).toEqual([queued]);
  });

  it("interruptSession sends every required RPC fallback abort primitive", async () => {
    const id = registry.openSession(workspaceDir);
    const rec = registry.getSession(id);
    expect(rec).toBeDefined();
    if (!rec) return;
    const commands: string[] = [];
    rec.proc = {
      sendCommand: async (command: { type: string }) => {
        commands.push(command.type);
        return { success: true };
      },
      stop: () => {},
      stderrLog: [],
    } as never;
    rec._procReady = true;
    rec._interruptOps = new Map([
      [1, { kind: "agent", source: "event" }],
      [2, { kind: "bash", source: "command" }],
    ]);
    rec.interruptible = true;
    rec.interruptKind = "bash";

    await registry.interruptSession(id);

    expect(commands).toEqual(["abort", "abort_bash"]);
  });

  it("activateSession respawns after the previous process exits", async () => {
    const id = registry.openSession(workspaceDir);
    await registry.activateSession(id, FAKE_PI);
    const first = registry.getSession(id)?.proc;
    expect(first).toBeDefined();
    if (!first) return;

    first.stop();
    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "exited"),
      5000,
      "exited status",
    );

    statusChanges.length = 0;
    await registry.activateSession(id, FAKE_PI);
    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "ready"),
      5000,
      "ready after respawn",
    );
    const second = registry.getSession(id)?.proc;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // Stale exit events from the old proc must not perturb the new state.
    await new Promise((r) => setTimeout(r, 500));
    const stillReady = statusChanges.filter((s) => s.sessionId === id && s.status === "exited");
    expect(stillReady).toHaveLength(0);
    expect(registry.getSession(id)?.status).toBe("ready");
  }, 15_000);

  it("clears proc readiness and busy when a live process errors", async () => {
    const id = registry.openSession(workspaceDir);
    await registry.activateSession(id, FAKE_PI);
    const rec = registry.getSession(id);
    const proc = rec?.proc;
    expect(proc).toBeDefined();
    if (rec) rec.busy = true;

    proc?.emit("error", new Error("boom"));

    expect(registry.getSession(id)?.status).toBe("failed");
    expect(registry.getSession(id)?.proc).toBeUndefined();
    expect(registry.getSession(id)?._procReady).toBe(false);
    expect(registry.getSession(id)?.busy).toBe(false);
  });

  it("setWorktreeAndRespawn rejects when activation fails and restores the old worktree", async () => {
    const oldWorktree = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-old-wt-")));
    const newWorktree = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-new-wt-")));
    const id = registry.openSession(workspaceDir, undefined, oldWorktree);
    await expect(
      registry.setWorktreeAndRespawn(id, newWorktree, "/no/such/pi-binary"),
    ).rejects.toThrow();
    expect(registry.getSession(id)?.status).toBe("failed");
    expect(registry.getSession(id)?.worktreePath).toBe(oldWorktree);

    // The failed replacement activation must not leave a stale suppression
    // flag that poisons a later normal activation.
    await registry.activateSession(id, FAKE_PI);
    const response = await registry.sendCommand(id, { type: "get_state" });
    expect(response.success).toBe(true);
    registry.closeSession(id);

    fs.rmSync(oldWorktree, { recursive: true, force: true });
    fs.rmSync(newWorktree, { recursive: true, force: true });
  });

  it("setWorktreeAndRespawn rejects queued commands when the replacement process exits immediately", async () => {
    const crashingPi = join(sessionsDir, "crashing-pi.sh");
    fs.writeFileSync(crashingPi, "#!/bin/sh\nexit 7\n");
    fs.chmodSync(crashingPi, 0o755);
    const id = registry.openSession(workspaceDir);

    const respawn = registry.setWorktreeAndRespawn(id, workspaceDir, crashingPi);
    const queuedCommand = registry.sendCommand(id, { type: "get_state" });

    await expect(respawn).rejects.toThrow(/Exited with code 7|exited with code 7/i);
    await expect(queuedCommand).rejects.toThrow(/Exited with code 7|exited with code 7/i);
    expect(registry.getSession(id)?.status).toBe("exited");
  });

  it("clears proc readiness when a live process exits", async () => {
    const id = registry.openSession(workspaceDir);
    await registry.activateSession(id, FAKE_PI);
    const proc = registry.getSession(id)?.proc;
    expect(proc).toBeDefined();

    proc?.emit("exit", 0, null);

    const rec = registry.getSession(id);
    expect(rec?.status).toBe("exited");
    expect(rec?.proc).toBeUndefined();
    expect(rec?._procReady).toBe(false);
    await expect(registry.sendCommand(id, { type: "get_state" })).rejects.toThrow(
      /No active process/,
    );
  });

  it("reloadSession restarts the pi process and re-reaches ready", async () => {
    const id = registry.openSession(workspaceDir);
    await registry.activateSession(id, FAKE_PI);
    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "ready"),
      5000,
      "initial ready",
    );
    const first = registry.getSession(id)?.proc;
    expect(first).toBeDefined();
    if (!first) return;

    statusChanges.length = 0;
    await registry.reloadSession(id, FAKE_PI);

    // A fresh process is spawned (different instance)...
    const second = registry.getSession(id)?.proc;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // ...and it climbs back to ready.
    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "ready"),
      5000,
      "ready after reload",
    );
    expect(registry.getSession(id)?.status).toBe("ready");

    // Stale exit from the old proc must not perturb the reloaded session.
    await new Promise((r) => setTimeout(r, 500));
    const staleExited = statusChanges.filter((s) => s.sessionId === id && s.status === "exited");
    expect(staleExited).toHaveLength(0);
  }, 15_000);

  it("reloadSession refuses while the session is mid-turn", async () => {
    const id = registry.openSession(workspaceDir);
    await registry.activateSession(id, FAKE_PI);
    const proc = registry.getSession(id)?.proc;
    expect(proc).toBeDefined();
    if (!proc) return;

    void proc.sendCommand({ type: "prompt", message: "hello" });
    await waitFor(() => registry.getSession(id)?.busy === true, 5000, "busy=true");

    await expect(registry.reloadSession(id, FAKE_PI)).rejects.toThrow(/finish before reloading/);
    // The live proc is untouched.
    expect(registry.getSession(id)?.proc).toBe(proc);
  }, 15_000);

  it("closeSession removes the record and frees the byFile slot", async () => {
    const fileA = join(sessionsDir, "test-a.jsonl");
    fs.writeFileSync(fileA, "");
    const id = registry.openSession(workspaceDir, fileA);
    registry.closeSession(id);
    expect(registry.getSession(id)).toBeUndefined();

    // Re-opening with the same file should now succeed.
    const id2 = registry.openSession(workspaceDir, fileA);
    expect(id2).toBeDefined();
    expect(id2).not.toBe(id);

    // No status changes should have been emitted for the closed id after the close call.
    const afterClose = statusChanges.filter(
      (s) =>
        s.sessionId === id &&
        statusChanges.indexOf(s) > statusChanges.findIndex((x) => x.sessionId === id),
    );
    // The above may be brittle; simpler assertion: nothing after the close event.
    expect(statusChanges.every((s) => s.sessionId !== id)).toBe(true);
  });

  it("getByFile returns the record after openSession(ws, fileA); undefined for unknown; undefined after close", () => {
    const fileA = join(sessionsDir, "lookup-a.jsonl");
    fs.writeFileSync(fileA, "");
    const id = registry.openSession(workspaceDir, fileA);

    const found = registry.getByFile(fileA);
    expect(found).toBeDefined();
    expect(found?.sessionId).toBe(id);

    // Unknown path returns undefined.
    expect(registry.getByFile(join(sessionsDir, "nope.jsonl"))).toBeUndefined();

    // After close, the byFile slot is freed and getByFile returns undefined.
    registry.closeSession(id);
    expect(registry.getByFile(fileA)).toBeUndefined();
  });

  it("getByFile still returns an exited record (handler uses it to decide on a fresh open)", async () => {
    const fileA = join(sessionsDir, "exited-lookup.jsonl");
    fs.writeFileSync(fileA, "");
    const id = registry.openSession(workspaceDir, fileA);
    await registry.activateSession(id, FAKE_PI);

    const proc = registry.getSession(id)?.proc;
    expect(proc).toBeDefined();
    if (!proc) return;

    proc.stop();
    await waitFor(
      () => statusChanges.some((s) => s.sessionId === id && s.status === "exited"),
      5000,
      "exited status",
    );

    const found = registry.getByFile(fileA);
    expect(found).toBeDefined();
    expect(found?.sessionId).toBe(id);
    expect(found?.status).toBe("exited");
  }, 15_000);

  it("noteSessionFile sets once and ignores later changes", () => {
    const id = registry.openSession(workspaceDir);
    const fileA = join(sessionsDir, "first.jsonl");
    const fileB = join(sessionsDir, "second.jsonl");
    registry.noteSessionFile(id, fileA);
    expect(registry.getSession(id)?.sessionFile).toBe(fileA);

    registry.noteSessionFile(id, fileB);
    expect(registry.getSession(id)?.sessionFile).toBe(fileA);
  });

  describe("updateSessionFile (WP4 fileChanged flow)", () => {
    it("re-points byFile to the new path, freeing the old slot", () => {
      const id = registry.openSession(workspaceDir);
      const fileA = join(sessionsDir, "orig.jsonl");
      const fileB = join(sessionsDir, "new.jsonl");
      registry.noteSessionFile(id, fileA);
      expect(registry.getByFile(fileA)?.sessionId).toBe(id);

      registry.updateSessionFile(id, fileB);
      expect(registry.getSession(id)?.sessionFile).toBe(fileB);
      // Old slot freed so a future openSession(ws, fileA) doesn't
      // collide with the just-moved session.
      expect(registry.getByFile(fileA)).toBeUndefined();
      expect(registry.getByFile(fileB)?.sessionId).toBe(id);
    });

    it("clears the file when called with undefined (lazy new_session)", () => {
      const id = registry.openSession(workspaceDir);
      const fileA = join(sessionsDir, "lazy.jsonl");
      registry.noteSessionFile(id, fileA);
      registry.updateSessionFile(id, undefined);
      expect(registry.getSession(id)?.sessionFile).toBeUndefined();
      expect(registry.getByFile(fileA)).toBeUndefined();
    });

    it("is a no-op for unknown session ids", () => {
      const fileA = join(sessionsDir, "unknown.jsonl");
      // Should not throw.
      registry.updateSessionFile("unknown" as SessionId, fileA);
      expect(registry.getByFile(fileA)).toBeUndefined();
    });

    it("preserves ownership of the previous byFile slot when it points at a different session", () => {
      const fileA = join(sessionsDir, "shared.jsonl");
      fs.writeFileSync(fileA, "");
      const id1 = registry.openSession(workspaceDir, fileA);
      const id2 = registry.openSession(workspaceDir);
      // id1 owns fileA in byFile; move id2 to fileA — should free id1's
      // prior mapping (which is fileA) and re-claim it for id2.
      registry.updateSessionFile(id2, fileA);
      expect(registry.getByFile(fileA)?.sessionId).toBe(id2);
    });
  });
});

// ── Concurrency / lock-lifecycle (P1-d, P1-e, P1-f, P1-h, P2-b) ────────────
//
// These tests reproduce the close-during-activate race (P1-e), the queued-
// command hang on that race (P1-h), the onCompromised throw (P1-d), the
// failed-activation lock leak (P1-f), and the /reload host re-try (P2-b).
// They drive SessionHost via the __forkOverride test seam so waitForReady can
// be held open deterministically — the exact window closeSession races.

describe("SessionRegistry concurrency & lock lifecycle", () => {
  let registry: SessionRegistry;
  let statusChanges: Array<{
    sessionId: SessionId;
    status: SessionStatus;
    error?: string | undefined;
  }>;
  let panelEvents: Array<{ sessionId: SessionId; event: PanelEvent }>;
  let fakeHost: FakeHostProcess;
  let sessionsDir: string;
  let workspaceDir: string;

  beforeAll(() => {
    registry = new SessionRegistry(
      () => {},
      () => {},
      (sessionId, status, error) => {
        statusChanges.push({ sessionId, status, error: error });
      },
      (sessionId, event) => {
        panelEvents.push({ sessionId, event });
      },
      () => {
        // unified submit requests — ignored in test
      },
    );
  });

  beforeEach(() => {
    statusChanges = [];
    panelEvents = [];
    fakeHost = new FakeHostProcess();
    __forkOverride.fn = () =>
      fakeHost as unknown as ReturnType<typeof import("node:child_process").fork>;
    sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-conc-sess-"));
    workspaceDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-conc-ws-"));
  });

  afterEach(() => {
    __forkOverride.fn = null;
    for (const rec of registry.getAll()) registry.closeSession(rec.sessionId);
  });

  it("P1-e: closeSession during host activation cancels the spawn (no orphaned proc, no zombie record)", async () => {
    // A session file makes activateSession await the advisory lock; in host
    // mode it then awaits waitForReady. closeSession racing that window must
    // NOT leave a spawned host process attached to a deleted record.
    const file = join(sessionsDir, "race-close.jsonl");
    fs.writeFileSync(file, "");
    const id = registry.openSession(workspaceDir, file);

    // Kick off activation (host mode) but don't await — waitForReady is held
    // open because the fake host never emits ready.
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    // Let the lock acquire + host construct + waitForReady start.
    await new Promise((r) => setTimeout(r, 50));
    // No fallback yet (host hasn't failed).
    expect(panelEvents.some((p) => p.event.type === "host_fallback")).toBe(false);

    // Close mid-activation. SessionHost.stop() kills the host → exit fires →
    // waitForReady rejects → the host-failure catch runs. BUGGY: the catch
    // emits host_fallback AND spawns a PiProcess fallback onto the deleted
    // record (orphan). FIXED: the _dead cancellation preempts the catch, so
    // NEITHER happens.
    registry.closeSession(id);

    // Let the activation settle (waitForReady rejects via kill → exit).
    await activating;
    await new Promise((r) => setTimeout(r, 30));

    // The record is gone and stayed gone.
    expect(registry.getSession(id)).toBeUndefined();
    expect(fakeHost.killed).toBe(true);
    // CRITICAL assertion: the host-failure fallback did NOT run after close.
    // On the buggy code, the catch fires host_fallback despite the session
    // being closed — that's the orphan. On the fixed code, _dead preempts it.
    expect(panelEvents.some((p) => p.event.type === "host_fallback")).toBe(false);
  }, 15_000);

  it("P1-h: a command queued during activation rejects (does not hang) when the session is closed mid-activation", async () => {
    const file = join(sessionsDir, "race-queue.jsonl");
    fs.writeFileSync(file, "");
    const id = registry.openSession(workspaceDir, file);

    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    await new Promise((r) => setTimeout(r, 50));

    // A command arrives while activation is in flight → it queues.
    const cmdPromise = registry.sendCommand(id, { type: "get_state" });

    // Close the session mid-activation. The queued command MUST reject (not
    // hang forever). Before the fix, closeSession deleted the record without
    // rejecting the queue, so cmdPromise never settled.
    registry.closeSession(id);

    await expect(cmdPromise).rejects.toThrow(/closed|No active process|exited/i);
    await activating;
  }, 15_000);

  it("clears host busy, retry, and interrupt state on agent_settled", async () => {
    const id = registry.openSession(workspaceDir);
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    await new Promise((r) => setTimeout(r, 30));
    fakeHost.emitReady("0.80.6");
    await activating;

    fakeHost.emitMessage({ type: "event", event: { type: "agent_start" } });
    fakeHost.emitMessage({
      type: "event",
      event: { type: "interrupt_state", interruptible: true, operation: "agent" },
    });
    fakeHost.emitMessage({
      type: "event",
      event: { type: "agent_end", willRetry: true },
    });
    expect(registry.getSession(id)).toMatchObject({
      busy: true,
      retryPending: true,
      interruptible: true,
    });

    fakeHost.emitMessage({ type: "event", event: { type: "agent_settled" } });
    fakeHost.emitMessage({
      type: "event",
      event: { type: "interrupt_state", interruptible: false },
    });
    fakeHost.emitMessage({
      type: "event",
      event: { type: "streaming_state", isStreaming: false },
    });
    expect(registry.getSession(id)).toMatchObject({
      busy: false,
      retryPending: false,
      interruptible: false,
    });
  });

  it("ignores an old agent_settled after an extension handler starts a new run", async () => {
    const id = registry.openSession(workspaceDir);
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    await new Promise((r) => setTimeout(r, 30));
    fakeHost.emitReady("0.80.6");
    await activating;

    fakeHost.emitMessage({ type: "event", event: { type: "agent_start" } });
    fakeHost.emitMessage({ type: "event", event: { type: "agent_end", willRetry: false } });
    fakeHost.emitMessage({ type: "event", event: { type: "agent_start" } });
    fakeHost.emitMessage({
      type: "event",
      event: { type: "interrupt_state", interruptible: true, operation: "agent" },
    });
    fakeHost.emitMessage({ type: "event", event: { type: "agent_settled" } });

    expect(registry.getSession(id)).toMatchObject({
      busy: true,
      retryPending: false,
      interruptible: true,
    });
  });

  it("keeps host busy after agent_end and preserves a newer bash interrupt at settlement", async () => {
    const id = registry.openSession(workspaceDir);
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    await new Promise((r) => setTimeout(r, 30));
    fakeHost.emitReady("0.80.6");
    await activating;

    fakeHost.emitMessage({ type: "event", event: { type: "agent_start" } });
    fakeHost.emitMessage({
      type: "event",
      event: { type: "streaming_state", isStreaming: true },
    });
    fakeHost.emitMessage({ type: "event", event: { type: "agent_end", willRetry: false } });
    expect(registry.getSession(id)?.busy).toBe(true);

    fakeHost.emitMessage({
      type: "event",
      event: { type: "interrupt_state", interruptible: true, operation: "bash" },
    });
    fakeHost.emitMessage({ type: "event", event: { type: "agent_settled" } });
    fakeHost.emitMessage({
      type: "event",
      event: { type: "streaming_state", isStreaming: false },
    });

    expect(registry.getSession(id)).toMatchObject({
      busy: true,
      interruptible: true,
      interruptKind: "bash",
    });
  });

  it("P1-i: commands during the host handshake are queued, not bounced with 'Not initialized'", async () => {
    // Host mode assigns record.proc = hostProc BEFORE waitForReady (so the
    // trust dialog can round-trip). The renderer fires its init commands
    // (get_state/get_available_models/get_session_stats) the moment status
    // flips to "starting" — i.e. mid-handshake. Those MUST queue until the host
    // finishes initializing; routing them to the not-yet-ready host makes it
    // reply "Not initialized" (the dev-time error this reproduces). The fake
    // now models that bounce (host.mjs:340), so a routing regression fails here
    // instead of silently buffering.
    const file = join(sessionsDir, "init-window.jsonl");
    fs.writeFileSync(file, "");
    const id = registry.openSession(workspaceDir, file);

    // Kick off host activation; do NOT emit ready yet — the handshake is open.
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    // Let the lock acquire + host construct; record.proc is set (pre-ready).
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.getSession(id)?.proc).toBeDefined(); // assigned early…
    expect(registry.getSession(id)?._procReady).not.toBe(true); // …but not ready

    // A command arrives mid-handshake. It must be QUEUED, not sent to the host.
    const cmdPromise = registry.sendCommand(id, { type: "get_state" });
    await new Promise((r) => setTimeout(r, 20));
    // The fake host must NOT have received any command yet (it was queued).
    // Before the fix, rec.proc was truthy so sendCommand routed straight to the
    // un-initialized host → "Not initialized".
    expect(fakeHost.sent.some((m) => m.type === "command")).toBe(false);

    // Host finishes initializing → queued command flushes to the live host.
    fakeHost.emitReady("0.81.0");
    await activating;
    await waitFor(() => fakeHost.sent.some((m) => m.type === "command"), 2000, "flushed command");

    // Respond to the now-flushed command and confirm it resolves successfully —
    // NOT rejected with "Not initialized".
    const cmdMsg = fakeHost.sent.find((m) => m.type === "command");
    if (!cmdMsg) throw new Error("expected a flushed command in fakeHost.sent");
    fakeHost.emitMessage({ type: "response", id: cmdMsg.id, success: true, data: { ok: true } });
    await expect(cmdPromise).resolves.toMatchObject({ success: true });
  }, 15_000);

  it("worktree respawn during host handshake keeps queued commands off the old cwd proc", async () => {
    const firstHost = new FakeHostProcess();
    const secondHost = new FakeHostProcess();
    const hosts = [firstHost, secondHost];
    __forkOverride.fn = () =>
      hosts.shift() as unknown as ReturnType<typeof import("node:child_process").fork>;

    const worktreeDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-pending-wt-")));
    const id = registry.openSession(workspaceDir);
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    await new Promise((r) => setTimeout(r, 30));

    const command = registry.sendCommand(id, { type: "prompt", message: "run in worktree" });
    const respawn = registry.setWorktreeAndRespawn(id, worktreeDir, FAKE_PI, {});
    await new Promise((r) => setTimeout(r, 30));

    firstHost.emitReady("0.81.0");
    await activating;
    await new Promise((r) => setTimeout(r, 30));
    expect(firstHost.sent.some((m) => m.type === "command")).toBe(false);

    secondHost.emitReady("0.81.0");
    await respawn;
    await waitFor(
      () => secondHost.sent.some((m) => m.type === "command"),
      2000,
      "new host command",
    );
    const cmd = secondHost.sent.find((m) => m.type === "command");
    if (!cmd) throw new Error("expected queued command to flush to replacement host");
    secondHost.emitMessage({ type: "response", id: cmd.id, success: true, data: { ok: true } });
    await expect(command).resolves.toMatchObject({ success: true });

    expect(secondHost.sent.find((m) => m.type === "init")?.cwd).toBe(worktreeDir);
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }, 15_000);

  it("reloadSession during host handshake waits for quiescence and does not emit host_fallback", async () => {
    const firstHost = new FakeHostProcess();
    const secondHost = new FakeHostProcess();
    const hosts = [firstHost, secondHost];
    __forkOverride.fn = () =>
      hosts.shift() as unknown as ReturnType<typeof import("node:child_process").fork>;

    const id = registry.openSession(workspaceDir);
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    await new Promise((r) => setTimeout(r, 30));

    const reloadP = registry.reloadSession(id, FAKE_PI, {});
    await new Promise((r) => setTimeout(r, 30));
    expect(secondHost.sent).toHaveLength(0);

    firstHost.emitReady("0.81.0");
    await activating;
    await new Promise((r) => setTimeout(r, 30));
    secondHost.emitReady("0.81.0");
    await reloadP;

    expect(panelEvents.some((p) => p.event.type === "host_fallback")).toBe(false);
    expect(registry.getSession(id)?.proc).toBeInstanceOf(SessionHost);
  }, 15_000);

  it("overlapping worktree respawns are serialized so final cwd matches final worktree", async () => {
    const initialHost = new FakeHostProcess();
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const hosts = [initialHost, hostA, hostB];
    __forkOverride.fn = () =>
      hosts.shift() as unknown as ReturnType<typeof import("node:child_process").fork>;

    const worktreeA = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-conc-wt-a-")));
    const worktreeB = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-conc-wt-b-")));
    const id = registry.openSession(workspaceDir);
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    await new Promise((r) => setTimeout(r, 30));

    const respawnA = registry.setWorktreeAndRespawn(id, worktreeA, FAKE_PI, {});
    const respawnB = registry.setWorktreeAndRespawn(id, worktreeB, FAKE_PI, {});

    initialHost.emitReady("0.81.0");
    await activating;
    await waitFor(() => hostA.sent.some((m) => m.type === "init"), 2000, "host A init");
    hostA.emitReady("0.81.0");
    await respawnA;
    await waitFor(() => hostB.sent.some((m) => m.type === "init"), 2000, "host B init");
    hostB.emitReady("0.81.0");
    await respawnB;

    expect(hostA.sent.find((m) => m.type === "init")?.cwd).toBe(worktreeA);
    expect(hostB.sent.find((m) => m.type === "init")?.cwd).toBe(worktreeB);
    expect(registry.getSession(id)?.worktreePath).toBe(worktreeB);
    expect(registry.getSession(id)?.proc).toBeInstanceOf(SessionHost);
    fs.rmSync(worktreeA, { recursive: true, force: true });
    fs.rmSync(worktreeB, { recursive: true, force: true });
  }, 15_000);

  it("setWorktreeAndRespawn during host handshake respawns host in the worktree cwd", async () => {
    const firstHost = new FakeHostProcess();
    const secondHost = new FakeHostProcess();
    const hosts = [firstHost, secondHost];
    __forkOverride.fn = () =>
      hosts.shift() as unknown as ReturnType<typeof import("node:child_process").fork>;

    const worktreeDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-conc-wt-")));
    const id = registry.openSession(workspaceDir);
    const activating = registry.activateSession(id, FAKE_PI, {}, true);
    await new Promise((r) => setTimeout(r, 30));

    const respawnP = registry.setWorktreeAndRespawn(id, worktreeDir, FAKE_PI, {});
    await new Promise((r) => setTimeout(r, 30));
    expect(secondHost.sent).toHaveLength(0);

    firstHost.emitReady("0.81.0");
    await activating;
    await new Promise((r) => setTimeout(r, 30));
    secondHost.emitReady("0.81.0");
    await respawnP;

    const init = secondHost.sent.find((m) => m.type === "init");
    expect(init?.cwd).toBe(worktreeDir);
    expect(registry.getSession(id)?.worktreePath).toBe(worktreeDir);
    expect(registry.getSession(id)?.proc).toBeInstanceOf(SessionHost);
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }, 15_000);

  it("P1-d: a compromised advisory lock does not throw in the main process", async () => {
    // proper-lockfile's default onCompromised throws, which fires from a
    // setTimeout (recurring update timer) when the lockfile mtime is
    // compromised. Simulate a compromise right after lock acquire and assert
    // no throw escapes into the main process.
    const file = join(sessionsDir, "compromised.jsonl");
    fs.writeFileSync(file, "");
    const id = registry.openSession(workspaceDir, file);

    // Spy on the lock options to capture onCompromised and invoke it after lock.
    const origLock = lockfile.lock.bind(lockfile);
    let capturedOnCompromised: ((err: Error) => void) | null = null;
    // biome-ignore lint/suspicious/noExplicitAny: proper-lockfile's opts type isn't exported; this is a test spy.
    const lockSpy = (target: string, opts: any) => {
      capturedOnCompromised = opts.onCompromised;
      return origLock(target, opts);
    };
    // biome-ignore lint/suspicious/noExplicitAny: cast to install the spy on the singleton.
    (lockfile as any).lock = lockSpy;

    let threw = false;
    try {
      await registry.activateSession(id, FAKE_PI, {}, false);
      // Fire onCompromised as proper-lockfile's update timer would.
      const handler = capturedOnCompromised as ((err: Error) => void) | null;
      expect(handler).not.toBeNull();
      try {
        handler!(new Error("lock compromised by another process"));
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      // _hasLock is cleared so we don't try to unlock a lock we've lost.
      expect(registry.getSession(id)?._hasLock).toBe(false);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore the singleton.
      (lockfile as any).lock = origLock;
    }
  }, 15_000);

  it("stopAll stops live processes and releases advisory locks", async () => {
    const file = join(sessionsDir, "stop-all.jsonl");
    fs.writeFileSync(file, "");
    const id = registry.openSession(workspaceDir, file);
    await registry.activateSession(id, FAKE_PI, {}, false);
    expect(fs.existsSync(`${file}.lock`)).toBe(true);

    registry.stopAll();
    await waitFor(() => !fs.existsSync(`${file}.lock`), 2000, "lock released by stopAll");
    expect(registry.getSession(id)?.proc).toBeUndefined();
    expect(registry.getSession(id)?._procReady).toBe(false);
  }, 15_000);

  it("P1-f: a failed activation releases the advisory lock (no leak)", async () => {
    const file = join(sessionsDir, "failed-activate.jsonl");
    fs.writeFileSync(file, "");
    const id = registry.openSession(workspaceDir, file);

    // P1-f: a FULLY-failed activation (no fallback) must release the advisory
    // lock in the finally, not leak it. Force a full failure by making the
    // PiProcess spawn fail synchronously: a non-existent cwd makes spawn
    // emit 'error' immediately, the proc never reaches ready, and (since
    // useHost=false, no host fallback) activateSession's status lands
    // "failed". Before the fix, _hasLock stayed true and the lockfile +
    // proper-lockfile's recurring update timer leaked until closeSession.
    const lockPath = `${file}.lock`;
    // Nonexistent piPath → PiProcess spawn ENOENT → 'error' event → status
    // "failed" (async). No host fallback (useHost=false). Before P1-f, the
    // async-failure path never released the lock, leaking the lockfile +
    // proper-lockfile's recurring update timer.
    await registry.activateSession(id, "/no/such/pi-binary", {}, false).catch(() => {});
    // Let the spawn 'error' event + status transition settle.
    await new Promise((r) => setTimeout(r, 150));

    // The lockfile must be gone (exit/error listener released it).
    expect(fs.existsSync(lockPath)).toBe(false);
    // And _hasLock cleared.
    expect(registry.getSession(id)?._hasLock).not.toBe(true);
  }, 15_000);

  it("P2-b: reloadSession re-tries the host after a prior fallback (user upgraded pi)", async () => {
    // First activation: host fails (exit 42, version too low) → fallback to
    // pi --mode rpc, _useHost reset to false. Then the user upgrades pi and
    // hits /reload — which should re-try the host (useHost=true), not stay
    // permanently on rpc.
    const id = registry.openSession(workspaceDir);
    // Host exits with code 42 (version too low) immediately.
    const failHost = new FakeHostProcess();
    __forkOverride.fn = () =>
      failHost as unknown as ReturnType<typeof import("node:child_process").fork>;
    const activateP = registry.activateSession(id, FAKE_PI, {}, true);
    // Let the host construct, then fail it.
    await new Promise((r) => setTimeout(r, 30));
    failHost.emitExit(42);
    await activateP;
    // Fallback to PiProcess occurred:
    expect(panelEvents.some((p) => p.event.type === "host_fallback")).toBe(true);

    // Now the fake host succeeds on retry (simulating a pi upgrade).
    const okHost = new FakeHostProcess();
    __forkOverride.fn = () =>
      okHost as unknown as ReturnType<typeof import("node:child_process").fork>;
    // reloadSession awaits activateSession → waitForReady, so we must emit
    // ready while it's in flight, not after. Kick it off, then ready the host.
    const reloadP = registry.reloadSession(id, FAKE_PI, {});
    await new Promise((r) => setTimeout(r, 40)); // host constructs, waitForReady pending
    okHost.emitReady("0.81.0");
    await reloadP;
    await new Promise((r) => setTimeout(r, 30));
    // After reload, the session is running a SessionHost (panels available),
    // NOT stuck on the rpc fallback.
    const rec = registry.getSession(id);
    expect(rec?.proc).toBeInstanceOf(SessionHost);
    expect(rec?._useHost).toBe(true);
  }, 15_000);
});
