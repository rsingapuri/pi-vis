import { z } from "zod";
import { ThinkingLevelSchema } from "./thinking.js";

// Minimal passthrough schema for wire AgentMessage objects embedded in events.
// Content arrays contain text/thinking/toolCall blocks — modeled as passthrough
// since the transcript reducer drives UI state from streaming events, not these snapshots.
// `role` is a free string: pi emits "user" for delivered prompts, "assistant"
// for model output, "toolResult" for tool outcomes, and "custom" (plus
// extension-defined values) for extension-originated messages. The transcript
// reducer branches on the role string at runtime rather than the type system.
const WireAgentMessageSchema = z
  .object({
    role: z.string(),
  })
  .passthrough();

// AssistantMessageEvent sub-events (nested inside message_update.assistantMessageEvent).
// Real wire format: text_start/thinking_start carry contentIndex + partial snapshot,
// NOT the text/thinking content itself — those come via *_delta events.
const TextStartEventSchema = z
  .object({
    type: z.literal("text_start"),
    contentIndex: z.number().optional(),
  })
  .passthrough();

const TextDeltaEventSchema = z
  .object({
    type: z.literal("text_delta"),
    delta: z.string(),
    contentIndex: z.number().optional(),
  })
  .passthrough();

const TextEndEventSchema = z
  .object({
    type: z.literal("text_end"),
    contentIndex: z.number().optional(),
    content: z.string().optional(),
  })
  .passthrough();

const ThinkingStartEventSchema = z
  .object({
    type: z.literal("thinking_start"),
    contentIndex: z.number().optional(),
  })
  .passthrough();

const ThinkingDeltaEventSchema = z
  .object({
    type: z.literal("thinking_delta"),
    delta: z.string(),
    contentIndex: z.number().optional(),
  })
  .passthrough();

const ThinkingEndEventSchema = z
  .object({
    type: z.literal("thinking_end"),
    contentIndex: z.number().optional(),
    content: z.string().optional(),
  })
  .passthrough();

export const AssistantMessageEventSchema = z.discriminatedUnion("type", [
  TextStartEventSchema,
  TextDeltaEventSchema,
  TextEndEventSchema,
  ThinkingStartEventSchema,
  ThinkingDeltaEventSchema,
  ThinkingEndEventSchema,
]);

export type AssistantMessageEvent = z.infer<typeof AssistantMessageEventSchema>;

// Top-level session events forwarded by the SDK host

export const AgentStartEventSchema = z.object({
  type: z.literal("agent_start"),
});

export const AgentEndEventSchema = z.object({
  type: z.literal("agent_end"),
  messages: z.array(WireAgentMessageSchema).optional(),
  willRetry: z.boolean().optional(),
});

// Pi >= 0.80.4 emits this after the full session-level run has settled and no
// automatic retry, compaction, or queued continuation remains. Transcript
// consumers retain agent_end for historical event compatibility.
export const AgentSettledEventSchema = z.object({
  type: z.literal("agent_settled"),
});

export const TurnStartEventSchema = z.object({
  type: z.literal("turn_start"),
});

export const TurnEndEventSchema = z.object({
  type: z.literal("turn_end"),
  message: WireAgentMessageSchema.optional(),
  toolResults: z.array(z.unknown()).optional(),
});

// message_start/end carry the full AgentMessage snapshot.
// message_update carries the streaming sub-event in assistantMessageEvent.
export const MessageStartEventSchema = z.object({
  type: z.literal("message_start"),
  message: WireAgentMessageSchema,
  /** Host-owned identity of the GUI queue slot delivered by this event. */
  queueIntentId: z.string().optional(),
});

export const MessageUpdateEventSchema = z.object({
  type: z.literal("message_update"),
  message: WireAgentMessageSchema,
  assistantMessageEvent: AssistantMessageEventSchema.optional(),
});

export const MessageEndEventSchema = z.object({
  type: z.literal("message_end"),
  message: WireAgentMessageSchema,
});

// Tool execution events — args/result are the real field names (not input/output)
export const ToolExecutionStartEventSchema = z.object({
  type: z.literal("tool_execution_start"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
});

export const ToolExecutionUpdateEventSchema = z.object({
  type: z.literal("tool_execution_update"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  partialResult: z.unknown(),
});

export const ToolExecutionEndEventSchema = z.object({
  type: z.literal("tool_execution_end"),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
  isError: z.boolean(),
});

// queue_update carries pending steering/follow-up message arrays, not position counters
export const QueueUpdateEventSchema = z.object({
  type: z.literal("queue_update"),
  steering: z.array(z.string()),
  followUp: z.array(z.string()),
});

export const CompactionStartEventSchema = z.object({
  type: z.literal("compaction_start"),
  reason: z.enum(["manual", "threshold", "overflow"]).optional(),
});

export const CompactionEndEventSchema = z.object({
  type: z.literal("compaction_end"),
  reason: z.enum(["manual", "threshold", "overflow"]).optional(),
  result: z
    .object({
      summary: z.string(),
      firstKeptEntryId: z.string().optional(),
      tokensBefore: z.number().optional(),
    })
    .passthrough()
    .optional(),
  aborted: z.boolean().optional(),
  willRetry: z.boolean().optional(),
  errorMessage: z.string().optional(),
});

export const AutoRetryStartEventSchema = z.object({
  type: z.literal("auto_retry_start"),
  attempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number().optional(),
  errorMessage: z.string().optional(),
});

export const AutoRetryEndEventSchema = z.object({
  type: z.literal("auto_retry_end"),
  success: z.boolean(),
  attempt: z.number().optional(),
  finalError: z.string().optional(),
});

export const ThinkingLevelChangedEventSchema = z.object({
  type: z.literal("thinking_level_changed"),
  level: ThinkingLevelSchema,
});

// Pi >= 0.80.4 emits this when an extension persists an appendEntry() value.
// The entry remains out of model context; the SDK host can render it through
// the extension's matching registerEntryRenderer() callback on demand.
export const EntryAppendedEventSchema = z.object({
  type: z.literal("entry_appended"),
  entry: z
    .object({
      id: z.string(),
      type: z.string(),
      customType: z.string().optional(),
    })
    .passthrough(),
});

// SDK-host rendering parity for Pi 0.80.4's opt-in showCacheMissNotices.
export const CacheMissNoticeEventSchema = z.object({
  type: z.literal("cache_miss_notice"),
  noticeId: z.string(),
  missedTokens: z.number(),
  missedCost: z.number(),
  idleMs: z.number(),
  modelChanged: z.boolean(),
  // Historical replay anchors the synthetic notice after its persisted
  // assistant entry. Live notices omit this because message_end precedes
  // SessionManager persistence.
  afterEntryId: z.string().optional(),
});

// extension_error uses extensionPath + error, not extensionName + message
export const ExtensionErrorEventSchema = z.object({
  type: z.literal("extension_error"),
  extensionPath: z.string().optional(),
  event: z.unknown().optional(),
  error: z.unknown().optional(),
});

// Emitted whenever session metadata changes. set_session_name uses a non-empty
// string; a new-session reset emits the same event with no name to clear it.
export const SessionInfoChangedEventSchema = z.object({
  type: z.literal("session_info_changed"),
  // New-session resets clear the name and emit `undefined`.
  name: z.string().optional(),
});

const KnownPiEventSchema = z.discriminatedUnion("type", [
  AgentStartEventSchema,
  AgentEndEventSchema,
  AgentSettledEventSchema,
  TurnStartEventSchema,
  TurnEndEventSchema,
  MessageStartEventSchema,
  MessageUpdateEventSchema,
  MessageEndEventSchema,
  ToolExecutionStartEventSchema,
  ToolExecutionUpdateEventSchema,
  ToolExecutionEndEventSchema,
  QueueUpdateEventSchema,
  CompactionStartEventSchema,
  CompactionEndEventSchema,
  AutoRetryStartEventSchema,
  AutoRetryEndEventSchema,
  ThinkingLevelChangedEventSchema,
  EntryAppendedEventSchema,
  CacheMissNoticeEventSchema,
  ExtensionErrorEventSchema,
  SessionInfoChangedEventSchema,
]);

const UnknownPiEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough()
  .transform((val) => ({ ...val, __unknown: true as const }));

export const PiEventSchema = KnownPiEventSchema.or(UnknownPiEventSchema);

export type KnownPiEvent = z.infer<typeof KnownPiEventSchema>;
export type UnknownPiEvent = z.infer<typeof UnknownPiEventSchema>;
export type PiEvent = z.infer<typeof PiEventSchema>;

export type AgentStartEvent = z.infer<typeof AgentStartEventSchema>;
export type AgentEndEvent = z.infer<typeof AgentEndEventSchema>;
export type AgentSettledEvent = z.infer<typeof AgentSettledEventSchema>;
export type TurnStartEvent = z.infer<typeof TurnStartEventSchema>;
export type TurnEndEvent = z.infer<typeof TurnEndEventSchema>;
export type MessageStartEvent = z.infer<typeof MessageStartEventSchema>;
export type MessageUpdateEvent = z.infer<typeof MessageUpdateEventSchema>;
export type MessageEndEvent = z.infer<typeof MessageEndEventSchema>;
export type ToolExecutionStartEvent = z.infer<typeof ToolExecutionStartEventSchema>;
export type ToolExecutionUpdateEvent = z.infer<typeof ToolExecutionUpdateEventSchema>;
export type ToolExecutionEndEvent = z.infer<typeof ToolExecutionEndEventSchema>;
export type CompactionEndEvent = z.infer<typeof CompactionEndEventSchema>;
export type ThinkingLevelChangedEvent = z.infer<typeof ThinkingLevelChangedEventSchema>;
export type EntryAppendedEvent = z.infer<typeof EntryAppendedEventSchema>;
export type CacheMissNoticeEvent = z.infer<typeof CacheMissNoticeEventSchema>;
export type SessionInfoChangedEvent = z.infer<typeof SessionInfoChangedEventSchema>;
