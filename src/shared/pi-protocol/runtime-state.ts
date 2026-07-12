import { z } from "zod";
import { PI_COMMAND_POLICY, type PiRpcCommand, PiRpcCommandSchema } from "./commands.js";
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

export const RendererCommandRequestSchema = z
  .object({
    requestId: z.string().min(1),
    command: PiRpcCommandSchema,
    expectedHostInstanceId: z.string().min(1),
    expectedSessionEpoch: z.number().int().nonnegative(),
    intentId: z.string().min(1).optional(),
    uiSurface: SubmissionSurfaceSchema.optional(),
    sourceText: z.string().optional(),
    editorRevision: z.number().int().nonnegative().optional(),
  })
  .superRefine((request, ctx) => {
    const policy = PI_COMMAND_POLICY[request.command.type];
    if (
      !("submissionOnly" in policy && policy.submissionOnly) &&
      (policy.class === "effectful" || policy.class === "replacement") &&
      !request.intentId
    ) {
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

const commandTypes = Object.keys(PI_COMMAND_POLICY) as [
  PiRpcCommand["type"],
  ...PiRpcCommand["type"][],
];
export const PiCommandTypeSchema = z.enum(commandTypes);

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

const RuntimeModelSchema = z
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
