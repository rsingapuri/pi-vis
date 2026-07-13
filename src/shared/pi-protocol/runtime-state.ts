import { z } from "zod";
import { PiEventSchema } from "./events.js";
import { ExtensionUiRequestSchema } from "./extension-ui.js";
import { PanelEventSchema } from "./panel-events.js";
import { PiRpcResponseSchema } from "./responses.js";
import { ThinkingLevelSchema } from "./thinking.js";

export const RuntimeAvailabilitySchema = z.enum(["available", "unavailable", "transitioning"]);
export type RuntimeAvailability = z.infer<typeof RuntimeAvailabilitySchema>;

export const SubmissionDispositionSchema = z.enum([
  "not_submitted",
  "in_custody",
  "consumed",
  "rejected",
  "completed",
  "extension_error",
  "outcome_unknown",
]);
export type SubmissionDisposition = z.infer<typeof SubmissionDispositionSchema>;

export const EscapeDispositionSchema = z.enum([
  "abort_requested",
  "already_inactive",
  "not_applicable",
  "failed",
  "outcome_unknown",
]);
export type EscapeDisposition = z.infer<typeof EscapeDispositionSchema>;

export const SubmissionSurfaceSchema = z.enum(["composer", "unified"]);
export type SubmissionSurface = z.infer<typeof SubmissionSurfaceSchema>;

export const RuntimeIdentitySchema = z.object({
  hostInstanceId: z.string().min(1),
  sessionEpoch: z.number().int().nonnegative(),
});
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

/**
 * Transitional payload for the retired renderer command bridge. It intentionally
 * has no dependency on Pi's command union: new renderer reads use
 * `SessionQueryEnvelope` and mutations use `IntentEnvelope`.
 *
 * `any` quarantines the old bridge while main/renderer callers migrate. The
 * schema still requires a command discriminant so malformed IPC never reaches
 * the registry as an untyped value.
 */
// biome-ignore lint/suspicious/noExplicitAny: Compatibility boundary for callers not migrated to intents/queries.
export type LegacyCommandPayload = any;
export const LegacyCommandPayloadSchema: z.ZodType<LegacyCommandPayload> = z
  .object({ type: z.string().min(1) })
  .passthrough();

// The legacy bridge retains its effect-intent fence until callers finish
// migration. This is intentionally a narrow structural check; Pi command
// validation remains at the host boundary and is not re-exported here.
const LegacyIntentRequiredCommandTypes = new Set([
  "abort",
  "bash",
  "abort_bash",
  "cycle_model",
  "cycle_thinking_level",
  "new_session",
  "switch_session",
  "fork",
  "clone",
  "compact",
  "abort_retry",
  "export_html",
  "navigate_tree",
]);

/** @deprecated Use `IntentEnvelope` for mutations; retained only for migration. */
export const RendererCommandRequestSchema = z
  .object({
    requestId: z.string().min(1),
    command: LegacyCommandPayloadSchema,
    expectedHostInstanceId: z.string().min(1),
    expectedSessionEpoch: z.number().int().nonnegative(),
    intentId: z.string().min(1).optional(),
    uiSurface: SubmissionSurfaceSchema.optional(),
    sourceText: z.string().optional(),
    editorRevision: z.number().int().nonnegative().optional(),
  })
  .superRefine((request, ctx) => {
    if (LegacyIntentRequiredCommandTypes.has(request.command.type) && !request.intentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intentId"],
        message: `${request.command.type} requires an effect intent id`,
      });
    }
  });
export type RendererCommandRequest = z.infer<typeof RendererCommandRequestSchema>;

export const CommandDispositionSchema = z.enum(["not_executed", "completed", "outcome_unknown"]);
export type CommandDisposition = z.infer<typeof CommandDispositionSchema>;

/** @deprecated Command discriminants are no longer part of the shared process API. */
export const PiCommandTypeSchema = z.string().min(1);

/** Pi response plus authoritative command admission/settlement metadata. */
export const CommandSettlementSchema = PiRpcResponseSchema.and(
  z.object({
    requestId: z.string(),
    intentId: z.string().optional(),
    commandType: PiCommandTypeSchema,
    commandClass: z.enum(["read_only", "idempotent", "effectful", "replacement"]),
    hostInstanceId: z.string(),
    sessionEpoch: z.number().int().nonnegative(),
    disposition: CommandDispositionSchema,
    successorIdentity: RuntimeIdentitySchema.optional(),
    restorationId: z.string().optional(),
  }),
);
export type CommandSettlement = z.infer<typeof CommandSettlementSchema>;

export const ReloadRequestSchema = z.object({
  requestId: z.string().min(1),
  intentId: z.string().min(1),
  expectedHostInstanceId: z.string().min(1),
  expectedSessionEpoch: z.number().int().nonnegative(),
  sourceText: z.string().optional(),
});
export type ReloadRequest = z.infer<typeof ReloadRequestSchema>;

export const ReloadSettlementSchema = z.object({
  requestId: z.string(),
  intentId: z.string(),
  operation: z.literal("reload"),
  hostInstanceId: z.string(),
  sessionEpoch: z.number().int().nonnegative(),
  disposition: CommandDispositionSchema,
  success: z.boolean(),
  error: z.string().optional(),
  successorIdentity: RuntimeIdentitySchema.optional(),
  restorationId: z.string().optional(),
});
export type ReloadSettlement = z.infer<typeof ReloadSettlementSchema>;

export const RuntimeImageSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
export type RuntimeImage = z.infer<typeof RuntimeImageSchema>;

export const SessionSubmissionSchema = z.object({
  intentId: z.string(),
  expectedHostId: z.string(),
  expectedEpoch: z.number().int().nonnegative(),
  editorRevision: z.number().int().nonnegative(),
  text: z.string(),
  images: z.array(RuntimeImageSchema).default([]),
  requestedMode: z.enum(["steer", "followUp"]),
  surface: SubmissionSurfaceSchema,
});
export type SessionSubmission = z.infer<typeof SessionSubmissionSchema>;

export const SubmissionResultSchema = z.object({
  intentId: z.string(),
  hostInstanceId: z.string(),
  sessionEpoch: z.number().int().nonnegative(),
  editorRevision: z.number().int().nonnegative(),
  disposition: SubmissionDispositionSchema,
  /** True when prompt admission targeted Pi's active-turn queue. */
  queued: z.boolean().optional(),
  message: z.string().optional(),
  custodyId: z.string().optional(),
});
export type SubmissionResult = z.infer<typeof SubmissionResultSchema>;

export const EscapeResultSchema = z.object({
  requestId: z.string(),
  hostInstanceId: z.string(),
  sessionEpoch: z.number().int().nonnegative(),
  disposition: EscapeDispositionSchema,
  target: z.enum(["navigation", "compaction", "retry", "streaming", "bash", "editor"]).optional(),
  message: z.string().optional(),
  restorationId: z.string().optional(),
});
export type EscapeResult = z.infer<typeof EscapeResultSchema>;

export const RuntimeModelSchema = z
  .object({
    id: z.string(),
    provider: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const RuntimeCatalogSchema = z.object({
  notifications: z
    .array(z.object({ id: z.string(), message: z.string(), type: z.string().optional() }))
    .default([]),
  statuses: z.record(z.string()).default({}),
  widgets: z.record(z.array(z.string())).default({}),
  title: z.string().optional(),
  workingMessage: z.string().optional(),
  workingVisible: z.boolean().optional(),
  hiddenThinkingLabel: z.string().optional(),
  toolsExpanded: z.boolean().optional(),
  capabilityDiagnostics: z.array(z.string()).default([]),
});
export type RuntimeCatalog = z.infer<typeof RuntimeCatalogSchema>;

export const RuntimeEditorStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  text: z.string(),
  attachments: z.array(z.unknown()).default([]),
  conflictText: z.string().optional(),
  conflictAttachments: z.array(z.unknown()).optional(),
  alternateConflictText: z.string().optional(),
  alternateConflictAttachments: z.array(z.unknown()).optional(),
  additionalConflictCandidates: z
    .array(z.object({ text: z.string(), attachments: z.array(z.unknown()) }))
    .optional(),
});
export type RuntimeEditorState = z.infer<typeof RuntimeEditorStateSchema>;

/** A fresh, direct read from the public AgentSession getters. */
export const AgentSessionSnapshotSchema = z.object({
  hostInstanceId: z.string(),
  sessionEpoch: z.number().int().nonnegative(),
  snapshotSequence: z.number().int().positive(),
  capturedAt: z.number(),
  isStreaming: z.boolean(),
  isIdle: z.boolean(),
  isCompacting: z.boolean(),
  isRetrying: z.boolean(),
  retryAttempt: z.number().int().nonnegative(),
  isBashRunning: z.boolean(),
  model: RuntimeModelSchema.nullable(),
  thinkingLevel: ThinkingLevelSchema,
  sessionId: z.string(),
  sessionFile: z.string().optional(),
  sessionName: z.string().optional(),
  pendingMessageCount: z.number().int().nonnegative(),
  steering: z.array(z.string()),
  followUp: z.array(z.string()),
  /** Positional GUI intent ownership aligned with the transformed text queues.
   * Null slots are extension/external queue entries. Optional for persisted
   * compatibility; current SDK hosts always publish them. */
  steeringIntentIds: z.array(z.string().nullable()).optional(),
  followUpIntentIds: z.array(z.string().nullable()).optional(),
  hostFacts: z.object({
    submitting: z.boolean(),
    actualCompaction: z.boolean(),
    navigation: z.boolean(),
    pendingDialogs: z.number().int().nonnegative(),
    custodyCount: z.number().int().nonnegative(),
  }),
  catalog: RuntimeCatalogSchema,
  editor: RuntimeEditorStateSchema,
});
export type AgentSessionSnapshot = z.infer<typeof AgentSessionSnapshotSchema>;

export const RuntimeRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: PiEventSchema }),
  z.object({ type: z.literal("ui"), request: ExtensionUiRequestSchema }),
  z.object({ type: z.literal("panel"), event: PanelEventSchema }),
  z.object({ type: z.literal("submission"), result: SubmissionResultSchema }),
  z.object({ type: z.literal("escape"), result: EscapeResultSchema }),
  // clearQueue() payloads are held for review; attachment bytes are retained
  // with their original submission intent so restoration is lossless.
  z.object({
    type: z.literal("queue_restoration"),
    restorationId: z.string(),
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
    originalAttachments: z.array(z.object({ intentId: z.string(), images: z.array(z.unknown()) })),
    /** GUI queue intents destructively removed by clearQueue(). */
    clearedIntentIds: z.array(z.string()).optional(),
    /** Present for an ambiguous effectful command that has no replayable queue payload. */
    commandDescription: z.string().optional(),
    requiresReview: z.literal(true),
  }),
]);
export type RuntimeRecord = z.infer<typeof RuntimeRecordSchema>;

export const TransitionBatchSchema = z.object({
  transitionId: z.string(),
  provisionalEpoch: z.number().int().nonnegative(),
  records: z.array(RuntimeRecordSchema),
  terminalSnapshot: AgentSessionSnapshotSchema,
});
export type TransitionBatch = z.infer<typeof TransitionBatchSchema>;

export const HostEnvelopeSchema = z
  .object({
    hostInstanceId: z.string().uuid(),
    sessionEpoch: z.number().int().nonnegative(),
    transportSequence: z.number().int().positive(),
    payload: z.discriminatedUnion("type", [
      z.object({ type: z.literal("spawned") }),
      z.object({
        type: z.literal("transition_started"),
        transitionId: z.string(),
        provisionalEpoch: z.number().int().nonnegative(),
      }),
      z.object({ type: z.literal("transition_cancelled"), transitionId: z.string() }),
      z.object({
        type: z.literal("ready"),
        piVersion: z.string().optional(),
        snapshot: AgentSessionSnapshotSchema,
        records: z.array(RuntimeRecordSchema).default([]),
      }),
      z.object({
        type: z.literal("snapshot"),
        snapshot: AgentSessionSnapshotSchema,
        full: z.boolean().default(false),
      }),
      z.object({ type: z.literal("transition_batch"), batch: TransitionBatchSchema }),
      z.object({
        type: z.literal("error"),
        message: z.string(),
        versionTooLow: z.boolean().optional(),
      }),
    ]),
  })
  .superRefine((envelope, ctx) => {
    const payload = envelope.payload;
    const snapshot =
      payload.type === "ready" || payload.type === "snapshot"
        ? payload.snapshot
        : payload.type === "transition_batch"
          ? payload.batch.terminalSnapshot
          : undefined;
    if (snapshot) {
      if (snapshot.hostInstanceId !== envelope.hostInstanceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Envelope/snapshot host identity mismatch",
        });
      }
      if (snapshot.sessionEpoch !== envelope.sessionEpoch) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Envelope/snapshot epoch mismatch" });
      }
    }
    if (payload.type === "transition_batch") {
      if (payload.batch.provisionalEpoch !== envelope.sessionEpoch) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Envelope/transition epoch mismatch",
        });
      }
      for (const record of payload.batch.records) {
        const identity =
          record.type === "submission" || record.type === "escape" ? record.result : undefined;
        if (
          identity &&
          (identity.hostInstanceId !== envelope.hostInstanceId ||
            identity.sessionEpoch !== payload.batch.provisionalEpoch)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Transition record identity mismatch",
          });
        }
      }
    }
  });
export type HostEnvelope = z.infer<typeof HostEnvelopeSchema>;

export interface RuntimeStateUpdate {
  availability: RuntimeAvailability;
  hostInstanceId?: string;
  sessionEpoch?: number;
  receivedAt: number;
  leaseExpiresAt?: number;
  snapshot?: AgentSessionSnapshot;
  reason?: string;
}

// ── Authority-frame protocol (migration foundation) ──────────────────────
// These contracts deliberately sit beside the legacy snapshot/envelope wire
// format above. Consumers can migrate plane-by-plane without weakening the
// established host IPC contract.

const NonEmptyIdSchema = z.string().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();

/** Identifies an exact child-authority commit, never wall-clock freshness. */
export const AuthorityCursorSchema = RuntimeIdentitySchema.extend({
  transportSequence: PositiveIntegerSchema,
  snapshotSequence: PositiveIntegerSchema,
}).strict();
export type AuthorityCursor = z.infer<typeof AuthorityCursorSchema>;

export const AuthoritativeQueuesSchema = z
  .object({
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
    /** Parallel ownership slots. Null is an extension/external queue entry. */
    steeringIntentIds: z.array(NonEmptyIdSchema.nullable()),
    followUpIntentIds: z.array(NonEmptyIdSchema.nullable()),
  })
  .strict()
  .superRefine((queues, ctx) => {
    if (queues.steering.length !== queues.steeringIntentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steeringIntentIds"],
        message: "steering intent ownership must align with steering queue slots",
      });
    }
    if (queues.followUp.length !== queues.followUpIntentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["followUpIntentIds"],
        message: "follow-up intent ownership must align with follow-up queue slots",
      });
    }
    const ownedIntentIds = [...queues.steeringIntentIds, ...queues.followUpIntentIds].filter(
      (intentId): intentId is string => intentId !== null,
    );
    if (new Set(ownedIntentIds).size !== ownedIntentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "one GUI intent may own at most one authoritative queue slot",
      });
    }
  });
export type AuthoritativeQueues = z.infer<typeof AuthoritativeQueuesSchema>;

export const AgentActivitySchema = z
  .object({
    kind: z.literal("agent"),
    state: z.enum(["active", "cancelling"]),
    startedAt: z.number().optional(),
  })
  .strict();
export type AgentActivity = z.infer<typeof AgentActivitySchema>;

export const CompactionActivitySchema = z
  .object({
    kind: z.literal("compaction"),
    state: z.enum(["active", "active_unknown_origin", "cancelling", "retry_wait"]),
    attempt: NonNegativeIntegerSchema,
    intentId: NonEmptyIdSchema.optional(),
    startedAt: z.number().optional(),
    anomaly: z.enum(["getter_event_disagreement", "missing_start_event"]).optional(),
  })
  .strict();
export type CompactionActivity = z.infer<typeof CompactionActivitySchema>;

export const RetryActivitySchema = z
  .object({
    kind: z.literal("retry"),
    state: z.enum(["active", "cancelling", "waiting"]),
    attempt: NonNegativeIntegerSchema,
    startedAt: z.number().optional(),
  })
  .strict();
export type RetryActivity = z.infer<typeof RetryActivitySchema>;

export const BashActivitySchema = z
  .object({
    kind: z.literal("bash"),
    state: z.enum(["active", "cancelling"]),
    intentId: NonEmptyIdSchema.optional(),
    command: z.string().optional(),
    startedAt: z.number().optional(),
  })
  .strict();
export type BashActivity = z.infer<typeof BashActivitySchema>;

export const NavigationActivitySchema = z
  .object({
    kind: z.literal("navigation"),
    state: z.enum(["active", "cancelling"]),
    intentId: NonEmptyIdSchema.optional(),
    targetId: NonEmptyIdSchema.optional(),
    startedAt: z.number().optional(),
  })
  .strict();
export type NavigationActivity = z.infer<typeof NavigationActivitySchema>;

export const CommandActivitySchema = z
  .object({
    kind: z.literal("command"),
    state: z.enum(["invoking", "cancelling"]),
    intentId: NonEmptyIdSchema,
    command: z.string(),
    startedAt: z.number().optional(),
  })
  .strict();
export type CommandActivity = z.infer<typeof CommandActivitySchema>;

export const SemanticActivitySchema = z
  .object({
    agent: AgentActivitySchema.optional(),
    compaction: CompactionActivitySchema.optional(),
    retry: RetryActivitySchema.optional(),
    bash: BashActivitySchema.optional(),
    navigation: NavigationActivitySchema.optional(),
    command: CommandActivitySchema.optional(),
  })
  .strict();
export type SemanticActivity = z.infer<typeof SemanticActivitySchema>;

// ── Read-only session queries ───────────────────────────────────────────
// Queries are deliberately separate from mutation intents and the legacy Pi
// command bridge. Their discriminants name every currently supported host read
// and cannot describe an effect.
export const SessionQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("get_available_models") }).strict(),
  z.object({ type: z.literal("get_scoped_models") }).strict(),
  z.object({ type: z.literal("get_logout_providers") }).strict(),
  z.object({ type: z.literal("get_commands") }).strict(),
  z.object({ type: z.literal("get_state") }).strict(),
  z.object({ type: z.literal("get_session_stats") }).strict(),
  z.object({ type: z.literal("get_messages") }).strict(),
  z.object({ type: z.literal("get_fork_messages") }).strict(),
  z.object({ type: z.literal("get_last_assistant_text") }).strict(),
  z.object({ type: z.literal("get_trust_state") }).strict(),
  z.object({ type: z.literal("get_tree") }).strict(),
  z
    .object({
      type: z.literal("render_entry"),
      entryId: NonEmptyIdSchema,
      cols: z.number().int().min(20).max(240),
      expanded: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("get_cache_miss_notices") }).strict(),
]);
export type SessionQuery = z.infer<typeof SessionQuerySchema>;

export const SessionQueryTypeSchema = z.enum([
  "get_available_models",
  "get_scoped_models",
  "get_logout_providers",
  "get_commands",
  "get_state",
  "get_session_stats",
  "get_messages",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_trust_state",
  "get_tree",
  "render_entry",
  "get_cache_miss_notices",
]);
export type SessionQueryType = z.infer<typeof SessionQueryTypeSchema>;

/** Queries may be retried only while their named owner remains authoritative. */
export const QueryRetryPolicySchema = z.literal("same_owner");
export type QueryRetryPolicy = z.infer<typeof QueryRetryPolicySchema>;
export interface QueryPolicy {
  retry: QueryRetryPolicy;
}

/** Exhaustive retry policy for every read-only host operation. */
export const SESSION_QUERY_POLICY = {
  get_available_models: { retry: "same_owner" },
  get_scoped_models: { retry: "same_owner" },
  get_logout_providers: { retry: "same_owner" },
  get_commands: { retry: "same_owner" },
  get_state: { retry: "same_owner" },
  get_session_stats: { retry: "same_owner" },
  get_messages: { retry: "same_owner" },
  get_fork_messages: { retry: "same_owner" },
  get_last_assistant_text: { retry: "same_owner" },
  get_trust_state: { retry: "same_owner" },
  get_tree: { retry: "same_owner" },
  render_entry: { retry: "same_owner" },
  get_cache_miss_notices: { retry: "same_owner" },
} as const satisfies Record<SessionQuery["type"], QueryPolicy>;

export function queryPolicy(query: SessionQuery): QueryPolicy {
  return SESSION_QUERY_POLICY[query.type];
}

/** Owner-bound read request. `observedCursor` is diagnostic, never a CAS gate. */
export const SessionQueryEnvelopeSchema = z
  .object({
    sessionId: NonEmptyIdSchema,
    queryId: NonEmptyIdSchema,
    expectedOwner: RuntimeIdentitySchema,
    observedCursor: AuthorityCursorSchema.optional(),
    query: SessionQuerySchema,
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (
      envelope.observedCursor &&
      (envelope.observedCursor.hostInstanceId !== envelope.expectedOwner.hostInstanceId ||
        envelope.observedCursor.sessionEpoch !== envelope.expectedOwner.sessionEpoch)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedCursor"],
        message: "observed cursor must belong to the expected owner",
      });
    }
  });
export type SessionQueryEnvelope = z.infer<typeof SessionQueryEnvelopeSchema>;
export const QueryEnvelopeSchema = SessionQueryEnvelopeSchema;
export type QueryEnvelope = SessionQueryEnvelope;

/** A query response is correlated with both its request and authoritative owner. */
export const SessionQueryResultSchema = z
  .object({
    queryId: NonEmptyIdSchema,
    owner: RuntimeIdentitySchema,
    queryType: SessionQueryTypeSchema,
    response: PiRpcResponseSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.response.command !== result.queryType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response", "command"],
        message: "query response command must match its query type",
      });
    }
  });
export type SessionQueryResult = z.infer<typeof SessionQueryResultSchema>;
export const QueryResultSchema = SessionQueryResultSchema;
export type QueryResult = SessionQueryResult;

export const SessionIntentKindSchema = z.enum([
  "interrupt",
  "submit",
  "compact",
  "invokeCommand",
  "runBash",
  "navigate",
  "setModel",
  "setThinking",
  "rename",
  "reload",
]);
export type SessionIntentKind = z.infer<typeof SessionIntentKindSchema>;

export const SessionIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interrupt") }).strict(),
  z
    .object({
      kind: z.literal("submit"),
      editorRevision: NonNegativeIntegerSchema,
      text: z.string(),
      images: z.array(RuntimeImageSchema),
      requestedMode: z.enum(["steer", "followUp"]),
      surface: SubmissionSurfaceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("compact"), instructions: z.string().optional() }).strict(),
  z
    .object({
      kind: z.literal("invokeCommand"),
      text: z.string(),
      editorRevision: NonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("runBash"),
      command: z.string(),
      excludeFromContext: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("navigate"),
      targetId: NonEmptyIdSchema,
      summarize: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("setModel"), provider: z.string(), modelId: NonEmptyIdSchema })
    .strict(),
  z.object({ kind: z.literal("setThinking"), level: ThinkingLevelSchema }).strict(),
  z.object({ kind: z.literal("rename"), name: z.string() }).strict(),
  z.object({ kind: z.literal("reload") }).strict(),
]);
export type SessionIntent = z.infer<typeof SessionIntentSchema>;

/** A stable, owner-bound mutation request. `observedCursor` is informational. */
export const IntentEnvelopeSchema = z
  .object({
    sessionId: NonEmptyIdSchema,
    intentId: NonEmptyIdSchema,
    rendererGeneration: NonNegativeIntegerSchema,
    expectedOwner: RuntimeIdentitySchema,
    observedCursor: AuthorityCursorSchema.optional(),
    intent: SessionIntentSchema,
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (
      envelope.observedCursor &&
      (envelope.observedCursor.hostInstanceId !== envelope.expectedOwner.hostInstanceId ||
        envelope.observedCursor.sessionEpoch !== envelope.expectedOwner.sessionEpoch)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedCursor"],
        message: "observed cursor must belong to the expected owner",
      });
    }
  });
export type IntentEnvelope<I extends SessionIntent = SessionIntent> = Omit<
  z.infer<typeof IntentEnvelopeSchema>,
  "intent"
> & { intent: I };

export const IntentReceiptSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("admitted"),
        intentId: NonEmptyIdSchema,
        owner: RuntimeIdentitySchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("duplicate"),
        intentId: NonEmptyIdSchema,
        owner: RuntimeIdentitySchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("not_admitted"),
        intentId: NonEmptyIdSchema,
        reason: z.enum([
          "stale_owner",
          "transport_unavailable",
          "closing",
          "transitioning",
          "invalid",
        ]),
        /** `payload_conflict` distinguishes duplicate-ID rejection from malformed input. */
        invalidReason: z.enum(["malformed", "payload_conflict"]).optional(),
      })
      .strict(),
    z
      .object({
        status: z.literal("delivery_unknown"),
        intentId: NonEmptyIdSchema,
        owner: RuntimeIdentitySchema,
      })
      .strict(),
  ])
  .superRefine((receipt, ctx) => {
    if (
      receipt.status === "not_admitted" &&
      receipt.reason !== "invalid" &&
      receipt.invalidReason
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["invalidReason"],
        message: "invalidReason is only valid for invalid admission",
      });
    }
  });
export type IntentReceipt = z.infer<typeof IntentReceiptSchema>;

export const IntentPayloadConflictSchema = z
  .object({
    intentId: NonEmptyIdSchema,
    owner: RuntimeIdentitySchema,
    expectedPayloadFingerprint: NonEmptyIdSchema,
    receivedPayloadFingerprint: NonEmptyIdSchema,
  })
  .strict()
  .refine(
    (conflict) => conflict.expectedPayloadFingerprint !== conflict.receivedPayloadFingerprint,
    "payload conflict requires distinct payload fingerprints",
  );
export type IntentPayloadConflict = z.infer<typeof IntentPayloadConflictSchema>;

export const IntentOutcomeStateSchema = z.enum([
  "completed",
  "rejected",
  "cancelled",
  "failed",
  "outcome_unknown",
]);
export type IntentOutcomeState = z.infer<typeof IntentOutcomeStateSchema>;

const OutcomeBaseSchema = z.object({
  intentId: NonEmptyIdSchema,
  owner: RuntimeIdentitySchema,
  state: IntentOutcomeStateSchema,
  restorationId: NonEmptyIdSchema.optional(),
  error: z.string().optional(),
});

export const InterruptIntentResultSchema = z
  .object({
    target: z.enum(["navigation", "compaction", "retry", "streaming", "bash", "editor"]),
    interrupted: z.boolean(),
  })
  .strict();
export const SubmitIntentResultSchema = z
  .object({
    disposition: SubmissionDispositionSchema,
    editorRevision: NonNegativeIntegerSchema,
    queued: z.boolean().optional(),
    custodyId: NonEmptyIdSchema.optional(),
    message: z.string().optional(),
  })
  .strict();
export const CompactIntentResultSchema = z
  .object({
    compactionId: NonEmptyIdSchema.optional(),
    attempt: NonNegativeIntegerSchema.optional(),
  })
  .strict();
export const InvokeCommandIntentResultSchema = z
  .object({ commandType: NonEmptyIdSchema.optional(), response: z.unknown().optional() })
  .strict();
export const RunBashIntentResultSchema = z.object({ started: z.boolean() }).strict();
export const NavigateIntentResultSchema = z
  .object({ targetId: NonEmptyIdSchema, summarized: z.boolean().optional() })
  .strict();
export const SetModelIntentResultSchema = z
  .object({ provider: z.string(), modelId: NonEmptyIdSchema })
  .strict();
export const SetThinkingIntentResultSchema = z.object({ level: ThinkingLevelSchema }).strict();
export const RenameIntentResultSchema = z.object({ name: z.string() }).strict();
export const ReloadIntentResultSchema = z
  .object({ successorIdentity: RuntimeIdentitySchema.optional() })
  .strict();

export const IntentOutcomeSchema = z.discriminatedUnion("kind", [
  OutcomeBaseSchema.extend({
    kind: z.literal("interrupt"),
    result: InterruptIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("submit"),
    result: SubmitIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("compact"),
    result: CompactIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("invokeCommand"),
    result: InvokeCommandIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("runBash"),
    result: RunBashIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("navigate"),
    result: NavigateIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("setModel"),
    result: SetModelIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("setThinking"),
    result: SetThinkingIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("rename"),
    result: RenameIntentResultSchema.optional(),
  }).strict(),
  OutcomeBaseSchema.extend({
    kind: z.literal("reload"),
    result: ReloadIntentResultSchema.optional(),
  }).strict(),
]);
export type IntentOutcome = z.infer<typeof IntentOutcomeSchema>;

export const IntentProjectionSchema = z
  .object({
    intentId: NonEmptyIdSchema,
    owner: RuntimeIdentitySchema,
    kind: SessionIntentKindSchema,
    state: z.enum(["recorded", "admitted", "invoking", "in_custody"]),
    recordedAt: z.number(),
  })
  .strict();
export type IntentProjection = z.infer<typeof IntentProjectionSchema>;

export const CustodyProjectionSchema = z
  .object({
    custodyId: NonEmptyIdSchema,
    intentId: NonEmptyIdSchema,
    owner: RuntimeIdentitySchema,
    queueMode: z.enum(["steer", "followUp"]),
    barrier: z.enum(["compaction", "navigation", "admission_fence"]),
    enteredAt: z.number(),
    requiresReview: z.boolean(),
  })
  .strict();
export type CustodyProjection = z.infer<typeof CustodyProjectionSchema>;

export const ObservedOperationRecordSchema = z
  .object({
    operationId: NonEmptyIdSchema,
    owner: RuntimeIdentitySchema,
    kind: z.enum(["agent", "compaction", "retry", "bash", "navigation", "command"]),
    state: z.enum(["started", "active", "retry_wait", "completed", "aborted", "failed", "unknown"]),
    intentId: NonEmptyIdSchema.optional(),
    observedAt: z.number(),
    detail: z.string().optional(),
  })
  .strict();
export type ObservedOperationRecord = z.infer<typeof ObservedOperationRecordSchema>;

export const OperationJournalRecordSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("observed_operation"),
      sequence: NonNegativeIntegerSchema,
      record: ObservedOperationRecordSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("intent_outcome"),
      sequence: NonNegativeIntegerSchema,
      outcome: IntentOutcomeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("anomaly"),
      sequence: NonNegativeIntegerSchema,
      owner: RuntimeIdentitySchema,
      code: z.enum(["getter_event_disagreement", "missing_start_event", "queue_correlation_lost"]),
      observedAt: z.number(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type OperationJournalRecord = z.infer<typeof OperationJournalRecordSchema>;
export const OperationJournalEntrySchema = OperationJournalRecordSchema;
export type OperationJournalEntry = OperationJournalRecord;

export const SemanticSnapshotSchema = z
  .object({
    owner: RuntimeIdentitySchema,
    snapshotSequence: PositiveIntegerSchema,
    capturedAt: z.number(),
    sdk: z
      .object({
        isStreaming: z.boolean(),
        isIdle: z.boolean(),
        isCompacting: z.boolean(),
        isRetrying: z.boolean(),
        retryAttempt: NonNegativeIntegerSchema,
        isBashRunning: z.boolean(),
      })
      .strict(),
    activity: SemanticActivitySchema,
    queues: AuthoritativeQueuesSchema,
    custody: z.array(CustodyProjectionSchema),
    editor: RuntimeEditorStateSchema,
    activeIntents: z.array(IntentProjectionSchema),
    recentIntentOutcomes: z.array(IntentOutcomeSchema),
    recentObservedOperations: z.array(ObservedOperationRecordSchema),
    operationJournalLowWatermark: NonNegativeIntegerSchema,
    operationJournalHighWatermark: NonNegativeIntegerSchema,
    operationJournalTruncated: z.boolean(),
    model: RuntimeModelSchema.nullable(),
    thinkingLevel: ThinkingLevelSchema,
    catalog: RuntimeCatalogSchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.sdk.isStreaming && snapshot.sdk.isIdle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sdk", "isIdle"],
        message: "a streaming SDK snapshot cannot also be idle",
      });
    }
    if (snapshot.operationJournalLowWatermark > snapshot.operationJournalHighWatermark) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationJournalLowWatermark"],
        message: "journal low watermark cannot exceed high watermark",
      });
    }
    const seenIntentIds = new Set<string>();
    for (const intent of snapshot.activeIntents) {
      if (seenIntentIds.has(intent.intentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeIntents"],
          message: "active intent IDs must be unique",
        });
        break;
      }
      seenIntentIds.add(intent.intentId);
    }
    for (const [field, entries] of [
      ["custody", snapshot.custody],
      ["activeIntents", snapshot.activeIntents],
      ["recentIntentOutcomes", snapshot.recentIntentOutcomes],
      ["recentObservedOperations", snapshot.recentObservedOperations],
    ] as const) {
      for (const [index, entry] of entries.entries()) {
        if (
          entry.owner.hostInstanceId !== snapshot.owner.hostInstanceId ||
          entry.owner.sessionEpoch !== snapshot.owner.sessionEpoch
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index, "owner"],
            message: "semantic projection belongs to a different authority owner",
          });
        }
      }
    }
  });
export type SemanticSnapshot = z.infer<typeof SemanticSnapshotSchema>;

export const AuthorityRecordSchema = z.discriminatedUnion("type", [
  // Pi events are presentation records carried atomically with the resulting
  // semantic snapshot; they never become an independent liveness authority.
  z
    .object({ type: z.literal("event"), event: PiEventSchema })
    .strict(),
  z.object({ type: z.literal("intent_outcome"), outcome: IntentOutcomeSchema }).strict(),
  z
    .object({ type: z.literal("observed_operation"), record: ObservedOperationRecordSchema })
    .strict(),
  z
    .object({
      type: z.literal("custody"),
      action: z.enum(["entered", "drained", "restored"]),
      custody: CustodyProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("anomaly"),
      owner: RuntimeIdentitySchema,
      code: z.enum(["getter_event_disagreement", "missing_start_event", "queue_correlation_lost"]),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type AuthorityRecord = z.infer<typeof AuthorityRecordSchema>;

export const AuthorityFrameSchema = z
  .object({
    owner: RuntimeIdentitySchema,
    transportSequence: PositiveIntegerSchema,
    frameId: NonEmptyIdSchema,
    records: z.array(AuthorityRecordSchema),
    terminalSnapshot: SemanticSnapshotSchema,
  })
  .strict()
  .superRefine((frame, ctx) => {
    if (
      frame.owner.hostInstanceId !== frame.terminalSnapshot.owner.hostInstanceId ||
      frame.owner.sessionEpoch !== frame.terminalSnapshot.owner.sessionEpoch
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terminalSnapshot", "owner"],
        message: "frame and terminal snapshot must have the same owner",
      });
    }
    for (const [index, record] of frame.records.entries()) {
      const owner =
        record.type === "event"
          ? frame.owner
          : record.type === "intent_outcome"
            ? record.outcome.owner
            : record.type === "observed_operation"
              ? record.record.owner
              : record.type === "custody"
                ? record.custody.owner
                : record.owner;
      if (
        owner.hostInstanceId !== frame.owner.hostInstanceId ||
        owner.sessionEpoch !== frame.owner.sessionEpoch
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["records", index],
          message: "authority record belongs to a different owner",
        });
      }
    }
  });
export type AuthorityFrame = z.infer<typeof AuthorityFrameSchema>;

export const PlaneSchema = z.enum(["semantic", "transcript", "extensionUi", "panel"]);
export type Plane = z.infer<typeof PlaneSchema>;

export const PlaneSyncSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("following"), cursor: AuthorityCursorSchema }).strict(),
  z
    .object({
      state: z.literal("synchronizing"),
      lastCursor: AuthorityCursorSchema.optional(),
      reason: NonEmptyIdSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      lastCursor: AuthorityCursorSchema.optional(),
      reason: NonEmptyIdSchema,
    })
    .strict(),
]);
export type PlaneSync = z.infer<typeof PlaneSyncSchema>;

export const TranscriptPresentationBaselineSchema = z
  .object({
    sync: PlaneSyncSchema,
    persistedHistoryCursor: z.string().nullable(),
    liveTailCursor: z.string().nullable(),
    overlapBoundary: z.string().nullable(),
    currentStreamingMessage: z.unknown().optional(),
  })
  .strict();
export type TranscriptPresentationBaseline = z.infer<typeof TranscriptPresentationBaselineSchema>;

export const ExtensionUiPresentationBaselineSchema = z
  .object({
    sync: PlaneSyncSchema,
    notifications: z.array(
      z.object({ id: NonEmptyIdSchema, message: z.string(), type: z.string().optional() }).strict(),
    ),
    statuses: z.record(z.string()),
    widgets: z.record(z.array(z.string())),
    dialogs: z.array(
      z
        .object({
          request: ExtensionUiRequestSchema,
          rendererGeneration: NonNegativeIntegerSchema,
          inputPending: z.boolean(),
          acknowledged: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type ExtensionUiPresentationBaseline = z.infer<typeof ExtensionUiPresentationBaselineSchema>;

export const PanelKeyframeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("keyframe"),
      ansi: z.string(),
      renderRevision: NonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("repaint_required"), renderRevision: NonNegativeIntegerSchema })
    .strict(),
]);
export type PanelKeyframe = z.infer<typeof PanelKeyframeSchema>;

export const PanelPresentationBaselineSchema = z
  .object({
    panelKey: NonEmptyIdSchema,
    panelId: NonNegativeIntegerSchema,
    owner: RuntimeIdentitySchema,
    sync: PlaneSyncSchema,
    overlay: z.boolean(),
    unified: z.boolean(),
    inputAcknowledgedThrough: NonNegativeIntegerSchema,
    keyframe: PanelKeyframeSchema,
  })
  .strict()
  .superRefine((panel, ctx) => {
    if (panel.keyframe.kind === "keyframe" && panel.sync.state !== "following") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sync"],
        message: "a keyframed panel must be following before input is enabled",
      });
    }
    if (panel.keyframe.kind === "repaint_required" && panel.sync.state === "following") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sync"],
        message: "a repaint-required panel cannot claim to be following",
      });
    }
  });
export type PanelPresentationBaseline = z.infer<typeof PanelPresentationBaselineSchema>;

export const SemanticPresentationBaselineSchema = z
  .object({ sync: PlaneSyncSchema, snapshot: SemanticSnapshotSchema })
  .strict();
export type SemanticPresentationBaseline = z.infer<typeof SemanticPresentationBaselineSchema>;

/** A named baseline lets attach/replay code handle all presentation planes uniformly. */
export const PresentationBaselineSchema = z.discriminatedUnion("plane", [
  z.object({ plane: z.literal("semantic"), baseline: SemanticPresentationBaselineSchema }).strict(),
  z
    .object({ plane: z.literal("transcript"), baseline: TranscriptPresentationBaselineSchema })
    .strict(),
  z
    .object({ plane: z.literal("extensionUi"), baseline: ExtensionUiPresentationBaselineSchema })
    .strict(),
  z.object({ plane: z.literal("panel"), baseline: PanelPresentationBaselineSchema }).strict(),
]);
export type PresentationBaseline = z.infer<typeof PresentationBaselineSchema>;

export const AuthorityAttachRequestSchema = z
  .object({ sessionId: NonEmptyIdSchema, rendererGeneration: NonNegativeIntegerSchema })
  .strict();
export type AuthorityAttachRequest = z.infer<typeof AuthorityAttachRequestSchema>;

export const AuthorityAttachBaselineSchema = z
  .object({
    sessionId: NonEmptyIdSchema,
    rendererGeneration: NonNegativeIntegerSchema,
    owner: RuntimeIdentitySchema,
    semantic: SemanticPresentationBaselineSchema,
    operationJournal: z.array(OperationJournalRecordSchema),
    transcript: TranscriptPresentationBaselineSchema,
    extensionUi: ExtensionUiPresentationBaselineSchema,
    panels: z.array(PanelPresentationBaselineSchema),
    publicationHighWatermark: NonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((baseline, ctx) => {
    const semanticOwner = baseline.semantic.snapshot.owner;
    if (
      semanticOwner.hostInstanceId !== baseline.owner.hostInstanceId ||
      semanticOwner.sessionEpoch !== baseline.owner.sessionEpoch
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semantic", "snapshot", "owner"],
        message: "attach semantic snapshot must belong to the baseline owner",
      });
    }
    if (baseline.semantic.sync.state === "following") {
      const cursor = baseline.semantic.sync.cursor;
      if (
        cursor.hostInstanceId !== baseline.owner.hostInstanceId ||
        cursor.sessionEpoch !== baseline.owner.sessionEpoch ||
        cursor.snapshotSequence !== baseline.semantic.snapshot.snapshotSequence
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["semantic", "sync", "cursor"],
          message: "following semantic baseline cursor must identify its snapshot",
        });
      }
    }
    for (const [path, sync] of [
      ["transcript", baseline.transcript.sync],
      ["extensionUi", baseline.extensionUi.sync],
    ] as const) {
      if (
        sync.state === "following" &&
        (sync.cursor.hostInstanceId !== baseline.owner.hostInstanceId ||
          sync.cursor.sessionEpoch !== baseline.owner.sessionEpoch)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path, "sync", "cursor"],
          message: "following presentation baseline belongs to a different owner",
        });
      }
    }
    for (const [index, panel] of baseline.panels.entries()) {
      if (
        panel.owner.hostInstanceId !== baseline.owner.hostInstanceId ||
        panel.owner.sessionEpoch !== baseline.owner.sessionEpoch
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["panels", index, "owner"],
          message: "panel baseline belongs to a different owner",
        });
      }
      if (
        panel.sync.state === "following" &&
        (panel.sync.cursor.hostInstanceId !== panel.owner.hostInstanceId ||
          panel.sync.cursor.sessionEpoch !== panel.owner.sessionEpoch)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["panels", index, "sync", "cursor"],
          message: "following panel baseline cursor belongs to a different owner",
        });
      }
    }
    let previousJournalSequence = -1;
    for (const [index, journal] of baseline.operationJournal.entries()) {
      if (
        journal.sequence <= previousJournalSequence ||
        journal.sequence < baseline.semantic.snapshot.operationJournalLowWatermark ||
        journal.sequence > baseline.semantic.snapshot.operationJournalHighWatermark
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["operationJournal", index, "sequence"],
          message: "journal records must be ordered and within the snapshot watermarks",
        });
      }
      previousJournalSequence = journal.sequence;
      const journalOwner =
        journal.type === "intent_outcome"
          ? journal.outcome.owner
          : journal.type === "observed_operation"
            ? journal.record.owner
            : journal.owner;
      if (
        journalOwner.hostInstanceId !== baseline.owner.hostInstanceId ||
        journalOwner.sessionEpoch !== baseline.owner.sessionEpoch
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["operationJournal", index],
          message: "journal record belongs to a different owner",
        });
      }
    }
  });
export type AuthorityAttachBaseline = z.infer<typeof AuthorityAttachBaselineSchema>;
export const AttachBaselineSchema = AuthorityAttachBaselineSchema;
export type AttachBaseline = AuthorityAttachBaseline;

export const TranscriptPublicationPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("delta"),
      cursor: AuthorityCursorSchema,
      liveTailCursor: z.string(),
      entries: z.array(z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reset_required"),
      cursor: AuthorityCursorSchema,
      reason: NonEmptyIdSchema,
    })
    .strict(),
]);
export type TranscriptPublicationPayload = z.infer<typeof TranscriptPublicationPayloadSchema>;

export const ExtensionUiPublicationPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("request"),
      cursor: AuthorityCursorSchema,
      request: ExtensionUiRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("baseline_required"),
      cursor: AuthorityCursorSchema,
      reason: NonEmptyIdSchema,
    })
    .strict(),
]);
export type ExtensionUiPublicationPayload = z.infer<typeof ExtensionUiPublicationPayloadSchema>;

export const PanelPublicationPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ansi_delta"),
      cursor: AuthorityCursorSchema,
      panelKey: NonEmptyIdSchema,
      data: z.string(),
      renderRevision: NonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("keyframe"),
      cursor: AuthorityCursorSchema,
      panel: PanelPresentationBaselineSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("repaint_required"),
      cursor: AuthorityCursorSchema,
      panelKey: NonEmptyIdSchema,
      reason: NonEmptyIdSchema,
    })
    .strict(),
]);
export type PanelPublicationPayload = z.infer<typeof PanelPublicationPayloadSchema>;

export const RendererPublicationSchema = z
  .discriminatedUnion("plane", [
    z
      .object({
        sessionId: NonEmptyIdSchema,
        rendererGeneration: NonNegativeIntegerSchema,
        publicationSequence: PositiveIntegerSchema,
        plane: z.literal("semantic"),
        owner: RuntimeIdentitySchema,
        payload: AuthorityFrameSchema,
      })
      .strict(),
    z
      .object({
        sessionId: NonEmptyIdSchema,
        rendererGeneration: NonNegativeIntegerSchema,
        publicationSequence: PositiveIntegerSchema,
        plane: z.literal("transcript"),
        owner: RuntimeIdentitySchema,
        payload: TranscriptPublicationPayloadSchema,
      })
      .strict(),
    z
      .object({
        sessionId: NonEmptyIdSchema,
        rendererGeneration: NonNegativeIntegerSchema,
        publicationSequence: PositiveIntegerSchema,
        plane: z.literal("extensionUi"),
        owner: RuntimeIdentitySchema,
        payload: ExtensionUiPublicationPayloadSchema,
      })
      .strict(),
    z
      .object({
        sessionId: NonEmptyIdSchema,
        rendererGeneration: NonNegativeIntegerSchema,
        publicationSequence: PositiveIntegerSchema,
        plane: z.literal("panel"),
        owner: RuntimeIdentitySchema,
        payload: PanelPublicationPayloadSchema,
      })
      .strict(),
  ])
  .superRefine((publication, ctx) => {
    const payloadOwner =
      publication.plane === "semantic"
        ? publication.payload.owner
        : publication.payload.cursor?.hostInstanceId
          ? {
              hostInstanceId: publication.payload.cursor.hostInstanceId,
              sessionEpoch: publication.payload.cursor.sessionEpoch,
            }
          : undefined;
    if (
      payloadOwner &&
      (payloadOwner.hostInstanceId !== publication.owner.hostInstanceId ||
        payloadOwner.sessionEpoch !== publication.owner.sessionEpoch)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "publication payload belongs to a different owner",
      });
    }
  });
export type RendererPublication = z.infer<typeof RendererPublicationSchema>;

export const AuthorityAttachResponseSchema = z
  .object({ baseline: AuthorityAttachBaselineSchema, replay: z.array(RendererPublicationSchema) })
  .strict()
  .superRefine((response, ctx) => {
    for (const [index, publication] of response.replay.entries()) {
      if (
        publication.sessionId !== response.baseline.sessionId ||
        publication.rendererGeneration !== response.baseline.rendererGeneration ||
        publication.publicationSequence <= response.baseline.publicationHighWatermark
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["replay", index],
          message: "attach replay must be newer than its matching baseline high-water mark",
        });
      }
    }
  });
export type AuthorityAttachResponse = z.infer<typeof AuthorityAttachResponseSchema>;
