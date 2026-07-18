import type {
  AuthorityAttachResponse,
  AuthorityFrame,
  RendererPublication,
  RuntimeIdentity,
  SemanticSnapshot,
} from "@shared/pi-protocol/runtime-state.js";
import { describe, expect, it } from "vitest";
import {
  createRendererAuthorityState,
  reduceAuthorityAttach,
  reduceAuthorityPublication,
} from "./authority-reducer.js";

const owner: RuntimeIdentity = { hostInstanceId: "host-a", sessionEpoch: 1 };
const successor: RuntimeIdentity = { hostInstanceId: "host-b", sessionEpoch: 2 };

function snapshot(sequence: number, snapshotOwner = owner): SemanticSnapshot {
  return {
    owner: snapshotOwner,
    snapshotSequence: sequence,
    capturedAt: 1,
    sdk: {
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      retryAttempt: 0,
      isBashRunning: false,
    },
    activity: {},
    queues: { steering: [], followUp: [], steeringIntentIds: [], followUpIntentIds: [] },
    custody: [],
    editor: { revision: 0, text: "", attachments: [] },
    activeIntents: [],
    recentIntentOutcomes: [],
    recentObservedOperations: [],
    operationJournalLowWatermark: 0,
    operationJournalHighWatermark: 0,
    operationJournalTruncated: false,
    model: null,
    thinkingLevel: "off",
    catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
  };
}

function frame(transportSequence: number, snapshotSequence = transportSequence): AuthorityFrame {
  return {
    owner,
    transportSequence,
    frameId: `frame-${transportSequence}`,
    records: [
      {
        type: "anomaly",
        owner,
        code: "missing_start_event",
      },
    ],
    terminalSnapshot: snapshot(snapshotSequence),
  };
}

function baseline(highWatermark = 10): Extract<AuthorityAttachResponse, { status: "ready" }> {
  const cursor = { ...owner, transportSequence: 1, snapshotSequence: 1 };
  return {
    status: "ready",
    baseline: {
      sessionId: "session-a",
      rendererGeneration: 7,
      owner,
      semantic: { sync: { state: "following", cursor }, snapshot: snapshot(1) },
      operationJournal: [],
      transcript: {
        sync: { state: "following", cursor },
        persistedHistoryCursor: null,
        liveTailCursor: null,
        overlapBoundary: null,
      },
      extensionUi: {
        sync: { state: "following", cursor },
        notifications: [],
        statuses: {},
        widgets: {},
        dialogs: [],
      },
      panels: [
        {
          panelKey: "panel-a",
          panelId: 1,
          owner,
          sync: { state: "following", cursor },
          overlay: true,
          unified: false,
          mode: "viewport",
          inputAcknowledgedThrough: 0,
          keyframe: { kind: "keyframe", ansi: "initial", renderRevision: 1 },
        },
      ],
      restorations: [],

      publicationHighWatermark: highWatermark,
    },
    replay: [],
  };
}

function semanticPublication(sequence: number, transportSequence = 2): RendererPublication {
  return {
    sessionId: "session-a",
    rendererGeneration: 7,
    publicationSequence: sequence,
    plane: "semantic",
    owner,
    payload: frame(transportSequence),
  };
}

describe("authority reducer", () => {
  it("installs a baseline then atomically applies a contiguous replay", () => {
    const response = baseline();
    response.replay = [semanticPublication(11)];

    const state = reduceAuthorityAttach(createRendererAuthorityState(), response);

    expect(state.semantic).toEqual({
      state: "following",
      cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
    });
    expect(state.authoritativeSnapshot?.snapshotSequence).toBe(2);
    expect(state.lastSemanticFrame?.records).toEqual(frame(2).records);
    expect(state.recentRecords).toEqual(frame(2).records);
  });

  it("requires a contiguous attach replay before calling any plane following", () => {
    const response = baseline();
    response.replay = [semanticPublication(12)];

    const state = reduceAuthorityAttach(createRendererAuthorityState(), response);

    expect(state.semantic.state).toBe("synchronizing");
    expect(state.transcript.state).toBe("synchronizing");
    expect(state.panels.get("panel-a")?.inputEnabled).toBe(false);
  });

  it("fences every plane on a global publication gap and preserves its stale diagnostic", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const before = attached.authoritativeSnapshot;
    const state = reduceAuthorityPublication(attached, semanticPublication(12));

    expect(state.semantic.state).toBe("synchronizing");
    expect(state.transcript.state).toBe("synchronizing");
    expect(state.extensionUi.state).toBe("synchronizing");
    expect(state.panels.get("panel-a")?.sync.state).toBe("synchronizing");
    expect(state.panels.get("panel-a")?.inputEnabled).toBe(false);
    expect(state.authoritativeSnapshot).toBeUndefined();
    expect(state.staleDiagnosticSnapshot).toBe(before);
  });

  it("ignores duplicate and reordered publications", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const current = reduceAuthorityPublication(attached, semanticPublication(11));
    const duplicate = reduceAuthorityPublication(current, semanticPublication(11));
    const older = reduceAuthorityPublication(current, semanticPublication(10));

    expect(duplicate).toBe(current);
    expect(older).toBe(current);
  });

  it("installs a successor baseline atomically and rejects predecessor publications", () => {
    const first = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const response = baseline(12);
    response.baseline.owner = successor;
    response.baseline.semantic = {
      sync: {
        state: "following",
        cursor: { ...successor, transportSequence: 1, snapshotSequence: 1 },
      },
      snapshot: snapshot(1, successor),
    };
    response.baseline.transcript.sync = {
      state: "following",
      cursor: { ...successor, transportSequence: 1, snapshotSequence: 1 },
    };
    response.baseline.extensionUi.sync = {
      state: "following",
      cursor: { ...successor, transportSequence: 1, snapshotSequence: 1 },
    };
    response.baseline.panels = [];
    const attached = reduceAuthorityAttach(first, response);
    const old = semanticPublication(13);

    const state = reduceAuthorityPublication(attached, old);

    expect(attached.owner).toEqual(successor);
    expect(attached.authoritativeSnapshot?.owner).toEqual(successor);
    expect(state).toBe(attached);
  });

  it("synchronizes transcript and extension UI independently", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const transcriptReset: RendererPublication = {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "transcript",
      owner,
      payload: {
        kind: "reset_required",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        reason: "history_reset",
      },
    };
    const extensionReset: RendererPublication = {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 12,
      plane: "extensionUi",
      owner,
      payload: {
        kind: "baseline_required",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        reason: "extension_reset",
      },
    };

    const state = reduceAuthorityPublication(
      reduceAuthorityPublication(attached, transcriptReset),
      extensionReset,
    );

    expect(state.semantic.state).toBe("following");
    expect(state.transcript.state).toBe("synchronizing");
    expect(state.extensionUi.state).toBe("synchronizing");
    expect(state.panels.get("panel-a")?.sync.state).toBe("following");
  });

  it("fences a semantic transport discontinuity even when publications are contiguous", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const state = reduceAuthorityPublication(attached, semanticPublication(11, 3));

    expect(state.semantic).toMatchObject({
      state: "synchronizing",
      reason: "semantic_transport_gap",
    });
    expect(state.staleDiagnosticSnapshot?.snapshotSequence).toBe(1);
  });

  it("keeps panel synchronization independent from semantic control", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const panelReset: RendererPublication = {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "panel",
      owner,
      payload: {
        kind: "repaint_required",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        panelKey: "panel-a",
        reason: "repaint_required",
        renderRevision: 2,
      },
    };

    const state = reduceAuthorityPublication(attached, panelReset);

    expect(state.semantic.state).toBe("following");
    expect(state.panels.get("panel-a")?.sync.state).toBe("synchronizing");
    expect(state.panels.get("panel-a")?.inputEnabled).toBe(false);
  });

  it("reconstructs a pending extension dialog from its sequenced UI plane", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const state = reduceAuthorityPublication(attached, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "extensionUi",
      owner,
      payload: {
        kind: "request",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        request: {
          type: "extension_ui_request",
          id: "dialog-1",
          operationId: "dialog-1",
          method: "confirm",
          title: "Reload?",
        },
      },
    });

    expect(state.extensionUi.state).toBe("following");
    expect(state.extensionUiBaseline?.dialogs).toMatchObject([
      { request: { id: "dialog-1" }, inputPending: true, acknowledged: false },
    ]);
  });

  it("replaces provider-auth revisions without stacking stale secret prompts", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const request = (transportSequence: number, phase: "waiting" | "prompt") =>
      ({
        sessionId: "session-a",
        rendererGeneration: 7,
        publicationSequence: 9 + transportSequence,
        plane: "extensionUi",
        owner,
        payload: {
          kind: "request",
          cursor: { ...owner, transportSequence, snapshotSequence: 2 },
          request: {
            type: "extension_ui_request",
            id: "provider-auth-1",
            operationId: `provider-auth-1:${transportSequence}`,
            method: "providerAuth",
            providerName: "Project Provider",
            authType: "api_key",
            phase,
            ...(phase === "prompt"
              ? { promptType: "secret", prompt: "API key" }
              : { message: "Starting sign-in…" }),
          },
        },
      }) as RendererPublication;

    const waiting = reduceAuthorityPublication(attached, request(2, "waiting"));
    const prompted = reduceAuthorityPublication(waiting, request(3, "prompt"));

    expect(prompted.extensionUiBaseline?.dialogs).toHaveLength(1);
    expect(prompted.extensionUiBaseline?.dialogs[0]?.request).toMatchObject({
      id: "provider-auth-1",
      operationId: "provider-auth-1:3",
      phase: "prompt",
      promptType: "secret",
    });
  });

  it("marks only a transcript source gap synchronizing", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const state = reduceAuthorityPublication(attached, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "transcript",
      owner,
      payload: {
        kind: "delta",
        cursor: { ...owner, transportSequence: 3, snapshotSequence: 2 },
        liveTailCursor: "3",
        entries: [],
      },
    });

    expect(state.transcript).toMatchObject({
      state: "synchronizing",
      reason: "transcript_transport_gap",
    });
    expect(state.semantic.state).toBe("following");
    expect(state.extensionUi.state).toBe("following");
  });

  it("keeps a panel fenced through repaint and follows only the acknowledged keyframe", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const repaint = reduceAuthorityPublication(attached, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "panel",
      owner,
      payload: {
        kind: "repaint_required",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        panelKey: "panel-a",
        reason: "repaint_required",
        renderRevision: 2,
      },
    });
    const pendingAck = reduceAuthorityPublication(repaint, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 12,
      plane: "panel",
      owner,
      payload: {
        kind: "keyframe",
        cursor: { ...owner, transportSequence: 3, snapshotSequence: 3 },
        panel: {
          panelKey: "panel-a",
          panelId: 1,
          owner,
          sync: {
            state: "synchronizing",
            lastCursor: { ...owner, transportSequence: 3, snapshotSequence: 3 },
            reason: "repaint_ack_pending",
          },
          overlay: true,
          unified: false,
          mode: "viewport",
          inputAcknowledgedThrough: 0,
          keyframe: { kind: "keyframe", ansi: "repaint", renderRevision: 2 },
        },
      },
    });
    const state = reduceAuthorityPublication(pendingAck, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 13,
      plane: "panel",
      owner,
      payload: {
        kind: "keyframe",
        cursor: { ...owner, transportSequence: 4, snapshotSequence: 4 },
        panel: {
          panelKey: "panel-a",
          panelId: 1,
          owner,
          sync: {
            state: "following",
            cursor: { ...owner, transportSequence: 4, snapshotSequence: 4 },
          },
          overlay: true,
          unified: false,
          mode: "viewport",
          inputAcknowledgedThrough: 0,
          keyframe: { kind: "keyframe", ansi: "repaint", renderRevision: 2 },
        },
      },
    });

    expect(repaint.panels.get("panel-a")?.inputEnabled).toBe(false);
    expect(pendingAck.panels.get("panel-a")?.inputEnabled).toBe(false);
    expect(pendingAck.panels.get("panel-a")?.ansi).toEqual(["repaint"]);
    expect(state.panels.get("panel-a")?.inputEnabled).toBe(true);
    expect(state.panels.get("panel-a")?.ansi).toEqual(["repaint"]);
  });

  it("continues a synchronizing attach baseline through repaint acknowledgement", () => {
    const attachedResponse = baseline();
    attachedResponse.baseline.panels[0] = {
      ...attachedResponse.baseline.panels[0]!,
      sync: {
        state: "synchronizing",
        lastCursor: { ...owner, transportSequence: 1, snapshotSequence: 1 },
        reason: "repaint_required",
      },
      keyframe: { kind: "repaint_required", renderRevision: 2 },
    };
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), attachedResponse);
    const repaint = reduceAuthorityPublication(attached, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "panel",
      owner,
      payload: {
        kind: "repaint_required",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        panelKey: "panel-a",
        reason: "repaint_required",
        renderRevision: 3,
      },
    });
    const pending = reduceAuthorityPublication(repaint, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 12,
      plane: "panel",
      owner,
      payload: {
        kind: "keyframe",
        cursor: { ...owner, transportSequence: 3, snapshotSequence: 3 },
        panel: {
          ...attachedResponse.baseline.panels[0]!,
          sync: {
            state: "synchronizing",
            lastCursor: { ...owner, transportSequence: 3, snapshotSequence: 3 },
            reason: "repaint_ack_pending",
          },
          keyframe: { kind: "keyframe", ansi: "complete", renderRevision: 3 },
        },
      },
    });
    const following = reduceAuthorityPublication(pending, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 13,
      plane: "panel",
      owner,
      payload: {
        kind: "keyframe",
        cursor: { ...owner, transportSequence: 4, snapshotSequence: 4 },
        panel: {
          ...attachedResponse.baseline.panels[0]!,
          sync: {
            state: "following",
            cursor: { ...owner, transportSequence: 4, snapshotSequence: 4 },
          },
          keyframe: { kind: "keyframe", ansi: "complete", renderRevision: 3 },
        },
      },
    });

    expect(pending.panels.get("panel-a")?.sync.state).toBe("synchronizing");
    expect(pending.panels.get("panel-a")?.inputEnabled).toBe(false);
    expect(following.panels.get("panel-a")?.sync.state).toBe("following");
    expect(following.panels.get("panel-a")?.inputEnabled).toBe(true);
  });

  it("does not treat interleaved panel IDs as a source transport gap", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const withPanelB = reduceAuthorityPublication(attached, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "panel",
      owner,
      payload: {
        kind: "reset",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        panelKey: "panel-b",
        panelId: 2,
        overlay: true,
        unified: false,
        mode: "viewport",
        renderRevision: 1,
      },
    });
    const state = reduceAuthorityPublication(withPanelB, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 12,
      plane: "panel",
      owner,
      payload: {
        kind: "ansi_delta",
        cursor: { ...owner, transportSequence: 3, snapshotSequence: 3 },
        panelKey: "panel-a",
        data: "A after B",
        renderRevision: 1,
      },
    });

    expect(state.panels.get("panel-a")?.sync.state).toBe("following");
    expect(state.panels.get("panel-a")?.ansi).toEqual(["initial", "A after B"]);
    expect(state.panels.get("panel-b")?.sync.state).toBe("synchronizing");
    expect(state.panelTransportSequence).toBe(3);
  });

  it("uses a sequenced authority mode update", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const state = reduceAuthorityPublication(attached, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "panel",
      owner,
      payload: {
        kind: "mode",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        panelKey: "panel-a",
        mode: "content",
      },
    });

    expect(state.panels.get("panel-a")?.baseline.mode).toBe("content");
    expect(state.panels.get("panel-a")?.inputEnabled).toBe(true);
  });

  it("does not mutate Maps from the prior projection", () => {
    const attached = reduceAuthorityAttach(createRendererAuthorityState(), baseline());
    const state = reduceAuthorityPublication(attached, {
      sessionId: "session-a",
      rendererGeneration: 7,
      publicationSequence: 11,
      plane: "panel",
      owner,
      payload: {
        kind: "ansi_delta",
        cursor: { ...owner, transportSequence: 2, snapshotSequence: 2 },
        panelKey: "panel-a",
        data: "next",
        renderRevision: 2,
      },
    });

    expect(state.panels).not.toBe(attached.panels);
    expect(attached.panels.get("panel-a")?.ansi).toEqual(["initial"]);
    expect(state.panels.get("panel-a")?.ansi).toEqual(["initial", "next"]);
  });
});
