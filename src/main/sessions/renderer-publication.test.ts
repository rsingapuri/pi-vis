import type { SessionId } from "@shared/ids.js";
import type {
  AuthorityAttachBaseline,
  AuthorityFrame,
  RendererPublication,
  RuntimeIdentity,
  TranscriptPublicationPayload,
} from "@shared/pi-protocol/runtime-state.js";
import { describe, expect, it, vi } from "vitest";
import { RendererPublicationRouter } from "./renderer-publication.js";

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
  } as unknown as AuthorityAttachBaseline;
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
    let resolveBaseline!: (value: AuthorityAttachBaseline) => void;
    const attaching = router.attach(
      4,
      () => new Promise<AuthorityAttachBaseline>((resolve) => (resolveBaseline = resolve)),
    );

    expect(router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) })).toBe(
      true,
    );
    resolveBaseline(baseline(owner(), 1));
    const response = await attaching;

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
    let resolveBaseline!: (value: AuthorityAttachBaseline) => void;
    const attaching = router.attach(
      4,
      () => new Promise<AuthorityAttachBaseline>((resolve) => (resolveBaseline = resolve)),
    );

    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    resolveBaseline(baseline(owner(), 2));

    const response = await attaching;
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
    let resolveBaseline!: (value: AuthorityAttachBaseline) => void;
    const attaching = router.attach(
      4,
      () => new Promise<AuthorityAttachBaseline>((resolve) => (resolveBaseline = resolve)),
    );

    // The transcript frame arrives first, but the semantic cursor already
    // covers the later semantic frame. The replay sequence must be compacted.
    router.route({ plane: "transcript", owner: owner(), payload: transcript(owner(), 2) });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    resolveBaseline(baseline(owner(), 2, 0, 1));

    const response = await attaching;
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
    await router.attach(4, async () => baseline(owner(), 1));
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    expect(delivered[0]?.publicationSequence).toBe(1);

    let resolveBaseline!: (value: AuthorityAttachBaseline) => void;
    const reattaching = router.attach(
      4,
      () => new Promise<AuthorityAttachBaseline>((resolve) => (resolveBaseline = resolve)),
    );
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    resolveBaseline(baseline(owner(), 2, 0));

    const response = await reattaching;
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
    await router.attach(1, async () => baseline(owner()));

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
    await router.attach(1, async () => baseline(owner(), 1));

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
    await router.attach(1, async () => current);

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
    let resolveFirst!: (value: AuthorityAttachBaseline) => void;
    const getBaseline = vi
      .fn<() => Promise<AuthorityAttachBaseline>>()
      .mockImplementationOnce(
        () => new Promise<AuthorityAttachBaseline>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValueOnce(baseline(owner(), 3));
    const attaching = router.attach(1, getBaseline);
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    resolveFirst(baseline(owner(), 1));

    const response = await attaching;
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
    let resolveFirst!: (value: AuthorityAttachBaseline) => void;
    const getBaseline = vi
      .fn<() => Promise<AuthorityAttachBaseline>>()
      .mockImplementationOnce(
        () => new Promise<AuthorityAttachBaseline>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValueOnce(baseline(owner(1), 2));
    const attaching = router.attach(1, getBaseline);
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    router.setExpectedOwner(owner(1));
    resolveFirst(baseline(owner(1), 1));

    const response = await attaching;
    expect(getBaseline).toHaveBeenCalledTimes(2);
    expect(response.baseline.publicationHighWatermark).toBe(1);
    expect(response.replay).toEqual([]);
  });

  it("advances the baseline high-water when it is ahead of every buffered source frame", async () => {
    const router = new RendererPublicationRouter("session" as SessionId, () => {});
    router.setExpectedOwner(owner());
    let resolveBaseline!: (value: AuthorityAttachBaseline) => void;
    const attaching = router.attach(
      1,
      () => new Promise<AuthorityAttachBaseline>((resolve) => (resolveBaseline = resolve)),
    );
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 2) });
    router.route({ plane: "semantic", owner: owner(), payload: frame(owner(), 3) });
    resolveBaseline(baseline(owner(), 3));

    const response = await attaching;
    expect(response.baseline.publicationHighWatermark).toBe(2);
    expect(response.replay).toEqual([]);
  });
});
