import { z } from "zod";
import { ProjectTrustOptionSchema } from "./commands.js";
import { ThinkingLevelSchema } from "./thinking.js";

export const PiRpcResponseSchema = z.object({
  type: z.literal("response"),
  command: z.string(),
  success: z.boolean(),
  id: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export type PiRpcResponse = z.infer<typeof PiRpcResponseSchema>;

const SessionStateModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    api: z.string().optional(),
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    reasoning: z.boolean().optional(),
  })
  .passthrough();

export const SessionStateSchema = z
  .object({
    model: SessionStateModelSchema.nullable().optional(),
    thinkingLevel: ThinkingLevelSchema,
    isStreaming: z.boolean().optional(),
    isCompacting: z.boolean().optional(),
    steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
    followUpMode: z.enum(["all", "one-at-a-time"]).optional(),
    sessionFile: z.string().optional(),
    sessionId: z.string(),
    sessionName: z.string().optional(),
    autoCompactionEnabled: z.boolean().optional(),
    messageCount: z.number().optional(),
    pendingMessageCount: z.number().optional(),
  })
  .passthrough();

export type SessionState = z.infer<typeof SessionStateSchema>;

// Real wire shape from get_state/get_available_models: model has id, name, api, provider, baseUrl, etc.
export const ModelInfoSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    api: z.string().optional(),
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    reasoning: z.boolean().optional(),
    // Accepted input modalities. Pi's model registry defaults this to
    // ["text"]; vision-capable models also list "image". The composer
    // uses it to gate image attachment — sending an image to a text-only
    // model silently drops it before the provider API call.
    input: z.array(z.enum(["text", "image"])).optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
  })
  .passthrough();

export type ModelInfo = z.infer<typeof ModelInfoSchema>;

// Real wire shape from get_session_stats response data
export const SessionStatsSchema = z
  .object({
    sessionFile: z.string().optional(),
    sessionId: z.string(),
    userMessages: z.number().optional(),
    assistantMessages: z.number().optional(),
    toolCalls: z.number().optional(),
    toolResults: z.number().optional(),
    totalMessages: z.number().optional(),
    tokens: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
        total: z.number(),
      })
      .optional(),
    cost: z.number().optional(),
    contextUsage: z
      .object({
        tokens: z.number().nullable(),
        contextWindow: z.number(),
        percent: z.number().nullable(),
      })
      .optional(),
  })
  .passthrough();

export type SessionStats = z.infer<typeof SessionStatsSchema>;

// Tolerant SlashCommandInfo: pi v0.79.1 emits the strict shape
//   { name, description?, source: "extension"|"prompt"|"skill",
//     sourceInfo: { path, scope: "user"|"project"|"temporary", ... } }
// while docs (and earlier versions) show a flat `{ location, path }` shape.
// We accept both and preserve any extra fields via .passthrough().
export const SlashCommandInfoSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: z.string().optional(),
    // Flat shape (older docs / test fixtures)
    location: z.string().optional(),
    path: z.string().optional(),
    // Nested shape (v0.79.1 wire)
    sourceInfo: z
      .object({
        path: z.string().optional(),
        scope: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type SlashCommandInfo = z.infer<typeof SlashCommandInfoSchema>;

// Small data schemas used by the command executor. They tolerate missing
// fields (e.g. `cancelled`) so we can branch on truthiness without runtime
// guards scattered through executeAction.
export const ForkMessagesDataSchema = z
  .object({
    messages: z
      .array(
        z.object({
          entryId: z.string(),
          text: z.string(),
        }),
      )
      .optional(),
  })
  .passthrough();

export type ForkMessagesData = z.infer<typeof ForkMessagesDataSchema>;

export const LastAssistantTextDataSchema = z
  .object({
    text: z.string().nullable().optional(),
  })
  .passthrough();

export type LastAssistantTextData = z.infer<typeof LastAssistantTextDataSchema>;

export const ExportHtmlDataSchema = z
  .object({
    path: z.string().optional(),
  })
  .passthrough();

export type ExportHtmlData = z.infer<typeof ExportHtmlDataSchema>;

export const CancellationDataSchema = z
  .object({
    cancelled: z.boolean().optional(),
  })
  .passthrough();

export type CancellationData = z.infer<typeof CancellationDataSchema>;

// ── Trust state response (host-only /trust support) ──────────────────────
// Returned by the get_trust_state host bridge command. `currentOptions`
// mirrors pi's getProjectTrustOptions choice set (buildProjectTrustOptions
// in bootstrap.mjs). `hasTrustRequiringResources` gates whether /trust is
// meaningful at all (false → the renderer toasts and skips the picker).
export const TrustStateDataSchema = z.object({
  cwd: z.string(),
  hasTrustRequiringResources: z.boolean(),
  // The cwd's currently-saved trust decision (null = no saved entry).
  // Lets the picker show the current state (pi's TrustSelectorComponent does).
  savedDecision: z.boolean().nullable(),
  // Whether pi's settings.json has projectTrusted=true (the global default).
  projectTrusted: z.boolean(),
  currentOptions: z.array(ProjectTrustOptionSchema),
});

export type TrustStateData = z.infer<typeof TrustStateDataSchema>;

// Scoped-models data: get_scoped_models returns all available models plus
// the pre-checked provider/id list. enabledIds is null when nothing is
// scoped (all models available) — mirrors pi's showModelsSelector initial
// state (null = check-all).
export const ScopedModelsDataSchema = z
  .object({
    models: z.array(ModelInfoSchema),
    enabledIds: z.array(z.string()).nullable(),
  })
  .passthrough();

export type ScopedModelsData = z.infer<typeof ScopedModelsDataSchema>;

// Logout-providers data: get_logout_providers returns providers with stored
// auth, each tagged oauth vs api_key so the picker can show a badge.
export const LogoutProvidersDataSchema = z
  .object({
    providers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        authType: z.enum(["oauth", "api_key"]),
      }),
    ),
  })
  .passthrough();

export type LogoutProvidersData = z.infer<typeof LogoutProvidersDataSchema>;
