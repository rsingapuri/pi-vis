// @ts-nocheck -- legacy router fixtures exercise the runtime protocol separately.
import type { SessionId } from "@shared/ids.js";
import type {
  AuthorityAttachBaselineResponse,
  AuthorityAttachResponse,
  AuthorityFrame,
  RendererPublication,
  RuntimeIdentity,
  TranscriptPublicationPayload,
} from "@shared/pi-protocol/runtime-state.js";
import { describe, expect, it, vi } from "vitest";
import { AuthorityAttachError, RendererPublicationRouter } from "./renderer-publication.js";

function expectReady(
  response: AuthorityAttachResponse,
): Extract<AuthorityAttachResponse, { status: "ready" }> {
  if (response.status !== "ready") throw new Error("expected ready attach");
  return response;
}

function expectDetached(router: RendererPublicationRouter): void {
  const internal = router as unknown as {
    state: string;
    buffer: unknown[];
    overflowed: boolean;
  };
  expect(internal.state).toBe("detached");
  expect(internal.buffer).toEqual([]);
  expect(internal.overflowed).toBe(false);
}

const owner = (epoch = 0): RuntimeIdentity => ({
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  sessionEpoch: epoch,
});

function baseline(
  currentOwner: RuntimeIdentity,
  transportSequence = 1,
  highWatermark = 0,
  transcriptTransportSequence?: number,
) {
  return {
    sessionId: "child-session",
    rendererGeneration: 0,
    owner: currentOwner,
    semantic: {
      sync: {
        state: "following",
        cursor: {
          ...currentOwner,
          transportSequence,
          snapshotSequence: 1,
        },
      },
      snapshot: { owner: currentOwner, snapshotSequence: 1 },
    },
    operationJournal: [],
    transcript: {
      sync:
        transcriptTransportSequence === undefined
          ? { state: "unavailable", reason: "not_attached" }
          : {
              state: "following",
              cursor: {
                ...currentOwner,
                transportSequence: transcriptTransportSequence,
                snapshotSequence: 1,
              },
            },
      persistedHistoryCursor: null,
      liveTailCursor: null,
      overlapBoundary: null,
    },
    extensionUi: {
      sync: { state: "unavailable", reason: "not_attached" },
      notifications: [],
      statuses: {},
      widgets: {},
      dialogs: [],
    },
    panels: [],
    restorations: [],

    publicationHighWatermark: highWatermark,
  } as unknown as AuthorityAttachResponse;
}

function frame(currentOwner: RuntimeIdentity, transportSequence: number): AuthorityFrame {
  return {
    owner: currentOwner,
    transportSequence,
    frameId: `frame-${transportSequence}`,
    records: [{ type: "anomaly", owner: currentOwner, code: "missing_start_event" }],
    terminalSnapshot: { owner: currentOwner, snapshotSequence: transportSequence },
  } as unknown as AuthorityFrame;
}

function transcript(
  currentOwner: RuntimeIdentity,
  transportSequence: number,
): TranscriptPublicationPayload {
  return {
    cursor: { ...currentOwner, transportSequence, snapshotSequence: 1 },
  } as unknown as TranscriptPublicationPayload;
}

describe("RendererPublicationRouter", () => {
  it("installs a baseline high-water and replays the contiguous attach tail", async () => {
    const delivered: RendererPublication[] = [];
    const router = new RendererPublicationRouter("session" as SessionId, (item) =>
      delivered.push(item),
    );
    router.setExpectedOwner(owner());
    let resolveBaseline!: (value: AuthorityAttachBaselineResponse) => void;
    const attaching = router.attach(
      4,
      () => new Promise<AuthorityAttachBaselineResponse>((resolve) => (resolveBaseline = resolve)),
    );

    expect(router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) })).toBe(
      true,
    );
    resolveBaseline({ status: "ready", baseline: baseline(owner(), 1) });
    const response = expectReady(await attaching);
    if (response.status !== "ready") throw new Error("expected ready attach");

    expect(response.baseline).toMatchObject({
      sessionId: "session",
      rendererGeneration: 4,
      restorations: [],

      publicationHighWatermark: 0,
    });
    expect(response.replay).toHaveLength(1);
    expect(response.replay[0]).toMatchObject({
      plane: "semantic",
      publicationSequence: 1,
      payload: { frameId: "frame-2", records: [{ type: "anomaly" }] },
    });
    expect(delivered).toEqual([]);

    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ publicationSequence: 2, payload: { frameId: "frame-3" } });
  });

  it("drops a buffered frame already covered by the returned baseline", async () => {
    const delivered: RendererPublication[] = [];
    const router = new RendererPublicationRouter("session" as SessionId, (item) =>
      delivered.push(item),
    );
    router.setExpectedOwner(owner());
    let resolveBaseline!: (value: AuthorityAttachBaselineResponse) => void;
    const attaching = router.attach(
      4,
      () => new Promise<AuthorityAttachBaselineResponse>((resolve) => (resolveBaseline = resolve)),
    );

    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    resolveBaseline({ status: "ready", baseline: baseline(owner(), 2) });

    const response = expectReady(await attaching);
    if (response.status !== "ready") throw new Error("expected ready attach");
    expect(response.baseline.publicationHighWatermark).toBe(1);
    expect(response.replay).toEqual([]);
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    expect(delivered[0]).toMatchObject({ publicationSequence: 2, payload: { frameId: "frame-3" } });
  });

  it("drops covered prefixes independently for mixed planes and replays the contiguous tail", async () => {
    const delivered: RendererPublication[] = [];
    const router = new RendererPublicationRouter("session" as SessionId, (item) =>
      delivered.push(item),
    );
    router.setExpectedOwner(owner());
    let resolveBaseline!: (value: AuthorityAttachBaselineResponse) => void;
    const attaching = router.attach(
      4,
      () => new Promise<AuthorityAttachBaselineResponse>((resolve) => (resolveBaseline = resolve)),
    );

    // The transcript frame arrives first, but the semantic cursor already
    // covers the later semantic frame. The replay sequence must be compacted.
    router.route({ plane: "transcript", owner: owner(), payload: transcript(owner(), 2) });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    resolveBaseline({ status: "ready", baseline: baseline(owner(), 2, 0, 1) });

    const response = expectReady(await attaching);
    if (response.status !== "ready") throw new Error("expected ready attach");
    expect(response.baseline.publicationHighWatermark).toBe(1);
    expect(response.replay).toHaveLength(1);
    expect(response.replay[0]).toMatchObject({ plane: "transcript", publicationSequence: 2 });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    expect(delivered[0]).toMatchObject({ publicationSequence: 3, payload: { frameId: "frame-3" } });
  });

  it("uses the main publication high-water on same-generation reattach", async () => {
    const delivered: RendererPublication[] = [];
    const router = new RendererPublicationRouter("session" as SessionId, (item) =>
      delivered.push(item),
    );
    router.setExpectedOwner(owner());
    await router.attach(4, async () => ({ status: "ready", baseline: baseline(owner(), 1) }));
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    expect(delivered[0]?.publicationSequence).toBe(1);

    let resolveBaseline!: (value: AuthorityAttachBaselineResponse) => void;
    const reattaching = router.attach(
      4,
      () => new Promise<AuthorityAttachBaselineResponse>((resolve) => (resolveBaseline = resolve)),
    );
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    resolveBaseline({ status: "ready", baseline: baseline(owner(), 2, 0) });

    const response = expectReady(await reattaching);
    expect(response.baseline.publicationHighWatermark).toBe(1);
    expect(response.replay).toHaveLength(1);
    expect(response.replay[0]?.publicationSequence).toBe(2);
  });

  it("fences predecessor owners and never forwards their semantic frame", async () => {
    const delivered: RendererPublication[] = [];
    const router = new RendererPublicationRouter("session" as SessionId, (item) =>
      delivered.push(item),
    );
    router.setExpectedOwner(owner());
    await router.attach(1, async () => ({ status: "ready", baseline: baseline(owner()) }));

    expect(router.route({ plane: "semantic", owner: owner(1), payload: frame(owner(1), 2) })).toBe(
      false,
    );
    expect(delivered).toEqual([]);

    router.setExpectedOwner(owner(1));
    expect(router.synchronizing).toBe(true);
    expect(router.route({ plane: "semantic", owner: owner(1), payload: frame(owner(1), 2) })).toBe(
      false,
    );
  });

  it("marks a dropped per-plane publication synchronizing while preserving the opaque gap frame", async () => {
    const delivered = vi.fn();
    const router = new RendererPublicationRouter("session" as SessionId, delivered);
    router.setExpectedOwner(owner());
    await router.attach(1, async () => ({ status: "ready", baseline: baseline(owner(), 1) }));

    expect(router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) })).toBe(
      true,
    );
    expect(router.synchronizing).toBe(true);
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "semantic",
        payload: expect.objectContaining({ frameId: "frame-3" }),
      }),
    );
  });

  it("keeps an unrelated plane following after a transcript source gap", async () => {
    const delivered: RendererPublication[] = [];
    const router = new RendererPublicationRouter("session" as SessionId, (item) =>
      delivered.push(item),
    );
    router.setExpectedOwner(owner());
    const current = baseline(owner(), 1);
    current.transcript.sync = {
      state: "following",
      cursor: { ...owner(), transportSequence: 1, snapshotSequence: 1 },
    };
    await router.attach(1, async () => ({ status: "ready", baseline: current }));

    router.route({
      plane: "transcript",
      owner: owner(),
      payload: {
        kind: "delta",
        cursor: { ...owner(), transportSequence: 3, snapshotSequence: 1 },
        liveTailCursor: "3",
        entries: [],
      },
    });
    const semanticAccepted = router.route({
      plane: "semantic",
      owner: owner(),
      payload: frame(owner(), 2),
    });

    expect(router.synchronizing).toBe(true);
    expect(semanticAccepted).toBe(true);
    expect(delivered.map((item) => item.plane)).toEqual(["transcript", "semantic"]);
  });

  it("bounds attach buffering and retries from a fresh baseline after overflow", async () => {
    const router = new RendererPublicationRouter("session" as SessionId, () => {}, {
      maxBufferedPublications: 1,
    });
    router.setExpectedOwner(owner());
    let resolveFirst!: (value: AuthorityAttachBaselineResponse) => void;
    const getBaseline = vi
      .fn<() => Promise<AuthorityAttachBaselineResponse>>()
      .mockImplementationOnce(
        () => new Promise<AuthorityAttachBaselineResponse>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValueOnce({ status: "ready", baseline: baseline(owner(), 3) });
    const attaching = router.attach(1, getBaseline);
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    resolveFirst({ status: "ready", baseline: baseline(owner(), 1) });

    const response = expectReady(await attaching);
    if (response.status !== "ready") throw new Error("expected ready attach");
    expect(getBaseline).toHaveBeenCalledTimes(2);
    expect(response.baseline.publicationHighWatermark).toBe(2);
    expect(response.replay).toEqual([]);
    // Overflowed entries still consumed the sequence space before the retry.
    expect(router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 4) })).toBe(
      true,
    );
  });

  it("retries after owner replacement without reusing buffered sequence numbers", async () => {
    const router = new RendererPublicationRouter("session" as SessionId, () => {});
    router.setExpectedOwner(owner());
    let resolveFirst!: (value: AuthorityAttachBaselineResponse) => void;
    const getBaseline = vi
      .fn<() => Promise<AuthorityAttachBaselineResponse>>()
      .mockImplementationOnce(
        () => new Promise<AuthorityAttachBaselineResponse>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValueOnce({ status: "ready", baseline: baseline(owner(1), 2) });
    const attaching = router.attach(1, getBaseline);
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    router.setExpectedOwner(owner(1));
    resolveFirst({ status: "ready", baseline: baseline(owner(1), 1) });

    const response = expectReady(await attaching);
    if (response.status !== "ready") throw new Error("expected ready attach");
    expect(getBaseline).toHaveBeenCalledTimes(2);
    expect(response.baseline.publicationHighWatermark).toBe(1);
    expect(response.replay).toEqual([]);
  });

  it("detaches and clears an overflowed attach after its baseline provider rejects", async () => {
    const delivered: RendererPublication[] = [];
    const router = new RendererPublicationRouter(
      "session" as SessionId,
      (item) => delivered.push(item),
      { maxBufferedPublications: 1 },
    );
    router.setExpectedOwner(owner());
    let rejectBaseline!: (reason: Error) => void;
    const attaching = router.attach(
      1,
      () =>
        new Promise<AuthorityAttachBaselineResponse>(
          (_resolve, reject) => (rejectBaseline = reject),
        ),
    );
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });

    const failure = new Error("baseline provider failed");
    rejectBaseline(failure);
    await expect(attaching).rejects.toBe(failure);

    expectDetached(router);
    expect(router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 4) })).toBe(
      false,
    );

    expectReady(
      await router.attach(1, async () => ({ status: "ready", baseline: baseline(owner(), 1) })),
    );
    expect(router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) })).toBe(
      true,
    );
    expect(delivered).toHaveLength(1);
  });

  it("detaches and clears an overflowed attach after baseline owner validation fails", async () => {
    const router = new RendererPublicationRouter("session" as SessionId, () => {}, {
      maxBufferedPublications: 1,
    });
    router.setExpectedOwner(owner());
    let resolveBaseline!: (value: AuthorityAttachBaselineResponse) => void;
    const attaching = router.attach(
      1,
      () => new Promise<AuthorityAttachBaselineResponse>((resolve) => (resolveBaseline = resolve)),
    );
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    const invalidBaseline = baseline(owner(), 1);
    invalidBaseline.semantic.snapshot.owner = owner(1);
    resolveBaseline({ status: "ready", baseline: invalidBaseline });

    await expect(attaching).rejects.toThrow(AuthorityAttachError);
    await expect(attaching).rejects.toThrow("Authority baseline semantic owner mismatch");
    expectDetached(router);
    expect(router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 4) })).toBe(
      false,
    );

    expectReady(
      await router.attach(1, async () => ({ status: "ready", baseline: baseline(owner(), 1) })),
    );
  });

  it.each([
    { status: "transitioning", transitionId: "replace-owner" },
    { status: "unavailable", reason: "not_attached" },
  ] as const)("passes through a typed $status attach response", async (source) => {
    const router = new RendererPublicationRouter("session" as SessionId, () => {});

    await expect(router.attach(1, async () => source)).resolves.toEqual(source);
    expectDetached(router);
  });

  it("advances the baseline high-water when it is ahead of every buffered source frame", async () => {
    const router = new RendererPublicationRouter("session" as SessionId, () => {});
    router.setExpectedOwner(owner());
    let resolveBaseline!: (value: AuthorityAttachBaselineResponse) => void;
    const attaching = router.attach(
      1,
      () => new Promise<AuthorityAttachBaselineResponse>((resolve) => (resolveBaseline = resolve)),
    );
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    resolveBaseline({ status: "ready", baseline: baseline(owner(), 3) });

    const response = expectReady(await attaching);
    if (response.status !== "ready") throw new Error("expected ready attach");
    expect(response.baseline.publicationHighWatermark).toBe(2);
    expect(response.replay).toEqual([]);
  });
});
