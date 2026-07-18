import { describe, expect, it } from "vitest";
import {
  AuthorityAttachBaselineSchema,
  AuthorityAttachResponseSchema,
  AuthorityCursorSchema,
  AuthorityFrameSchema,
  IntentEnvelopeSchema,
  IntentOutcomeSchema,
  IntentPayloadConflictSchema,
  PanelPresentationBaselineSchema,
  RendererPublicationSchema,
  SESSION_QUERY_POLICY,
  SemanticSnapshotSchema,
  SessionQueryEnvelopeSchema,
  SessionQueryResultSchema,
  SessionQuerySchema,
} from "./runtime-state.js";

const owner = { hostInstanceId: "host-a", sessionEpoch: 4 };
const otherOwner = { hostInstanceId: "host-b", sessionEpoch: 4 };
const cursor = { ...owner, transportSequence: 7, snapshotSequence: 11 };

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    owner,
    snapshotSequence: 11,
    capturedAt: 1_700_000_000_000,
    sdk: {
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      retryAttempt: 0,
      isBashRunning: false,
    },
    activity: {},
    queues: {
      steering: [],
      followUp: [],
      steeringIntentIds: [],
      followUpIntentIds: [],
      management: { available: true },
    },
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
    catalog: {},
    ...overrides,
  };
}

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-a",
    rendererGeneration: 2,
    owner,
    semantic: { sync: { state: "following", cursor }, snapshot: snapshot() },
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
    panels: [],
    restorations: [],

    publicationHighWatermark: 20,
    ...overrides,
  };
}

describe("authority protocol schemas", () => {
  it("enforces cursor identity and semantic ownership as a property of every projection", () => {
    expect(AuthorityCursorSchema.safeParse(cursor).success).toBe(true);

    const ownerMismatches = [
      {
        custody: [
          {
            custodyId: "c",
            intentId: "i",
            owner: otherOwner,
            queueMode: "steer",
            barrier: "compaction",
            enteredAt: 1,
            certainty: "not_processed",
          },
        ],
      },
      {
        activeIntents: [
          { intentId: "i", owner: otherOwner, kind: "submit", state: "recorded", recordedAt: 1 },
        ],
      },
      {
        recentIntentOutcomes: [
          { intentId: "i", owner: otherOwner, kind: "reload", state: "completed", result: {} },
        ],
      },
      {
        recentObservedOperations: [
          { operationId: "op", owner: otherOwner, kind: "agent", state: "active", observedAt: 1 },
        ],
      },
    ];
    for (const mismatch of ownerMismatches) {
      expect(SemanticSnapshotSchema.safeParse(snapshot(mismatch)).success).toBe(false);
    }

    expect(
      SemanticSnapshotSchema.safeParse(
        snapshot({
          queues: { steering: ["one"], followUp: [], steeringIntentIds: [], followUpIntentIds: [] },
        }),
      ).success,
    ).toBe(false);
    expect(
      SemanticSnapshotSchema.safeParse(
        snapshot({
          queues: {
            steering: [],
            followUp: [],
            steeringIntentIds: [],
            followUpIntentIds: [],
            management: { available: false },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      SemanticSnapshotSchema.safeParse(
        snapshot({
          sdk: {
            isStreaming: true,
            isIdle: true,
            isCompacting: false,
            isRetrying: false,
            retryAttempt: 0,
            isBashRunning: false,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("requires an observed cursor to belong to the intent's expected owner and models conflicting duplicate payloads", () => {
    const envelope = {
      sessionId: "session-a",
      intentId: "intent-a",
      rendererGeneration: 2,
      expectedOwner: owner,
      observedCursor: cursor,
      intent: {
        kind: "submit",
        editorRevision: 0,
        text: "hello",
        images: [],
        requestedMode: "steer",
        surface: "composer",
      },
    };
    expect(IntentEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      IntentEnvelopeSchema.safeParse({
        ...envelope,
        intent: {
          ...envelope.intent,
          images: [{ type: "image", data: "AA==", mimeType: "image/png", extra: true }],
        },
      }).success,
    ).toBe(false);
    expect(
      IntentEnvelopeSchema.safeParse({
        ...envelope,
        observedCursor: { ...cursor, hostInstanceId: "host-b" },
      }).success,
    ).toBe(false);

    const reload = {
      ...envelope,
      intent: { kind: "reload", editorRevision: 3, editorText: "/reload " },
    };
    expect(IntentEnvelopeSchema.safeParse(reload).success).toBe(true);
    expect(
      IntentEnvelopeSchema.safeParse({
        ...reload,
        intent: { kind: "reload", editorRevision: 3 },
      }).success,
    ).toBe(false);

    expect(
      IntentPayloadConflictSchema.safeParse({
        intentId: "intent-a",
        owner,
        expectedPayloadFingerprint: "first",
        receivedPayloadFingerprint: "second",
      }).success,
    ).toBe(true);
    expect(
      IntentPayloadConflictSchema.safeParse({
        intentId: "intent-a",
        owner,
        expectedPayloadFingerprint: "same",
        receivedPayloadFingerprint: "same",
      }).success,
    ).toBe(false);

    const manageQueue = {
      ...envelope,
      intent: {
        kind: "manageQueue",
        operation: "clear",
        expectedSteeringIntentIds: ["steer-a"],
        expectedFollowUpIntentIds: ["follow-a"],
      },
    };
    expect(IntentEnvelopeSchema.safeParse(manageQueue).success).toBe(true);
    expect(
      IntentEnvelopeSchema.safeParse({
        ...manageQueue,
        intent: { kind: "manageQueue", operation: "update", targetIntentId: "steer-a" },
      }).success,
    ).toBe(false);
    expect(
      IntentEnvelopeSchema.safeParse({
        ...manageQueue,
        intent: {
          kind: "manageQueue",
          operation: "remove",
          targetIntentId: "steer-a",
          expectedSteeringIntentIds: ["steer-a"],
        },
      }).success,
    ).toBe(false);
  });

  it("models catalog refresh as a bounded mutation rather than a query", () => {
    const envelope = {
      sessionId: "session-a",
      intentId: "refresh-a",
      rendererGeneration: 1,
      expectedOwner: owner,
      intent: { kind: "refreshModels" },
    };
    expect(IntentEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      IntentOutcomeSchema.safeParse({
        intentId: "refresh-a",
        owner,
        kind: "refreshModels",
        state: "completed",
        result: { refreshed: true },
      }).success,
    ).toBe(true);
    expect(SessionQuerySchema.safeParse({ type: "refreshModels" }).success).toBe(false);
  });

  it("keeps runtime login intents and outcomes bounded and non-secret", () => {
    const envelope = {
      sessionId: "session-a",
      intentId: "login-a",
      rendererGeneration: 1,
      expectedOwner: owner,
      intent: { kind: "loginProvider", providerId: "project-provider", authType: "api_key" },
    };
    expect(IntentEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      IntentEnvelopeSchema.safeParse({
        ...envelope,
        intent: { ...envelope.intent, authType: "password" },
      }).success,
    ).toBe(false);
    const outcome = {
      intentId: "login-a",
      owner,
      kind: "loginProvider",
      state: "completed",
      result: { providerId: "project-provider", authType: "api_key" },
    };
    expect(IntentOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(
      IntentOutcomeSchema.safeParse({
        ...outcome,
        result: { ...outcome.result, credential: "secret" },
      }).success,
    ).toBe(false);
  });

  it("admits only explicit read operations as owner-bound queries", () => {
    const query = { type: "render_entry", entryId: "entry-a", cols: 80, expanded: true };
    expect(SessionQuerySchema.safeParse(query).success).toBe(true);
    for (const effect of [
      { type: "compact" },
      { type: "set_model", provider: "openai", modelId: "gpt" },
      { type: "navigate_tree", targetId: "entry-a" },
      { type: "new_session" },
      { type: "prompt", message: "must submit" },
    ]) {
      expect(SessionQuerySchema.safeParse(effect).success).toBe(false);
    }
    expect(Object.keys(SESSION_QUERY_POLICY).sort()).toEqual([
      "get_available_models",
      "get_cache_miss_notices",
      "get_commands",
      "get_fork_messages",
      "get_last_assistant_text",
      "get_login_providers",
      "get_logout_providers",
      "get_messages",
      "get_scoped_models",
      "get_session_stats",
      "get_state",
      "get_tree",
      "get_trust_state",
      "render_entry",
    ]);

    const envelope = {
      sessionId: "session-a",
      queryId: "query-a",
      expectedOwner: owner,
      observedCursor: cursor,
      query,
    };
    expect(SessionQueryEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      SessionQueryEnvelopeSchema.safeParse({
        ...envelope,
        observedCursor: { ...cursor, hostInstanceId: "host-b" },
      }).success,
    ).toBe(false);
    expect(
      SessionQueryResultSchema.safeParse({
        status: "ok",
        queryId: "query-a",
        owner,
        queryType: "render_entry",
        response: { type: "response", command: "render_entry", success: true },
      }).success,
    ).toBe(true);
    expect(
      SessionQueryResultSchema.safeParse({
        status: "ok",
        queryId: "query-a",
        owner,
        queryType: "render_entry",
        response: { type: "response", command: "compact", success: true },
      }).success,
    ).toBe(false);
  });

  it("keeps per-intent terminal results discriminated", () => {
    expect(
      IntentOutcomeSchema.safeParse({
        intentId: "intent-a",
        owner,
        kind: "submit",
        state: "completed",
        result: { disposition: "consumed", editorRevision: 3, queued: true },
      }).success,
    ).toBe(true);
    expect(
      IntentOutcomeSchema.safeParse({
        intentId: "intent-a",
        owner,
        kind: "setModel",
        state: "completed",
        result: { provider: "openai" },
      }).success,
    ).toBe(false);
    expect(
      IntentOutcomeSchema.safeParse({
        intentId: "queue-edit",
        owner,
        kind: "manageQueue",
        state: "completed",
        result: { operation: "update", targetIntentId: "queued-a", queue: "steer" },
      }).success,
    ).toBe(true);
  });

  it("carries only validated public post-navigation tree data", () => {
    const outcome = {
      intentId: "intent-a",
      owner,
      kind: "navigate" as const,
      state: "completed" as const,
      result: {
        targetId: "target-a",
        summarized: true,
        editorText: "restored draft",
        leafId: "leaf-a",
        branch: [{ id: "root-a", type: "message", timestamp: 1 }],
      },
    };
    expect(IntentOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(
      IntentOutcomeSchema.safeParse({
        ...outcome,
        result: { ...outcome.result, branch: [{ id: "missing-type" }] },
      }).success,
    ).toBe(false);
    expect(
      IntentOutcomeSchema.safeParse({
        ...outcome,
        result: { ...outcome.result, extra: true },
      }).success,
    ).toBe(false);
  });

  it("accepts only atomically owner-consistent frames and publication payloads", () => {
    const frame = {
      owner,
      transportSequence: 7,
      frameId: "frame-7",
      records: [],
      terminalSnapshot: snapshot(),
    };
    expect(AuthorityFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      AuthorityFrameSchema.safeParse({
        ...frame,
        terminalSnapshot: snapshot({ owner: otherOwner }),
      }).success,
    ).toBe(false);

    const publication = {
      sessionId: "session-a",
      rendererGeneration: 2,
      publicationSequence: 21,
      plane: "semantic",
      owner,
      payload: frame,
    };
    expect(RendererPublicationSchema.safeParse(publication).success).toBe(true);
    expect(RendererPublicationSchema.safeParse({ ...publication, owner: otherOwner }).success).toBe(
      false,
    );
  });

  it("requires attach baselines, panel reconstruction, and replay to be internally coherent", () => {
    expect(AuthorityAttachBaselineSchema.safeParse(baseline()).success).toBe(true);
    expect(
      AuthorityAttachBaselineSchema.safeParse(
        baseline({
          semantic: {
            sync: { state: "following", cursor: { ...cursor, snapshotSequence: 10 } },
            snapshot: snapshot(),
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      PanelPresentationBaselineSchema.safeParse({
        panelKey: "panel-a",
        panelId: 1,
        owner,
        sync: { state: "following", cursor },
        overlay: true,
        unified: false,
        inputAcknowledgedThrough: 0,
        keyframe: { kind: "repaint_required", renderRevision: 1 },
      }).success,
    ).toBe(false);

    const response = {
      status: "ready",
      baseline: baseline(),
      replay: [
        {
          sessionId: "session-a",
          rendererGeneration: 2,
          publicationSequence: 21,
          plane: "semantic",
          owner,
          payload: {
            owner,
            transportSequence: 8,
            frameId: "frame-8",
            records: [],
            terminalSnapshot: snapshot({ snapshotSequence: 12 }),
          },
        },
      ],
    };
    expect(AuthorityAttachResponseSchema.safeParse(response).success).toBe(true);
    expect(
      AuthorityAttachResponseSchema.safeParse({
        ...response,
        replay: [{ ...response.replay[0], publicationSequence: 20 }],
      }).success,
    ).toBe(false);
  });
});
