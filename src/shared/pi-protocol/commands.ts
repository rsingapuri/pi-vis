import { z } from "zod";
import { ThinkingLevelSchema } from "./thinking.js";

const BaseCommand = z.object({
  id: z.string().optional(),
});

// ImageContent format per pi RPC protocol:
// {"type": "image", "data": "<raw base64>", "mimeType": "image/png"}
export const ImageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

export type ImageContent = z.infer<typeof ImageContentSchema>;

export const PromptCommandSchema = BaseCommand.extend({
  type: z.literal("prompt"),
  message: z.string(),
  images: z.array(ImageContentSchema).optional(),
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});

export const SteerCommandSchema = BaseCommand.extend({
  type: z.literal("steer"),
  message: z.string(),
  images: z.array(ImageContentSchema).optional(),
});

export const FollowUpCommandSchema = BaseCommand.extend({
  type: z.literal("follow_up"),
  message: z.string(),
  images: z.array(ImageContentSchema).optional(),
});

export const AbortCommandSchema = BaseCommand.extend({
  type: z.literal("abort"),
});

export const BashCommandSchema = BaseCommand.extend({
  type: z.literal("bash"),
  command: z.string(),
  excludeFromContext: z.boolean().optional(),
});

export const AbortBashCommandSchema = BaseCommand.extend({
  type: z.literal("abort_bash"),
});

export const SetModelCommandSchema = BaseCommand.extend({
  type: z.literal("set_model"),
  // Some pi model-registry entries are providerless. When omitted/empty, the
  // SDK host resolves by id only (requiring an unambiguous model id).
  provider: z.string().optional(),
  modelId: z.string(),
});

export const CycleModelCommandSchema = BaseCommand.extend({
  type: z.literal("cycle_model"),
});

export const GetAvailableModelsCommandSchema = BaseCommand.extend({
  type: z.literal("get_available_models"),
});

export const GetLoginProvidersCommandSchema = BaseCommand.extend({
  type: z.literal("get_login_providers"),
});

export const GetScopedModelsCommandSchema = BaseCommand.extend({
  type: z.literal("get_scoped_models"),
});

export const SetScopedModelsCommandSchema = BaseCommand.extend({
  type: z.literal("set_scoped_models"),
  enabledIds: z.array(z.string()).nullable(),
});

export const SaveScopedModelsCommandSchema = BaseCommand.extend({
  type: z.literal("save_scoped_models"),
  enabledIds: z.array(z.string()).nullable(),
});

export const GetLogoutProvidersCommandSchema = BaseCommand.extend({
  type: z.literal("get_logout_providers"),
});

export const LogoutProviderCommandSchema = BaseCommand.extend({
  type: z.literal("logout_provider"),
  provider: z.string(),
});

export const SetThinkingLevelCommandSchema = BaseCommand.extend({
  type: z.literal("set_thinking_level"),
  level: ThinkingLevelSchema,
});

export const CycleThinkingLevelCommandSchema = BaseCommand.extend({
  type: z.literal("cycle_thinking_level"),
});

export const NewSessionCommandSchema = BaseCommand.extend({
  type: z.literal("new_session"),
  parentSession: z.string().optional(),
});

export const SwitchSessionCommandSchema = BaseCommand.extend({
  type: z.literal("switch_session"),
  sessionPath: z.string(),
});

export const ForkCommandSchema = BaseCommand.extend({
  type: z.literal("fork"),
  entryId: z.string(),
});

export const CloneCommandSchema = BaseCommand.extend({
  type: z.literal("clone"),
});

export const SetSessionNameCommandSchema = BaseCommand.extend({
  type: z.literal("set_session_name"),
  name: z.string(),
});

export const GetCommandsCommandSchema = BaseCommand.extend({
  type: z.literal("get_commands"),
});

export const GetStateCommandSchema = BaseCommand.extend({
  type: z.literal("get_state"),
});

export const GetSessionStatsCommandSchema = BaseCommand.extend({
  type: z.literal("get_session_stats"),
});

export const GetMessagesCommandSchema = BaseCommand.extend({
  type: z.literal("get_messages"),
});

export const GetForkMessagesCommandSchema = BaseCommand.extend({
  type: z.literal("get_fork_messages"),
});

export const GetLastAssistantTextCommandSchema = BaseCommand.extend({
  type: z.literal("get_last_assistant_text"),
});

export const CompactCommandSchema = BaseCommand.extend({
  type: z.literal("compact"),
  customInstructions: z.string().optional(),
});

export const SetAutoCompactionCommandSchema = BaseCommand.extend({
  type: z.literal("set_auto_compaction"),
  enabled: z.boolean(),
});

export const SetAutoRetryCommandSchema = BaseCommand.extend({
  type: z.literal("set_auto_retry"),
  enabled: z.boolean(),
});

export const AbortRetryCommandSchema = BaseCommand.extend({
  type: z.literal("abort_retry"),
});

export const SetSteeringModeCommandSchema = BaseCommand.extend({
  type: z.literal("set_steering_mode"),
  mode: z.enum(["all", "one-at-a-time"]),
});

export const SetFollowUpModeCommandSchema = BaseCommand.extend({
  type: z.literal("set_follow_up_mode"),
  mode: z.enum(["all", "one-at-a-time"]),
});

export const ExportHtmlCommandSchema = BaseCommand.extend({
  type: z.literal("export_html"),
  outputPath: z.string().optional(),
});

// ── Trust (pi-vis host-only; mirrors pi's TUI showTrustSelector) ─────────
// get_trust_state returns the cwd, whether the cwd has trust-requiring
// project resources, and pi's full project-trust choice set (each with a
// label, the `trusted` answer, and the `updates` to persist). Used by the
// /trust picker. NOT part of pi's RPC protocol — it is implemented only by
// the direct SDK host.
export const ProjectTrustUpdateSchema = z.object({
  path: z.string(),
  // null = clear the entry so a broader (parent) grant takes over —
  // matches pi's ProjectTrustStore semantics.
  decision: z.boolean().nullable(),
});

export type ProjectTrustUpdate = z.infer<typeof ProjectTrustUpdateSchema>;

export const ProjectTrustOptionSchema = z.object({
  label: z.string(),
  trusted: z.boolean(),
  updates: z.array(ProjectTrustUpdateSchema),
});

export type ProjectTrustOption = z.infer<typeof ProjectTrustOptionSchema>;

export const GetTrustStateCommandSchema = BaseCommand.extend({
  type: z.literal("get_trust_state"),
});

export const SetTrustCommandSchema = BaseCommand.extend({
  type: z.literal("set_trust"),
  // The chosen option's updates to persist + the trusted answer to apply.
  updates: z.array(ProjectTrustUpdateSchema),
  trusted: z.boolean(),
});

// Conversation-tree navigation — SDK-host-only feature. The bridge in
// resources/pi-session-host/bridge.mjs implements these against the public
// session.sessionManager / session.navigateTree surface. A host capability
// gap returns `success:false` (the renderer maps that to a friendly
// "unsupported" state — see tree-store.openTreeForSession).
export const GetTreeCommandSchema = BaseCommand.extend({
  type: z.literal("get_tree"),
});

export const NavigateTreeCommandSchema = BaseCommand.extend({
  type: z.literal("navigate_tree"),
  targetId: z.string(),
  summarize: z.boolean().optional(),
  label: z.string().optional(),
});

export const SetLabelCommandSchema = BaseCommand.extend({
  type: z.literal("set_label"),
  targetId: z.string(),
  // Omit / empty string = clear the label.
  label: z.string().optional(),
});

// Pi >= 0.80.4 SDK-host-only rendering for appendEntry() values paired with
// registerEntryRenderer(). The renderer supplies its current text-column width
// so the extension's public pi-tui Component can lay itself out responsively.
export const RenderEntryCommandSchema = BaseCommand.extend({
  type: z.literal("render_entry"),
  entryId: z.string(),
  cols: z.number().int().min(20).max(240),
  expanded: z.boolean().optional(),
});

// SDK-host-only replay for Pi's non-persisted showCacheMissNotices cards.
export const GetCacheMissNoticesCommandSchema = BaseCommand.extend({
  type: z.literal("get_cache_miss_notices"),
});

export const PiRpcCommandSchema = z.discriminatedUnion("type", [
  PromptCommandSchema,
  SteerCommandSchema,
  FollowUpCommandSchema,
  AbortCommandSchema,
  BashCommandSchema,
  AbortBashCommandSchema,
  SetModelCommandSchema,
  CycleModelCommandSchema,
  GetAvailableModelsCommandSchema,
  GetLoginProvidersCommandSchema,
  GetScopedModelsCommandSchema,
  SetScopedModelsCommandSchema,
  SaveScopedModelsCommandSchema,
  GetLogoutProvidersCommandSchema,
  LogoutProviderCommandSchema,
  SetThinkingLevelCommandSchema,
  CycleThinkingLevelCommandSchema,
  NewSessionCommandSchema,
  SwitchSessionCommandSchema,
  ForkCommandSchema,
  CloneCommandSchema,
  SetSessionNameCommandSchema,
  GetCommandsCommandSchema,
  GetStateCommandSchema,
  GetSessionStatsCommandSchema,
  GetMessagesCommandSchema,
  GetForkMessagesCommandSchema,
  GetLastAssistantTextCommandSchema,
  CompactCommandSchema,
  SetAutoCompactionCommandSchema,
  SetAutoRetryCommandSchema,
  AbortRetryCommandSchema,
  SetSteeringModeCommandSchema,
  SetFollowUpModeCommandSchema,
  ExportHtmlCommandSchema,
  GetTrustStateCommandSchema,
  SetTrustCommandSchema,
  GetTreeCommandSchema,
  NavigateTreeCommandSchema,
  SetLabelCommandSchema,
  RenderEntryCommandSchema,
  GetCacheMissNoticesCommandSchema,
]);

export type PiRpcCommand = z.infer<typeof PiRpcCommandSchema>;

/**
 * Renderer-command policy. This table is deliberately exhaustive: adding a
 * PiRpcCommand discriminant without classifying its admission/replay semantics
 * is a compile-time error.
 */
export type PiCommandClass = "read_only" | "idempotent" | "effectful" | "replacement";
export interface PiCommandPolicy {
  class: PiCommandClass;
  /** Text work is admitted exclusively through session.submit. */
  submissionOnly?: true;
}

export const PI_COMMAND_POLICY = {
  prompt: { class: "effectful", submissionOnly: true },
  steer: { class: "effectful", submissionOnly: true },
  follow_up: { class: "effectful", submissionOnly: true },
  abort: { class: "effectful" },
  bash: { class: "effectful" },
  abort_bash: { class: "effectful" },
  set_model: { class: "idempotent" },
  cycle_model: { class: "effectful" },
  get_available_models: { class: "read_only" },
  get_login_providers: { class: "read_only" },
  get_scoped_models: { class: "read_only" },
  set_scoped_models: { class: "idempotent" },
  save_scoped_models: { class: "idempotent" },
  get_logout_providers: { class: "read_only" },
  logout_provider: { class: "idempotent" },
  set_thinking_level: { class: "idempotent" },
  cycle_thinking_level: { class: "effectful" },
  new_session: { class: "replacement" },
  switch_session: { class: "replacement" },
  fork: { class: "replacement" },
  clone: { class: "replacement" },
  set_session_name: { class: "idempotent" },
  get_commands: { class: "read_only" },
  get_state: { class: "read_only" },
  get_session_stats: { class: "read_only" },
  get_messages: { class: "read_only" },
  get_fork_messages: { class: "read_only" },
  get_last_assistant_text: { class: "read_only" },
  compact: { class: "effectful" },
  set_auto_compaction: { class: "idempotent" },
  set_auto_retry: { class: "idempotent" },
  abort_retry: { class: "effectful" },
  set_steering_mode: { class: "idempotent" },
  set_follow_up_mode: { class: "idempotent" },
  export_html: { class: "effectful" },
  get_trust_state: { class: "read_only" },
  set_trust: { class: "idempotent" },
  get_tree: { class: "read_only" },
  navigate_tree: { class: "effectful" },
  set_label: { class: "idempotent" },
  render_entry: { class: "read_only" },
  get_cache_miss_notices: { class: "read_only" },
} as const satisfies Record<PiRpcCommand["type"], PiCommandPolicy>;

type CommandTypeForClass<Class extends PiCommandClass> = {
  [Type in PiRpcCommand["type"]]: (typeof PI_COMMAND_POLICY)[Type]["class"] extends Class
    ? Type
    : never;
}[PiRpcCommand["type"]];

type CommandForClass<Class extends PiCommandClass> = Extract<
  PiRpcCommand,
  { type: CommandTypeForClass<Class> }
>;

export type PiReadOnlyCommand = CommandForClass<"read_only">;
export type PiIdempotentCommand = CommandForClass<"idempotent">;
export type PiEffectfulCommand = CommandForClass<"effectful">;
export type PiReplacementCommand = CommandForClass<"replacement">;
export type PiSubmissionOnlyCommand = Extract<
  PiRpcCommand,
  { type: "prompt" | "steer" | "follow_up" }
>;

export function commandPolicy(command: PiRpcCommand): PiCommandPolicy {
  return PI_COMMAND_POLICY[command.type];
}

export type PromptCommand = z.infer<typeof PromptCommandSchema>;
export type BashCommand = z.infer<typeof BashCommandSchema>;
export type SetModelCommand = z.infer<typeof SetModelCommandSchema>;
export type GetScopedModelsCommand = z.infer<typeof GetScopedModelsCommandSchema>;
export type SetScopedModelsCommand = z.infer<typeof SetScopedModelsCommandSchema>;
export type SaveScopedModelsCommand = z.infer<typeof SaveScopedModelsCommandSchema>;
export type GetLogoutProvidersCommand = z.infer<typeof GetLogoutProvidersCommandSchema>;
export type LogoutProviderCommand = z.infer<typeof LogoutProviderCommandSchema>;
export type SetThinkingLevelCommand = z.infer<typeof SetThinkingLevelCommandSchema>;
