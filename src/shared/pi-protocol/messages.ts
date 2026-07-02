import { z } from "zod";

export const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.string(),
  images: z.array(z.string()).optional(),
});

export const AssistantTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const AssistantThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

export const ToolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.unknown()).optional(),
  output: z.unknown().optional(),
  diff: z.string().optional(),
  patch: z.string().optional(),
  isError: z.boolean().optional(),
  isStreaming: z.boolean().optional(),
});

export const BashBlockSchema = z.object({
  type: z.literal("bash"),
  command: z.string(),
  output: z.string().optional(),
  exitCode: z.number().optional(),
});

export const CompactionMarkerSchema = z.object({
  type: z.literal("compaction"),
  summary: z.string().optional(),
  reason: z.enum(["manual", "threshold", "overflow"]).optional(),
  tokensBefore: z.number().optional(),
  firstKeptEntryId: z.string().optional(),
  aborted: z.boolean().optional(),
  willRetry: z.boolean().optional(),
  errorMessage: z.string().optional(),
});

export const CustomMessageBlockSchema = z.object({
  type: z.literal("custom_message"),
  content: z.string(),
  display: z.boolean().optional(),
});

export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AssistantTextBlock = z.infer<typeof AssistantTextBlockSchema>;
export type AssistantThinkingBlock = z.infer<typeof AssistantThinkingBlockSchema>;
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;
export type BashBlock = z.infer<typeof BashBlockSchema>;
export type CompactionMarker = z.infer<typeof CompactionMarkerSchema>;
export type CustomMessageBlock = z.infer<typeof CustomMessageBlockSchema>;
