import { z } from "zod";

export const SessionHeaderSchema = z
  .object({
    type: z.literal("session"),
    version: z.number(),
    id: z.string(),
    timestamp: z.string().or(z.number()),
    cwd: z.string(),
    model: z.string().optional(),
  })
  .passthrough();

export type SessionHeader = z.infer<typeof SessionHeaderSchema>;

const BaseEntrySchema = z.object({
  id: z.string(), // 8-hex
  parentId: z.string().optional(),
  timestamp: z.string().or(z.number()).optional(),
});

// Real pi v3 nests message data under a `message` key. The body carries
// role/content + toolResult-specific fields; entry-level fields (id, parentId,
// timestamp) live on the envelope.
const MessageBodySchema = z
  .object({
    role: z.enum(["user", "assistant", "toolResult"]),
    content: z.unknown(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

export const MessageEntrySchema = BaseEntrySchema.extend({
  type: z.literal("message"),
  message: MessageBodySchema,
});

export const ModelChangeEntrySchema = BaseEntrySchema.extend({
  type: z.literal("model_change"),
  provider: z.string().optional(),
  modelId: z.string().optional(),
});

export const ThinkingLevelChangeEntrySchema = BaseEntrySchema.extend({
  type: z.literal("thinking_level_change"),
  thinkingLevel: z.string().optional(),
});

export const CompactionEntrySchema = BaseEntrySchema.extend({
  type: z.literal("compaction"),
  summary: z.string().optional(),
  reason: z.enum(["manual", "threshold", "overflow"]).optional(),
  tokensBefore: z.number().optional(),
  firstKeptEntryId: z.string().optional(),
});

export const BranchSummaryEntrySchema = BaseEntrySchema.extend({
  type: z.literal("branch_summary"),
  summary: z.string().optional(),
});

export const CustomEntrySchema = BaseEntrySchema.extend({
  type: z.literal("custom"),
}).passthrough();

export const CustomMessageEntrySchema = BaseEntrySchema.extend({
  type: z.literal("custom_message"),
  content: z.string().optional(),
  display: z.boolean().optional(),
}).passthrough();

export const LabelEntrySchema = BaseEntrySchema.extend({
  type: z.literal("label"),
  label: z.string().optional(),
});

export const SessionInfoEntrySchema = BaseEntrySchema.extend({
  type: z.literal("session_info"),
  name: z.string().optional(),
}).passthrough();

export const KnownSessionEntrySchema = z.discriminatedUnion("type", [
  MessageEntrySchema,
  ModelChangeEntrySchema,
  ThinkingLevelChangeEntrySchema,
  CompactionEntrySchema,
  BranchSummaryEntrySchema,
  CustomEntrySchema,
  CustomMessageEntrySchema,
  LabelEntrySchema,
  SessionInfoEntrySchema,
]);

const UnknownEntrySchema = z
  .object({ type: z.string() })
  .passthrough()
  .transform((v) => ({ ...v, __unknown: true as const }));

export const SessionEntrySchema = KnownSessionEntrySchema.or(UnknownEntrySchema);

export type SessionEntry = z.infer<typeof SessionEntrySchema>;
export type KnownSessionEntry = z.infer<typeof KnownSessionEntrySchema>;
export type MessageEntry = z.infer<typeof MessageEntrySchema>;
export type CompactionEntry = z.infer<typeof CompactionEntrySchema>;
export type CustomMessageEntry = z.infer<typeof CustomMessageEntrySchema>;
export type SessionInfoEntry = z.infer<typeof SessionInfoEntrySchema>;
