import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionId } from "@shared/ids.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";
import type {
  AgentSessionSnapshot,
  AuthorityFrame,
  IntentEnvelope,
  SessionRuntimeResumeState,
} from "@shared/pi-protocol/runtime-state.js";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHostProcess } from "../../../tests/fixtures/fake-host-process.mjs";
import {
  HostRequestTimeoutError,
  __forkOverride,
  confinedSessionRuntimeStrategyForPlatform,
} from "../pi/session-host.js";
import { type SessionRecord, SessionRegistry } from "./session-registry.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const runtimeIdentity = (record: NonNullable<ReturnType<SessionRegistry["getSession"]>>) =>
  [record.proc!.hostInstanceId!, record.proc!.sessionEpoch] as const;

function publishRuntimeResumeCheckpoint(
  record: NonNullable<ReturnType<SessionRegistry["getSession"]>>,
  state: SessionRuntimeResumeState,
  transportSequence = 1,
): void {
  const owner = {
    hostInstanceId: record.proc!.hostInstanceId!,
    sessionEpoch: record.proc!.sessionEpoch,
  };
  record.proc!.emit("authorityFrame", {
    owner,
    transportSequence,
    frameId: `resume-checkpoint-${transportSequence}`,
    records: [],
    // This registry test exercises opaque continuation custody. SessionHost
    // schema validation and state-authority frame construction are covered in
    // their focused suites.
    terminalSnapshot: {} as AuthorityFrame["terminalSnapshot"],
    runtimeResumeState: structuredClone(state),
  });
}

function persistedSessionFixture(id: string): { root: string; sessionFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pivis-${id}-`));
  const sessionFile = path.join(root, "session.jsonl");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: new Date().toISOString(),
      cwd: root,
    })}\n`,
  );
  return { root, sessionFile };
}

function harness(
  options: {
    failStartupAt?: number[];
    configureFake?: (fake: FakeHostProcess, spawnIndex: number) => void;
    unifiedClaimTimeoutMs?: number;
    initialSessionFile?: string;
  } = {},
) {
  const runtimeStates: unknown[] = [];
  const events: unknown[] = [];
  const statuses: unknown[] = [];
  const unifiedRequests: unknown[] = [];
  const restorations: unknown[] = [];
  const uiRequests: unknown[] = [];
  const uiAcknowledgements: unknown[] = [];
  const panelEvents: unknown[] = [];
  const submissions: unknown[] = [];
  const readyLocks: boolean[] = [];
  const availableRuntimeLocks: boolean[] = [];
  const fileChanges: unknown[] = [];
  const fakes: FakeHostProcess[] = [];
  const spawnArgs: string[][] = [];
  const spawnCwds: Array<string | undefined> = [];
  const spawnStdios: unknown[] = [];
  __forkOverride.fn = (_path, args, forkOptions) => {
    const spawnIndex = fakes.length;
    spawnArgs.push(args);
    spawnCwds.push((forkOptions as { cwd?: string }).cwd);
    spawnStdios.push((forkOptions as { stdio?: unknown }).stdio);
    const fake = new FakeHostProcess();
    options.configureFake?.(fake, spawnIndex);
    fakes.push(fake);
    fake.on("message", (message) => {
      if ((message as { type?: string }).type !== "init") return;
      if (options.initialSessionFile) {
        const readyAfterPermit = (permit: {
          type?: string;
          allowed?: boolean;
        }) => {
          if (permit.type !== "initial_session_file_permit") return;
          fake.off("message", readyAfterPermit);
          queueMicrotask(() => {
            if (permit.allowed) fake.emitReady("0.80.6");
            else fake.emitError("initial session-file lock denied");
          });
        };
        fake.on("message", readyAfterPermit);
        // SessionRegistry attaches host listeners immediately after
        // construction, before the real child can finish runtime creation.
        queueMicrotask(() => {
          fake.emitWire({
            type: "initial_session_file",
            sessionFile: options.initialSessionFile,
          });
        });
        return;
      }
      queueMicrotask(() => {
        if (options.failStartupAt?.includes(spawnIndex)) fake.emitError("direct host unavailable");
        else fake.emitReady("0.80.6");
      });
    });
    return fake as never;
  };
  const registry = new SessionRegistry(
    (_sid, event) => events.push(event),
    (...args) => uiRequests.push(args),
    (sid, status, ...rest) => {
      statuses.push([sid, status, ...rest]);
      if (status === "ready") readyLocks.push(registry.getSession(sid)?._hasLock === true);
    },
    (...args) => panelEvents.push(args),
    (...args) => unifiedRequests.push(args),
    (sid, state) => {
      runtimeStates.push(state);
      if (state.availability === "available")
        availableRuntimeLocks.push(registry.getSession(sid)?._hasLock === true);
    },
    (...args) => submissions.push(args),
    (...args) => restorations.push(args),
    (...args) => uiAcknowledgements.push(args),
    () => {},
    {
      ...(options.unifiedClaimTimeoutMs !== undefined
        ? { unifiedClaimTimeoutMs: options.unifiedClaimTimeoutMs }
        : {}),
    },
    () => {},
    (...args) => fileChanges.push(args),
  );
  return {
    registry,
    runtimeStates,
    events,
    statuses,
    unifiedRequests,
    restorations,
    submissions,
    uiRequests,
    uiAcknowledgements,
    panelEvents,
    readyLocks,
    availableRuntimeLocks,
    fileChanges,
    fakes,
    spawnArgs,
    spawnCwds,
    spawnStdios,
  };
}

function expectDirectHostSpawns(spawnArgs: string[][], count: number): void {
  expect(spawnArgs).toHaveLength(count);
  expect(spawnArgs.every((args) => args.length === 0)).toBe(true);
  expect(spawnArgs.flat()).not.toContain("--mode");
  expect(spawnArgs.flat()).not.toContain("rpc");
}

beforeEach(() => {
  __forkOverride.fn = null;
});

afterEach(() => {
  __forkOverride.fn = null;
});

describe("SessionRegistry direct AgentSession authority", () => {
  it("silently closes cold sessions", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");

    await h.registry.closeSessionGracefully(id);

    expect(h.registry.getSession(id)).toBeUndefined();
  });

  it("shares stopAll and waits for every detached host to exit", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const fake = h.fakes[0]!;
    vi.spyOn(fake, "disconnect").mockImplementation(() => {
      fake.disconnectCalls++;
      fake.connected = false;
      fake.emit("disconnect");
    });

    const first = h.registry.stopAll();
    const reentrant = h.registry.stopAll();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await tick();

    expect(reentrant).toBe(first);
    expect(fake.disconnectCalls).toBe(1);
    expect(settled).toBe(false);
    expect(() => h.registry.openSession("/tmp/too-late")).toThrow(
      "Session registry is shutting down",
    );

    fake.emitExit(0);
    await first;

    expect(h.registry.getSession(id)).toBeUndefined();
    expect(settled).toBe(true);
  });

  it("waits for a shutdown-racing lock acquisition to finish its compensating unlock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pivis-stop-lock-race-"));
    const sessionFile = path.join(dir, "session.jsonl");
    await writeFile(sessionFile, "");
    let releaseLockAcquisition!: () => void;
    const lockAcquisition = new Promise<void>((resolve) => {
      releaseLockAcquisition = resolve;
    });
    let releaseUnlock!: () => void;
    const unlock = new Promise<void>((resolve) => {
      releaseUnlock = resolve;
    });
    const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async () => {
      await lockAcquisition;
      return async () => {};
    });
    const unlockSpy = vi.spyOn(lockfile, "unlock").mockImplementation(async () => {
      await unlock;
    });
    const h = harness();
    const id = h.registry.openSession(dir, sessionFile);
    try {
      const activation = h.registry.activateSession(id, "/tmp/pi", {});
      await vi.waitFor(() => expect(lockSpy).toHaveBeenCalledOnce());

      const stopping = h.registry.stopAll();
      let settled = false;
      void stopping.then(() => {
        settled = true;
      });
      await tick();
      expect(settled).toBe(false);

      releaseLockAcquisition();
      await vi.waitFor(() => expect(unlockSpy).toHaveBeenCalledOnce());
      expect(settled).toBe(false);

      releaseUnlock();
      await stopping;
      await activation;
      expect(h.registry.getSession(id)).toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      releaseLockAcquisition();
      releaseUnlock();
      lockSpy.mockRestore();
      unlockSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for real-host controls without the explicit test environment", async () => {
    const h = harness();
    const prior = process.env.PIVIS_TEST_REAL_HOST_CONTROL;
    delete process.env.PIVIS_TEST_REAL_HOST_CONTROL;
    try {
      await expect(h.registry.testControl("missing" as SessionId, "kill")).resolves.toEqual({
        status: "disabled",
      });
    } finally {
      if (prior !== undefined) process.env.PIVIS_TEST_REAL_HOST_CONTROL = prior;
    }
  });

  it("acknowledges a test-only host kill only after the bounded replacement is ready", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const predecessor = h.registry.getSession(id)!.proc!;
    const prior = process.env.PIVIS_TEST_REAL_HOST_CONTROL;
    process.env.PIVIS_TEST_REAL_HOST_CONTROL = "1";
    try {
      const result = await h.registry.testControl(id, "kill", 1_000);
      expect(result.status).toBe("restarted");
      if (result.status !== "restarted") throw new Error("host did not restart");
      expect(predecessor.exitCode).toBe(143);
      expect(h.registry.getSession(id)!.proc).not.toBe(predecessor);
      expect(result.owner).toEqual({
        hostInstanceId: h.registry.getSession(id)!.snapshot!.hostInstanceId,
        sessionEpoch: h.registry.getSession(id)!.snapshot!.sessionEpoch,
      });
    } finally {
      if (prior === undefined) delete process.env.PIVIS_TEST_REAL_HOST_CONTROL;
      else process.env.PIVIS_TEST_REAL_HOST_CONTROL = prior;
      h.registry.stopAll();
    }
  });

  it("escapes a streaming host from a fresh direct snapshot before force close", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    // The cached snapshot is deliberately stale; close eligibility comes only
    // from the direct child snapshot requested at the close boundary.
    record.snapshot = { ...record.snapshot!, isStreaming: false, isIdle: true };
    h.fakes[0]!.runtime.isStreaming = true;
    h.fakes[0]!.runtime.isIdle = false;
    const escapeRequest = vi.spyOn(record.proc!, "escape");
    const forceClose = vi.spyOn(record.proc!, "forceClose");

    await h.registry.closeSessionGracefully(id);

    expect(escapeRequest).toHaveBeenCalledOnce();
    expect(forceClose).toHaveBeenCalledOnce();
    expect(escapeRequest.mock.invocationCallOrder[0]).toBeLessThan(
      forceClose.mock.invocationCallOrder[0]!,
    );
    expect(h.registry.getSession(id)).toBeUndefined();
  });

  it("forces cleanup when the best-effort streaming escape fails", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    h.fakes[0]!.runtime.isStreaming = true;
    h.fakes[0]!.runtime.isIdle = false;
    const escapeRequest = vi
      .spyOn(record.proc!, "escape")
      .mockRejectedValue(new Error("abort failed"));
    const forceClose = vi
      .spyOn(record.proc!, "forceClose")
      .mockRejectedValue(new Error("child unavailable"));

    await h.registry.closeSessionGracefully(id);

    expect(escapeRequest).toHaveBeenCalledOnce();
    expect(forceClose).toHaveBeenCalledOnce();
    expect(escapeRequest.mock.invocationCallOrder[0]).toBeLessThan(
      forceClose.mock.invocationCallOrder[0]!,
    );
    expect(h.registry.getSession(id)).toBeUndefined();
    expect(h.fakes[0]!.disconnectCalls).toBe(1);
    expect(h.fakes[0]!.exitCode).toBe(0);
    expect(h.fakes[0]!.killed).toBe(false);
  });

  it("forces cleanup when the best-effort streaming escape times out", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const snapshot = { ...record.snapshot!, isStreaming: true, isIdle: false };
    vi.spyOn(record.proc!, "requestSnapshot").mockResolvedValue(snapshot);
    const escapeRequest = vi
      .spyOn(record.proc!, "escape")
      .mockImplementation(() => new Promise(() => {}));
    const forceClose = vi.spyOn(record.proc!, "forceClose").mockResolvedValue();

    vi.useFakeTimers();
    try {
      const closing = h.registry.closeSessionGracefully(id);
      await vi.advanceTimersByTimeAsync(251);
      await closing;
    } finally {
      vi.useRealTimers();
    }

    expect(escapeRequest).toHaveBeenCalledOnce();
    expect(forceClose).toHaveBeenCalledOnce();
    expect(escapeRequest.mock.invocationCallOrder[0]).toBeLessThan(
      forceClose.mock.invocationCallOrder[0]!,
    );
    expect(h.registry.getSession(id)).toBeUndefined();
  });

  it("uses only the SDK host and never spawns an rpc argv", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    expectDirectHostSpawns(h.spawnArgs, 1);
    expect(h.registry.getSession(id)?.proc).toBeDefined();
    h.registry.stopAll();
  });

  it("pins a validated search file descriptor through cold host activation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-confined-activation-"));
    const file = path.join(root, "session.jsonl");
    fs.writeFileSync(file, '{"type":"session","id":"pinned"}\n');
    const descriptor = fs.openSync(file, "r");
    // The real child projects the canonical source supplied alongside its
    // internal runtime pin. Model that explicit field here; the real Pi
    // repeated-open behavior is covered at the state-authority boundary.
    const h = harness({
      configureFake: (fake) => {
        Object.assign(fake.runtime, { sessionFile: file });
      },
    });
    try {
      const id = h.registry.openSession(root, file);
      expect(h.registry.adoptConfinedSessionDescriptor(id, file, descriptor, root)).toBe(true);
      await h.registry.activateSession(id, "/tmp/pi", {});

      const hostDescriptor = (h.spawnStdios[0] as Array<string | number> | undefined)?.[4];
      const init = h.fakes[0]?.sent[0] as
        | { type?: string; sessionFile?: string; canonicalSessionFile?: string }
        | undefined;
      const strategy = confinedSessionRuntimeStrategyForPlatform(process.platform);
      let runtimeAlias: string | undefined;
      if (strategy === "inherited-descriptor") {
        expect(hostDescriptor).toEqual(expect.any(Number));
        expect(hostDescriptor).not.toBe(descriptor);
        expect(init).toMatchObject({
          type: "init",
          sessionFile: "/proc/self/fd/4",
          canonicalSessionFile: file,
        });
      } else {
        expect(hostDescriptor).toBeUndefined();
        expect(h.spawnStdios[0]).toEqual(["pipe", "pipe", "pipe", "ipc"]);
        expect(init).toMatchObject({ type: "init", canonicalSessionFile: file });
        runtimeAlias = init?.sessionFile;
        expect(runtimeAlias?.startsWith(path.join(root, ".pivis-session-"))).toBe(true);
        expect(fs.statSync(runtimeAlias!).ino).toBe(fs.statSync(file).ino);
      }
      expect(h.registry.getSession(id)?.snapshot?.sessionFile).toBe(file);
      expect(() => fs.fstatSync(descriptor)).toThrow();
      await h.registry.closeSessionGracefully(id);
      if (typeof hostDescriptor === "number") {
        expect(() => fs.fstatSync(hostDescriptor)).toThrow();
      }
      if (runtimeAlias) expect(fs.existsSync(runtimeAlias)).toBe(false);
    } finally {
      h.registry.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a confined search source replaced before cold activation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-confined-race-"));
    const file = path.join(root, "session.jsonl");
    const displaced = path.join(root, "displaced.jsonl");
    fs.writeFileSync(file, '{"type":"session","id":"original"}\n');
    const descriptor = fs.openSync(file, "r");
    const h = harness();
    try {
      const id = h.registry.openSession(root, file, undefined, descriptor, root);
      fs.renameSync(file, displaced);
      fs.writeFileSync(file, '{"type":"session","id":"replacement"}\n');

      await expect(h.registry.activateSession(id, "/tmp/pi", {})).rejects.toThrow(
        "changed while it was opened",
      );
      expect(h.fakes).toHaveLength(0);
      await h.registry.closeSessionGracefully(id);
    } finally {
      h.registry.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels an activation visit released before Pi discovery reaches the registry", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");

    await expect(h.registry.releaseActivationVisit(id, "visit-early")).resolves.toEqual({
      released: false,
    });
    await h.registry.activateSession(id, "/tmp/pi", {}, "visit-early");

    expect(h.fakes).toHaveLength(0);
    expect(h.registry.getSession(id)?.status).toBe("cold");
    h.registry.stopAll();
  });

  it("expires a release that never reaches activation and does not cancel a delayed arrival", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const id = h.registry.openSession("/tmp/project");
      await h.registry.releaseActivationVisit(id, "visit-expired");
      expect(h.registry.getSession(id)?._releasedActivationVisits.size).toBe(1);

      await vi.advanceTimersByTimeAsync(2_001);
      expect(h.registry.getSession(id)?._releasedActivationVisits.size).toBe(0);
      const activation = h.registry.activateSession(id, "/tmp/pi", {}, "visit-expired");
      await vi.runAllTicks();
      await activation;

      expect(h.fakes).toHaveLength(1);
      expect(h.registry.getSession(id)?.status).toBe("ready");
      h.registry.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases only the untouched cold-session activation visit", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {}, "visit-unused");
    const fake = h.fakes[0]!;

    await expect(h.registry.releaseActivationVisit(id, "visit-unused")).resolves.toEqual({
      released: true,
    });

    expect(fake.disconnectCalls).toBe(1);
    expect(fake.exitCode).toBe(0);
    expect(fake.killed).toBe(false);
    expect(h.registry.getSession(id)).toMatchObject({
      status: "cold",
      proc: undefined,
    });
    expect(h.panelEvents).toContainEqual([id, { type: "unified_panel_reset" }]);
    h.registry.stopAll();
  });

  it("retains the advisory lock until an activation-visit host actually exits", async () => {
    const { root, sessionFile } = persistedSessionFixture("activation-retirement-lock");
    const h = harness({
      configureFake: (fake, spawnIndex) => {
        if (spawnIndex !== 0) return;
        fake.disconnect = () => {
          if (!fake.connected) throw new Error("Host process IPC channel closed");
          fake.disconnectCalls++;
          fake.connected = false;
          fake.emit("disconnect");
        };
      },
    });
    const id = h.registry.openSession(root, sessionFile);
    try {
      await h.registry.activateSession(id, "/tmp/pi", {}, "visit-with-lock");
      const record = h.registry.getSession(id)!;
      const predecessor = h.fakes[0]!;

      const releasing = h.registry.releaseActivationVisit(id, "visit-with-lock");
      await vi.waitFor(() => expect(predecessor.disconnectCalls).toBe(1));

      expect(predecessor.exitCode).toBeNull();
      expect(record._hasLock).toBe(true);
      expect(record._retiringHost).toBeDefined();

      predecessor.emitExit(0);
      await expect(releasing).resolves.toEqual({ released: true });
      expect(record._hasLock).toBe(false);
      expect(record._retiringHost).toBeUndefined();
    } finally {
      h.registry.stopAll();
      await tick();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels an in-flight activation release when the user returns", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {}, "visit-returned");
    const fake = h.fakes[0]!;
    fake.autoRespondToStateRequests = false;

    const releasing = h.registry.releaseActivationVisit(id, "visit-returned");
    await vi.waitFor(() =>
      expect(fake.sent.some((message) => message.type === "state_request")).toBe(true),
    );
    expect(h.registry.cancelActivationVisitRelease(id, "visit-returned")).toBe(true);
    const request = [...fake.sent].reverse().find((message) => message.type === "state_request")!;
    fake.emitWire({
      type: "response",
      id: request.id,
      success: true,
      data: fake.snapshot(),
    });

    await expect(releasing).resolves.toEqual({ released: false });
    expect(h.registry.getSession(id)?.proc).toBeDefined();
    expect(fake.killed).toBe(false);
    h.registry.stopAll();
  });

  it("never releases a host that predated the activation visit", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.activateSession(id, "/tmp/pi", {}, "stale-visit");

    await expect(h.registry.releaseActivationVisit(id, "stale-visit")).resolves.toEqual({
      released: false,
    });
    expect(h.registry.getSession(id)?.proc).toBeDefined();
    expect(h.fakes[0]!.killed).toBe(false);
    h.registry.stopAll();
  });

  it("keeps a visit host after the immediate startup window or extension UI appears", async () => {
    const late = harness();
    const lateId = late.registry.openSession("/tmp/late");
    await late.registry.activateSession(lateId, "/tmp/pi", {}, "visit-late");
    late.registry.getSession(lateId)!._activationVisitStartedAt = Date.now() - 10_000;
    await expect(late.registry.releaseActivationVisit(lateId, "visit-late")).resolves.toEqual({
      released: false,
    });
    expect(late.registry.getSession(lateId)?.proc).toBeDefined();
    late.registry.stopAll();

    const panel = harness();
    const panelId = panel.registry.openSession("/tmp/panel");
    await panel.registry.activateSession(panelId, "/tmp/pi", {}, "visit-panel");
    panel.fakes[0]!.emitWire({
      type: "panel_open",
      panelId: 9,
      overlay: false,
      unified: true,
    });
    await expect(panel.registry.releaseActivationVisit(panelId, "visit-panel")).resolves.toEqual({
      released: false,
    });
    expect(panel.registry.getSession(panelId)?.proc).toBeDefined();
    panel.registry.stopAll();
  });

  it("keeps a visit host after editor interaction or fresh non-idle state", async () => {
    const edited = harness();
    const editedId = edited.registry.openSession("/tmp/edited");
    await edited.registry.activateSession(editedId, "/tmp/pi", {}, "visit-edited");
    const editedRecord = edited.registry.getSession(editedId)!;
    await edited.registry.applyEditorPatch(editedId, ...runtimeIdentity(editedRecord), {
      baseRevision: 0,
      revision: 1,
      text: "draft",
      attachments: [],
    });
    await expect(edited.registry.releaseActivationVisit(editedId, "visit-edited")).resolves.toEqual(
      { released: false },
    );
    expect(editedRecord.proc).toBeDefined();
    edited.registry.stopAll();

    const busy = harness();
    const busyId = busy.registry.openSession("/tmp/busy");
    await busy.registry.activateSession(busyId, "/tmp/pi", {}, "visit-busy");
    busy.fakes[0]!.runtime.isIdle = false;
    busy.fakes[0]!.runtime.isStreaming = true;
    await expect(busy.registry.releaseActivationVisit(busyId, "visit-busy")).resolves.toEqual({
      released: false,
    });
    expect(busy.registry.getSession(busyId)?.proc).toBeDefined();
    busy.registry.stopAll();
  });

  it("retains an activation visit when worktree work is admitted before replacement", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {}, "visit-worktree");

    h.registry.beginWorktreeSwitch(id);

    await expect(h.registry.releaseActivationVisit(id, "visit-worktree")).resolves.toEqual({
      released: false,
    });
    expect(h.registry.getSession(id)?.proc).toBeDefined();
    expect(h.fakes[0]!.killed).toBe(false);
    h.registry.stopAll();
  });

  it("suspends the registry snapshot lease for acknowledged provisional lifecycle UI", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const id = h.registry.openSession("/tmp/project");
      const activation = h.registry.activateSession(id, "/tmp/pi", {});
      await vi.runAllTicks();
      await activation;
      h.fakes[0]!.emitWire({
        type: "extension_ui_request",
        id: "slow-lifecycle",
        operationId: "slow-lifecycle",
        method: "confirm",
        title: "Lifecycle",
        message: "Continue?",
        provisionalEpoch: 1,
      });

      await vi.advanceTimersByTimeAsync(6_000);

      expect(h.registry.getSession(id)?.availability).toBe("available");
      expect(h.registry.getSession(id)?.leaseExpiresAt).toBeUndefined();
      h.registry.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a startup failure host-unavailable without spawning rpc argv", async () => {
    const h = harness({ failStartupAt: [0] });
    const id = h.registry.openSession("/tmp/project");
    await expect(h.registry.activateSession(id, "/tmp/pi", {})).rejects.toThrow(
      "direct host unavailable",
    );
    expectDirectHostSpawns(h.spawnArgs, 1);
    expect(h.registry.getSession(id)?.status).toBe("failed");
    expect(h.registry.getSession(id)?.proc).toBeUndefined();
    h.registry.stopAll();
  });

  it("reserves a pathless child-discovered file before available/ready publication and rejects a competing registry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pivis-initial-lock-"));
    const sessionFile = path.join(dir, "new.jsonl");
    await writeFile(sessionFile, "");
    const first = harness({ initialSessionFile: sessionFile });
    const firstId = first.registry.openSession(dir);
    expect(first.registry.canCreateInitialWorktree(firstId)).toBe(true);
    let second: ReturnType<typeof harness> | undefined;
    let secondId: SessionId | undefined;
    try {
      await first.registry.activateSession(firstId, "/tmp/pi", {});

      expect(first.registry.getSession(firstId)).toMatchObject({
        sessionFile: path.resolve(sessionFile),
        _lockPath: path.resolve(sessionFile),
        _hasLock: true,
        status: "ready",
      });
      expect(first.registry.canCreateInitialWorktree(firstId)).toBe(true);
      expect(first.availableRuntimeLocks.length).toBeGreaterThan(0);
      expect(first.availableRuntimeLocks.every(Boolean)).toBe(true);
      expect(first.readyLocks).toEqual([true]);
      expect(
        first.fakes[0]!.sent.find((message) => message.type === "initial_session_file_permit"),
      ).toMatchObject({ allowed: true });

      second = harness({ initialSessionFile: sessionFile });
      secondId = second.registry.openSession(dir);
      await expect(second.registry.activateSession(secondId, "/tmp/pi", {})).rejects.toThrow(
        "initial session-file lock denied",
      );
      expect(second.readyLocks).toEqual([]);
      expect(second.availableRuntimeLocks).toEqual([]);
      expect(
        second.fakes[0]!.sent.find((message) => message.type === "initial_session_file_permit"),
      ).toMatchObject({ allowed: false });

      // The rejected reservation is cleared by activation rollback. Once the
      // owner releases its lock, this same registry record may retry cleanly.
      first.registry.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await second.registry.activateSession(secondId, "/tmp/pi", {});
      expect(second.registry.getSession(secondId)).toMatchObject({
        _hasLock: true,
        _lockPath: path.resolve(sessionFile),
        status: "ready",
      });
    } finally {
      first.registry.stopAll();
      second?.registry.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retires fresh-worktree eligibility only after the first user message starts", async () => {
    const h = harness();
    const freshId = h.registry.openSession("/tmp/project");
    const resumedId = h.registry.openSession("/tmp/project", "/tmp/resumed.jsonl");
    expect(h.registry.canCreateInitialWorktree(freshId)).toBe(true);
    expect(h.registry.canCreateInitialWorktree(resumedId)).toBe(false);

    await h.registry.activateSession(freshId, "/tmp/pi", {});
    h.fakes[0]!.emitWire({
      type: "event",
      event: { type: "message_start", message: { role: "user", content: "hello" } },
    });
    await tick();

    expect(h.registry.canCreateInitialWorktree(freshId)).toBe(false);
    h.registry.stopAll();
  });

  it("fails closed when the primary advisory lock is compromised", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pivis-primary-compromise-"));
    const sessionFile = path.join(dir, "session.jsonl");
    await writeFile(sessionFile, "");
    const callbacks: Array<(error: Error) => void> = [];
    const originalLock = lockfile.lock;
    const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
      if (options?.onCompromised) callbacks.push(options.onCompromised);
      return originalLock(file, options);
    });
    const h = harness();
    const id = h.registry.openSession(dir, sessionFile);
    try {
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      expect(callbacks).toHaveLength(1);

      callbacks[0]!(new Error("primary lock lost"));

      expect(record).toMatchObject({
        _lockCompromised: true,
        availability: "unavailable",
        status: "failed",
        proc: undefined,
      });
      expect(h.fakes[0]!.disconnectCalls).toBe(1);
      await vi.waitFor(() => expect(h.fakes[0]!.exitCode).toBe(0));
      expect(h.fakes[0]!.killed).toBe(false);
      await expect(
        h.registry.dispatchIntent({
          sessionId: id,
          intentId: "after-primary-compromise",
          rendererGeneration: 0,
          expectedOwner: { hostInstanceId, sessionEpoch },
          intent: { kind: "interrupt" },
        }),
      ).resolves.toMatchObject({ status: "not_admitted" });
      expect(h.fakes[0]!.sent.some((message) => message.type === "intent_dispatch")).toBe(false);
    } finally {
      lockSpy.mockRestore();
      h.registry.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a reserved successor lock is compromised", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pivis-successor-compromise-"));
    const oldFile = path.join(dir, "old.jsonl");
    const nextFile = path.join(dir, "next.jsonl");
    await Promise.all([writeFile(oldFile, ""), writeFile(nextFile, "")]);
    const callbacks: Array<(error: Error) => void> = [];
    const originalLock = lockfile.lock;
    const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
      if (options?.onCompromised) callbacks.push(options.onCompromised);
      return originalLock(file, options);
    });
    const h = harness();
    const id = h.registry.openSession(dir, oldFile);
    try {
      await h.registry.activateSession(id, "/tmp/pi", {});
      const fake = h.fakes[0]!;
      const record = h.registry.getSession(id)!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      fake.emitControl({
        type: "transition_started",
        transitionId: "compromised-successor",
        provisionalEpoch: 1,
      });
      fake.emitWire({
        type: "transition_prepare",
        transitionId: "compromised-successor",
        phase: "prepare",
        kind: "switch",
        targetFile: nextFile,
      });
      await vi.waitFor(() => {
        expect(callbacks).toHaveLength(2);
        expect(
          fake.sent.some(
            (message) =>
              message.type === "transition_permit" &&
              message.transitionId === "compromised-successor" &&
              message.allowed === true,
          ),
        ).toBe(true);
      });

      callbacks[1]!(new Error("successor lock lost"));

      // A delayed valid-looking successor batch must not install its baseline
      // or transfer routing after the reserved lock is lost.
      fake.sessionEpoch = 1;
      const terminalSnapshot = { ...fake.snapshot(), sessionFile: nextFile };
      fake.emitWire({
        type: "transition_batch",
        batch: {
          transitionId: "compromised-successor",
          provisionalEpoch: 1,
          records: [],
          terminalSnapshot,
        },
      });
      await tick();

      expect(record).toMatchObject({
        _lockCompromised: true,
        availability: "unavailable",
        status: "failed",
        proc: undefined,
        sessionFile: oldFile,
      });
      expect(record.snapshot?.sessionEpoch).toBe(sessionEpoch);
      expect(h.fakes[0]!.disconnectCalls).toBe(1);
      await vi.waitFor(() => expect(h.fakes[0]!.exitCode).toBe(0));
      expect(h.fakes[0]!.killed).toBe(false);
      await expect(
        h.registry.dispatchIntent({
          sessionId: id,
          intentId: "after-successor-compromise",
          rendererGeneration: 0,
          expectedOwner: { hostInstanceId, sessionEpoch },
          intent: { kind: "interrupt" },
        }),
      ).resolves.toMatchObject({ status: "not_admitted" });
      expect(h.fakes[0]!.sent.some((message) => message.type === "intent_dispatch")).toBe(false);
    } finally {
      lockSpy.mockRestore();
      h.registry.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("atomically promotes a discovered different-file /new successor lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pivis-different-file-new-"));
    const oldFile = path.join(dir, "old.jsonl");
    const nextFile = path.join(dir, "next.jsonl");
    await Promise.all([writeFile(oldFile, ""), writeFile(nextFile, "")]);
    const h = harness();
    const descriptor = fs.openSync(oldFile, "r");
    const id = h.registry.openSession(dir, oldFile, undefined, descriptor, dir);
    try {
      await h.registry.activateSession(id, "/tmp/pi", {});
      const fake = h.fakes[0]!;
      const initialRuntimePath = (
        fake.sent[0] as { type?: string; sessionFile?: string } | undefined
      )?.sessionFile;
      fake.emitControl({
        type: "transition_started",
        transitionId: "different-file-new",
        provisionalEpoch: 1,
      });
      fake.emitWire({
        type: "transition_prepare",
        transitionId: "different-file-new",
        phase: "prepare",
        kind: "new",
      });
      await vi.waitFor(() =>
        expect(
          fake.sent.filter(
            (message) =>
              message.type === "transition_permit" &&
              message.transitionId === "different-file-new" &&
              message.allowed === true,
          ),
        ).toHaveLength(1),
      );
      fake.emitWire({
        type: "transition_prepare",
        transitionId: "different-file-new",
        phase: "successor",
        kind: "new",
        targetFile: nextFile,
      });
      await vi.waitFor(() =>
        expect(
          fake.sent.filter(
            (message) =>
              message.type === "transition_permit" &&
              message.transitionId === "different-file-new" &&
              message.allowed === true,
          ),
        ).toHaveLength(2),
      );

      fake.sessionEpoch = 1;
      fake.emitControl({
        type: "transition_batch",
        batch: {
          transitionId: "different-file-new",
          provisionalEpoch: 1,
          records: [],
          terminalSnapshot: { ...fake.snapshot(), sessionFile: nextFile },
        },
      });

      await vi.waitFor(() =>
        expect(h.registry.getSession(id)).toMatchObject({
          availability: "available",
          sessionFile: path.resolve(nextFile),
          _lockPath: path.resolve(nextFile),
          _hasLock: true,
          snapshot: { sessionEpoch: 1, sessionFile: nextFile },
        }),
      );
      expect(h.registry.getSession(id)?._transitionLock).toBeUndefined();
      expect(h.registry.getSession(id)?._confinedSessionDescriptor).toBeUndefined();
      expect(h.registry.getSession(id)?._confinedSessionAlias).toBeUndefined();
      if (initialRuntimePath?.endsWith(".runtime-pin")) {
        expect(fs.existsSync(initialRuntimePath)).toBe(false);
      }
      expect(h.fileChanges).toContainEqual([
        id,
        { hostInstanceId: fake.hostInstanceId, sessionEpoch: 1 },
        nextFile,
        undefined,
      ]);
    } finally {
      h.registry.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes a semantic replacement even when /new reuses the predecessor file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pivis-same-file-new-"));
    const oldFile = path.join(dir, "old.jsonl");
    await writeFile(oldFile, "");
    const h = harness();
    const id = h.registry.openSession(dir, oldFile);
    try {
      await h.registry.activateSession(id, "/tmp/pi", {});
      const fake = h.fakes[0]!;
      fake.emitControl({
        type: "transition_started",
        transitionId: "same-file-new",
        provisionalEpoch: 1,
      });
      fake.emitWire({
        type: "transition_prepare",
        transitionId: "same-file-new",
        phase: "prepare",
        kind: "new",
      });
      await vi.waitFor(() =>
        expect(
          fake.sent.filter(
            (message) =>
              message.type === "transition_permit" &&
              message.transitionId === "same-file-new" &&
              message.allowed === true,
          ),
        ).toHaveLength(1),
      );
      fake.emitWire({
        type: "transition_prepare",
        transitionId: "same-file-new",
        phase: "successor",
        kind: "new",
        targetFile: oldFile,
      });
      await vi.waitFor(() =>
        expect(
          fake.sent.filter(
            (message) =>
              message.type === "transition_permit" &&
              message.transitionId === "same-file-new" &&
              message.allowed === true,
          ),
        ).toHaveLength(2),
      );
      expect(h.registry.getSession(id)?._hostTransition).toMatchObject({ kind: "new" });
      fake.sessionEpoch = 1;
      fake.emitControl({
        type: "transition_batch",
        batch: {
          transitionId: "same-file-new",
          provisionalEpoch: 1,
          records: [],
          terminalSnapshot: { ...fake.snapshot(), sessionFile: oldFile },
        },
      });

      await vi.waitFor(() =>
        expect(h.registry.getSession(id)).toMatchObject({
          availability: "available",
          snapshot: { sessionEpoch: 1 },
        }),
      );
      await vi.waitFor(() =>
        expect(h.fileChanges).toContainEqual([
          id,
          { hostInstanceId: fake.hostInstanceId, sessionEpoch: 1 },
          oldFile,
          undefined,
        ]),
      );
      expect(h.registry.getSession(id)).toMatchObject({ availability: "available" });
    } finally {
      h.registry.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the predecessor lock when a permitted successor rolls back", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pivis-transition-lock-"));
    const oldFile = path.join(dir, "old.jsonl");
    const nextFile = path.join(dir, "next.jsonl");
    await Promise.all([writeFile(oldFile, ""), writeFile(nextFile, "")]);
    const h = harness();
    const id = h.registry.openSession(dir, oldFile);
    try {
      await h.registry.activateSession(id, "/tmp/pi", {});
      const fake = h.fakes[0]!;
      fake.emitControl({
        type: "transition_started",
        transitionId: "rollback-lock",
        provisionalEpoch: 1,
      });
      fake.emitWire({
        type: "transition_prepare",
        transitionId: "rollback-lock",
        phase: "prepare",
        kind: "switch",
        targetFile: nextFile,
      });
      await vi.waitFor(() =>
        expect(
          fake.sent.some(
            (message) =>
              message.type === "transition_permit" &&
              message.transitionId === "rollback-lock" &&
              message.allowed === true,
          ),
        ).toBe(true),
      );
      fake.emitControl({
        type: "transition_cancelled",
        transitionId: "rollback-lock",
      });

      // The reservation for nextFile is gone, while the old primary lock is
      // still held and therefore cannot be silently moved by bookkeeping.
      expect(() => h.registry.updateSessionFile(id, nextFile)).toThrow("held advisory lock");
      expect(h.registry.getSession(id)?._lockPath).toBe(path.resolve(oldFile));
    } finally {
      h.registry.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not dispatch reload without a child lifecycle permit", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    h.fakes[0]!.runtime = {
      ...h.fakes[0]!.runtime,
      isIdle: false,
      isStreaming: true,
    };

    await expect(
      h.registry.executeReload(id, {
        requestId: "reload-denied",
        intentId: "reload-denied-intent",
        expectedHostInstanceId: record.proc!.hostInstanceId!,
        expectedSessionEpoch: record.proc!.sessionEpoch,
      }),
    ).resolves.toMatchObject({ disposition: "not_executed" });
    expect(h.fakes[0]!.sent.some((message) => message.type === "reload")).toBe(false);
    expect(h.fakes[0]!.sent.some((message) => message.type === "lifecycle_permit")).toBe(true);
    h.registry.stopAll();
  });

  it("does not dispatch a stale escape into a replacement runtime", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const before = h.fakes[0]!.sent.filter((message) => message.type === "escape").length;

    await expect(
      h.registry.escapeSession(id, "stale-escape", {
        hostInstanceId: "stale-host",
        sessionEpoch: record.snapshot!.sessionEpoch,
      }),
    ).resolves.toMatchObject({ disposition: "not_applicable" });
    expect(h.fakes[0]!.sent.filter((message) => message.type === "escape")).toHaveLength(before);
    h.registry.stopAll();
  });

  it("settles a lost escape acknowledgement as outcome unknown", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const fake = h.fakes[0]!;
    const originalSend = fake.send.bind(fake);
    fake.send = ((
      message: Parameters<typeof fake.send>[0],
      callback?: Parameters<typeof fake.send>[1],
    ) => {
      if (message.type !== "escape") return originalSend(message, callback);
      fake.sent.push(message);
      queueMicrotask(() => callback?.(null));
      return true;
    }) as typeof fake.send;

    const pending = h.registry.escapeSession(id, "ambiguous-escape", {
      hostInstanceId,
      sessionEpoch,
    });
    await tick();
    fake.emitExit(1);
    await expect(pending).resolves.toMatchObject({
      requestId: "ambiguous-escape",
      disposition: "outcome_unknown",
      hostInstanceId,
      sessionEpoch,
    });
    h.registry.stopAll();
  });

  it("fences dispatch intents by renderer generation and expected owner without forwarding", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    record._rendererGeneration = 2;
    const dispatch = vi.spyOn(record.proc!, "dispatchIntent");

    await expect(
      h.registry.dispatchIntent({
        sessionId: id,
        intentId: "stale-generation",
        rendererGeneration: 1,
        expectedOwner: { hostInstanceId, sessionEpoch },
        intent: {
          kind: "runBash",
          command: "pwd",
          excludeFromContext: false,
          editorRevision: 1,
          editorText: "!pwd",
        },
      }),
    ).resolves.toEqual({
      status: "not_admitted",
      intentId: "stale-generation",
      reason: "invalid",
    });
    await expect(
      h.registry.dispatchIntent({
        sessionId: id,
        intentId: "stale-owner",
        rendererGeneration: 2,
        expectedOwner: { hostInstanceId: "retired-host", sessionEpoch },
        intent: {
          kind: "runBash",
          command: "pwd",
          excludeFromContext: false,
          editorRevision: 1,
          editorText: "!pwd",
        },
      }),
    ).resolves.toEqual({
      status: "not_admitted",
      intentId: "stale-owner",
      reason: "stale_owner",
    });
    expect(dispatch).not.toHaveBeenCalled();
    h.registry.stopAll();
  });

  it("fences dispatch intents while unavailable, closing, or transitioning", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const dispatch = vi.spyOn(record.proc!, "dispatchIntent");
    const envelope = (intentId: string): IntentEnvelope => ({
      sessionId: id,
      intentId,
      rendererGeneration: record._rendererGeneration,
      expectedOwner: { hostInstanceId, sessionEpoch },
      intent: {
        kind: "runBash",
        command: "pwd",
        excludeFromContext: false,
        editorRevision: 1,
        editorText: "!pwd",
      },
    });

    record.availability = "unavailable";
    await expect(h.registry.dispatchIntent(envelope("unavailable"))).resolves.toEqual({
      status: "not_admitted",
      intentId: "unavailable",
      reason: "transport_unavailable",
    });
    record.availability = "transitioning";
    await expect(h.registry.dispatchIntent(envelope("transitioning"))).resolves.toEqual({
      status: "not_admitted",
      intentId: "transitioning",
      reason: "transitioning",
    });
    record.availability = "available";
    record._closing = true;
    await expect(h.registry.dispatchIntent(envelope("closing"))).resolves.toEqual({
      status: "not_admitted",
      intentId: "closing",
      reason: "closing",
    });
    expect(dispatch).not.toHaveBeenCalled();
    h.registry.stopAll();
  });

  it("marks an export outcome_unknown without replay after its dispatch acknowledgement is lost", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const pending = h.registry.dispatchIntent({
      sessionId: id,
      intentId: "lost-dispatch",
      rendererGeneration: record._rendererGeneration,
      expectedOwner: { hostInstanceId, sessionEpoch },
      intent: { kind: "export" },
    });
    await vi.waitFor(() =>
      expect(h.fakes[0]!.sent.filter((message) => message.type === "dispatch_intent")).toHaveLength(
        1,
      ),
    );
    h.fakes[0]!.emitExit(1);

    await expect(pending).resolves.toEqual({
      status: "delivery_unknown",
      intentId: "lost-dispatch",
      owner: { hostInstanceId, sessionEpoch },
    });
    expect(record._retainedDispatchIntents).toHaveLength(1);
    expect([...record._retainedDispatchIntents.values()][0]).toMatchObject({
      possibleDispatch: true,
      deliveryUnknown: true,
      recoveryPublished: true,
    });
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: `ambiguous-intent:${hostInstanceId}:${sessionEpoch}:lost-dispatch`,
        disposition: "dropped",
      }),
    ]);
    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    expect(h.fakes[1]!.sent.filter((message) => message.type === "dispatch_intent")).toHaveLength(
      0,
    );
    h.registry.stopAll();
  });

  it("escrows an admitted envelope submit as byte-identical dropped evidence and never replays it", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const images = [{ type: "image" as const, mimeType: "image/png", data: "AAEC/frozen" }];
    const pending = h.registry.dispatchIntent({
      sessionId: id,
      intentId: "lost-envelope-submit",
      rendererGeneration: record._rendererGeneration,
      expectedOwner: { hostInstanceId, sessionEpoch },
      intent: {
        kind: "submit",
        editorRevision: 7,
        text: "retain exactly this text",
        images,
        requestedMode: "steer",
        surface: "composer",
      },
    });
    await vi.waitFor(() =>
      expect(h.fakes[0]!.sent.some((message) => message.type === "dispatch_intent")).toBe(true),
    );
    h.fakes[0]!.emitWire({
      type: "editor_source_cleared",
      intentId: "lost-envelope-submit",
      editorRevision: 7,
      editor: { revision: 8, text: "", attachments: [] },
    });
    h.fakes[0]!.emitExit(1);
    await expect(pending).resolves.toMatchObject({
      status: "delivery_unknown",
    });
    await vi.waitFor(() =>
      expect(h.restorations).toContainEqual([
        id,
        expect.objectContaining({
          restorationId: `ambiguous-intent:${hostInstanceId}:${sessionEpoch}:lost-envelope-submit`,
          text: "retain exactly this text",
          attachments: images,
          disposition: "dropped",
          intentIds: ["lost-envelope-submit"],
        }),
      ]),
    );
    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    expect(h.fakes[1]!.sent.filter((message) => message.type === "dispatch_intent")).toHaveLength(
      0,
    );
    h.registry.stopAll();
  });

  it("drops a crash-restored draft when the exact prompt persisted after dispatch", async () => {
    const { root, sessionFile } = persistedSessionFixture("persisted-crash");
    const h = harness();
    try {
      const id = h.registry.openSession(root, sessionFile);
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      const first = h.fakes[0]!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      const editorText = "persisted before the host stopped";
      const dispatchedText = `/tmp/context.txt\n${editorText}`;
      first.editor = {
        revision: 2,
        text: editorText,
        attachments: [{ kind: "file", name: "context.txt", path: "/tmp/context.txt" }],
      };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.snapshot?.editor.revision).toBe(2));

      const pending = h.registry.dispatchIntent({
        sessionId: id,
        intentId: "persisted-before-crash",
        rendererGeneration: record._rendererGeneration,
        expectedOwner: { hostInstanceId, sessionEpoch },
        intent: {
          kind: "submit",
          editorRevision: 2,
          // File paths are prepended after the editor revision is captured.
          // Recovery ownership therefore cannot be inferred from text equality.
          text: dispatchedText,
          inputKind: "ordinary",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      });
      await vi.waitFor(() =>
        expect(h.fakes[0]!.sent.some((message) => message.type === "dispatch_intent")).toBe(true),
      );
      fs.appendFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: "persisted-user",
          message: { role: "user", content: dispatchedText },
        })}\n`,
      );
      first.emitWire({
        type: "editor_source_cleared",
        intentId: "persisted-before-crash",
        editorRevision: 2,
        editor: { revision: 3, text: "", attachments: [] },
      });
      first.emitExit(1);

      await expect(pending).resolves.toMatchObject({ status: "delivery_unknown" });
      await vi.waitFor(() =>
        expect(h.restorations).toContainEqual([
          id,
          expect.objectContaining({
            restorationId: `ambiguous-intent:${hostInstanceId}:${sessionEpoch}:persisted-before-crash`,
            intentIds: ["persisted-before-crash"],
            disposition: "dropped",
          }),
        ]),
      );
      await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
      await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
      expect(h.fakes[1]!.sent.some((message) => message.type === "dispatch_intent")).toBe(false);
      expect(h.fakes[1]!.sent.some((message) => message.type === "editor_patch")).toBe(false);
      expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
        text: "",
        attachments: [] as unknown[],
      });
    } finally {
      h.registry.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles a first prompt persisted after Pi materializes its deferred session file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-deferred-first-prompt-"));
    const sessionDir = path.join(root, "sessions");
    const manager = SessionManager.create(root, sessionDir);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("Pi did not allocate a persisted session path");
    expect(fs.existsSync(sessionFile)).toBe(false);

    const h = harness();
    try {
      const id = h.registry.openSession(root, sessionFile);
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      const first = h.fakes[0]!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      const prompt = "first prompt persisted before the host stopped";
      first.editor = { revision: 1, text: prompt, attachments: [] };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.snapshot?.editor.revision).toBe(1));

      const pending = h.registry.dispatchIntent({
        sessionId: id,
        intentId: "deferred-first-prompt",
        rendererGeneration: record._rendererGeneration,
        expectedOwner: { hostInstanceId, sessionEpoch },
        intent: {
          kind: "submit",
          editorRevision: 1,
          text: prompt,
          inputKind: "ordinary",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      });
      await vi.waitFor(() =>
        expect(first.sent.some((message) => message.type === "dispatch_intent")).toBe(true),
      );

      manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "persisted response" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      expect(fs.existsSync(sessionFile)).toBe(true);
      first.emitWire({
        type: "editor_source_cleared",
        intentId: "deferred-first-prompt",
        editorRevision: 1,
        editor: { revision: 2, text: "", attachments: [] },
      });
      first.emitExit(1);

      await expect(pending).resolves.toMatchObject({ status: "delivery_unknown" });
      await vi.waitFor(() =>
        expect(h.restorations).toContainEqual([
          id,
          expect.objectContaining({
            restorationId: `ambiguous-intent:${hostInstanceId}:${sessionEpoch}:deferred-first-prompt`,
            intentIds: ["deferred-first-prompt"],
            disposition: "dropped",
          }),
        ]),
      );
      await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
      expect(h.fakes[1]!.sent.some((message) => message.type === "editor_patch")).toBe(false);
    } finally {
      h.registry.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves newer editor work when an older same-session dispatch persisted", async () => {
    const { root, sessionFile } = persistedSessionFixture("newer-editor-crash");
    const h = harness();
    try {
      const id = h.registry.openSession(root, sessionFile);
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      const first = h.fakes[0]!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      const dispatchedText = "older prompt that persisted";
      first.editor = { revision: 2, text: dispatchedText, attachments: [] };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.snapshot?.editor.revision).toBe(2));

      const pending = h.registry.dispatchIntent({
        sessionId: id,
        intentId: "older-persisted-submit",
        rendererGeneration: record._rendererGeneration,
        expectedOwner: { hostInstanceId, sessionEpoch },
        intent: {
          kind: "submit",
          editorRevision: 2,
          text: dispatchedText,
          inputKind: "ordinary",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      });
      await vi.waitFor(() =>
        expect(first.sent.some((message) => message.type === "dispatch_intent")).toBe(true),
      );
      first.editor = {
        revision: 3,
        text: "newer unsent edit",
        attachments: [{ kind: "file", name: "new.txt", path: "/tmp/new.txt" }],
      };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.snapshot?.editor.revision).toBe(3));
      fs.appendFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: "older-persisted-user",
          message: { role: "user", content: dispatchedText },
        })}\n`,
      );
      first.emitExit(1);

      await expect(pending).resolves.toMatchObject({ status: "delivery_unknown" });
      await vi.waitFor(() =>
        expect(h.restorations).toContainEqual([
          id,
          expect.objectContaining({
            restorationId: `ambiguous-intent:${hostInstanceId}:${sessionEpoch}:older-persisted-submit`,
            disposition: "dropped",
          }),
        ]),
      );
      await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
      expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
        text: "newer unsent edit",
        attachments: [expect.objectContaining({ name: "new.txt" })],
      });
    } finally {
      h.registry.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never rehydrates an admitted primary when persistence is unproven and preserves its conflict", async () => {
    const { root, sessionFile } = persistedSessionFixture("unknown-persistence-crash");
    const h = harness();
    try {
      const id = h.registry.openSession(root, sessionFile);
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      const first = h.fakes[0]!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      const editorText = "restore this unproven draft";
      const dispatchedText = `/tmp/evidence.txt\n${editorText}`;
      first.editor = {
        revision: 4,
        text: editorText,
        attachments: [{ kind: "file", name: "evidence.txt", path: "/tmp/evidence.txt" }],
        conflictText: "newer unsent conflict",
        conflictAttachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
      };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.snapshot?.editor.revision).toBe(4));

      const pending = h.registry.dispatchIntent({
        sessionId: id,
        intentId: "unproven-submit",
        rendererGeneration: record._rendererGeneration,
        expectedOwner: { hostInstanceId, sessionEpoch },
        intent: {
          kind: "submit",
          editorRevision: 4,
          text: dispatchedText,
          inputKind: "ordinary",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      });
      await vi.waitFor(() =>
        expect(first.sent.some((message) => message.type === "dispatch_intent")).toBe(true),
      );
      first.emitWire({
        type: "editor_source_cleared",
        intentId: "unproven-submit",
        editorRevision: 4,
        editor: {
          revision: 5,
          text: "",
          attachments: [],
          conflictText: "newer unsent conflict",
          conflictAttachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
        },
      });
      first.emitExit(1);

      await expect(pending).resolves.toMatchObject({ status: "delivery_unknown" });
      await vi.waitFor(() =>
        expect(h.restorations).toContainEqual([
          id,
          expect.objectContaining({
            restorationId: `ambiguous-intent:${hostInstanceId}:${sessionEpoch}:unproven-submit`,
            disposition: "dropped",
            intentIds: ["unproven-submit"],
          }),
        ]),
      );
      await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
      expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
        text: "newer unsent conflict",
        attachments: [expect.objectContaining({ name: "newer.txt" })],
      });
      expect(h.registry.getSession(id)?.snapshot?.editor.text).not.toBe(editorText);
    } finally {
      h.registry.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("promotes distinct conflict candidates when the delivered primary is suppressed", async () => {
    const { root, sessionFile } = persistedSessionFixture("conflict-candidate-crash");
    const h = harness();
    try {
      const id = h.registry.openSession(root, sessionFile);
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      const first = h.fakes[0]!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      const dispatchedText = "delivered primary";
      first.editor = {
        revision: 6,
        text: dispatchedText,
        attachments: [] as unknown[],
        conflictText: "first surviving candidate",
        conflictAttachments: [],
        alternateConflictText: "second surviving candidate",
        alternateConflictAttachments: [],
        additionalConflictCandidates: [
          { text: "third surviving candidate", attachments: [] },
          {
            text: "fourth surviving candidate",
            attachments: [{ kind: "file", name: "fourth.txt", path: "/tmp/fourth.txt" }],
          },
        ],
      };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.snapshot?.editor.revision).toBe(6));

      const pending = h.registry.dispatchIntent({
        sessionId: id,
        intentId: "delivered-primary-with-conflicts",
        rendererGeneration: record._rendererGeneration,
        expectedOwner: { hostInstanceId, sessionEpoch },
        intent: {
          kind: "submit",
          editorRevision: 6,
          text: dispatchedText,
          inputKind: "ordinary",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      });
      await vi.waitFor(() =>
        expect(first.sent.some((message) => message.type === "dispatch_intent")).toBe(true),
      );
      fs.appendFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: "delivered-primary-user",
          message: { role: "user", content: dispatchedText },
        })}\n`,
      );
      first.emitWire({
        type: "editor_source_cleared",
        intentId: "delivered-primary-with-conflicts",
        editorRevision: 6,
        editor: {
          revision: 7,
          text: "",
          attachments: [],
          conflictText: "first surviving candidate",
          conflictAttachments: [],
          alternateConflictText: "second surviving candidate",
          alternateConflictAttachments: [],
          additionalConflictCandidates: [
            { text: "third surviving candidate", attachments: [] },
            {
              text: "fourth surviving candidate",
              attachments: [{ kind: "file", name: "fourth.txt", path: "/tmp/fourth.txt" }],
            },
          ],
        },
      });
      first.emitExit(1);

      await expect(pending).resolves.toMatchObject({ status: "delivery_unknown" });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
      expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
        text: "first surviving candidate",
        conflictText: "second surviving candidate",
        alternateConflictText: "third surviving candidate",
        additionalConflictCandidates: [
          {
            text: "fourth surviving candidate",
            attachments: [expect.objectContaining({ name: "fourth.txt" })],
          },
        ],
      });
      expect(h.registry.getSession(id)?.snapshot?.editor.text).not.toBe(dispatchedText);
    } finally {
      h.registry.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-emits a resolved detached restoration after renderer replacement until acknowledged", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.emitWire({
      type: "queue_restoration",
      restorationId: "detached-draft",
      steering: [],
      followUp: ["restore after reload"],
      originalAttachments: [],
      certainty: "not_processed",
    });
    await vi.waitFor(() =>
      expect(h.restorations).toContainEqual([
        id,
        expect.objectContaining({
          restorationId: "detached-draft",
          text: "restore after reload",
          disposition: "restore",
        }),
      ]),
    );
    expect(h.restorations).toHaveLength(1);

    const reattach = h.registry.rendererAttach(id, 1);
    await reattach;
    expect(h.restorations).toHaveLength(2);
    expect(h.restorations[1]).toEqual(h.restorations[0]);

    expect(h.registry.acknowledgeRestoration(id, "detached-draft")).toBe(true);
    await h.registry.rendererAttach(id, 1);
    expect(h.restorations).toHaveLength(2);
    h.registry.stopAll();
  });

  it("forwards restoration acknowledgement to the child exactly once", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    record._restorations.set("child-custody", {
      type: "queue_restoration",
      restorationId: "child-custody",
    });

    expect(h.registry.acknowledgeRestoration(id, "child-custody")).toBe(true);
    expect(h.registry.acknowledgeRestoration(id, "child-custody")).toBe(false);
    expect(
      h.fakes[0]!.sent.filter(
        (message) =>
          message.type === "restoration_ack" && message.restorationId === "child-custody",
      ),
    ).toHaveLength(1);
    h.registry.stopAll();
  });

  it("forwards navigation presentation acknowledgement only to the exact runtime owner", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const owner = { hostInstanceId, sessionEpoch };

    await expect(
      h.registry.acknowledgeNavigationPresentation(id, "navigate-owner-bound", owner),
    ).resolves.toBe(true);
    await expect(
      h.registry.acknowledgeNavigationPresentation(id, "navigate-owner-bound", {
        ...owner,
        sessionEpoch: owner.sessionEpoch + 1,
      }),
    ).resolves.toBe(false);
    expect(
      h.fakes[0]!.sent.filter(
        (message) =>
          message.type === "navigation_presentation_ack" &&
          message.intentId === "navigate-owner-bound",
      ),
    ).toHaveLength(1);
    h.registry.stopAll();
  });

  it("retains admitted dispatch escrow across duplicate receipts until a terminal authority frame", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const owner = { hostInstanceId, sessionEpoch };
    const envelope = {
      sessionId: id,
      intentId: "opaque-duplicate",
      rendererGeneration: record._rendererGeneration,
      expectedOwner: owner,
      // This deliberately future/unknown kind proves registry routing does not
      // branch on SessionIntent semantics; the child remains the validator.
      intent: { kind: "future_child_intent", privatePayload: { answer: 42 } },
    } as unknown as IntentEnvelope;
    const dispatch = vi
      .spyOn(record.proc!, "dispatchIntent")
      .mockResolvedValueOnce({
        status: "admitted",
        intentId: envelope.intentId,
        owner,
      })
      .mockResolvedValueOnce({
        status: "duplicate",
        intentId: envelope.intentId,
        owner,
      });

    await expect(h.registry.dispatchIntent(envelope)).resolves.toEqual({
      status: "admitted",
      intentId: envelope.intentId,
      owner,
    });
    await expect(h.registry.dispatchIntent(envelope)).resolves.toEqual({
      status: "duplicate",
      intentId: envelope.intentId,
      owner,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      intentId: envelope.intentId,
      expectedOwner: owner,
      intent: envelope.intent,
    });
    expect(h.submissions).toEqual([]);
    expect(record._retainedDispatchIntents).toHaveLength(1);
    h.registry.routeAuthorityPublication(id, {
      plane: "semantic",
      owner,
      payload: {
        owner,
        transportSequence: 1,
        frameId: "terminal-opaque-duplicate",
        records: [
          {
            type: "intent_outcome",
            outcome: {
              intentId: envelope.intentId,
              owner,
              kind: "runBash",
              state: "completed",
              result: { started: true },
            },
          },
        ],
        terminalSnapshot: {},
      },
    } as never);
    expect(record._retainedDispatchIntents).toHaveLength(0);
    h.registry.stopAll();
  });

  it("routes an owner-bound query through the read-only host transport without effects", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const query = vi.spyOn(record.proc!, "query").mockResolvedValue({
      type: "response",
      command: "get_state",
      success: true,
      data: { opaque: "child-owned" },
    });
    const mutationSequence = record._mutationSequence;
    const activationInteracted = record._activationVisitInteracted;

    await expect(
      h.registry.query({
        sessionId: id,
        queryId: "read-state",
        expectedOwner: { hostInstanceId, sessionEpoch },
        query: { type: "get_state" },
      }),
    ).resolves.toEqual({
      status: "ok",
      queryId: "read-state",
      owner: { hostInstanceId, sessionEpoch },
      queryType: "get_state",
      response: {
        type: "response",
        command: "get_state",
        success: true,
        data: { opaque: "child-owned" },
      },
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({ type: "get_state" });
    expect(record._mutationSequence).toBe(mutationSequence);
    expect(record._activationVisitInteracted).toBe(activationInteracted);
    await expect(
      h.registry.query({
        sessionId: id,
        queryId: "effectful-query",
        expectedOwner: { hostInstanceId, sessionEpoch },
        query: { type: "compact" } as never,
      }),
    ).rejects.toThrow(/Invalid session query/);
    expect(query).toHaveBeenCalledOnce();
    h.registry.stopAll();
  });

  it("maps a render_message query to the owner-fenced host command", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const query = vi.spyOn(record.proc!, "query").mockResolvedValue({
      type: "response",
      command: "render_message",
      success: true,
      data: { rendered: true, ansi: "rendered" },
    });

    await expect(
      h.registry.query({
        sessionId: id,
        queryId: "render-custom-message",
        expectedOwner: { hostInstanceId, sessionEpoch },
        query: {
          type: "render_message",
          customType: "status-card",
          timestamp: 1_700_000_000_000,
          cols: 96,
          expanded: true,
        },
      }),
    ).resolves.toMatchObject({
      status: "ok",
      queryId: "render-custom-message",
      owner: { hostInstanceId, sessionEpoch },
      queryType: "render_message",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({
      type: "render_message",
      customType: "status-card",
      timestamp: 1_700_000_000_000,
      cols: 96,
      expanded: true,
    });
    h.registry.stopAll();
  });

  it("maps a batched Markdown transform query to the owner-fenced host command", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const items = [
      {
        requestId: "markdown-a",
        markdown: "before",
        messageType: "assistant" as const,
        isStreaming: false,
        availableWidth: 80,
      },
    ];
    const query = vi.spyOn(record.proc!, "query").mockResolvedValue({
      type: "response",
      command: "transform_markdown",
      success: true,
      data: { items: [{ requestId: "markdown-a", markdown: "after" }] },
    });

    await expect(
      h.registry.query({
        sessionId: id,
        queryId: "transform-markdown",
        expectedOwner: { hostInstanceId, sessionEpoch },
        query: { type: "transform_markdown", items },
      }),
    ).resolves.toMatchObject({
      status: "ok",
      queryType: "transform_markdown",
      owner: { hostInstanceId, sessionEpoch },
    });
    expect(query).toHaveBeenCalledWith({ type: "transform_markdown", items });
    h.registry.stopAll();
  });

  it("does not dispatch a query with a stale owner", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const query = vi.spyOn(record.proc!, "query");

    await expect(
      h.registry.query({
        sessionId: id,
        queryId: "stale-before",
        expectedOwner: { hostInstanceId, sessionEpoch: sessionEpoch + 1 },
        query: { type: "get_state" },
      }),
    ).resolves.toEqual({ status: "superseded" });
    expect(query).not.toHaveBeenCalled();
    h.registry.stopAll();
  });

  it("fences a query response after its owner changes without retrying", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    let resolveQuery!: (response: PiRpcResponse) => void;
    const query = vi.spyOn(record.proc!, "query").mockImplementation(
      () =>
        new Promise<PiRpcResponse>((resolve) => {
          resolveQuery = resolve;
        }),
    );

    const pending = h.registry.query({
      sessionId: id,
      queryId: "stale-after",
      expectedOwner: { hostInstanceId, sessionEpoch },
      query: { type: "get_state" },
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    record.proc!.sessionEpoch = sessionEpoch + 1;
    resolveQuery({
      type: "response",
      command: "get_state",
      success: true,
      data: {},
    });

    await expect(pending).resolves.toEqual({ status: "superseded" });
    expect(query).toHaveBeenCalledOnce();
    h.registry.stopAll();
  });

  it("repairs a dropped start event from a fresh direct snapshot", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const fake = h.fakes[0]!;
    fake.runtime = { ...fake.runtime, isStreaming: true, isIdle: false };
    fake.emitControl({
      type: "snapshot",
      snapshot: fake.snapshot(),
      full: false,
    });
    await tick();
    expect(h.registry.getSession(id)?.snapshot?.isStreaming).toBe(true);
    expect(h.events).toEqual([]);
    h.registry.stopAll();
  });

  it("ignores reversed snapshots and detects a transport gap", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const fake = h.fakes[0]!;
    fake.runtime = { ...fake.runtime, isStreaming: true, isIdle: false };
    const newest = fake.snapshot() as unknown as AgentSessionSnapshot;
    fake.emitControl({ type: "snapshot", snapshot: newest, full: false });
    const stale = {
      ...newest,
      snapshotSequence: newest.snapshotSequence - 1,
      isStreaming: false,
    };
    fake.emitControl({ type: "snapshot", snapshot: stale, full: false });
    fake.transportSequence += 1;
    fake.emitControl({
      type: "snapshot",
      snapshot: fake.snapshot(),
      full: false,
    });
    await tick();
    expect(h.registry.getSession(id)?.snapshot?.isStreaming).toBe(true);
    expect(
      h.runtimeStates.some(
        (state) => (state as { availability?: string }).availability === "unavailable",
      ),
    ).toBe(true);
    h.registry.stopAll();
  });

  it("rehydrates authoritative unsent editor text, attachments, and conflict after crash", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const first = h.fakes[0]!;
    first.editor = {
      revision: 4,
      text: "unsent draft",
      attachments: [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }],
      conflictText: "alternate local draft",
      conflictAttachments: [{ kind: "file", name: "alternate.txt", path: "/tmp/alternate.txt" }],
      alternateConflictText: "third draft",
      alternateConflictAttachments: [{ kind: "file", name: "third.txt", path: "/tmp/third.txt" }],
      additionalConflictCandidates: [
        {
          text: "fourth draft",
          attachments: [{ kind: "file", name: "fourth.txt", path: "/tmp/fourth.txt" }],
        },
      ],
    };
    first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
    await vi.waitFor(() =>
      expect(h.registry.getSession(id)?.snapshot?.editor.text).toBe("unsent draft"),
    );

    first.emitExit(1);

    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    const replacement = h.fakes[1]!;
    expect(replacement.sent).toContainEqual(
      expect.objectContaining({
        type: "editor_patch",
        patch: expect.objectContaining({
          text: "unsent draft",
          attachments: [expect.objectContaining({ name: "notes.txt" })],
        }),
      }),
    );
    expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
      text: "unsent draft",
      attachments: [expect.objectContaining({ name: "notes.txt" })],
      conflictText: "alternate local draft",
      conflictAttachments: [expect.objectContaining({ name: "alternate.txt" })],
      alternateConflictText: "third draft",
      alternateConflictAttachments: [expect.objectContaining({ name: "third.txt" })],
      additionalConflictCandidates: [
        {
          text: "fourth draft",
          attachments: [expect.objectContaining({ name: "fourth.txt" })],
        },
      ],
    });
    h.registry.stopAll();
  });

  it("recaptures restored editor custody when a replacement fails during final setup", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const first = h.fakes[0]!;
    first.editor = {
      revision: 4,
      text: "unsent draft",
      attachments: [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }],
      conflictText: "alternate local draft",
      conflictAttachments: [{ kind: "file", name: "alternate.txt", path: "/tmp/alternate.txt" }],
      alternateConflictText: "third draft",
      alternateConflictAttachments: [{ kind: "file", name: "third.txt", path: "/tmp/third.txt" }],
      additionalConflictCandidates: [
        {
          text: "fourth draft",
          attachments: [{ kind: "file", name: "fourth.txt", path: "/tmp/fourth.txt" }],
        },
      ],
    };
    first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
    await vi.waitFor(() =>
      expect(h.registry.getSession(id)?.snapshot?.editor.text).toBe("unsent draft"),
    );

    const resync = h.registry.resyncSession.bind(h.registry);
    let failFirstReplacement = true;
    vi.spyOn(h.registry, "resyncSession").mockImplementation((sessionId) => {
      if (failFirstReplacement && h.fakes.length === 2) {
        failFirstReplacement = false;
        return Promise.reject(new Error("replacement final resync failed"));
      }
      return resync(sessionId);
    });

    first.emitExit(1);

    await vi.waitFor(() => expect(h.fakes).toHaveLength(3), { timeout: 4_000 });
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    const secondReplacement = h.fakes[2]!;
    expect(secondReplacement.sent).toContainEqual(
      expect.objectContaining({
        type: "editor_patch",
        patch: expect.objectContaining({
          text: "unsent draft",
          attachments: [expect.objectContaining({ name: "notes.txt" })],
        }),
      }),
    );
    expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
      text: "unsent draft",
      attachments: [expect.objectContaining({ name: "notes.txt" })],
      conflictText: "alternate local draft",
      conflictAttachments: [expect.objectContaining({ name: "alternate.txt" })],
      alternateConflictText: "third draft",
      alternateConflictAttachments: [expect.objectContaining({ name: "third.txt" })],
      additionalConflictCandidates: [
        {
          text: "fourth draft",
          attachments: [expect.objectContaining({ name: "fourth.txt" })],
        },
      ],
    });
    h.registry.stopAll();
  });

  it("retains replacement attachments when recovery candidates have identical text", async () => {
    const h = harness({
      configureFake: (fake, spawnIndex) => {
        if (spawnIndex !== 1) return;
        fake.beforeEditorPatch = () => {
          fake.beforeEditorPatch = undefined;
          fake.editor = {
            revision: 1,
            text: "user recovery draft",
            attachments: [
              {
                kind: "file",
                name: "replacement.txt",
                path: "/tmp/replacement.txt",
              },
            ],
          };
        };
      },
    });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const first = h.fakes[0]!;
    first.editor = {
      revision: 3,
      text: "user recovery draft",
      attachments: [],
      conflictText: "user recovery draft",
      conflictAttachments: [
        { kind: "file", name: "replacement.txt", path: "/tmp/replacement.txt" },
      ],
    };
    first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
    await vi.waitFor(() =>
      expect(h.registry.getSession(id)?.snapshot?.editor.text).toBe("user recovery draft"),
    );

    first.emitExit(1);

    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
      text: "user recovery draft",
      conflictText: "user recovery draft",
      conflictAttachments: [expect.objectContaining({ name: "replacement.txt" })],
    });
    expect(h.registry.getSession(id)?.snapshot?.editor.alternateConflictText).toBeUndefined();
    expect(h.fakes[1]!.sent.filter((message) => message.type === "editor_patch")).toHaveLength(3);
    h.registry.stopAll();
  });

  it("keeps both editor candidates when recovery conflicts exhaust retries", async () => {
    const h = harness({
      configureFake: (fake, spawnIndex) => {
        if (spawnIndex !== 1) return;
        let mutation = 0;
        fake.beforeEditorPatch = () => {
          mutation++;
          fake.editor = {
            revision: fake.editor.revision + 1,
            text: `replacement draft ${mutation}`,
            attachments: [
              {
                kind: "file",
                name: `replacement-${mutation}.txt`,
                path: `/tmp/r-${mutation}`,
              },
            ],
          };
        };
      },
    });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const first = h.fakes[0]!;
    first.editor = {
      revision: 2,
      text: "old-host draft",
      attachments: [{ kind: "file", name: "old.txt", path: "/tmp/old" }],
      conflictText: "old alternate draft",
      conflictAttachments: [
        { kind: "file", name: "old-alternate.txt", path: "/tmp/old-alternate" },
      ],
    };
    first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
    await vi.waitFor(() =>
      expect(h.registry.getSession(id)?.snapshot?.editor.text).toBe("old-host draft"),
    );

    first.emitExit(1);

    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
      text: "replacement draft 3",
      attachments: [expect.objectContaining({ name: "replacement-3.txt" })],
      conflictText: "old-host draft",
      conflictAttachments: [expect.objectContaining({ name: "old.txt" })],
      alternateConflictText: "old alternate draft",
      alternateConflictAttachments: [expect.objectContaining({ name: "old-alternate.txt" })],
    });
    expect(h.fakes[1]!.sent.filter((message) => message.type === "editor_patch")).toHaveLength(3);
    h.registry.stopAll();
  });

  it("rejects submissions while authoritative availability is transitioning", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    h.fakes[0]!.emitControl({
      type: "transition_started",
      transitionId: "replacement-1",
      provisionalEpoch: record.snapshot!.sessionEpoch + 1,
    });
    expect(record.availability).toBe("transitioning");
    h.fakes[0]!.emitControl({
      type: "snapshot",
      snapshot: h.fakes[0]!.snapshot(),
      full: true,
    });
    expect(record.availability).toBe("transitioning");

    await expect(
      h.registry.submit(id, {
        intentId: "during-transition",
        expectedHostId: record.proc!.hostInstanceId!,
        expectedEpoch: record.snapshot!.sessionEpoch,
        editorRevision: record.snapshot!.editor.revision,
        text: "must not dispatch",
        images: [],
        requestedMode: "followUp",
        surface: "composer",
      }),
    ).resolves.toMatchObject({
      intentId: "during-transition",
      disposition: "not_submitted",
      message: expect.stringContaining("runtime is transitioning"),
    });

    expect(h.fakes[0]!.sent.some((message) => message.type === "submit")).toBe(false);
    h.fakes[0]!.emitControl({
      type: "transition_cancelled",
      transitionId: "replacement-1",
    });
    expect(record.availability).toBe("available");
    h.registry.stopAll();
  });

  it("does not release transition state for an uncorrelated terminal batch", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const initialEpoch = record.snapshot!.sessionEpoch;
    h.fakes[0]!.emitControl({
      type: "transition_started",
      transitionId: "expected-transition",
      provisionalEpoch: initialEpoch + 1,
    });
    const staleTerminal = h.fakes[0]!.snapshot();

    h.fakes[0]!.emitControl({
      type: "transition_batch",
      batch: {
        transitionId: "expected-transition",
        provisionalEpoch: staleTerminal.sessionEpoch,
        records: [],
        terminalSnapshot: staleTerminal,
      },
    });

    expect(record._hostTransition).toEqual({
      transitionId: "expected-transition",
      provisionalEpoch: initialEpoch + 1,
    });
    expect(record.availability).not.toBe("available");
    expect(record.snapshot?.sessionEpoch).toBe(initialEpoch);
    h.registry.stopAll();
  });

  it("returns explicit not-submitted dispositions for every pre-dispatch fence", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const base = {
      intentId: "pre-dispatch",
      expectedHostId: record.proc!.hostInstanceId!,
      expectedEpoch: record.snapshot!.sessionEpoch,
      editorRevision: record.snapshot!.editor.revision,
      text: "must not dispatch",
      images: [],
      requestedMode: "followUp" as const,
      surface: "composer" as const,
    };

    await expect(
      h.registry.submit(id, { ...base, expectedHostId: "stale-host" }),
    ).resolves.toMatchObject({
      disposition: "not_submitted",
      message: expect.stringContaining("stale"),
    });

    record._closing = true;
    await expect(
      h.registry.submit(id, { ...base, intentId: "during-close" }),
    ).resolves.toMatchObject({
      disposition: "not_submitted",
      message: expect.stringContaining("close"),
    });
    record._closing = false;

    await expect(
      h.registry.submit("missing" as never, {
        ...base,
        intentId: "missing-session",
      }),
    ).resolves.toMatchObject({
      intentId: "missing-session",
      disposition: "not_submitted",
      hostInstanceId: base.expectedHostId,
      sessionEpoch: base.expectedEpoch,
    });
    expect(h.fakes[0]!.sent.some((message) => message.type === "submit")).toBe(false);
    h.registry.stopAll();
  });

  it("retains each submitted payload until an explicit disposition", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const base = {
      expectedHostId: record.proc!.hostInstanceId!,
      expectedEpoch: record.snapshot!.sessionEpoch,
      editorRevision: 0,
      text: "hello",
      images: [],
      requestedMode: "steer" as const,
      surface: "composer" as const,
    };
    const [a, b] = await Promise.all([
      h.registry.submit(id, { ...base, intentId: "intent-a" }),
      h.registry.submit(id, { ...base, intentId: "intent-b", text: "second" }),
    ]);
    expect(a.disposition).toBe("consumed");
    expect(b.disposition).toBe("consumed");
    h.registry.stopAll();
  });

  it("retires retained composer payload presentation when custody becomes ambiguous", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const result = await h.registry.submit(id, {
      intentId: "crash-review",
      expectedHostId: record.proc!.hostInstanceId!,
      expectedEpoch: record.snapshot!.sessionEpoch,
      editorRevision: 3,
      text: "recover exact text",
      images: [{ type: "image", data: "bytes", mimeType: "image/png" }],
      requestedMode: "followUp",
      surface: "composer",
    });
    expect(result.disposition).toBe("consumed");

    h.fakes[0]!.emitStderr("provider bridge fatal detail\n");
    h.fakes[0]!.emitExit(1);
    expect(record.error).toContain("provider bridge fatal detail");
    await vi.waitFor(() => expect(h.restorations).toHaveLength(1));

    expect(h.restorations[0]).toEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-submission:crash-review",
        text: "recover exact text",
        attachments: [{ type: "image", data: "bytes", mimeType: "image/png" }],
        disposition: "dropped",
        intentIds: ["crash-review"],
      }),
    ]);
    expect(h.submissions).toContainEqual([
      id,
      expect.objectContaining({
        intentId: "crash-review",
        disposition: "outcome_unknown",
      }),
    ]);
    await vi.waitFor(() => expect(record.status).toBe("ready"));
    expect(h.registry.acknowledgeRestoration(id, "ambiguous-submission:crash-review")).toBe(true);
    expect(record._retainedIntents.has("crash-review")).toBe(false);
    h.submissions.length = 0;
    await h.registry.rendererAttach(id, record._rendererGeneration + 1);
    expect(h.submissions).not.toContainEqual([
      id,
      expect.objectContaining({ intentId: "crash-review" }),
    ]);
    await expect(
      h.registry.setWorktreeAndRespawn(id, "/tmp/reviewed-worktree", "/tmp/pi", {}),
    ).resolves.toBeUndefined();
    h.registry.stopAll();
  });

  it("suppresses legacy submitted editor recovery after clear even with exact persistence proof", async () => {
    const { root, sessionFile } = persistedSessionFixture("legacy-persisted-crash");
    const h = harness();
    try {
      const id = h.registry.openSession(root, sessionFile);
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      const first = h.fakes[0]!;
      const editorText = "legacy submitted editor";
      const dispatchedText = `/tmp/legacy.txt\n${editorText}`;
      first.editor = {
        revision: 8,
        text: editorText,
        attachments: [{ kind: "file", name: "legacy.txt", path: "/tmp/legacy.txt" }],
      };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.snapshot?.editor.revision).toBe(8));

      await expect(
        h.registry.submit(id, {
          intentId: "legacy-persisted-submit",
          expectedHostId: record.proc!.hostInstanceId!,
          expectedEpoch: record.snapshot!.sessionEpoch,
          editorRevision: 8,
          text: dispatchedText,
          inputKind: "ordinary",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        }),
      ).resolves.toMatchObject({ disposition: "consumed" });
      fs.appendFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: "legacy-persisted-user",
          message: { role: "user", content: dispatchedText },
        })}\n`,
      );
      first.emitExit(1);

      await vi.waitFor(() =>
        expect(h.restorations).toContainEqual([
          id,
          expect.objectContaining({
            restorationId: "ambiguous-submission:legacy-persisted-submit",
            disposition: "dropped",
          }),
        ]),
      );
      await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
      expect(h.fakes[1]!.sent.some((message) => message.type === "editor_patch")).toBe(false);
      expect(h.registry.getSession(id)?.snapshot?.editor.text).toBe("");
    } finally {
      h.registry.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never restores active-turn work after prompt admission cleared it", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    fake.runtime = { ...fake.runtime, isStreaming: true, isIdle: false };
    fake.emitControl({
      type: "snapshot",
      snapshot: fake.snapshot(),
      full: false,
    });
    await tick();

    await h.registry.submit(id, {
      intentId: "queued-before-crash",
      expectedHostId: record.proc!.hostInstanceId!,
      expectedEpoch: record.snapshot!.sessionEpoch,
      editorRevision: 0,
      text: "queued follow-up",
      images: [{ type: "image", data: "queued-bytes", mimeType: "image/png" }],
      requestedMode: "followUp",
      surface: "composer",
    });
    fake.emitWire({
      type: "submission_disposition",
      result: {
        intentId: "queued-before-crash",
        hostInstanceId: fake.hostInstanceId,
        sessionEpoch: fake.sessionEpoch,
        editorRevision: 0,
        disposition: "completed",
        queued: true,
      },
    });
    await vi.waitFor(() =>
      expect(record._retainedIntents.get("queued-before-crash")?.disposition).toBe("completed"),
    );

    fake.emitExit(1);
    await vi.waitFor(() =>
      expect(h.restorations).toContainEqual([
        id,
        expect.objectContaining({
          restorationId: "ambiguous-submission:queued-before-crash",
          text: "queued follow-up",
          attachments: [{ type: "image", data: "queued-bytes", mimeType: "image/png" }],
          disposition: "dropped",
          intentIds: ["queued-before-crash"],
        }),
      ]),
    );
    h.registry.stopAll();
  });

  it("joins replayed unified submission intents without dispatching text twice", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    const originalSend = fake.send.bind(fake);
    let heldSubmit:
      | { id: string; submission: { intentId: string; editorRevision: number } }
      | undefined;
    fake.send = ((
      message: Parameters<typeof originalSend>[0],
      callback?: Parameters<typeof originalSend>[1],
    ) => {
      if (message.type !== "submit") return originalSend(message, callback);
      fake.sent.push(message);
      heldSubmit = message as unknown as typeof heldSubmit;
      callback?.(null);
      return true;
    }) as typeof fake.send;
    const submission = {
      intentId: "stable-unified-intent",
      expectedHostId: record.proc!.hostInstanceId!,
      expectedEpoch: record.snapshot!.sessionEpoch,
      editorRevision: 0,
      text: "submit exactly once",
      images: [],
      requestedMode: "followUp" as const,
      surface: "unified" as const,
    };

    const first = h.registry.submit(id, submission);
    const replay = h.registry.submit(id, structuredClone(submission));
    await vi.waitFor(() => expect(heldSubmit).toBeDefined());
    expect(fake.sent.filter((message) => message.type === "submit")).toHaveLength(1);
    fake.emitWire({
      type: "response",
      id: heldSubmit!.id,
      success: true,
      data: {
        intentId: submission.intentId,
        hostInstanceId: submission.expectedHostId,
        sessionEpoch: submission.expectedEpoch,
        editorRevision: submission.editorRevision,
        disposition: "consumed",
      },
    });

    await expect(Promise.all([first, replay])).resolves.toEqual([
      expect.objectContaining({
        intentId: submission.intentId,
        disposition: "consumed",
      }),
      expect.objectContaining({
        intentId: submission.intentId,
        disposition: "consumed",
      }),
    ]);
    h.registry.stopAll();
  });

  it("turns a predecessor submission settlement into dropped evidence without publishing successor completion", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    const originalSend = fake.send.bind(fake);
    let heldSubmitId: string | undefined;
    fake.send = ((
      message: Parameters<typeof originalSend>[0],
      callback?: Parameters<typeof originalSend>[1],
    ) => {
      if (message.type !== "submit") return originalSend(message, callback);
      fake.sent.push(message);
      heldSubmitId = (message as unknown as { id: string }).id;
      callback?.(null);
      return true;
    }) as typeof fake.send;
    const hostInstanceId = record.proc!.hostInstanceId!;
    const originEpoch = record.snapshot!.sessionEpoch;
    const pending = h.registry.submit(id, {
      intentId: "predecessor-submit",
      expectedHostId: hostInstanceId,
      expectedEpoch: originEpoch,
      editorRevision: 0,
      text: "possibly consumed by predecessor",
      images: [],
      requestedMode: "followUp",
      surface: "composer",
    });
    await vi.waitFor(() => expect(heldSubmitId).toEqual(expect.any(String)));

    fake.sessionEpoch = originEpoch + 1;
    record.snapshot = { ...record.snapshot!, sessionEpoch: originEpoch + 1 };
    fake.emitWire({
      type: "response",
      id: heldSubmitId!,
      success: true,
      data: {
        intentId: "predecessor-submit",
        hostInstanceId,
        sessionEpoch: originEpoch,
        editorRevision: 0,
        disposition: "consumed",
      },
    });

    await expect(pending).resolves.toMatchObject({
      disposition: "outcome_unknown",
    });
    expect(
      h.submissions.some(
        (entry) =>
          (entry as [SessionId, { intentId: string; disposition: string }])[1]?.intentId ===
            "predecessor-submit" &&
          (entry as [SessionId, { disposition: string }])[1]?.disposition === "consumed",
      ),
    ).toBe(false);
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-submission:predecessor-submit",
        text: "possibly consumed by predecessor",
        disposition: "dropped",
        intentIds: ["predecessor-submit"],
      }),
    ]);
    h.registry.stopAll();
  });

  it("converts an old-epoch async submission disposition into dropped outcome evidence", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    const originalSend = fake.send.bind(fake);
    fake.send = ((
      message: Parameters<typeof originalSend>[0],
      callback?: Parameters<typeof originalSend>[1],
    ) => {
      if (message.type !== "submit") return originalSend(message, callback);
      fake.sent.push(message);
      callback?.(null);
      return true;
    }) as typeof fake.send;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const pending = h.registry.submit(id, {
      intentId: "transition-terminal",
      expectedHostId: hostInstanceId,
      expectedEpoch: sessionEpoch,
      editorRevision: 0,
      text: "terminal during transition",
      images: [],
      requestedMode: "followUp",
      surface: "composer",
    });
    await vi.waitFor(() =>
      expect(fake.sent.some((message) => message.type === "submit")).toBe(true),
    );
    record._hostTransition = {
      transitionId: "forced-transition",
      provisionalEpoch: sessionEpoch + 1,
    };
    record.availability = "transitioning";
    fake.emitWire({
      type: "submission_disposition",
      result: {
        intentId: "transition-terminal",
        hostInstanceId,
        sessionEpoch,
        editorRevision: 0,
        disposition: "completed",
      },
    });
    await tick();

    expect(
      h.submissions.some(
        (entry) =>
          (entry as [SessionId, { intentId: string; disposition: string }])[1]?.intentId ===
            "transition-terminal" &&
          (entry as [SessionId, { disposition: string }])[1]?.disposition === "completed",
      ),
    ).toBe(false);
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-submission:transition-terminal",
        text: "terminal during transition",
        disposition: "dropped",
        intentIds: ["transition-terminal"],
      }),
    ]);
    h.registry.stopAll();
    await expect(pending).resolves.toMatchObject({
      disposition: "outcome_unknown",
    });
  });

  it("keeps a dispatched submission outcome unknown when the host dies before replying", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    const originalSend = fake.send.bind(fake);
    fake.send = ((
      message: Parameters<typeof originalSend>[0],
      callback?: Parameters<typeof originalSend>[1],
    ) => {
      if (message.type !== "submit") return originalSend(message, callback);
      fake.sent.push(message);
      callback?.(null);
      return true;
    }) as typeof fake.send;

    const pending = h.registry.submit(id, {
      intentId: "boundary-crash",
      expectedHostId: record.proc!.hostInstanceId!,
      expectedEpoch: record.snapshot!.sessionEpoch,
      editorRevision: 0,
      text: "possibly consumed",
      images: [{ type: "image", data: "uncertain-bytes", mimeType: "image/png" }],
      requestedMode: "followUp",
      surface: "composer",
    });
    await vi.waitFor(() => expect(record._retainedIntents.has("boundary-crash")).toBe(true));
    expect(record._retainedIntents.get("boundary-crash")?.disposition).toBe("outcome_unknown");

    fake.emitExit(1);
    await expect(pending).resolves.toMatchObject({
      intentId: "boundary-crash",
      disposition: "outcome_unknown",
    });
    expect(record._retainedIntents.get("boundary-crash")?.disposition).toBe("outcome_unknown");
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-submission:boundary-crash",
        text: "possibly consumed",
        attachments: [{ type: "image", data: "uncertain-bytes", mimeType: "image/png" }],
        disposition: "dropped",
        intentIds: ["boundary-crash"],
      }),
    ]);
    h.registry.stopAll();
  });

  it("resyncs revisioned editor state instead of forwarding extension injection", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const fake = h.fakes[0]!;
    h.uiRequests.length = 0;
    fake.emitWire({
      type: "extension_ui_request",
      id: "editor-change",
      method: "set_editor_text",
      text: "extension edit",
    });

    await vi.waitFor(() =>
      expect(fake.sent.some((message) => message.type === "state_request")).toBe(true),
    );
    expect(h.uiRequests).toEqual([]);
    h.registry.stopAll();
  });

  it("replaces provider-auth revisions and clears them by operation or stable acknowledgement", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    const stableId = "provider-auth-openrouter";

    fake.emitWire({
      type: "extension_ui_request",
      id: stableId,
      operationId: `${stableId}:1`,
      method: "providerAuth",
      providerName: "OpenRouter",
      authType: "oauth",
      phase: "oauth",
      authUrl: "https://openrouter.example/authorize",
    });
    expect([...record._pendingUiRequests.keys()]).toEqual([`${stableId}:1`]);

    fake.emitWire({ type: "ui_ack", operationId: `${stableId}:1` });
    expect(record._pendingUiRequests.size).toBe(0);

    fake.emitWire({
      type: "extension_ui_request",
      id: stableId,
      operationId: `${stableId}:2`,
      method: "providerAuth",
      providerName: "OpenRouter",
      authType: "oauth",
      phase: "oauth",
      authUrl: "https://openrouter.example/authorize",
    });
    fake.emitWire({
      type: "extension_ui_request",
      id: stableId,
      operationId: `${stableId}:3`,
      method: "providerAuth",
      providerName: "OpenRouter",
      authType: "oauth",
      phase: "prompt",
      prompt: "Paste the authorization code or redirect URL",
      promptType: "manual_code",
      placeholder: "https://localhost/callback?code=...",
    });

    expect([...record._pendingUiRequests.entries()]).toEqual([
      [
        `${stableId}:3`,
        expect.objectContaining({
          id: stableId,
          operationId: `${stableId}:3`,
          phase: "prompt",
          promptType: "manual_code",
        }),
      ],
    ]);
    expect(h.uiRequests.slice(-2)).toEqual([
      [id, expect.objectContaining({ operationId: `${stableId}:2`, phase: "oauth" })],
      [
        id,
        expect.objectContaining({
          operationId: `${stableId}:3`,
          phase: "prompt",
          promptType: "manual_code",
        }),
      ],
    ]);

    fake.emitWire({ type: "ui_ack", operationId: `${stableId}:2` });
    expect([...record._pendingUiRequests.keys()]).toEqual([`${stableId}:3`]);

    // Provider-auth completion acknowledges the stable surface id rather than
    // its final prompt revision.
    fake.emitWire({ type: "ui_ack", operationId: stableId });
    expect(record._pendingUiRequests.size).toBe(0);
    expect(h.uiAcknowledgements).toContainEqual([id, `${stableId}:1`]);
    expect(h.uiAcknowledgements).toContainEqual([id, stableId]);
    h.registry.stopAll();
  });

  it("collapses provider-auth revisions installed by a transition batch", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    const stableId = "provider-auth-transition";

    fake.emitWire({
      type: "extension_ui_request",
      id: stableId,
      operationId: `${stableId}:direct`,
      method: "providerAuth",
      providerName: "OpenRouter",
      authType: "oauth",
      phase: "waiting",
    });
    expect([...record._pendingUiRequests.keys()]).toEqual([`${stableId}:direct`]);

    // Initial binding uses the same atomic transition-batch installation path
    // as replacement. Re-enter that path with two ordered revisions and prove
    // both the pre-batch revision and the first batch revision are superseded.
    record._procReady = false;
    const terminalSnapshot = fake.snapshot();
    fake.emitControl({
      type: "transition_batch",
      batch: {
        transitionId: `initial-${fake.hostInstanceId}`,
        provisionalEpoch: fake.sessionEpoch,
        records: [
          {
            type: "ui",
            request: {
              type: "extension_ui_request",
              id: stableId,
              operationId: `${stableId}:oauth`,
              method: "providerAuth",
              providerName: "OpenRouter",
              authType: "oauth",
              phase: "oauth",
              authUrl: "https://openrouter.example/authorize",
            },
          },
          {
            type: "ui",
            request: {
              type: "extension_ui_request",
              id: stableId,
              operationId: `${stableId}:manual`,
              method: "providerAuth",
              providerName: "OpenRouter",
              authType: "oauth",
              phase: "prompt",
              prompt: "Paste the authorization code or redirect URL",
              promptType: "manual_code",
            },
          },
        ],
        terminalSnapshot,
      },
    });
    record._procReady = true;

    expect([...record._pendingUiRequests.entries()]).toEqual([
      [
        `${stableId}:manual`,
        expect.objectContaining({
          id: stableId,
          operationId: `${stableId}:manual`,
          promptType: "manual_code",
        }),
      ],
    ]);
    fake.emitWire({ type: "ui_ack", operationId: `${stableId}:manual` });
    expect(record._pendingUiRequests.size).toBe(0);
    h.registry.stopAll();
  });

  it("retires old-host dialogs, panels, and pending acknowledgements before restart", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    fake.emitWire({
      type: "extension_ui_request",
      id: "stale-dialog",
      operationId: "stale-dialog",
      method: "input",
      title: "Old host dialog",
    });
    fake.emitWire({ type: "panel_open", panelId: 19, overlay: true });
    await vi.waitFor(() => expect(record._pendingUiRequests.has("stale-dialog")).toBe(true));
    const response = h.registry.respondToUiRequest(
      id,
      record._rendererGeneration,
      ...runtimeIdentity(record),
      "stale-dialog",
      {
        type: "extension_ui_response",
        id: "stale-dialog",
        value: "answer",
      },
    );
    expect(record._pendingUiAcks.has("stale-dialog")).toBe(true);

    fake.emitExit(1);

    await expect(response).resolves.toBe(false);
    expect(record._pendingUiAcks.size).toBe(0);
    expect(record._pendingUiRequests.size).toBe(0);
    expect(record._openPanels.size).toBe(0);
    expect(record._panelCheckpoints.size).toBe(0);
    expect(record._panelInputSequence.size).toBe(0);
    expect(h.uiAcknowledgements).toContainEqual([id, "stale-dialog"]);
    expect(h.panelEvents).toContainEqual([id, { type: "panel_clear_all" }]);
    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    h.registry.stopAll();
  });

  it("restarts a session with its own last authoritative model and thinking selection", async () => {
    const h = harness();
    const firstId = h.registry.openSession("/tmp/project-a");
    await h.registry.activateSession(firstId, "/tmp/pi", {});
    const firstRecord = h.registry.getSession(firstId)!;
    publishRuntimeResumeCheckpoint(firstRecord, {
      model: { provider: "provider-a", modelId: "model-a" },
      thinkingLevel: "high",
    });

    const secondId = h.registry.openSession("/tmp/project-b");
    await h.registry.activateSession(secondId, "/tmp/pi", {});
    const secondRecord = h.registry.getSession(secondId)!;
    publishRuntimeResumeCheckpoint(secondRecord, {
      model: { provider: "provider-b", modelId: "model-b" },
      thinkingLevel: "minimal",
    });

    h.fakes[0]!.emitExit(1);

    await vi.waitFor(() => expect(h.fakes).toHaveLength(3));
    expect(h.fakes[2]!.sent[0]).toMatchObject({
      type: "init",
      runtimeResumeState: {
        model: { provider: "provider-a", modelId: "model-a" },
        thinkingLevel: "high",
      },
    });
    expect(h.fakes[2]!.sent[0]).not.toMatchObject({
      runtimeResumeState: {
        model: { provider: "provider-b", modelId: "model-b" },
      },
    });
    h.registry.stopAll();
  });

  it("does not start automatic recovery while an unresponsive predecessor is disposing", async () => {
    const h = harness({
      configureFake: (fake, spawnIndex) => {
        if (spawnIndex !== 0) return;
        fake.disconnect = () => {
          if (!fake.connected) throw new Error("Host process IPC channel closed");
          fake.disconnectCalls++;
          fake.connected = false;
          fake.emit("disconnect");
        };
      },
    });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const predecessor = h.fakes[0]!;
    const predecessorHost = h.registry.getSession(id)!.proc!;

    predecessorHost.emit("unresponsive");
    await vi.waitFor(() => expect(predecessor.disconnectCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(predecessor.exitCode).toBeNull();
    expect(h.fakes).toHaveLength(1);
    expect(h.registry.getSession(id)?._retiringHost).toBeDefined();

    predecessor.emitExit(0);
    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    expect(h.registry.getSession(id)?._retiringHost).toBeUndefined();
    h.registry.stopAll();
  });

  it("automatically recovers an exit carrying the fatal IPC backpressure diagnostic", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});

    h.fakes[0]!.emitStderr(
      "[pi-session-host] Fatal IPC transport backpressure failure: IPC queue exceeded 8388608 bytes\n",
    );
    h.fakes[0]!.emitExit(1);

    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    expect(
      h.statuses.some(
        (status) =>
          Array.isArray(status) &&
          status[1] === "failed" &&
          String(status[2]).includes("Fatal IPC transport backpressure failure"),
      ),
    ).toBe(true);
    h.registry.stopAll();
  });

  it("counts one ready replacement crash only once when final activation setup also rejects", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});

    const resync = h.registry.resyncSession.bind(h.registry);
    let rejectReplacementResync!: (reason: Error) => void;
    let markReplacementResyncEntered!: () => void;
    const replacementResyncEntered = new Promise<void>((resolve) => {
      markReplacementResyncEntered = resolve;
    });
    let blockFirstReplacement = true;
    vi.spyOn(h.registry, "resyncSession").mockImplementation((sessionId) => {
      if (blockFirstReplacement && h.fakes.length === 2) {
        blockFirstReplacement = false;
        markReplacementResyncEntered();
        return new Promise((_resolve, reject) => {
          rejectReplacementResync = reject;
        });
      }
      return resync(sessionId);
    });

    h.fakes[0]!.emitExit(1);
    await replacementResyncEntered;
    h.fakes[1]!.emitExit(1);
    // The backoff can elapse before the still-pending activation settles. Its
    // successor must remain owned rather than firing early and being dropped
    // merely because `_activating` is still true.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(h.fakes).toHaveLength(2);
    rejectReplacementResync(new Error("final activation setup failed after host exit"));

    await vi.waitFor(() => expect(h.fakes).toHaveLength(3), { timeout: 3_000 });
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    expect(h.registry.getSession(id)?._rapidFailureCount).toBe(2);
    expect(h.registry.getSession(id)?._automaticRestartAttempt).toBeUndefined();
    h.registry.stopAll();
  });

  it("keeps recovering when replacement hosts fail before ready", async () => {
    const h = harness({ failStartupAt: [1, 2] });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});

    h.fakes[0]!.emitExit(1);

    await vi.waitFor(() => expect(h.fakes).toHaveLength(4), { timeout: 4_000 });
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    expectDirectHostSpawns(h.spawnArgs, 4);
    h.registry.stopAll();
  });

  it("automatically retries three rapid host failures before stopping a crash loop", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});

    for (let crash = 0; crash < 3; crash++) {
      h.fakes[crash]!.emitExit(1);
      await vi.waitFor(() => expect(h.fakes).toHaveLength(crash + 2), { timeout: 3_000 });
      await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    }
    expectDirectHostSpawns(h.spawnArgs, 4);

    h.fakes[3]!.emitExit(1);
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("failed"));
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(h.fakes).toHaveLength(4);
    expectDirectHostSpawns(h.spawnArgs, 4);
    h.registry.stopAll();
  });

  it("reloads in place without spawning a legacy rpc process", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});

    await h.registry.reloadSession(id);

    expectDirectHostSpawns(h.spawnArgs, 1);
    expect(h.registry.getSession(id)?.status).toBe("ready");
    h.registry.stopAll();
  });

  it("settles reload through a correlated replacement intent", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(h.registry.getSession(id)!);

    await expect(
      h.registry.executeReload(id, {
        requestId: "reload-request",
        intentId: "reload-intent",
        expectedHostInstanceId: hostInstanceId,
        expectedSessionEpoch: sessionEpoch,
        sourceText: "/reload",
      }),
    ).resolves.toMatchObject({
      success: true,
      disposition: "completed",
      successorIdentity: { hostInstanceId, sessionEpoch },
    });
    h.registry.stopAll();
  });

  it("does not restore a reload command after its presentation cleared", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const fake = h.fakes[0]!;
    const originalSend = fake.send.bind(fake);
    fake.send = ((
      message: Parameters<typeof fake.send>[0],
      callback?: Parameters<typeof fake.send>[1],
    ) => {
      if (message.type !== "reload") return originalSend(message, callback);
      fake.sent.push(message);
      queueMicrotask(() => callback?.(null));
      return true;
    }) as typeof fake.send;

    const pending = h.registry.executeReload(id, {
      requestId: "lost-reload-request",
      intentId: "lost-reload-intent",
      expectedHostInstanceId: hostInstanceId,
      expectedSessionEpoch: sessionEpoch,
      sourceText: "/reload",
    });
    await vi.waitFor(() =>
      expect(fake.sent.some((message) => message.type === "reload")).toBe(true),
    );
    fake.emitExit(1);

    await expect(pending).resolves.toMatchObject({
      success: false,
      disposition: "outcome_unknown",
      restorationId: "ambiguous-reload:lost-reload-intent",
    });
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-reload:lost-reload-intent",
        text: "/reload",
        disposition: "dropped",
        intentIds: ["lost-reload-intent"],
      }),
    ]);
    h.registry.stopAll();
  });

  it("rejects a reload bound to a replaced runtime before probing the host", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const epoch = h.registry.getSession(id)!.snapshot!.sessionEpoch;
    const stateRequestsBefore = h.fakes[0]!.sent.filter(
      (message) => message.type === "state_request",
    ).length;

    await expect(
      h.registry.reloadSession(id, undefined, undefined, {
        expectedHostInstanceId: "stale-host",
        expectedSessionEpoch: epoch,
      }),
    ).rejects.toThrow("Session changed before reload dispatch");
    expect(h.fakes[0]!.sent.filter((message) => message.type === "state_request")).toHaveLength(
      stateRequestsBefore,
    );
    expect(h.fakes[0]!.sent.some((message) => message.type === "reload")).toBe(false);
    h.registry.stopAll();
  });

  it("rejects reload when the fresh checkpoint became active", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.runtime = {
      ...h.fakes[0]!.runtime,
      isStreaming: true,
      isIdle: false,
    };

    await expect(h.registry.reloadSession(id)).rejects.toThrow("current response");

    expect(h.fakes[0]!.sent.some((message) => message.type === "reload")).toBe(false);
    h.registry.stopAll();
  });

  it("respawns a worktree with another argument-free direct host", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    // Mutate authoritative editor state without emitting an ordinary snapshot;
    // planned respawn must request a fresh checkpoint before detaching.
    h.fakes[0]!.editor = {
      revision: 2,
      text: "just-updated draft",
      attachments: [{ kind: "file", name: "fresh.txt", path: "/tmp/fresh.txt" }],
    };

    await h.registry.setWorktreeAndRespawn(id, "/tmp/project-worktree", "/tmp/pi", {});

    expectDirectHostSpawns(h.spawnArgs, 2);
    expect(h.spawnCwds).toEqual(["/tmp/project", "/tmp/project-worktree"]);
    expect(h.registry.getSession(id)?.status).toBe("ready");
    expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
      text: "just-updated draft",
      attachments: [expect.objectContaining({ name: "fresh.txt" })],
    });
    h.registry.stopAll();
  });

  it("does not spawn a worktree replacement before its predecessor exits", async () => {
    const h = harness({
      configureFake: (fake, spawnIndex) => {
        if (spawnIndex !== 0) return;
        fake.disconnect = () => {
          if (!fake.connected) throw new Error("Host process IPC channel closed");
          fake.disconnectCalls++;
          fake.connected = false;
          fake.emit("disconnect");
        };
      },
    });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const predecessor = h.fakes[0]!;

    const respawn = h.registry.setWorktreeAndRespawn(id, "/tmp/project-worktree", "/tmp/pi", {});
    await vi.waitFor(() => expect(predecessor.disconnectCalls).toBe(1));

    expect(predecessor.exitCode).toBeNull();
    expect(h.fakes).toHaveLength(1);

    predecessor.emitExit(0);
    await respawn;
    expectDirectHostSpawns(h.spawnArgs, 2);
    expect(h.registry.getSession(id)?.status).toBe("ready");
    h.registry.stopAll();
  });

  it("reactivates the previous checkout when destination startup fails", async () => {
    const h = harness({ failStartupAt: [1] });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.editor = { revision: 2, text: "recover me", attachments: [] };

    await expect(
      h.registry.setWorktreeAndRespawn(id, "/tmp/project-worktree", "/tmp/pi", {}),
    ).rejects.toThrow("direct host unavailable");

    expect(h.spawnCwds).toEqual(["/tmp/project", "/tmp/project-worktree", "/tmp/project"]);
    expect(h.registry.getSession(id)).toMatchObject({
      status: "ready",
      availability: "available",
      worktreePath: undefined,
    });
    expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
      text: "recover me",
    });
    h.registry.stopAll();
  });

  it("aborts planned respawn when the fresh checkpoint became active", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.runtime = {
      ...h.fakes[0]!.runtime,
      isStreaming: true,
      isIdle: false,
    };

    await expect(
      h.registry.setWorktreeAndRespawn(id, "/tmp/project-worktree", "/tmp/pi", {}),
    ).rejects.toThrow("active and retained work");

    expect(h.fakes).toHaveLength(1);
    expect(h.fakes[0]!.killed).toBe(false);
    expect(h.registry.getSession(id)?.worktreePath).toBeUndefined();
    h.registry.stopAll();
  });

  it("keeps the current host attached when an async pre-detach guard rejects", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});

    await expect(
      h.registry.setWorktreeAndRespawn(
        id,
        "/tmp/project-worktree",
        "/tmp/pi",
        {},
        {
          onBeforeDetach: async () => {
            await Promise.resolve();
            throw new Error("source checkout changed");
          },
        },
      ),
    ).rejects.toThrow("source checkout changed");

    expect(h.fakes).toHaveLength(1);
    expect(h.fakes[0]!.killed).toBe(false);
    expect(h.registry.getSession(id)?.worktreePath).toBeUndefined();
    expect(h.registry.getSession(id)?.status).toBe("ready");
    h.registry.stopAll();
  });

  it("runs the immediate source guard only after the final host snapshot settles", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const originalRequestSnapshot = record.proc!.requestSnapshot.bind(record.proc!);
    let finalSnapshotEntered = false;
    let releaseFinalSnapshot!: () => void;
    const finalSnapshot = new Promise<void>((resolve) => {
      releaseFinalSnapshot = resolve;
    });
    vi.spyOn(record.proc!, "requestSnapshot")
      .mockImplementationOnce(originalRequestSnapshot)
      .mockImplementationOnce(async () => {
        finalSnapshotEntered = true;
        await finalSnapshot;
        return originalRequestSnapshot();
      });
    const immediateGuard = vi.fn();

    const respawn = h.registry.setWorktreeAndRespawn(
      id,
      "/tmp/project-worktree",
      "/tmp/pi",
      {},
      { onImmediatelyBeforeDetach: immediateGuard },
    );
    await vi.waitFor(() => expect(finalSnapshotEntered).toBe(true));
    expect(immediateGuard).not.toHaveBeenCalled();
    releaseFinalSnapshot();
    await respawn;

    expect(immediateGuard).toHaveBeenCalledOnce();
    expect(h.fakes).toHaveLength(2);
    h.registry.stopAll();
  });

  it("fences editor ingress and captures a final draft after the async guard", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostId, epoch] = runtimeIdentity(record);
    let guardEntered = false;
    let releaseGuard!: () => void;
    const guard = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });

    const respawn = h.registry.setWorktreeAndRespawn(
      id,
      "/tmp/project-worktree",
      "/tmp/pi",
      {},
      {
        onBeforeDetach: async () => {
          guardEntered = true;
          await guard;
        },
      },
    );
    await vi.waitFor(() => expect(guardEntered).toBe(true));
    await expect(
      h.registry.applyEditorPatch(id, hostId, epoch, {
        baseRevision: 0,
        revision: 1,
        text: "late renderer draft",
        attachments: [],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      rejection: "runtime_unavailable",
    });
    h.fakes[0]!.editor = {
      revision: 3,
      text: "extension draft during guard",
      attachments: [],
    };
    releaseGuard();
    await respawn;

    expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
      text: "extension draft during guard",
    });
    expect(h.fakes).toHaveLength(2);
    h.registry.stopAll();
  });

  it("rejects delayed renderer mutations from a retired host identity", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [oldHost, oldEpoch] = runtimeIdentity(record);

    await h.registry.setWorktreeAndRespawn(id, "/tmp/project-worktree", "/tmp/pi", {});
    const replacement = h.fakes[1]!;
    replacement.emitWire({ type: "panel_open", panelId: 1, overlay: true });
    replacement.emitWire({
      type: "extension_ui_request",
      id: "reused-dialog",
      operationId: "reused-dialog",
      method: "input",
      title: "Replacement dialog",
    });

    await expect(
      h.registry.sendPanelInput(id, oldHost, oldEpoch, 1, 1, 1, "stale"),
    ).resolves.toEqual({
      acknowledgedThrough: 0,
      rejection: "runtime_replaced",
    });
    h.registry.resizePanel(id, oldHost, oldEpoch, 1, 80, 24);
    await expect(h.registry.closePanel(id, oldHost, oldEpoch, 1, "stale-close")).resolves.toBe(
      false,
    );
    await expect(
      h.registry.applyEditorPatch(id, oldHost, oldEpoch, {
        baseRevision: 0,
        revision: 1,
        text: "stale",
        attachments: [],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      rejection: "runtime_replaced",
    });
    await expect(
      h.registry.respondToUiRequest(
        id,
        record._rendererGeneration,
        oldHost,
        oldEpoch,
        "reused-dialog",
        { type: "extension_ui_response", id: "reused-dialog", value: "stale" },
      ),
    ).resolves.toBe(false);
    expect(
      replacement.sent.filter((message) =>
        [
          "panel_input",
          "panel_resize",
          "panel_close_request",
          "editor_patch",
          "dialog_response",
        ].includes(message.type),
      ),
    ).toEqual([]);
    h.registry.stopAll();
  });

  it("retires old-host UI before a planned worktree respawn", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    fake.emitWire({
      type: "extension_ui_request",
      id: "worktree-dialog",
      operationId: "worktree-dialog",
      method: "confirm",
      title: "Old runtime",
      message: "Continue?",
    });
    fake.emitWire({ type: "panel_open", panelId: 1, overlay: true });
    fake.emitWire({
      type: "panel_open",
      panelId: 2,
      overlay: false,
      unified: true,
    });
    await vi.waitFor(() => expect(record._openPanels.size).toBe(2));
    const response = h.registry.respondToUiRequest(
      id,
      record._rendererGeneration,
      ...runtimeIdentity(record),
      "worktree-dialog",
      { type: "extension_ui_response", id: "worktree-dialog", confirmed: true },
    );

    await h.registry.setWorktreeAndRespawn(id, "/tmp/project-worktree", "/tmp/pi", {});

    await expect(response).resolves.toBe(false);
    expect(record._pendingUiRequests.size).toBe(0);
    expect(record._pendingUiAcks.size).toBe(0);
    expect(record._openPanels.size).toBe(0);
    expect(h.uiAcknowledgements).toContainEqual([id, "worktree-dialog"]);
    expect(h.panelEvents).toContainEqual([id, { type: "panel_clear_all" }]);
    expect(h.panelEvents).toContainEqual([id, { type: "unified_panel_reset" }]);
    expectDirectHostSpawns(h.spawnArgs, 2);
    h.registry.stopAll();
  });

  it("allows more than ten explicitly active session processes", async () => {
    const h = harness();
    const ids = Array.from({ length: 11 }, () => h.registry.openSession("/tmp/project"));
    for (const id of ids) await h.registry.activateSession(id, "/tmp/pi", {});
    expect(h.registry.getAll().filter((record) => record.proc)).toHaveLength(11);
    expectDirectHostSpawns(h.spawnArgs, 11);
    h.registry.stopAll();
  });

  it("returns typed unavailability when attach crosses session disposal", async () => {
    const h = harness();
    const missing = "missing-session" as SessionId;
    await expect(h.registry.rendererAttach(missing, 1)).resolves.toEqual({
      status: "unavailable",
      reason: "session_missing",
    });
    await expect(h.registry.authorityAttach(missing, 1)).resolves.toEqual({
      status: "unavailable",
      reason: "session_missing",
    });
    const cold = h.registry.openSession("/tmp/project");
    await expect(h.registry.rendererAttach(cold, 1)).resolves.toEqual({
      status: "unavailable",
      reason: "host_cold",
    });

    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const activated = h.registry.getSession(id)!;
    activated.status = "starting";
    activated._activating = true;
    await expect(h.registry.rendererAttach(id, 1)).resolves.toEqual({
      status: "unavailable",
      reason: "host_cold",
    });
    expect(activated._rendererGeneration).toBe(1);
    activated.status = "ready";
    activated._activating = false;
    await h.registry.rendererAttach(id, 1);
    const attaching = h.registry.rendererAttach(id, 2);
    await vi.waitFor(() =>
      expect(
        h.fakes[0]!.sent.some(
          (message) => message.type === "renderer_detached" && message.rendererGeneration === 1,
        ),
      ).toBe(true),
    );

    h.registry.stopAll();
    await expect(attaching).resolves.toEqual({
      status: "unavailable",
      reason: "runtime_replaced",
    });

    const duringResync = harness();
    const resyncId = duringResync.registry.openSession("/tmp/project");
    await duringResync.registry.activateSession(resyncId, "/tmp/pi", {});
    const record = duringResync.registry.getSession(resyncId)!;
    const snapshot = structuredClone(record.snapshot!);
    let resolveSnapshot: ((value: AgentSessionSnapshot) => void) | undefined;
    vi.spyOn(record.proc!, "requestSnapshot").mockReturnValue(
      new Promise<AgentSessionSnapshot>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const resyncingAttach = duringResync.registry.rendererAttach(resyncId, 1);
    duringResync.registry.stopAll();
    resolveSnapshot?.(snapshot);
    await expect(resyncingAttach).resolves.toEqual({
      status: "unavailable",
      reason: "runtime_replaced",
    });

    const timedOut = harness();
    const timedOutId = timedOut.registry.openSession("/tmp/project");
    await timedOut.registry.activateSession(timedOutId, "/tmp/pi", {});
    vi.spyOn(
      timedOut.registry.getSession(timedOutId)!.proc!,
      "requestAuthorityAttach",
    ).mockRejectedValue(
      new HostRequestTimeoutError("Host request timeout for authority_attach (id=test)"),
    );
    await expect(timedOut.registry.authorityAttach(timedOutId, 1)).resolves.toEqual({
      status: "unavailable",
      reason: "host_unresponsive",
    });
    timedOut.registry.stopAll();

    const disconnected = harness();
    const disconnectedId = disconnected.registry.openSession("/tmp/project");
    await disconnected.registry.activateSession(disconnectedId, "/tmp/pi", {});
    disconnected.fakes[0]!.connected = false;
    await expect(disconnected.registry.authorityAttach(disconnectedId, 1)).resolves.toEqual({
      status: "unavailable",
      reason: "host_unresponsive",
    });
    disconnected.registry.stopAll();

    const generations = harness();
    const generationId = generations.registry.openSession("/tmp/project");
    await generations.registry.activateSession(generationId, "/tmp/pi", {});
    await generations.registry.rendererAttach(generationId, 1);
    generations.runtimeStates.length = 0;
    const secondGeneration = generations.registry.rendererAttach(generationId, 2);
    await vi.waitFor(() =>
      expect(
        generations.fakes[0]!.sent.some(
          (message) => message.type === "renderer_detached" && message.rendererGeneration === 1,
        ),
      ).toBe(true),
    );
    const thirdGeneration = generations.registry.rendererAttach(generationId, 3);
    await vi.waitFor(() =>
      expect(
        generations.fakes[0]!.sent.some(
          (message) => message.type === "renderer_detached" && message.rendererGeneration === 2,
        ),
      ).toBe(true),
    );
    generations.fakes[0]!.emitWire({ type: "renderer_cancelled", rendererGeneration: 2 });

    await expect(secondGeneration).resolves.toEqual({
      status: "unavailable",
      reason: "attach_superseded",
    });
    await expect(thirdGeneration).resolves.toMatchObject({ status: "attached" });
    expect(generations.runtimeStates).not.toContainEqual(
      expect.objectContaining({
        availability: "unavailable",
        reason: "Renderer cancellation acknowledgement timed out",
      }),
    );
    generations.registry.stopAll();
  });

  it("retries an unacknowledged detach before reopening a same-generation input sequence", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.rendererAttach(id, 1);
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    record._panelInputSequence.set(7, 4);
    const authorityRequest = vi
      .spyOn(record.proc!, "requestAuthorityAttach")
      .mockResolvedValue({ status: "transitioning", transitionId: "after-detach-fence" });

    vi.useFakeTimers();
    try {
      const firstAttach = h.registry.rendererAttach(id, 2);
      expect(
        fake.sent.filter(
          (message) => message.type === "renderer_detached" && message.rendererGeneration === 1,
        ),
      ).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(firstAttach).resolves.toEqual({
        status: "unavailable",
        reason: "host_unresponsive",
      });
      expect(h.runtimeStates.at(-1)).toMatchObject({
        availability: "unavailable",
        reason: "Renderer cancellation acknowledgement timed out",
      });
      expect(record._rendererCancellationObligation).toMatchObject({
        detachedGeneration: 1,
        successorGeneration: 2,
        hostInstanceId: fake.hostInstanceId,
        sessionEpoch: fake.sessionEpoch,
      });
      expect(record._panelInputSequence.get(7)).toBe(4);

      // Model the real stalled-main ordering: the child already fenced its
      // parser/input baseline, but its acknowledgement and snapshot arrive
      // only after main's timeout callback has won.
      fake.emitWire({ type: "renderer_cancelled", rendererGeneration: 1 });
      fake.emitControl({ type: "snapshot", snapshot: fake.snapshot(), full: true });
      expect(record.availability).toBe("available");
      await expect(h.registry.authorityAttach(id, 2)).resolves.toEqual({
        status: "unavailable",
        reason: "renderer_detach_pending",
      });
      expect(authorityRequest).not.toHaveBeenCalled();
      await expect(
        h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, 1, "still-fenced"),
      ).resolves.toEqual({
        acknowledgedThrough: 0,
        rejection: "runtime_unavailable",
      });

      const retry = h.registry.rendererAttach(id, 2);
      expect(
        fake.sent.filter(
          (message) => message.type === "renderer_detached" && message.rendererGeneration === 1,
        ),
      ).toHaveLength(2);
      fake.emitWire({ type: "renderer_cancelled", rendererGeneration: 1 });
      await expect(retry).resolves.toMatchObject({
        status: "attached",
        runtime: { availability: "available" },
      });
      await expect(h.registry.authorityAttach(id, 2)).resolves.toEqual({
        status: "transitioning",
        transitionId: "after-detach-fence",
      });
      expect(authorityRequest).toHaveBeenCalledOnce();

      expect(record._rendererCancellationObligation).toBeUndefined();
      expect(record._panelInputSequence.size).toBe(0);
      await expect(
        h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, 1, "x"),
      ).resolves.toEqual({ acknowledgedThrough: 1 });
    } finally {
      vi.useRealTimers();
      h.registry.stopAll();
    }
  });

  it("binds a renderer generation early enough to answer a pre-ready trust dialog", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;

    record.status = "starting";
    record._activating = true;
    record._procReady = false;
    record.availability = "unavailable";
    fake.emitWire({
      type: "extension_ui_request",
      id: "startup-trust",
      operationId: "startup-trust",
      method: "select",
      title: "Trust this folder?",
      options: ["Trust this folder", "Do not trust"],
    });
    await vi.waitFor(() => expect(record._pendingUiRequests.has("startup-trust")).toBe(true));
    fake.on("message", (message) => {
      if (message.type !== "dialog_response") return;
      queueMicrotask(() => fake.emitWire({ type: "ui_ack", operationId: "startup-trust" }));
    });

    await expect(
      h.registry.respondToUiRequest(id, 41, ...runtimeIdentity(record), "startup-trust", {
        type: "extension_ui_response",
        id: "startup-trust",
        value: "Trust this folder",
      }),
    ).resolves.toBe(true);

    expect(record._rendererGeneration).toBe(41);
    expect(fake.sent).toContainEqual({
      type: "dialog_response",
      response: {
        type: "extension_ui_response",
        id: "startup-trust",
        value: "Trust this folder",
      },
    });
    expect(record._pendingUiRequests.has("startup-trust")).toBe(false);
    h.registry.stopAll();
  });

  it("does not let a mismatched pre-ready dialog claim renderer ownership", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    record.status = "starting";
    record._activating = true;
    record._procReady = false;
    record.availability = "unavailable";
    fake.emitWire({
      type: "extension_ui_request",
      id: "startup-trust",
      operationId: "startup-trust",
      method: "select",
      title: "Trust this folder?",
      options: ["Trust this folder", "Do not trust"],
    });
    await vi.waitFor(() => expect(record._pendingUiRequests.has("startup-trust")).toBe(true));

    await expect(
      h.registry.respondToUiRequest(id, 41, ...runtimeIdentity(record), "different-operation", {
        type: "extension_ui_response",
        id: "startup-trust",
        value: "Trust this folder",
      }),
    ).resolves.toBe(false);

    expect(record._rendererGeneration).toBe(0);
    expect(fake.sent.some((message) => message.type === "dialog_response")).toBe(false);
    h.registry.stopAll();
  });

  it("replays unresolved unified submissions after renderer reattachment", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "unified-1",
      text: "rapid prompt",
      editorRevision: 8,
      postClearEditor: { revision: 9, text: "", attachments: [] },
      submissionIntentId: "unified-intent-1",
    });
    await tick();
    const submissionIntentId = (
      h.unifiedRequests[0] as [unknown, { submissionIntentId: string }] | undefined
    )?.[1].submissionIntentId;
    expect(submissionIntentId).toBe("unified-intent-1");
    h.unifiedRequests.length = 0;

    await h.registry.rendererAttach(id, 1);

    const [hostInstanceId, sessionEpoch] = runtimeIdentity(h.registry.getSession(id)!);
    expect(h.unifiedRequests).toEqual([
      [
        id,
        {
          id: "unified-1",
          text: "rapid prompt",
          editorRevision: 8,
          postClearEditor: { revision: 9, text: "", attachments: [] },
          submissionIntentId,
          hostInstanceId,
          sessionEpoch,
        },
      ],
    ]);
    const claim = h.registry.claimUnifiedSubmit(id, "unified-1", 1, {
      hostInstanceId,
      sessionEpoch,
    });
    expect(claim).toMatchObject({ claimed: true });
    if (!claim.claimed) throw new Error("claim rejected");
    expect(
      h.registry.respondToUnifiedSubmit(
        id,
        "unified-1",
        { rendererGeneration: 1, claimId: claim.claimId },
        { hostInstanceId, sessionEpoch },
        { ok: true },
      ).accepted,
    ).toBe(true);
    expect(
      h.registry.respondToUnifiedSubmit(
        id,
        "unified-1",
        { rendererGeneration: 1, claimId: claim.claimId },
        { hostInstanceId, sessionEpoch },
        { ok: true },
      ).accepted,
    ).toBe(false);
  });

  it("retires a claimed unified action as non-replayable review on renderer replacement", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.rendererAttach(id, 1);
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "claimed-unified",
      text: "!touch marker",
      editorRevision: 3,
      postClearEditor: { revision: 4, text: "", attachments: [] },
    });
    await tick();
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(h.registry.getSession(id)!);
    const claim = h.registry.claimUnifiedSubmit(id, "claimed-unified", 1, {
      hostInstanceId,
      sessionEpoch,
    });
    expect(claim).toMatchObject({ claimed: true, claimId: expect.any(String) });
    if (!claim.claimed) throw new Error("claim rejected");
    h.unifiedRequests.length = 0;

    const reattaching = h.registry.rendererAttach(id, 2);
    await vi.waitFor(() =>
      expect(
        h.fakes[0]!.sent.some(
          (message) => message.type === "renderer_detached" && message.rendererGeneration === 1,
        ),
      ).toBe(true),
    );
    h.fakes[0]!.emitWire({ type: "renderer_cancelled", rendererGeneration: 1 });
    await reattaching;

    expect(h.unifiedRequests).toEqual([]);
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-unified:claimed-unified",
        text: "",
        attachments: [],
        disposition: "dropped",
      }),
    ]);
    expect(
      h.registry.respondToUnifiedSubmit(
        id,
        "claimed-unified",
        { rendererGeneration: 1, claimId: claim.claimId },
        { hostInstanceId, sessionEpoch },
        { ok: true },
      ).accepted,
    ).toBe(false);
    expect(
      h.fakes[0]!.sent.some(
        (message) => message.type === "unified_submit_response" && message.id === "claimed-unified",
      ),
    ).toBe(true);
    h.registry.stopAll();
  });

  it("cancels the unified watchdog after a correlated response", async () => {
    const h = harness({ unifiedClaimTimeoutMs: 15 });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.rendererAttach(id, 1);
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "settled-unified",
      text: "settled",
      editorRevision: 0,
      postClearEditor: { revision: 1, text: "", attachments: [] },
    });
    await tick();
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(h.registry.getSession(id)!);
    const claim = h.registry.claimUnifiedSubmit(id, "settled-unified", 1, {
      hostInstanceId,
      sessionEpoch,
    });
    if (!claim.claimed) throw new Error("claim rejected");
    expect(
      h.registry.respondToUnifiedSubmit(
        id,
        "settled-unified",
        { rendererGeneration: 1, claimId: claim.claimId },
        { hostInstanceId, sessionEpoch },
        { ok: true },
      ),
    ).toEqual({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.restorations).toEqual([]);
    h.registry.stopAll();
  });

  it("retires a Unified claim at dispatch admission while terminal work may outlive its deadline", async () => {
    const h = harness({ unifiedClaimTimeoutMs: 15 });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.rendererAttach(id, 1);
    const fake = h.fakes[0]!;
    fake.emitWire({
      type: "unified_submit_request",
      id: "long-running-unified",
      text: "take your time",
      editorRevision: 4,
      postClearEditor: { revision: 5, text: "", attachments: [] },
      submissionIntentId: "long-running-intent",
    });
    await vi.waitFor(() => expect(h.unifiedRequests).toHaveLength(1));
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const claim = h.registry.claimUnifiedSubmit(id, "long-running-unified", 1, {
      hostInstanceId,
      sessionEpoch,
    });
    if (!claim.claimed) throw new Error("claim rejected");

    const originalSend = fake.send.bind(fake);
    let dispatchMessage: { id: string; envelope: IntentEnvelope } | undefined;
    fake.send = ((message, callback) => {
      if (message.type !== "dispatch_intent") return originalSend(message, callback);
      fake.sent.push(message);
      dispatchMessage = message as unknown as { id: string; envelope: IntentEnvelope };
      callback?.(null);
      return true;
    }) as typeof fake.send;
    const envelope: IntentEnvelope = {
      sessionId: id,
      intentId: "long-running-intent",
      rendererGeneration: 1,
      expectedOwner: { hostInstanceId, sessionEpoch },
      intent: {
        kind: "submit",
        editorRevision: 4,
        text: "take your time",
        inputKind: "ordinary",
        images: [],
        requestedMode: "followUp",
        surface: "unified",
      },
    };
    const pending = h.registry.dispatchIntent(envelope);
    await vi.waitFor(() => expect(dispatchMessage).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.restorations).toEqual([]);
    expect(record._pendingUnifiedSubmits.get("long-running-unified")?.dispatchStarted).toBe(true);

    fake.emitWire({
      type: "response",
      id: dispatchMessage!.id,
      success: true,
      data: {
        status: "admitted",
        intentId: envelope.intentId,
        owner: envelope.expectedOwner,
      },
    });
    await expect(pending).resolves.toMatchObject({ status: "admitted" });
    expect(
      fake.sent.filter(
        (message) =>
          message.type === "unified_submit_response" && message.id === "long-running-unified",
      ),
    ).toHaveLength(1);
    await expect(h.registry.dispatchIntent(envelope)).resolves.toMatchObject({
      status: "not_admitted",
      reason: "invalid",
    });
    expect(fake.sent.filter((message) => message.type === "dispatch_intent")).toHaveLength(1);
    h.registry.stopAll();
  });

  it("never forwards a Unified intent whose source claim already expired", async () => {
    const h = harness({ unifiedClaimTimeoutMs: 10 });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.rendererAttach(id, 1);
    const fake = h.fakes[0]!;
    fake.emitWire({
      type: "unified_submit_request",
      id: "expired-before-dispatch",
      text: "/reload",
      editorRevision: 2,
      postClearEditor: { revision: 3, text: "", attachments: [] },
      submissionIntentId: "expired-intent",
    });
    await vi.waitFor(() => expect(h.unifiedRequests).toHaveLength(1));
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(h.registry.getSession(id)!);
    expect(
      h.registry.claimUnifiedSubmit(id, "expired-before-dispatch", 1, {
        hostInstanceId,
        sessionEpoch,
      }),
    ).toMatchObject({ claimed: true });
    await vi.waitFor(() =>
      expect(h.registry.getSession(id)!._expiredUnifiedIntents.has("expired-intent")).toBe(true),
    );

    await expect(
      h.registry.dispatchIntent({
        sessionId: id,
        intentId: "expired-intent",
        rendererGeneration: 1,
        expectedOwner: { hostInstanceId, sessionEpoch },
        intent: {
          kind: "reload",
          editorRevision: 2,
          editorText: "/reload",
          surface: "unified",
        },
      }),
    ).resolves.toMatchObject({ status: "not_admitted", reason: "invalid" });
    expect(fake.sent.filter((message) => message.type === "dispatch_intent")).toEqual([]);
    h.registry.stopAll();
  });

  it("expires a hanging unified claim into one non-replayable review", async () => {
    const h = harness({ unifiedClaimTimeoutMs: 15 });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.rendererAttach(id, 1);
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "hanging-unified",
      text: "hang forever",
      editorRevision: 0,
      postClearEditor: { revision: 1, text: "", attachments: [] },
    });
    await vi.waitFor(() => expect(h.unifiedRequests).toHaveLength(1));
    const request = (h.unifiedRequests[0] as [SessionId, { submissionIntentId: string }])[1];
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(h.registry.getSession(id)!);
    const claim = h.registry.claimUnifiedSubmit(id, "hanging-unified", 1, {
      hostInstanceId,
      sessionEpoch,
    });
    if (!claim.claimed) throw new Error("claim rejected");

    await vi.waitFor(
      () =>
        expect(h.restorations).toContainEqual([
          id,
          expect.objectContaining({
            restorationId: "ambiguous-unified:hanging-unified",
            text: "",
            attachments: [],
            disposition: "dropped",
          }),
        ]),
      { timeout: 1_000 },
    );
    expect(
      h.fakes[0]!.sent.filter(
        (message) => message.type === "unified_submit_response" && message.id === "hanging-unified",
      ),
    ).toHaveLength(1);
    expect(
      h.registry.respondToUnifiedSubmit(
        id,
        "hanging-unified",
        { rendererGeneration: 1, claimId: claim.claimId },
        { hostInstanceId, sessionEpoch },
        { ok: true },
      ).accepted,
    ).toBe(false);
    expect(
      h.registry.claimUnifiedSubmit(id, "hanging-unified", 1, {
        hostInstanceId,
        sessionEpoch,
      }),
    ).toEqual({ claimed: false });

    const submitsBefore = h.fakes[0]!.sent.filter((message) => message.type === "submit").length;
    await expect(
      h.registry.submit(id, {
        intentId: request.submissionIntentId,
        expectedHostId: hostInstanceId,
        expectedEpoch: sessionEpoch,
        editorRevision: 0,
        text: "hang forever",
        images: [],
        requestedMode: "followUp",
        surface: "unified",
      }),
    ).resolves.toMatchObject({ disposition: "outcome_unknown" });
    expect(h.fakes[0]!.sent.filter((message) => message.type === "submit")).toHaveLength(
      submitsBefore,
    );
    h.unifiedRequests.length = 0;
    await h.registry.rendererAttach(id, 1);
    expect(h.unifiedRequests).toEqual([]);
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "hanging-unified",
      text: "hang forever",
      editorRevision: 0,
      postClearEditor: { revision: 1, text: "", attachments: [] },
    });
    await tick();
    expect(h.unifiedRequests).toEqual([]);
    expect(
      h.fakes[0]!.sent.filter(
        (message) => message.type === "unified_submit_response" && message.id === "hanging-unified",
      ),
    ).toHaveLength(2);
    expect(h.registry.getSession(id)?._retainedIntents.has(request.submissionIntentId)).toBe(true);
    expect(h.registry.acknowledgeRestoration(id, "ambiguous-unified:hanging-unified")).toBe(true);
    expect(h.registry.getSession(id)?._retainedIntents.has(request.submissionIntentId)).toBe(false);
    h.registry.stopAll();
  });

  it("keeps an acknowledged unified tombstone until an in-flight submission settles", async () => {
    const h = harness({ unifiedClaimTimeoutMs: 15 });
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.rendererAttach(id, 1);
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "inflight-unified",
      text: "possibly consumed",
      editorRevision: 0,
      postClearEditor: { revision: 1, text: "", attachments: [] },
    });
    await vi.waitFor(() => expect(h.unifiedRequests).toHaveLength(1));
    const request = (h.unifiedRequests[0] as [SessionId, { submissionIntentId: string }])[1];
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const claim = h.registry.claimUnifiedSubmit(id, "inflight-unified", 1, {
      hostInstanceId,
      sessionEpoch,
    });
    if (!claim.claimed) throw new Error("claim rejected");

    const fake = h.fakes[0]!;
    const originalSend = fake.send.bind(fake);
    let heldSubmitId: string | undefined;
    fake.send = ((
      message: Parameters<typeof originalSend>[0],
      callback?: Parameters<typeof originalSend>[1],
    ) => {
      if (message.type !== "submit") return originalSend(message, callback);
      fake.sent.push(message);
      heldSubmitId = (message as unknown as { id: string }).id;
      callback?.(null);
      return true;
    }) as typeof fake.send;
    const pending = h.registry.submit(id, {
      intentId: request.submissionIntentId,
      expectedHostId: hostInstanceId,
      expectedEpoch: sessionEpoch,
      editorRevision: 0,
      text: "possibly consumed",
      images: [],
      requestedMode: "followUp",
      surface: "unified",
    });
    await vi.waitFor(() => expect(heldSubmitId).toEqual(expect.any(String)));
    await vi.waitFor(() =>
      expect(record._restorations.has("ambiguous-unified:inflight-unified")).toBe(true),
    );
    expect(h.registry.acknowledgeRestoration(id, "ambiguous-unified:inflight-unified")).toBe(true);
    expect(record._expiredUnifiedIntents.has(request.submissionIntentId)).toBe(true);

    fake.emitWire({
      type: "response",
      id: heldSubmitId!,
      success: true,
      data: {
        intentId: request.submissionIntentId,
        hostInstanceId,
        sessionEpoch,
        editorRevision: 0,
        disposition: "consumed",
      },
    });
    await expect(pending).resolves.toMatchObject({
      disposition: "outcome_unknown",
    });
    await tick();
    expect(record._expiredUnifiedIntents.has(request.submissionIntentId)).toBe(false);
    expect(record._retainedIntents.has(request.submissionIntentId)).toBe(false);
    expect(
      h.submissions.some(
        (entry) =>
          (entry as [SessionId, { intentId: string; disposition: string }])[1]?.intentId ===
            request.submissionIntentId &&
          (entry as [SessionId, { disposition: string }])[1]?.disposition === "consumed",
      ),
    ).toBe(false);
    h.registry.stopAll();
  });

  it("turns a stale unified continuation into review instead of acknowledging a successor", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "unified-stale",
      text: "retain stale editor text",
      editorRevision: 3,
      postClearEditor: { revision: 4, text: "", attachments: [] },
    });
    await tick();
    await h.registry.rendererAttach(id, 1);
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(h.registry.getSession(id)!);
    const claim = h.registry.claimUnifiedSubmit(id, "unified-stale", 1, {
      hostInstanceId,
      sessionEpoch,
    });
    if (!claim.claimed) throw new Error("claim rejected");

    expect(
      h.registry.respondToUnifiedSubmit(
        id,
        "unified-stale",
        { rendererGeneration: 1, claimId: claim.claimId },
        { hostInstanceId, sessionEpoch: sessionEpoch + 1 },
        { ok: true },
      ).accepted,
    ).toBe(false);
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-unified:unified-stale",
        text: "",
        attachments: [],
        disposition: "dropped",
      }),
    ]);
    expect(h.fakes[0]!.sent.some((message) => message.type === "unified_submit_response")).toBe(
      false,
    );
    h.registry.stopAll();
  });

  it("silently drops a cleared pending unified submission after a host crash", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "unified-crash",
      text: "do not replay me",
      editorRevision: 5,
      postClearEditor: { revision: 6, text: "", attachments: [] },
    });
    await tick();
    h.unifiedRequests.length = 0;

    h.fakes[0]!.emitExit(1);
    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    await vi.waitFor(() => expect(h.registry.getSession(id)?._procReady).toBe(true));
    await h.registry.rendererAttach(id, 1);

    expect(h.unifiedRequests).toEqual([]);
    expect(h.restorations).toEqual([
      [
        id,
        expect.objectContaining({
          restorationId: "interrupted-unified:unified-crash",
          text: "",
          attachments: [],
          disposition: "dropped",
          intentIds: [expect.any(String)],
        }),
      ],
      [
        id,
        expect.objectContaining({
          restorationId: "interrupted-unified:unified-crash",
          text: "",
          attachments: [],
          disposition: "dropped",
          intentIds: [expect.any(String)],
        }),
      ],
    ]);
  });

  it.each([
    ["Unified prompt", "unified", "prompt body", "submit"],
    ["Unified slash", "unified", "/safe", "invokeCommand"],
    ["Unified shell", "unified", "!pwd", "runBash"],
    ["Composer prompt", "composer", "prompt body", "submit"],
    ["Composer slash", "composer", "/safe", "invokeCommand"],
    ["Composer shell", "composer", "!pwd", "runBash"],
    ["Composer reload", "composer", "/reload", "reload"],
  ] as const)(
    "%s clear fences a stale cached prefix across immediate host death",
    async (_label, surface, source, kind) => {
      const h = harness();
      const id = h.registry.openSession("/tmp/project");
      await h.registry.activateSession(id, "/tmp/pi", {});
      await h.registry.rendererAttach(id, 1);
      const first = h.fakes[0]!;
      first.editor = {
        revision: 1,
        text: "stale cached prefix",
        attachments: [],
        conflictText: "newer independent draft",
        conflictAttachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
      };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() =>
        expect(h.registry.getSession(id)?.snapshot?.editor.text).toBe("stale cached prefix"),
      );
      const record = h.registry.getSession(id)!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      const intentId = `${surface}-${kind}-clear`;

      if (surface === "unified") {
        first.emitWire({
          type: "unified_submit_request",
          id: `${intentId}-request`,
          text: source,
          editorRevision: 2,
          postClearEditor: {
            revision: 3,
            text: "",
            attachments: [],
            conflictText: "newer independent draft",
            conflictAttachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
          },
          submissionIntentId: intentId,
        });
        await vi.waitFor(() => expect(h.unifiedRequests.length).toBeGreaterThan(0));
        expect(
          h.registry.claimUnifiedSubmit(id, `${intentId}-request`, 1, {
            hostInstanceId,
            sessionEpoch,
          }),
        ).toMatchObject({ claimed: true });
      }

      const intent: IntentEnvelope["intent"] =
        kind === "submit"
          ? {
              kind,
              editorRevision: 2,
              text: source,
              inputKind: "ordinary",
              images: [],
              requestedMode: "followUp",
              surface,
            }
          : kind === "invokeCommand"
            ? { kind, editorRevision: 2, text: source, surface }
            : kind === "runBash"
              ? {
                  kind,
                  command: "pwd",
                  excludeFromContext: false,
                  editorRevision: 2,
                  editorText: source,
                  surface,
                }
              : {
                  kind,
                  editorRevision: 2,
                  editorText: source,
                  surface,
                };
      const envelope: IntentEnvelope = {
        sessionId: id,
        intentId,
        rendererGeneration: 1,
        expectedOwner: { hostInstanceId, sessionEpoch },
        intent,
      };
      const originalSend = first.send.bind(first);
      first.send = ((message, callback) => {
        if (message.type !== "dispatch_intent") return originalSend(message, callback);
        first.sent.push(message);
        callback?.(null);
        queueMicrotask(() => {
          first.emitWire({
            type: "editor_source_cleared",
            intentId,
            editorRevision: 2,
            editor: {
              revision: 3,
              text: "",
              attachments: [],
              conflictText: "newer independent draft",
              conflictAttachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
            },
          });
          first.emitWire({
            type: "response",
            id: message.id,
            success: true,
            data: { status: "admitted", intentId, owner: envelope.expectedOwner },
          });
        });
        return true;
      }) as typeof first.send;

      await expect(h.registry.dispatchIntent(envelope)).resolves.toMatchObject({
        status: "admitted",
      });
      first.emitExit(1);
      await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
      await vi.waitFor(() => expect(h.registry.getSession(id)?._procReady).toBe(true));

      const recovered = h.registry.getSession(id)?.snapshot?.editor;
      expect(recovered?.text).toBe("newer independent draft");
      expect(recovered?.attachments).toEqual([
        { kind: "file", name: "newer.txt", path: "/tmp/newer.txt" },
      ]);
      expect(recovered?.text).not.toContain("stale cached prefix");
      h.registry.stopAll();
    },
  );

  it.each([
    ["ordinary no-model guard", "guarded prompt", false],
    ["local settings command", "/settings", true],
  ] as const)(
    "%s clear survives renderer settlement and a crash before the next snapshot",
    async (_label, source, accepted) => {
      const h = harness();
      const id = h.registry.openSession("/tmp/project");
      await h.registry.activateSession(id, "/tmp/pi", {});
      await h.registry.rendererAttach(id, 1);
      const first = h.fakes[0]!;
      first.editor = {
        revision: 1,
        text: "cached predecessor",
        attachments: [],
        conflictText: "newer independent draft",
        conflictAttachments: [],
      };
      first.emitControl({ type: "snapshot", snapshot: first.snapshot() });
      await vi.waitFor(() =>
        expect(h.registry.getSession(id)?.snapshot?.editor.text).toBe("cached predecessor"),
      );
      const record = h.registry.getSession(id)!;
      const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
      const requestId = `local-clear-${accepted ? "accepted" : "guarded"}`;
      first.emitWire({
        type: "unified_submit_request",
        id: requestId,
        text: source,
        editorRevision: 2,
        postClearEditor: {
          revision: 3,
          text: "",
          attachments: [],
          conflictText: "newer independent draft",
          conflictAttachments: [],
        },
        submissionIntentId: `${requestId}-intent`,
      });
      await vi.waitFor(() => expect(h.unifiedRequests).toHaveLength(1));
      expect(record._editorClearedThroughRevision).toBe(2);
      const claim = h.registry.claimUnifiedSubmit(id, requestId, 1, {
        hostInstanceId,
        sessionEpoch,
      });
      if (!claim.claimed) throw new Error("claim rejected");
      expect(
        h.registry.respondToUnifiedSubmit(
          id,
          requestId,
          { rendererGeneration: 1, claimId: claim.claimId },
          { hostInstanceId, sessionEpoch },
          accepted ? { ok: true } : { ok: false, bailed: true, error: "No model selected" },
        ).accepted,
      ).toBe(true);

      first.emitExit(1);
      await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
      await vi.waitFor(() => expect(h.registry.getSession(id)?._procReady).toBe(true));
      expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
        text: "newer independent draft",
      });
      expect(h.registry.getSession(id)?.snapshot?.editor.text).not.toContain("cached predecessor");
      h.registry.stopAll();
    },
  );

  it.each([
    [
      "typed text",
      "original prompt",
      {
        baseRevision: 1,
        revision: 2,
        text: "local successor",
        attachments: [] as unknown[],
        preserveConflicts: true,
        sourceConsumeRevision: 0,
        sourceConsumeText: "original prompt",
      },
      "local successor",
    ],
    [
      "attachment-only edit",
      "/fork",
      {
        baseRevision: 1,
        revision: 2,
        text: "",
        attachments: [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }] as unknown[],
        preserveConflicts: true,
        sourceConsumeRevision: 0,
        sourceConsumeText: "/fork",
        inheritsSourceTextOnConsumeFailure: true,
      },
      "/fork",
    ],
  ] as const)(
    "never ABA-overwrites an external R+1 with a delayed consume %s successor",
    async (_label, sourceText, patch, expectedConflictText) => {
      const h = harness();
      const id = h.registry.openSession("/tmp/project");
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      record.snapshot = {
        ...record.snapshot!,
        editor: { revision: 0, text: sourceText, attachments: [] },
      };
      const owner = runtimeIdentity(record);
      let resolveConsume!: (value: PiRpcResponse) => void;
      record.proc!.consumeEditorSource = vi.fn(
        () =>
          new Promise<PiRpcResponse>((resolve) => {
            resolveConsume = resolve;
          }),
      );
      record.proc!.sendEditorPatch = vi.fn();

      const consume = h.registry.consumeEditorSource(id, ...owner, {
        editorRevision: 0,
        editorText: sourceText,
      });
      await vi.waitFor(() => expect(record.proc!.consumeEditorSource).toHaveBeenCalledOnce());
      const successor = h.registry.applyEditorPatch(id, ...owner, patch);
      expect(record._pendingEditorSuccessors.size).toBe(1);

      resolveConsume({
        type: "response",
        command: "consume_editor_source",
        success: true,
        data: {
          accepted: false,
          editor: { revision: 1, text: "extension primary", attachments: [] },
        },
      });

      await expect(consume).resolves.toMatchObject({
        accepted: false,
        editor: { revision: 1, text: "extension primary" },
      });
      await expect(successor).resolves.toMatchObject({
        accepted: false,
        text: "extension primary",
        conflictText: expectedConflictText,
      });
      expect(record.proc!.sendEditorPatch).not.toHaveBeenCalled();
      expect(record.snapshot?.editor).toMatchObject({
        revision: 1,
        text: "extension primary",
        conflictText: expectedConflictText,
      });
      if (_label === "attachment-only edit") {
        expect(record.snapshot?.editor.conflictAttachments).toEqual(patch.attachments);
      }
      h.registry.stopAll();
    },
  );

  it("keeps a delayed consume successor chain bounded to its exact latest candidate", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    record.snapshot = {
      ...record.snapshot!,
      editor: { revision: 0, text: "source", attachments: [] },
    };
    const owner = runtimeIdentity(record);
    let resolveConsume!: (value: PiRpcResponse) => void;
    record.proc!.consumeEditorSource = vi.fn(
      () =>
        new Promise<PiRpcResponse>((resolve) => {
          resolveConsume = resolve;
        }),
    );
    record.proc!.sendEditorPatch = vi.fn();
    const consume = h.registry.consumeEditorSource(id, ...owner, {
      editorRevision: 0,
      editorText: "source",
    });
    await vi.waitFor(() => expect(record.proc!.consumeEditorSource).toHaveBeenCalledOnce());

    const successors = Array.from({ length: 64 }, (_, index) =>
      h.registry.applyEditorPatch(id, ...owner, {
        baseRevision: index + 1,
        revision: index + 2,
        text: `latest-${"x".repeat(index + 1)}`,
        attachments: [],
        preserveConflicts: true,
        sourceConsumeRevision: 0,
        sourceConsumeText: "source",
      }),
    );
    expect(record._pendingEditorSuccessors.size).toBe(1);
    expect([...record._pendingEditorSuccessors.values()][0]).toMatchObject({
      revision: 65,
      text: `latest-${"x".repeat(64)}`,
    });

    resolveConsume({
      type: "response",
      command: "consume_editor_source",
      success: true,
      data: {
        accepted: false,
        editor: { revision: 1, text: "external", attachments: [] },
      },
    });
    await consume;
    await Promise.all(successors);

    const editor = record.snapshot!.editor;
    const candidates = [
      editor.conflictText,
      editor.alternateConflictText,
      ...(editor.additionalConflictCandidates ?? []).map((candidate) => candidate.text),
    ].filter((value): value is string => typeof value === "string");
    expect(candidates).toEqual([`latest-${"x".repeat(64)}`]);
    expect(record._pendingEditorSuccessors.size).toBe(0);
    expect(record.proc!.sendEditorPatch).not.toHaveBeenCalled();
    h.registry.stopAll();
  });

  it.each([
    ["typed successor", "prompt", "next draft", [], false],
    [
      "attachment-only successor",
      "/fork",
      "",
      [{ kind: "file", name: "next.txt", path: "/tmp/next.txt" }],
      true,
    ],
  ] as const)(
    "recovers an accepted %s as primary when the host dies before its patch response",
    async (_label, sourceText, successorText, successorAttachments, inheritsSourceText) => {
      const h = harness();
      const id = h.registry.openSession("/tmp/project");
      await h.registry.activateSession(id, "/tmp/pi", {});
      const record = h.registry.getSession(id)!;
      const first = h.fakes[0]!;
      record.snapshot = {
        ...record.snapshot!,
        editor: {
          revision: 0,
          text: sourceText,
          attachments: [],
          conflictText: "independent draft",
          conflictAttachments: [],
        },
      };
      const owner = runtimeIdentity(record);
      let resolveConsume!: (value: PiRpcResponse) => void;
      record.proc!.consumeEditorSource = vi.fn(
        () =>
          new Promise<PiRpcResponse>((resolve) => {
            resolveConsume = resolve;
          }),
      );
      const consume = h.registry.consumeEditorSource(id, ...owner, {
        editorRevision: 0,
        editorText: sourceText,
      });
      await vi.waitFor(() => expect(record.proc!.consumeEditorSource).toHaveBeenCalledOnce());
      const consumeIntentId = (record.proc!.consumeEditorSource as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.intentId as string;
      const successor = h.registry.applyEditorPatch(id, ...owner, {
        baseRevision: 1,
        revision: 2,
        text: successorText,
        attachments: [...successorAttachments],
        preserveConflicts: true,
        sourceConsumeRevision: 0,
        sourceConsumeText: sourceText,
        ...(inheritsSourceText ? { inheritsSourceTextOnConsumeFailure: true } : {}),
      });
      expect(record._pendingEditorSuccessors.size).toBe(1);

      // The child publishes the residual before its RPC response. That event
      // is already causal proof of exact consumption and must promote the
      // same-chain successor before a crash can capture recovery.
      first.emitWire({
        type: "editor_source_cleared",
        intentId: consumeIntentId,
        editorRevision: 0,
        editor: {
          revision: 1,
          text: "",
          attachments: [],
          conflictText: "independent draft",
          conflictAttachments: [],
        },
      });
      expect(record.snapshot?.editor).toMatchObject({
        revision: 2,
        text: successorText,
        attachments: successorAttachments,
        conflictText: "independent draft",
      });

      first.emitExit(1);
      // Unblock the retired request after crash capture. Its late response
      // cannot rewrite the replacement owner or demote the recovered primary.
      resolveConsume({
        type: "response",
        command: "consume_editor_source",
        success: true,
        data: {
          accepted: true,
          sourceRevision: 0,
          editor: { revision: 1, text: "", attachments: [] },
        },
      });
      await expect(consume).resolves.toMatchObject({
        accepted: false,
        rejection: "runtime_replaced",
      });
      await successor;
      await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
      await vi.waitFor(() => expect(h.registry.getSession(id)?._procReady).toBe(true));
      expect(h.registry.getSession(id)?.snapshot?.editor).toMatchObject({
        text: successorText,
        attachments: successorAttachments,
        conflictText: "independent draft",
      });
      expect(h.registry.getSession(id)?.snapshot?.editor.text).not.toBe(sourceText);
      h.registry.stopAll();
    },
  );

  it("rejects an overlapping exact editor consume without replacing the active lineage", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    record.snapshot = {
      ...record.snapshot!,
      editor: { revision: 0, text: "first", attachments: [] },
    };
    const owner = runtimeIdentity(record);
    let resolveConsume!: (value: PiRpcResponse) => void;
    record.proc!.consumeEditorSource = vi.fn(
      () =>
        new Promise<PiRpcResponse>((resolve) => {
          resolveConsume = resolve;
        }),
    );
    const first = h.registry.consumeEditorSource(id, ...owner, {
      editorRevision: 0,
      editorText: "first",
    });
    await vi.waitFor(() => expect(record.proc!.consumeEditorSource).toHaveBeenCalledOnce());
    const token = record._activeEditorConsume;
    await expect(
      h.registry.consumeEditorSource(id, ...owner, {
        editorRevision: 0,
        editorText: "first",
      }),
    ).resolves.toMatchObject({ accepted: false, rejection: "runtime_unavailable" });
    expect(record._activeEditorConsume).toBe(token);
    expect(record.proc!.consumeEditorSource).toHaveBeenCalledOnce();
    resolveConsume({
      type: "response",
      command: "consume_editor_source",
      success: true,
      data: {
        accepted: false,
        editor: { revision: 0, text: "first", attachments: [] },
      },
    });
    await first;
    h.registry.stopAll();
  });

  it("rejects an editor-patch acknowledgement that crosses an epoch boundary", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    type EditorPatchResponse = Awaited<
      ReturnType<NonNullable<SessionRecord["proc"]>["sendEditorPatch"]>
    >;
    let resolvePatch!: (value: EditorPatchResponse) => void;
    record.proc!.sendEditorPatch = vi.fn(
      () =>
        new Promise<EditorPatchResponse>((resolve) => {
          resolvePatch = resolve;
        }),
    );

    const pending = h.registry.applyEditorPatch(id, hostInstanceId, sessionEpoch, {
      baseRevision: 0,
      revision: 1,
      text: "predecessor edit",
      attachments: [],
    });
    await vi.waitFor(() => expect(record.proc!.sendEditorPatch).toHaveBeenCalledOnce());
    record.proc!.sessionEpoch = sessionEpoch + 1;
    record.snapshot = { ...record.snapshot!, sessionEpoch: sessionEpoch + 1 };
    resolvePatch({
      type: "response",
      command: "editor_patch",
      success: true,
      data: {
        accepted: true,
        revision: 1,
        text: "predecessor edit",
        attachments: [],
      },
    });

    await expect(pending).resolves.toMatchObject({
      accepted: false,
      rejection: "runtime_replaced",
    });
    h.registry.stopAll();
  });

  it("serializes rapid in-order panel input before gap detection", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    record._panelInputSequence.set(7, 0);
    let resolveFirst!: () => void;
    record.proc!.sendPanelInput = vi.fn(async (_panelId, _revision, sequence) => {
      if (sequence === 1) await new Promise<void>((resolve) => (resolveFirst = resolve));
      return { acknowledgedThrough: sequence };
    });

    const first = h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, 1, "a");
    const second = h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, 2, "b");
    await vi.waitFor(() => expect(record.proc!.sendPanelInput).toHaveBeenCalledTimes(1));
    resolveFirst();

    await expect(first).resolves.toEqual({ acknowledgedThrough: 1 });
    await expect(second).resolves.toEqual({ acknowledgedThrough: 2 });
    expect(record.proc!.sendPanelInput).toHaveBeenCalledTimes(2);
  });

  it("advances main's input gate from the host watermark before repaint reopens input", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    fake.emitWire({ type: "panel_open", panelId: 7, overlay: false, unified: true });
    expect(record._panelInputSequence.get(7)).toBe(0);
    vi.spyOn(record.proc!, "acknowledgePanelRepaint").mockResolvedValue({
      acknowledged: true,
      // Sequence 1 reached the host, but its correlated panel_input response
      // timed out before main could advance its own cumulative mirror.
      inputAcknowledgedThrough: 1,
    });

    await expect(
      h.registry.acknowledgePanelRepaint(id, ...runtimeIdentity(record), 7, 3),
    ).resolves.toEqual({ acknowledged: true });
    expect(record._panelInputSequence.get(7)).toBe(1);
    await expect(
      h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 3, 2, "successor"),
    ).resolves.toEqual({ acknowledgedThrough: 2 });
    expect(
      fake.sent.some(
        (message) =>
          message.type === "panel_input" && message.sequence === 2 && message.data === "successor",
      ),
    ).toBe(true);
    h.registry.stopAll();
  });

  it("reconciles a late keyframe watermark after the repaint acknowledgement RPC times out", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    await h.registry.rendererAttach(id, 1);
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const owner = { hostInstanceId, sessionEpoch };
    fake.emitWire({ type: "panel_open", panelId: 8, overlay: false, unified: true });
    expect(record._panelInputSequence.get(8)).toBe(0);

    vi.useFakeTimers();
    try {
      const repaintAck = h.registry.acknowledgePanelRepaint(id, ...runtimeIdentity(record), 8, 5);
      const repaintOutcome = repaintAck.then(
        () => undefined,
        (error: unknown) => error,
      );
      const request = fake.sent.find(
        (message) => message.type === "panel_repaint_ack" && message.panelId === 8,
      );
      if (!request || typeof request.id !== "string") throw new Error("missing repaint request");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(repaintOutcome).resolves.toMatchObject({
        message: expect.stringContaining("Host request timeout for panel_repaint_ack"),
      });

      // The response is too late for its request promise, but the immediately
      // following current-owner keyframe independently proves sequence 1 was
      // consumed and must advance main before it is routed to the renderer.
      fake.emitWire({
        type: "response",
        id: request.id,
        success: true,
        data: { acknowledged: true, inputAcknowledgedThrough: 1 },
      });
      const cursor = { ...owner, transportSequence: 10, snapshotSequence: 10 };
      h.registry.routeAuthorityPublication(id, {
        plane: "panel",
        owner,
        payload: {
          kind: "keyframe",
          cursor,
          panel: {
            panelKey: "panel:8",
            panelId: 8,
            owner,
            sync: { state: "following", cursor },
            overlay: false,
            unified: true,
            mode: "content",
            inputAcknowledgedThrough: 1,
            keyframe: { kind: "keyframe", ansi: "", renderRevision: 5 },
          },
        },
      });
      expect(record._panelInputSequence.get(8)).toBe(1);

      await expect(
        h.registry.sendPanelInput(id, ...runtimeIdentity(record), 8, 5, 2, "successor"),
      ).resolves.toEqual({ acknowledgedThrough: 2 });
    } finally {
      vi.useRealTimers();
      h.registry.stopAll();
    }
  });

  it("reports definitive no-delivery when panel ownership changes during the host await", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const owner = runtimeIdentity(record);
    record._panelInputSequence.set(7, 0);
    let resolveInput!: (result: { acknowledgedThrough: number }) => void;
    record.proc!.sendPanelInput = vi.fn(
      () =>
        new Promise<{ acknowledgedThrough: number }>((resolve) => {
          resolveInput = resolve;
        }),
    );

    const pending = h.registry.sendPanelInput(id, ...owner, 7, 1, 1, "first-key");
    await vi.waitFor(() => expect(record.proc!.sendPanelInput).toHaveBeenCalledOnce());
    record.proc!.sessionEpoch = owner[1] + 1;
    record.snapshot = { ...record.snapshot!, sessionEpoch: owner[1] + 1 };
    resolveInput({ acknowledgedThrough: 1 });

    await expect(pending).resolves.toEqual({
      acknowledgedThrough: 0,
      rejection: "runtime_replaced",
    });
    expect(record._panelInputSequence.get(7)).toBe(0);
    h.registry.stopAll();
  });

  it("reports unavailable without dispatch when a panel owner has died", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const owner = runtimeIdentity(record);
    const send = vi.spyOn(record.proc!, "sendPanelInput");
    record._dead = true;
    record.availability = "unavailable";

    await expect(h.registry.sendPanelInput(id, ...owner, 7, 1, 1, "first-key")).resolves.toEqual({
      acknowledgedThrough: 0,
      rejection: "runtime_unavailable",
    });
    expect(send).not.toHaveBeenCalled();
    h.registry.stopAll();
  });

  it("checkpoints panel editor text without echoing large attachment payloads to the renderer", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const hugeDataUrl = `data:image/png;base64,${"a".repeat(2_000_000)}`;
    const attachments = [{ kind: "image", data: hugeDataUrl, mimeType: "image/png" }];
    record.snapshot = {
      ...record.snapshot!,
      editor: {
        revision: 7,
        text: "before",
        attachments,
        conflictText: "retired conflict",
        conflictAttachments: [],
      },
    };
    record._editorRecovery = structuredClone(record.snapshot.editor);
    record._panelInputSequence.set(7, 0);
    record.proc!.sendPanelInput = vi.fn(async () => ({
      acknowledgedThrough: 1,
      editorCheckpoint: { revision: 8, text: "beforex", clearedConflicts: true },
    }));

    const result = await h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, 1, "x");

    expect(result).toEqual({ acknowledgedThrough: 1 });
    expect(JSON.stringify(result)).not.toContain("data:image");
    expect(record.snapshot?.editor).toEqual({
      revision: 8,
      text: "beforex",
      attachments,
    });
    expect(record._editorRecovery).toEqual(record.snapshot?.editor);
    const childCheckpoint = (record.proc!.sendPanelInput as ReturnType<typeof vi.fn>).mock
      .results[0]?.value;
    expect(JSON.stringify(await childCheckpoint)).not.toContain(hugeDataUrl);
    h.registry.stopAll();
  });

  it("acknowledges panel input cumulatively and rejects gaps", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    record._panelInputSequence.set(7, 0);
    await expect(
      h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, 2, "b"),
    ).resolves.toEqual({
      acknowledgedThrough: 0,
      gap: { expected: 1, received: 2 },
    });
    record.proc!.sendPanelInput = vi.fn(async () => {
      throw new Error("host rejected input");
    });
    await expect(
      h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, 1, "a"),
    ).rejects.toThrow("host rejected input");
    expect(record._panelInputSequence.get(7)).toBe(0);
  });

  it("owner-fences Shell Turn input and counts only an accepted host mutation", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const owner = runtimeIdentity(record);
    const mutationSequence = record._mutationSequence;
    const input = vi.spyOn(record.proc!, "sendShellInput").mockResolvedValue({
      accepted: true,
      acknowledgedThrough: 1,
    });

    await expect(
      h.registry.sendShellInput(id, ...owner, "shell-1", 1, "answer\n"),
    ).resolves.toEqual({ accepted: true, acknowledgedThrough: 1 });
    expect(input).toHaveBeenCalledWith("shell-1", 1, "answer\n");
    expect(record._mutationSequence).toBe(mutationSequence + 1);

    await expect(
      h.registry.sendShellInput(id, "stale-host", owner[1], "shell-1", 2, "stale"),
    ).resolves.toEqual({ accepted: false, acknowledgedThrough: 0 });
    expect(input).toHaveBeenCalledOnce();
    h.registry.stopAll();
  });

  it("discards a Shell Turn acknowledgement that crosses an owner epoch", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    let resolveInput!: (result: {
      accepted: boolean;
      acknowledgedThrough: number;
    }) => void;
    record.proc!.sendShellInput = vi.fn(
      () =>
        new Promise<{ accepted: boolean; acknowledgedThrough: number }>((resolve) => {
          resolveInput = resolve;
        }),
    );

    const pending = h.registry.sendShellInput(
      id,
      hostInstanceId,
      sessionEpoch,
      "shell-1",
      1,
      "answer\n",
    );
    await vi.waitFor(() => expect(record.proc!.sendShellInput).toHaveBeenCalledOnce());
    record.proc!.sessionEpoch = sessionEpoch + 1;
    record.snapshot = { ...record.snapshot!, sessionEpoch: sessionEpoch + 1 };
    resolveInput({ accepted: true, acknowledgedThrough: 1 });

    await expect(pending).resolves.toEqual({ accepted: false, acknowledgedThrough: 0 });
    h.registry.stopAll();
  });

  it("owner-fences Shell Turn resize, reconstruction, and termination controls", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const owner = runtimeIdentity(record);
    const resize = vi.spyOn(record.proc!, "sendShellResize").mockResolvedValue(true);
    const acknowledge = vi
      .spyOn(record.proc!, "acknowledgeShellReconstruction")
      .mockResolvedValue(true);
    const signal = vi.spyOn(record.proc!, "sendShellSignal").mockResolvedValue(true);

    await expect(h.registry.resizeShell(id, ...owner, "shell-1", 3, 100, 40)).resolves.toEqual({
      accepted: true,
    });
    await expect(
      h.registry.acknowledgeShellReconstruction(id, ...owner, "shell-1", 3, 8),
    ).resolves.toEqual({ accepted: true });
    await expect(h.registry.signalShell(id, ...owner, "shell-1", "interrupt")).resolves.toEqual({
      accepted: true,
    });
    expect(resize).toHaveBeenCalledWith("shell-1", 3, 100, 40);
    expect(acknowledge).toHaveBeenCalledWith("shell-1", 3, 8);
    expect(signal).toHaveBeenCalledWith("shell-1", "interrupt");

    await expect(
      h.registry.signalShell(id, "stale-host", owner[1], "shell-1", "kill"),
    ).resolves.toEqual({ accepted: false });
    expect(signal).toHaveBeenCalledOnce();
    h.registry.stopAll();
  });
});
