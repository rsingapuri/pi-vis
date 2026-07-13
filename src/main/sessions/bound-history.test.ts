import type { SessionId } from "@shared/ids.js";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import { describe, expect, it } from "vitest";
import { loadBoundHistory } from "./bound-history.js";
import type { SessionRecord } from "./session-registry.js";

const SID = "history-session" as SessionId;
const HISTORY: TranscriptBlock[] = [
  { id: "history-block", type: "user", data: { content: "history" } },
];

function record(
  overrides: Partial<SessionRecord> & { sessionFile?: string | undefined } = {},
): SessionRecord {
  return {
    sessionId: SID,
    workspacePath: "/tmp/workspace",
    sessionFile: "/tmp/session.jsonl",
    status: "cold",
    lastActiveAt: Date.now(),
    availability: "unavailable",
    _rapidFailureCount: 0,
    _retainedIntents: new Map(),
    _pendingSubmissionPromises: new Map(),
    _retainedCommandIntents: new Map(),
    _restorations: new Map(),
    _rendererGeneration: 0,
    _mutationSequence: 0,
    _panelInputSequence: new Map(),
    _panelInputChains: new Map(),
    _pendingUiRequests: new Map(),
    _openPanels: new Map(),
    _pendingUnifiedSubmits: new Map(),
    _panelCheckpoints: new Map(),
    _pendingUiAcks: new Map(),
    ...overrides,
  } as SessionRecord;
}

function deferredHistory(): {
  promise: Promise<TranscriptBlock[]>;
  resolve: (history: TranscriptBlock[]) => void;
} {
  let resolve!: (history: TranscriptBlock[]) => void;
  const promise = new Promise<TranscriptBlock[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SID,
  expectedSessionFile: "/tmp/session.jsonl",
  historyGeneration: 7,
  expectedHostInstanceId: null,
  expectedSessionEpoch: null,
  ...overrides,
});

describe("loadBoundHistory", () => {
  it("returns correlated complete history when the captured owner remains current", async () => {
    const current = record();
    await expect(
      loadBoundHistory(
        request(),
        () => current,
        async () => HISTORY,
      ),
    ).resolves.toEqual({ status: "loaded", historyGeneration: 7, history: HISTORY });
  });

  it("refuses a mismatched file or incomplete runtime identity before I/O", async () => {
    const current = record();
    let reads = 0;
    const load = async () => {
      reads++;
      return HISTORY;
    };
    await expect(
      loadBoundHistory(request({ expectedSessionFile: "/tmp/other.jsonl" }), () => current, load),
    ).resolves.toMatchObject({ status: "stale" });
    await expect(
      loadBoundHistory(request({ expectedHostInstanceId: "host-a" }), () => current, load),
    ).resolves.toMatchObject({ status: "stale" });
    expect(reads).toBe(0);
  });

  it("refuses to rebind an explicit cold-owner request when activation already won", async () => {
    const current = record({
      proc: { hostInstanceId: "host-a", sessionEpoch: 1 } as SessionRecord["proc"],
      snapshot: { hostInstanceId: "host-a", sessionEpoch: 1 } as SessionRecord["snapshot"],
    });
    let reads = 0;
    await expect(
      loadBoundHistory(
        request(),
        () => current,
        async () => {
          reads++;
          return HISTORY;
        },
      ),
    ).resolves.toMatchObject({ status: "stale" });
    expect(reads).toBe(0);
  });

  it("refuses cold-owner admission once activation has started before a process exists", async () => {
    const current = record({ status: "starting", _activating: true });
    let reads = 0;
    await expect(
      loadBoundHistory(
        request(),
        () => current,
        async () => {
          reads++;
          return HISTORY;
        },
      ),
    ).resolves.toMatchObject({ status: "stale" });
    expect(reads).toBe(0);
  });

  it("discards a cold read when activation installs a process during I/O", async () => {
    const current = record();
    const deferred = deferredHistory();
    const pending = loadBoundHistory(
      request(),
      () => current,
      () => deferred.promise,
    );
    current.proc = { hostInstanceId: "host-a", sessionEpoch: 1 } as SessionRecord["proc"];
    deferred.resolve(HISTORY);
    await expect(pending).resolves.toMatchObject({ status: "stale" });
  });

  it("discards a cold read when activation starts during I/O before process installation", async () => {
    const current = record();
    const deferred = deferredHistory();
    const pending = loadBoundHistory(
      request(),
      () => current,
      () => deferred.promise,
    );
    current.status = "starting";
    current._activating = true;
    deferred.resolve(HISTORY);
    await expect(pending).resolves.toMatchObject({ status: "stale" });
  });

  it("discards same-file reads after host replacement or epoch transition", async () => {
    const firstProc = { hostInstanceId: "host-a", sessionEpoch: 1 } as SessionRecord["proc"];
    const current = record({
      proc: firstProc,
      snapshot: { hostInstanceId: "host-a", sessionEpoch: 1 } as SessionRecord["snapshot"],
      status: "ready",
      availability: "available",
    });
    const first = deferredHistory();
    const hostRestart = loadBoundHistory(
      request({ expectedHostInstanceId: "host-a", expectedSessionEpoch: 1 }),
      () => current,
      () => first.promise,
    );
    current.proc = { hostInstanceId: "host-b", sessionEpoch: 1 } as SessionRecord["proc"];
    current.snapshot = { hostInstanceId: "host-b", sessionEpoch: 1 } as SessionRecord["snapshot"];
    first.resolve(HISTORY);
    await expect(hostRestart).resolves.toMatchObject({ status: "stale" });

    const second = deferredHistory();
    const epochTransition = loadBoundHistory(
      request({ expectedHostInstanceId: "host-b", expectedSessionEpoch: 1 }),
      () => current,
      () => second.promise,
    );
    current.proc!.sessionEpoch = 2;
    current.snapshot = { hostInstanceId: "host-b", sessionEpoch: 2 } as SessionRecord["snapshot"];
    second.resolve(HISTORY);
    await expect(epochTransition).resolves.toMatchObject({ status: "stale" });
  });

  it("discards an identity-bound read when a transition starts before I/O settles", async () => {
    const current = record({
      proc: { hostInstanceId: "host-a", sessionEpoch: 1 } as SessionRecord["proc"],
      snapshot: { hostInstanceId: "host-a", sessionEpoch: 1 } as SessionRecord["snapshot"],
      status: "ready",
      availability: "available",
    });
    const deferred = deferredHistory();
    const pending = loadBoundHistory(
      request({ expectedHostInstanceId: "host-a", expectedSessionEpoch: 1 }),
      () => current,
      () => deferred.promise,
    );
    current.availability = "transitioning";
    current._hostTransition = { transitionId: "transition", provisionalEpoch: 2 };
    deferred.resolve(HISTORY);
    await expect(pending).resolves.toMatchObject({ status: "stale" });
  });

  it("discards a read when the registry record is closed and recreated", async () => {
    let current = record();
    const deferred = deferredHistory();
    const pending = loadBoundHistory(
      request(),
      () => current,
      () => deferred.promise,
    );
    current = record();
    deferred.resolve(HISTORY);
    await expect(pending).resolves.toMatchObject({ status: "stale" });
  });
});
