import type { SessionId } from "@shared/ids.js";
import type { AgentSessionSnapshot } from "@shared/pi-protocol/runtime-state.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHostProcess } from "../../../tests/fixtures/fake-host-process.mjs";
import { __forkOverride } from "../pi/session-host.js";
import { type SessionRecord, SessionRegistry } from "./session-registry.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const runtimeIdentity = (record: NonNullable<ReturnType<SessionRegistry["getSession"]>>) =>
  [record.proc!.hostInstanceId!, record.proc!.sessionEpoch] as const;

function harness(
  options: {
    failStartupAt?: number[];
    configureFake?: (fake: FakeHostProcess, spawnIndex: number) => void;
    unifiedClaimTimeoutMs?: number;
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
  const fakes: FakeHostProcess[] = [];
  const spawnArgs: string[][] = [];
  const spawnCwds: Array<string | undefined> = [];
  __forkOverride.fn = (_path, args, forkOptions) => {
    const spawnIndex = fakes.length;
    spawnArgs.push(args);
    spawnCwds.push((forkOptions as { cwd?: string }).cwd);
    const fake = new FakeHostProcess();
    options.configureFake?.(fake, spawnIndex);
    fakes.push(fake);
    fake.on("message", (message) => {
      if ((message as { type?: string }).type !== "init") return;
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
    (...args) => statuses.push(args),
    (...args) => panelEvents.push(args),
    (...args) => unifiedRequests.push(args),
    (_sid, state) => runtimeStates.push(state),
    (...args) => submissions.push(args),
    (...args) => restorations.push(args),
    (...args) => uiAcknowledgements.push(args),
    () => {},
    {
      ...(options.unifiedClaimTimeoutMs !== undefined
        ? { unifiedClaimTimeoutMs: options.unifiedClaimTimeoutMs }
        : {}),
    },
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
    fakes,
    spawnArgs,
    spawnCwds,
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
  it("uses only the SDK host and never spawns an rpc argv", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    expectDirectHostSpawns(h.spawnArgs, 1);
    expect(h.registry.getSession(id)?.proc).toBeDefined();
    h.registry.stopAll();
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

    expect(fake.killed).toBe(true);
    expect(h.registry.getSession(id)).toMatchObject({ status: "cold", proc: undefined });
    expect(h.panelEvents).toContainEqual([id, { type: "unified_panel_reset" }]);
    h.registry.stopAll();
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
    fake.emitWire({ type: "response", id: request.id, success: true, data: fake.snapshot() });

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

  it("rejects identity-bound commands instead of rebinding them to the current host", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;

    await expect(
      h.registry.executeRendererCommand(id, {
        requestId: "stale-command",
        command: { type: "get_state" },
        expectedHostInstanceId: "replacement-host",
        expectedSessionEpoch: record.snapshot!.sessionEpoch,
      }),
    ).resolves.toMatchObject({
      success: false,
      disposition: "not_executed",
      error: "Session changed before command dispatch",
    });
    expect(h.fakes[0]!.sent.some((message) => message.type === "command")).toBe(false);
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

  it("settles a non-replacement command as unknown when its epoch changes before response", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    let resolveCommand!: (response: {
      type: "response";
      command: "compact";
      success: true;
      data: Record<string, never>;
    }) => void;
    vi.spyOn(record.proc!, "sendCommand").mockImplementation((_command, options) => {
      options?.onDispatched?.();
      return new Promise((resolve) => {
        resolveCommand = resolve;
      });
    });

    const pending = h.registry.executeRendererCommand(id, {
      requestId: "epoch-race",
      intentId: "epoch-race-intent",
      command: { type: "compact" },
      expectedHostInstanceId: hostInstanceId,
      expectedSessionEpoch: sessionEpoch,
      sourceText: "/compact",
    });
    record.proc!.sessionEpoch = sessionEpoch + 1;
    record.snapshot = {
      ...record.snapshot!,
      sessionEpoch: sessionEpoch + 1,
      snapshotSequence: record.snapshot!.snapshotSequence + 1,
    };
    resolveCommand({ type: "response", command: "compact", success: true, data: {} });

    await expect(pending).resolves.toMatchObject({
      disposition: "outcome_unknown",
      restorationId: "ambiguous-command:epoch-race-intent",
    });
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-command:epoch-race-intent",
        commandDescription: expect.stringContaining("compact"),
      }),
    ]);
    h.registry.stopAll();
  });

  it("fences command and ESC acknowledgements that arrive after close preparation", async () => {
    const commandHarness = harness();
    const commandSession = commandHarness.registry.openSession("/tmp/project-command");
    await commandHarness.registry.activateSession(commandSession, "/tmp/pi", {});
    const commandRecord = commandHarness.registry.getSession(commandSession)!;
    const [commandHost, commandEpoch] = runtimeIdentity(commandRecord);
    let resolveCommand!: (response: {
      type: "response";
      command: "compact";
      success: true;
      data: Record<string, never>;
    }) => void;
    vi.spyOn(commandRecord.proc!, "sendCommand").mockImplementation((_command, options) => {
      options?.onDispatched?.();
      return new Promise((resolve) => {
        resolveCommand = resolve;
      });
    });
    const command = commandHarness.registry.executeRendererCommand(commandSession, {
      requestId: "close-command",
      intentId: "close-command-intent",
      command: { type: "compact" },
      expectedHostInstanceId: commandHost,
      expectedSessionEpoch: commandEpoch,
      sourceText: "/compact",
    });
    await vi.waitFor(() => expect(commandRecord.proc!.sendCommand).toHaveBeenCalledOnce());
    const commandClose = await commandHarness.registry.prepareClose(commandSession);
    resolveCommand({ type: "response", command: "compact", success: true, data: {} });
    await expect(command).resolves.toMatchObject({ disposition: "outcome_unknown" });
    expect(commandHarness.restorations).toEqual([]);
    await expect(
      commandHarness.registry.confirmClose(commandSession, commandClose.reviewToken),
    ).resolves.toEqual({ closed: true });

    const escapeHarness = harness();
    const escapeSession = escapeHarness.registry.openSession("/tmp/project-escape");
    await escapeHarness.registry.activateSession(escapeSession, "/tmp/pi", {});
    const escapeRecord = escapeHarness.registry.getSession(escapeSession)!;
    const [escapeHost, escapeEpoch] = runtimeIdentity(escapeRecord);
    let resolveEscape!: (value: {
      requestId: string;
      hostInstanceId: string;
      sessionEpoch: number;
      disposition: "abort_requested";
      target: "streaming";
    }) => void;
    vi.spyOn(escapeRecord.proc!, "escape").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEscape = resolve;
        }),
    );
    const pendingEscape = escapeHarness.registry.escapeSession(escapeSession, "close-escape", {
      hostInstanceId: escapeHost,
      sessionEpoch: escapeEpoch,
    });
    await vi.waitFor(() => expect(escapeRecord.proc!.escape).toHaveBeenCalledOnce());
    const escapeClose = await escapeHarness.registry.prepareClose(escapeSession);
    resolveEscape({
      requestId: "close-escape",
      hostInstanceId: escapeHost,
      sessionEpoch: escapeEpoch,
      disposition: "abort_requested",
      target: "streaming",
    });
    await expect(pendingEscape).resolves.toMatchObject({ disposition: "outcome_unknown" });
    await expect(
      escapeHarness.registry.confirmClose(escapeSession, escapeClose.reviewToken),
    ).resolves.toEqual({ closed: true });
  });

  it("refuses renderer commands while runtime authority is unavailable", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    record.availability = "transitioning";
    const before = h.fakes[0]!.sent.filter((message) => message.type === "command").length;

    await expect(
      h.registry.executeRendererCommand(id, {
        requestId: "during-transition",
        command: { type: "get_state" },
        expectedHostInstanceId: hostInstanceId,
        expectedSessionEpoch: sessionEpoch,
      }),
    ).resolves.toMatchObject({ success: false, disposition: "not_executed" });
    expect(h.fakes[0]!.sent.filter((message) => message.type === "command")).toHaveLength(before);
    h.registry.stopAll();
  });

  it("settles a correlated host domain failure as completed rather than transport failure", async () => {
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
      if (message.type !== "command") return originalSend(message, callback);
      fake.sent.push(message);
      queueMicrotask(() => {
        callback?.(null);
        fake.emitWire({
          type: "response",
          id: message.id,
          success: false,
          error: "Nothing to compact",
        });
      });
      return true;
    }) as typeof fake.send;

    await expect(
      h.registry.executeRendererCommand(id, {
        requestId: "compact-domain-failure",
        intentId: "compact-domain-intent",
        command: { type: "compact" },
        expectedHostInstanceId: hostInstanceId,
        expectedSessionEpoch: sessionEpoch,
        sourceText: "/compact",
      }),
    ).resolves.toMatchObject({
      success: false,
      disposition: "completed",
      error: "Nothing to compact",
    });
    expect(record._retainedCommandIntents.size).toBe(0);
    expect(h.restorations).toHaveLength(0);
    h.registry.stopAll();
  });

  it("publishes review-only custody when an effectful acknowledgement is lost", async () => {
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
      if (message.type !== "command") return originalSend(message, callback);
      fake.sent.push(message);
      queueMicrotask(() => callback?.(null));
      return true;
    }) as typeof fake.send;

    const pending = h.registry.executeRendererCommand(id, {
      requestId: "ambiguous-bash",
      intentId: "ambiguous-bash-intent",
      command: { type: "bash", command: "touch marker" },
      expectedHostInstanceId: hostInstanceId,
      expectedSessionEpoch: sessionEpoch,
      sourceText: "!touch marker",
    });
    await tick();
    fake.emitExit(1);

    await expect(pending).resolves.toMatchObject({
      success: false,
      disposition: "outcome_unknown",
      restorationId: "ambiguous-command:ambiguous-bash-intent",
    });
    expect(h.restorations).toContainEqual([
      id,
      expect.objectContaining({
        restorationId: "ambiguous-command:ambiguous-bash-intent",
        followUp: [],
        commandDescription: expect.stringMatching(/bash.*!touch marker.*may have completed/),
      }),
    ]);
    expect(h.registry.acknowledgeRestoration(id, "ambiguous-command:ambiguous-bash-intent")).toBe(
      true,
    );
    expect(record._retainedCommandIntents.size).toBe(0);
    h.registry.stopAll();
  });

  it("does not misreport a dispatched idempotent command as not executed after transport loss", async () => {
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
      if (message.type !== "command") return originalSend(message, callback);
      fake.sent.push(message);
      queueMicrotask(() => callback?.(null));
      return true;
    }) as typeof fake.send;

    const pending = h.registry.executeRendererCommand(id, {
      requestId: "ambiguous-name",
      command: { type: "set_session_name", name: "Possibly applied" },
      expectedHostInstanceId: hostInstanceId,
      expectedSessionEpoch: sessionEpoch,
    });
    await tick();
    fake.emitExit(1);

    await expect(pending).resolves.toMatchObject({
      success: false,
      disposition: "outcome_unknown",
    });
    expect(h.restorations).toHaveLength(0);
    h.registry.stopAll();
  });

  it("repairs a dropped start event from a fresh direct snapshot", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const fake = h.fakes[0]!;
    fake.runtime = { ...fake.runtime, isStreaming: true, isIdle: false };
    fake.emitControl({ type: "snapshot", snapshot: fake.snapshot(), full: false });
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
    const stale = { ...newest, snapshotSequence: newest.snapshotSequence - 1, isStreaming: false };
    fake.emitControl({ type: "snapshot", snapshot: stale, full: false });
    fake.transportSequence += 1;
    fake.emitControl({ type: "snapshot", snapshot: fake.snapshot(), full: false });
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

  it("retains replacement attachments when recovery candidates have identical text", async () => {
    const h = harness({
      configureFake: (fake, spawnIndex) => {
        if (spawnIndex !== 1) return;
        fake.beforeEditorPatch = () => {
          fake.beforeEditorPatch = undefined;
          fake.editor = {
            revision: 1,
            text: "user recovery draft",
            attachments: [{ kind: "file", name: "replacement.txt", path: "/tmp/replacement.txt" }],
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
              { kind: "file", name: `replacement-${mutation}.txt`, path: `/tmp/r-${mutation}` },
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
      h.registry.submit("missing" as never, { ...base, intentId: "missing-session" }),
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

  it("publishes retained composer payloads for review when custody becomes ambiguous", async () => {
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
        followUp: ["recover exact text"],
        originalAttachments: [
          {
            intentId: "crash-review",
            images: [{ type: "image", data: "bytes", mimeType: "image/png" }],
          },
        ],
      }),
    ]);
    expect(h.submissions).toContainEqual([
      id,
      expect.objectContaining({ intentId: "crash-review", disposition: "outcome_unknown" }),
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

  it("restores active-turn work that completed prompt admission but remained queued", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const fake = h.fakes[0]!;
    fake.runtime = { ...fake.runtime, isStreaming: true, isIdle: false };
    fake.emitControl({ type: "snapshot", snapshot: fake.snapshot(), full: false });
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
          followUp: ["queued follow-up"],
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
      expect.objectContaining({ intentId: submission.intentId, disposition: "consumed" }),
      expect.objectContaining({ intentId: submission.intentId, disposition: "consumed" }),
    ]);
    h.registry.stopAll();
  });

  it("turns a predecessor submission settlement into review without publishing successor completion", async () => {
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

    await expect(pending).resolves.toMatchObject({ disposition: "outcome_unknown" });
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
        followUp: ["possibly consumed by predecessor"],
      }),
    ]);
    h.registry.stopAll();
  });

  it("converts an old-epoch async submission disposition during transition into review", async () => {
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
        followUp: ["terminal during transition"],
      }),
    ]);
    h.registry.stopAll();
    await expect(pending).resolves.toMatchObject({ disposition: "outcome_unknown" });
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
        followUp: ["possibly consumed"],
        originalAttachments: [
          {
            intentId: "boundary-crash",
            images: [{ type: "image", data: "uncertain-bytes", mimeType: "image/png" }],
          },
        ],
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

  it("restarts once and leaves a second rapid crash failed", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});

    h.fakes[0]!.emitExit(1);
    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("ready"));
    expectDirectHostSpawns(h.spawnArgs, 2);

    h.fakes[1]!.emitExit(1);
    await vi.waitFor(() => expect(h.registry.getSession(id)?.status).toBe("failed"));
    await tick();
    expect(h.fakes).toHaveLength(2);
    expectDirectHostSpawns(h.spawnArgs, 2);
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

  it("retains review when reload acknowledgement is lost after dispatch", async () => {
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
        commandDescription: expect.stringContaining("reload may have completed"),
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

  it("does not dispatch reload after close preparation wins a deferred preflight", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const originalRequestSnapshot = record.proc!.requestSnapshot.bind(record.proc!);
    let resolvePreflight!: (snapshot: AgentSessionSnapshot) => void;
    vi.spyOn(record.proc!, "requestSnapshot")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePreflight = resolve;
          }),
      )
      .mockImplementation(originalRequestSnapshot);

    const reload = h.registry.reloadSession(id);
    await vi.waitFor(() => expect(record.proc!.requestSnapshot).toHaveBeenCalledOnce());
    const prepared = await h.registry.prepareClose(id);
    resolvePreflight(record.snapshot!);
    await expect(reload).rejects.toThrow("close preparation");
    expect(h.fakes[0]!.sent.some((message) => message.type === "reload")).toBe(false);
    await expect(h.registry.confirmClose(id, prepared.reviewToken)).resolves.toEqual({
      closed: true,
    });
  });

  it("rejects reload when the fresh checkpoint became active", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.runtime = { ...h.fakes[0]!.runtime, isStreaming: true, isIdle: false };

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

  it("does not detach for worktree respawn after close wins a deferred preflight", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const originalRequestSnapshot = record.proc!.requestSnapshot.bind(record.proc!);
    let resolvePreflight!: (snapshot: AgentSessionSnapshot) => void;
    vi.spyOn(record.proc!, "requestSnapshot")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePreflight = resolve;
          }),
      )
      .mockImplementation(originalRequestSnapshot);

    const respawn = h.registry.setWorktreeAndRespawn(id, "/tmp/project-worktree", "/tmp/pi", {});
    await vi.waitFor(() => expect(record.proc!.requestSnapshot).toHaveBeenCalledOnce());
    const prepared = await h.registry.prepareClose(id);
    resolvePreflight(record.snapshot!);
    await expect(respawn).rejects.toThrow("active and retained work");
    expect(h.fakes).toHaveLength(1);
    expect(h.fakes[0]!.killed).toBe(false);
    await expect(h.registry.confirmClose(id, prepared.reviewToken)).resolves.toEqual({
      closed: true,
    });
  });

  it("aborts planned respawn when the fresh checkpoint became active", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.runtime = { ...h.fakes[0]!.runtime, isStreaming: true, isIdle: false };

    await expect(
      h.registry.setWorktreeAndRespawn(id, "/tmp/project-worktree", "/tmp/pi", {}),
    ).rejects.toThrow("active and retained work");

    expect(h.fakes).toHaveLength(1);
    expect(h.fakes[0]!.killed).toBe(false);
    expect(h.registry.getSession(id)?.worktreePath).toBeUndefined();
    h.registry.stopAll();
  });

  it("rejects a UI acknowledgement that arrives after close preparation", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const [hostInstanceId, sessionEpoch] = runtimeIdentity(record);
    const pending = h.registry.respondToUiRequest(
      id,
      record._rendererGeneration,
      hostInstanceId,
      sessionEpoch,
      "late-ui-ack",
      { type: "extension_ui_response", id: "late-ui-ack", value: "answer" },
    );
    await vi.waitFor(() =>
      expect(
        h.fakes[0]!.sent.some(
          (message) =>
            message.type === "dialog_response" &&
            (message.response as { id?: string } | undefined)?.id === "late-ui-ack",
        ),
      ).toBe(true),
    );
    const prepared = await h.registry.prepareClose(id);
    h.fakes[0]!.emitWire({ type: "ui_ack", operationId: "late-ui-ack" });
    await expect(pending).resolves.toBe(false);
    await expect(h.registry.confirmClose(id, prepared.reviewToken)).resolves.toEqual({
      closed: true,
    });
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

    await expect(h.registry.sendPanelInput(id, oldHost, oldEpoch, 1, 1, "stale")).resolves.toEqual({
      acknowledgedThrough: 0,
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
    ).rejects.toThrow("replaced");
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
    fake.emitWire({ type: "panel_open", panelId: 2, overlay: false, unified: true });
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

  it("requires a current prepare-close token", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const prepared = await h.registry.prepareClose(id);
    h.fakes[0]!.emitWire({ type: "event", event: { type: "agent_start" } });
    await expect(h.registry.confirmClose(id, prepared.reviewToken)).resolves.toEqual({
      closed: false,
      reason: "Session changed after the close checkpoint",
    });
    expect(h.registry.getSession(id)?._closing).toBe(false);
    const fresh = await h.registry.prepareClose(id);
    await expect(h.registry.confirmClose(id, fresh.reviewToken)).resolves.toEqual({ closed: true });
  });

  it("allows a failed or cold session with no host to close", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");

    const prepared = await h.registry.prepareClose(id);
    await expect(h.registry.confirmClose(id, prepared.reviewToken)).resolves.toEqual({
      closed: true,
    });
    expect(h.registry.getSession(id)).toBeUndefined();
  });

  it("rejects every renderer ingress path after prepare-close", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    const prepared = await h.registry.prepareClose(id);

    await expect(
      h.registry.respondToUiRequest(
        id,
        record._rendererGeneration,
        ...runtimeIdentity(record),
        "dialog-op",
        {
          type: "extension_ui_response",
          id: "dialog-op",
          value: "answer",
        },
      ),
    ).rejects.toThrow("close preparation");
    await expect(
      h.registry.closePanel(id, ...runtimeIdentity(record), 1, "panel-op"),
    ).rejects.toThrow("close preparation");
    await expect(
      h.registry.applyEditorPatch(id, ...runtimeIdentity(record), {
        baseRevision: 0,
        revision: 1,
        text: "late edit",
        attachments: [],
      }),
    ).rejects.toThrow("close preparation");
    await expect(
      h.registry.sendPanelInput(id, ...runtimeIdentity(record), 1, 1, "late input"),
    ).rejects.toThrow("close preparation");
    expect(() => h.registry.resizePanel(id, ...runtimeIdentity(record), 1, 80, 24)).toThrow(
      "close preparation",
    );

    await expect(h.registry.confirmClose(id, prepared.reviewToken)).resolves.toEqual({
      closed: true,
    });
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
    });
    await tick();
    const submissionIntentId = (
      h.unifiedRequests[0] as [unknown, { submissionIntentId: string }] | undefined
    )?.[1].submissionIntentId;
    expect(submissionIntentId).toEqual(expect.any(String));
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
        followUp: [],
        commandDescription: expect.stringContaining("!touch marker"),
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
            followUp: [],
            commandDescription: expect.stringContaining("hang forever"),
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
    await expect(pending).resolves.toMatchObject({ disposition: "outcome_unknown" });
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
        followUp: [],
        commandDescription: expect.stringContaining("retain stale editor text"),
      }),
    ]);
    expect(h.fakes[0]!.sent.some((message) => message.type === "unified_submit_response")).toBe(
      false,
    );
    h.registry.stopAll();
  });

  it("turns a pending unified submit into reviewable restoration on host crash", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    h.fakes[0]!.emitWire({
      type: "unified_submit_request",
      id: "unified-crash",
      text: "do not replay me",
      editorRevision: 5,
    });
    await tick();
    h.unifiedRequests.length = 0;

    h.fakes[0]!.emitExit(1);
    await vi.waitFor(() => expect(h.fakes).toHaveLength(2));
    await vi.waitFor(() => expect(h.registry.getSession(id)?._procReady).toBe(true));
    await h.registry.rendererAttach(id, 1);

    expect(h.unifiedRequests).toEqual([]);
    expect(h.restorations).toHaveLength(2);
    expect(h.restorations).toEqual(
      Array.from({ length: 2 }, () => [
        id,
        expect.objectContaining({
          type: "queue_restoration",
          followUp: ["do not replay me"],
          requiresReview: true,
        }),
      ]),
    );
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
      data: { accepted: true, revision: 1, text: "predecessor edit", attachments: [] },
    });

    await expect(pending).rejects.toThrow("replaced before editor patch acknowledgement");
    h.registry.stopAll();
  });

  it("serializes rapid in-order panel input before gap detection", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    record._panelInputSequence.set(7, 0);
    let resolveFirst!: () => void;
    record.proc!.sendPanelInput = vi.fn(async (_panelId, sequence) => {
      if (sequence === 1) await new Promise<void>((resolve) => (resolveFirst = resolve));
      return { acknowledgedThrough: sequence };
    });

    const first = h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, "a");
    const second = h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 2, "b");
    await vi.waitFor(() => expect(record.proc!.sendPanelInput).toHaveBeenCalledTimes(1));
    resolveFirst();

    await expect(first).resolves.toEqual({ acknowledgedThrough: 1 });
    await expect(second).resolves.toEqual({ acknowledgedThrough: 2 });
    expect(record.proc!.sendPanelInput).toHaveBeenCalledTimes(2);
  });

  it("acknowledges panel input cumulatively and rejects gaps", async () => {
    const h = harness();
    const id = h.registry.openSession("/tmp/project");
    await h.registry.activateSession(id, "/tmp/pi", {});
    const record = h.registry.getSession(id)!;
    record._panelInputSequence.set(7, 0);
    await expect(
      h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 2, "b"),
    ).resolves.toEqual({
      acknowledgedThrough: 0,
      gap: { expected: 1, received: 2 },
    });
    record.proc!.sendPanelInput = vi.fn(async () => {
      throw new Error("host rejected input");
    });
    await expect(
      h.registry.sendPanelInput(id, ...runtimeIdentity(record), 7, 1, "a"),
    ).rejects.toThrow("host rejected input");
    expect(record._panelInputSequence.get(7)).toBe(0);
  });
});
