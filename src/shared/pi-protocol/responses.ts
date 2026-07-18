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
    steering: z.array(z.string()).optional(),
    followUp: z.array(z.string()).optional(),
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
    // Per-level provider mapping. A null value explicitly disables that level;
    // xhigh/max are opt-in and are supported only when their mapping exists.
    thinkingLevelMap: z.record(z.string().nullable()).optional(),
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

export const LoginProvidersDataSchema = z
  .object({
    native: z.boolean(),
    providers: z
      .array(
        z
          .object({
            id: z.string().min(1).max(160),
            name: z.string().min(1).max(160),
            configured: z.boolean(),
            source: z.string().max(120).optional(),
            methods: z
              .array(z.enum(["oauth", "api_key"]))
              .min(1)
              .max(2),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type LoginProvidersData = z.infer<typeof LoginProvidersDataSchema>;
export type LoginProvider = LoginProvidersData["providers"][number];

// Conversation-tree response schemas. `SessionTreeEntrySchema` is intentionally
// loose — the renderer only needs `id`, `parentId`, `type`, `timestamp` plus
// enough per-type fields to render the preview text. The discriminated shapes
// in src/shared/session-file/entries.ts cover every concrete variant; we
// .passthrough() so type-specific extras (message bodies, summary text,
// modelId, etc.) survive the wire trip without us enumerating each one.
export const SessionTreeEntrySchema = z
  .object({
    id: z.string(),
    parentId: z.string().optional(),
    type: z.string(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type SessionTreeEntry = z.infer<typeof SessionTreeEntrySchema>;

// The WIRE shape is FLAT, not nested. pi's sessionManager.getTree() returns a
// recursively-nested tree ({entry, children:[...]}) whose depth equals the
// longest root→leaf message chain — unbounded. Electron's contextBridge
// hardcodes a 1000-level object-nesting limit, so any session with >1000
// messages in its longest chain threw "recursion depth exceeded" the moment
// the response crossed the preload→renderer boundary, before the renderer
// ever saw it. Flattening to a parentId-keyed list caps the wire depth at a
// constant (one level of nodes + the shallow per-entry fields); the renderer
// re-nests in its own world (no contextBridge limit there) via buildNestedTree.
export interface FlatTreeNode {
  entry: SessionTreeEntry;
  /** undefined/absent for top-level roots (mirrors their position in pi's nested tree). */
  parentId?: string | undefined;
  label?: string | undefined;
  labelTimestamp?: string | undefined;
}

export const FlatTreeNodeSchema = z.object({
  entry: SessionTreeEntrySchema,
  parentId: z.string().optional(),
  label: z.string().optional(),
  labelTimestamp: z.string().optional(),
});

// Nested form — used ONLY renderer-side (after buildNestedTree reconstitutes
// the tree in the renderer's main world, which has no contextBridge depth
// limit). Kept recursive for the flattener (a faithful port of pi's TUI
// tree-selector); never crosses the IPC/contextBridge boundary.
export interface SessionTreeNode {
  entry: SessionTreeEntry;
  children: SessionTreeNode[];
  label?: string | undefined;
  labelTimestamp?: string | undefined;
}

export const SessionTreeNodeSchema: z.ZodType<SessionTreeNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    entry: SessionTreeEntrySchema,
    children: z.array(SessionTreeNodeSchema),
    label: z.string().optional(),
    labelTimestamp: z.string().optional(),
  }),
);

export const GetTreeDataSchema = z.object({
  nodes: z.array(FlatTreeNodeSchema),
  // null when the session is in its pre-leaf state (e.g. immediately after
  // /new — no user messages have been appended yet).
  leafId: z.string().nullable(),
  // True when the host is up but the installed pi lacks the tree surface
  // (sessionManager.getTree/getLeafId). This is a *capability gap*, distinct
  // from a transient failure: the renderer maps it to the permanent
  // "unsupported" phase, while every other failure becomes a retryable
  // "error" phase. Without this flag the renderer can't tell a genuine gap
  // from a host-restart hiccup (both surface as a thrown command), so a
  // transient made the viewer stick on "unsupported" through /reload.
  unsupported: z.boolean().optional(),
});

export type GetTreeData = z.infer<typeof GetTreeDataSchema>;

export const NavigateTreeDataSchema = z.object({
  cancelled: z.boolean(),
  editorText: z.string().optional(),
  // The new active leaf AFTER navigation. null when the user navigated
  // back to the very first user message — see review S3 in the plan.
  leafId: z.string().nullable().optional(),
  aborted: z.boolean().optional(),
  // The active branch in root→leaf chronological order, sourced from
  // session.sessionManager.getBranch() (synchronous in pi). Empty when
  // navigation was cancelled, or when the new leaf is null (root).
  //
  // Note: pi's navigateTree() result also carries `summaryEntry` for the
  // synthesized branch_summary — deliberately omitted here because that
  // entry is already present as a node in `branch` whenever a summary was
  // generated, so carrying it separately would be redundant.
  branch: z.array(SessionTreeEntrySchema).optional(),
});

export type NavigateTreeData = z.infer<typeof NavigateTreeDataSchema>;
