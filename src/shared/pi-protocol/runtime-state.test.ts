import { describe, expect, it } from "vitest";
import {
  AgentSessionSnapshotSchema,
  AuthorityAttachBaselineSchema,
  AuthorityAttachResponseSchema,
  AuthorityCursorSchema,
  AuthorityFrameSchema,
  IntentEnvelopeSchema,
  IntentOutcomeSchema,
  IntentPayloadConflictSchema,
  IntentReceiptSchema,
  NonPtyShellTurnSnapshotSchema,
  PanelPresentationBaselineSchema,
  RendererPublicationSchema,
  SESSION_QUERY_POLICY,
  SemanticSnapshotSchema,
  SessionIntentSchema,
  SessionQueryEnvelopeSchema,
  SessionQueryResultSchema,
  SessionQuerySchema,
  SessionRuntimeResumeStateSchema,
  SessionSubmissionSchema,
  ShellTurnSnapshotSchema,
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

describe("session runtime resume state", () => {
  it("accepts a typed owner-local model and thinking selection", () => {
    expect(
      SessionRuntimeResumeStateSchema.parse({
        model: { provider: "provider-a", modelId: "model-a" },
        thinkingLevel: "xhigh",
      }),
    ).toEqual({
      model: { provider: "provider-a", modelId: "model-a" },
      thinkingLevel: "xhigh",
    });
    expect(
      SessionRuntimeResumeStateSchema.parse({
        model: null,
        thinkingLevel: "off",
      }),
    ).toEqual({ model: null, thinkingLevel: "off" });
  });

  it("rejects ambiguous model references and unknown thinking levels", () => {
    expect(
      SessionRuntimeResumeStateSchema.safeParse({
        model: { modelId: "model-a" },
        thinkingLevel: "extreme",
      }).success,
    ).toBe(false);
  });
});

describe("Pi 0.99 virtual-model routing state", () => {
  const routedModel = {
    model: { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
    thinkingLevel: "high",
  } as const;

  it("preserves the selected virtual model and its latest physical route", () => {
    expect(
      SemanticSnapshotSchema.parse(
        snapshot({
          model: { id: "auto", name: "Auto", provider: "router", api: "pi-virtual" },
          routedModel,
        }),
      ).routedModel,
    ).toEqual(routedModel);

    expect(
      AgentSessionSnapshotSchema.safeParse({
        hostInstanceId: "host-a",
        sessionEpoch: 4,
        snapshotSequence: 1,
        capturedAt: 1,
        isStreaming: false,
        isIdle: true,
        isCompacting: false,
        isRetrying: false,
        retryAttempt: 0,
        isBashRunning: false,
        model: { id: "auto", provider: "router", api: "pi-virtual" },
        routedModel,
        thinkingLevel: "medium",
        sessionId: "session-a",
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
        catalog: {},
        editor: { revision: 0, text: "", attachments: [] },
      }).success,
    ).toBe(true);
  });
});

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
            steering: ["one"],
            followUp: ["two"],
            steeringIntentIds: ["duplicate-owner"],
            followUpIntentIds: ["duplicate-owner"],
            management: {
              available: false,
              message: "One intent cannot own two removable positions",
              removableIntentIds: ["duplicate-owner"],
            },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      SemanticSnapshotSchema.safeParse(
        snapshot({
          queues: {
            steering: ["one"],
            followUp: [],
            steeringIntentIds: ["owned-one"],
            followUpIntentIds: [],
            management: {
              available: false,
              message: "Unknown removal ids are invalid",
              removableIntentIds: ["absent-target"],
            },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      SemanticSnapshotSchema.safeParse(
        snapshot({
          queues: {
            steering: ["one"],
            followUp: [],
            steeringIntentIds: ["owned-one"],
            followUpIntentIds: [],
            management: {
              available: false,
              message: "Only removal is safe",
              removableIntentIds: ["owned-one"],
            },
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      SemanticSnapshotSchema.safeParse(
        snapshot({
          queues: {
            steering: ["one"],
            followUp: [],
            steeringIntentIds: ["owned-one"],
            followUpIntentIds: [],
            management: {
              available: false,
              message: "Duplicate removal ids are invalid",
              removableIntentIds: ["owned-one", "owned-one"],
            },
          },
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
        inputKind: "ordinary",
        images: [],
        requestedMode: "steer",
        surface: "composer",
      },
    };
    expect(IntentEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      IntentEnvelopeSchema.safeParse({
        ...envelope,
        intent: { ...envelope.intent, inputKind: "unknown" },
      }).success,
    ).toBe(false);
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
    for (const invalidReload of [
      { kind: "reload", editorRevision: 3 },
      { kind: "reload", editorText: "/reload" },
      { kind: "reload", surface: "unified" },
      { kind: "reload", surface: "composer" },
    ]) {
      // Pairing belongs to SessionIntentSchema itself so callers that validate
      // an intent before constructing its envelope get the same strict fence.
      expect(SessionIntentSchema.safeParse(invalidReload).success).toBe(false);
      expect(IntentEnvelopeSchema.safeParse({ ...reload, intent: invalidReload }).success).toBe(
        false,
      );
    }

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

  it("validates original editor input classification on compatibility submissions", () => {
    const submission = {
      intentId: "submit-a",
      expectedHostId: "host-a",
      expectedEpoch: 4,
      editorRevision: 2,
      text: "/tmp/notes.txt\n\nExplain these notes",
      inputKind: "ordinary",
      images: [],
      requestedMode: "steer",
      surface: "composer",
    };
    expect(SessionSubmissionSchema.safeParse(submission).success).toBe(true);
    expect(SessionSubmissionSchema.safeParse({ ...submission, inputKind: "unknown" }).success).toBe(
      false,
    );
    const { inputKind: _legacyMissing, ...legacySubmission } = submission;
    expect(SessionSubmissionSchema.safeParse(legacySubmission).success).toBe(true);
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
      result: {
        providerId: "project-provider",
        authType: "api_key",
        synchronized: false,
      },
    };
    expect(IntentOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(
      IntentOutcomeSchema.safeParse({
        ...outcome,
        result: { ...outcome.result, credential: "secret" },
      }).success,
    ).toBe(false);
  });

  it("models trust selection as an exact child-revalidated mutation", () => {
    const envelope = {
      sessionId: "session-a",
      intentId: "trust-a",
      rendererGeneration: 1,
      expectedOwner: owner,
      intent: { kind: "setTrust", optionLabel: "Trust parent folder (/workspace)" },
    };
    expect(IntentEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      IntentEnvelopeSchema.safeParse({
        ...envelope,
        intent: {
          kind: "setTrust",
          optionLabel: "Trust parent folder (/workspace)",
          updates: [{ path: "/", decision: true }],
        },
      }).success,
    ).toBe(false);
    expect(
      IntentOutcomeSchema.safeParse({
        intentId: "trust-a",
        owner,
        kind: "setTrust",
        state: "completed",
        result: { trusted: true, persisted: true },
      }).success,
    ).toBe(true);
  });

  it("models picker continuations as bounded selections without editor or slash-text authority", () => {
    const base = {
      sessionId: "session-a",
      rendererGeneration: 1,
      expectedOwner: owner,
    };
    for (const [intentId, selection] of [
      ["fork-pick", { action: "fork", entryId: "entry-a" }],
      [
        "scope-pick",
        {
          action: "setScopedModels",
          enabledIds: ["anthropic/claude", "Saved pattern, with spaces"],
          persist: true,
        },
      ],
      ["logout-pick", { action: "logoutProvider", providerId: "anthropic" }],
    ] as const) {
      expect(
        IntentEnvelopeSchema.safeParse({
          ...base,
          intentId,
          intent: { kind: "pickerAction", selection, surface: "composer" },
        }).success,
      ).toBe(true);
    }
    for (const selection of [
      { action: "fork", entryId: "" },
      { action: "fork", entryId: "entry-a", text: "/fork entry-b" },
      { action: "setScopedModels", enabledIds: [""], persist: false },
      { action: "setScopedModels", enabledIds: null },
      { action: "logoutProvider", providerId: "anthropic", editorRevision: 9 },
      { action: "arbitraryCommand", text: "/new" },
    ]) {
      expect(
        SessionIntentSchema.safeParse({ kind: "pickerAction", selection, surface: "composer" })
          .success,
      ).toBe(false);
    }
    expect(
      SessionIntentSchema.safeParse({
        kind: "pickerAction",
        selection: { action: "fork", entryId: "entry-a" },
      }).success,
    ).toBe(false);
    expect(
      SessionIntentSchema.safeParse({
        kind: "pickerAction",
        selection: { action: "fork", entryId: "entry-a" },
        surface: "detached",
      }).success,
    ).toBe(false);
    expect(
      IntentOutcomeSchema.safeParse({
        intentId: "fork-pick",
        owner,
        kind: "pickerAction",
        state: "completed",
        result: { action: "fork" },
      }).success,
    ).toBe(true);
  });

  it("admits only explicit read operations as owner-bound queries", () => {
    const query = { type: "render_entry", entryId: "entry-a", cols: 80, expanded: true };
    expect(SessionQuerySchema.safeParse(query).success).toBe(true);
    expect(
      SessionQuerySchema.safeParse({
        type: "render_message",
        customType: "status-card",
        timestamp: 1_700_000_000_000,
        cols: 96,
        expanded: false,
      }).success,
    ).toBe(true);
    expect(
      SessionQuerySchema.safeParse({
        type: "transform_markdown",
        items: [
          {
            requestId: "markdown-a",
            markdown: "before",
            messageType: "assistant-thinking",
            isStreaming: false,
            availableWidth: 80,
          },
        ],
      }).success,
    ).toBe(true);
    for (const invalid of [
      { type: "render_message", customType: "", timestamp: 1, cols: 80 },
      { type: "render_message", customType: "status-card", cols: 80 },
      { type: "render_message", customType: "status-card", timestamp: 1, cols: 19 },
      { type: "render_message", customType: "status-card", timestamp: 1, cols: 241 },
      {
        type: "render_message",
        customType: "status-card",
        timestamp: Number.POSITIVE_INFINITY,
        cols: 80,
      },
    ]) {
      expect(SessionQuerySchema.safeParse(invalid).success).toBe(false);
    }
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
      "render_message",
      "transform_markdown",
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
    expect(
      SessionQueryResultSchema.safeParse({
        status: "ok",
        queryId: "query-message",
        owner,
        queryType: "render_message",
        response: { type: "response", command: "render_message", success: true },
      }).success,
    ).toBe(true);
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
      runtimeResumeState: {
        model: { provider: "provider-a", modelId: "model-a" },
        thinkingLevel: "high",
      },
    };
    expect(AuthorityFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      AuthorityFrameSchema.safeParse({
        ...frame,
        terminalSnapshot: snapshot({ owner: otherOwner }),
      }).success,
    ).toBe(false);
    expect(
      AuthorityFrameSchema.safeParse({
        ...frame,
        runtimeResumeState: {
          model: { provider: "", modelId: "model-a" },
          thinkingLevel: "high",
        },
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
    const streamingBaseline = baseline({
      transcript: {
        sync: { state: "following", cursor },
        persistedHistoryCursor: null,
        liveTailCursor: "7",
        overlapBoundary: null,
        currentStreamingMessage: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
        },
        currentStreamingMessageThroughSequence: cursor.transportSequence + 1,
      },
    });
    expect(AuthorityAttachBaselineSchema.safeParse(streamingBaseline).success).toBe(true);
    expect(
      AuthorityAttachBaselineSchema.safeParse({
        ...streamingBaseline,
        transcript: {
          ...streamingBaseline.transcript,
          currentStreamingMessage: undefined,
        },
      }).success,
    ).toBe(false);
    const navigationPresentation = {
      intentId: "navigate-a",
      owner,
      targetId: "leaf-a",
      leafId: "leaf-a",
      branch: [{ id: "leaf-a", type: "message" }],
    };
    expect(
      AuthorityAttachBaselineSchema.safeParse(
        baseline({ pendingNavigationPresentations: [navigationPresentation] }),
      ).success,
    ).toBe(true);
    const nonPtyShellTurn = {
      id: "remote-shell-1",
      command: "remote-build",
      owner,
      startedAt: 1_700_000_000_100,
      cwd: "/workspace/remote",
      pty: false as const,
      outputText: "building\n",
      outputThroughSequence: 3,
      replayTruncated: true,
    };
    const nonPtyBaseline = baseline({
      semantic: {
        sync: { state: "following", cursor },
        snapshot: snapshot({
          sdk: {
            isStreaming: false,
            isIdle: false,
            isCompacting: false,
            isRetrying: false,
            retryAttempt: 0,
            isBashRunning: true,
          },
          activity: {
            bash: {
              kind: "bash",
              state: "active",
              intentId: "remote-shell-1",
              command: "remote-build",
              pty: false,
            },
          },
        }),
      },
      transcript: {
        sync: { state: "following", cursor },
        persistedHistoryCursor: null,
        liveTailCursor: null,
        overlapBoundary: null,
        currentShellTurn: nonPtyShellTurn,
      },
    });
    expect(NonPtyShellTurnSnapshotSchema.safeParse(nonPtyShellTurn).success).toBe(true);
    expect(AuthorityAttachBaselineSchema.safeParse(nonPtyBaseline).success).toBe(true);
    expect(
      AuthorityAttachBaselineSchema.safeParse({
        ...nonPtyBaseline,
        transcript: {
          ...nonPtyBaseline.transcript,
          currentShellTurn: { ...nonPtyShellTurn, owner: otherOwner },
        },
      }).success,
    ).toBe(false);
    expect(
      AuthorityAttachBaselineSchema.safeParse({
        ...nonPtyBaseline,
        semantic: {
          ...nonPtyBaseline.semantic,
          snapshot: snapshot({
            activity: {
              bash: {
                kind: "bash",
                state: "active",
                intentId: "different-shell",
                pty: false,
              },
            },
          }),
        },
      }).success,
    ).toBe(false);
    expect(
      NonPtyShellTurnSnapshotSchema.safeParse({
        ...nonPtyShellTurn,
        ansi: "terminal-only-field",
      }).success,
    ).toBe(false);
    expect(
      AuthorityAttachBaselineSchema.safeParse(
        baseline({
          pendingNavigationPresentations: [
            navigationPresentation,
            { ...navigationPresentation, owner: otherOwner },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      AuthorityAttachBaselineSchema.safeParse(
        baseline({
          pendingNavigationPresentations: [navigationPresentation, { ...navigationPresentation }],
        }),
      ).success,
    ).toBe(false);
    const currentShellTurn = {
      id: "shell-1",
      command: "npm init",
      owner,
      startedAt: 1_700_000_000_000,
      cwd: "/workspace",
      excludeFromContext: true,
      cols: 96,
      rows: 30,
      mode: "compact",
      ansi: "Package name: ",
      reconstructionFenceToken: 7,
      outputThroughSequence: 4,
      inputAcknowledgedThrough: 2,
      resizeRevision: 3,
      interruptRequestedAt: 1_700_000_001_000,
    };
    expect(
      ShellTurnSnapshotSchema.safeParse({
        ...currentShellTurn,
        replayTruncated: true,
      }).success,
    ).toBe(true);
    const ptyBaseline = baseline({
      semantic: {
        sync: { state: "following", cursor },
        snapshot: snapshot({
          activity: {
            bash: {
              kind: "bash",
              state: "active",
              intentId: "shell-1",
              command: "npm init",
              pty: true,
              inputReady: true,
              terminalMode: "compact",
            },
          },
        }),
      },
      transcript: {
        sync: { state: "following", cursor },
        persistedHistoryCursor: null,
        liveTailCursor: null,
        overlapBoundary: null,
        currentShellTurn,
      },
    });
    expect(AuthorityAttachBaselineSchema.safeParse(ptyBaseline).success).toBe(true);
    expect(
      AuthorityAttachBaselineSchema.safeParse({
        ...ptyBaseline,
        transcript: {
          ...ptyBaseline.transcript,
          currentShellTurn: { ...currentShellTurn, owner: otherOwner },
        },
      }).success,
    ).toBe(false);
    expect(
      ShellTurnSnapshotSchema.safeParse({
        ...currentShellTurn,
        owner: otherOwner,
        outputThroughSequence: -1,
      }).success,
    ).toBe(false);
    expect(
      ShellTurnSnapshotSchema.safeParse({
        ...currentShellTurn,
        reconstructionFenceToken: -1,
      }).success,
    ).toBe(false);
    const { reconstructionFenceToken: _omittedFenceToken, ...missingFenceToken } = currentShellTurn;
    expect(ShellTurnSnapshotSchema.safeParse(missingFenceToken).success).toBe(false);
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

  it("models a busy Shell Turn refusal as a non-admitted receipt", () => {
    expect(
      IntentReceiptSchema.parse({
        status: "not_admitted",
        intentId: "shell-1",
        reason: "busy",
      }),
    ).toMatchObject({ status: "not_admitted", reason: "busy" });
  });

  it("types optional persistence for model and thinking defaults", () => {
    expect(
      SessionIntentSchema.parse({
        kind: "setModel",
        provider: "openai",
        modelId: "gpt-6-astra",
        persist: true,
      }),
    ).toMatchObject({ persist: true });
    expect(
      SessionIntentSchema.parse({ kind: "setThinking", level: "max", persist: true }),
    ).toMatchObject({ persist: true });
    expect(
      SessionIntentSchema.safeParse({ kind: "setThinking", level: "high", persist: "yes" }).success,
    ).toBe(false);
  });

  it("binds a Shell Turn command and context mode to its exact raw editor source", () => {
    expect(
      SessionIntentSchema.parse({
        kind: "runBash",
        command: "!echo once",
        excludeFromContext: true,
        editorRevision: 7,
        editorText: "!!!echo once  ",
      }),
    ).toMatchObject({
      command: "!echo once",
      excludeFromContext: true,
      editorRevision: 7,
    });
    for (const intent of [
      {
        kind: "runBash",
        command: "echo once",
        excludeFromContext: false,
        editorRevision: 7,
        editorText: "!!echo once",
      },
      {
        kind: "runBash",
        command: "echo different",
        excludeFromContext: false,
        editorRevision: 7,
        editorText: "!echo once",
      },
      {
        kind: "runBash",
        command: "echo once",
        excludeFromContext: false,
        editorRevision: 7,
        editorText: "echo once",
      },
    ]) {
      expect(SessionIntentSchema.safeParse(intent).success).toBe(false);
    }
  });

  it("models draft-preserving Shell Turn refusals as typed non-admitted receipts", () => {
    expect(
      IntentReceiptSchema.parse({
        status: "not_admitted",
        intentId: "shell-2",
        reason: "stale_editor",
      }),
    ).toMatchObject({ status: "not_admitted", reason: "stale_editor" });
    expect(
      IntentReceiptSchema.parse({
        status: "not_admitted",
        intentId: "shell-3",
        reason: "cancelled",
      }),
    ).toMatchObject({ status: "not_admitted", reason: "cancelled" });
  });
});
