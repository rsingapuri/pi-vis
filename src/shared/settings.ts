import { z } from "zod";
import { ThinkingLevelSchema } from "./pi-protocol/thinking.js";

const FontSettingsSchema = z.object({
  family: z.string(),
  sizePx: z.number().min(8).max(48),
});

export const AppSettingsSchema = z.object({
  piBinaryPath: z.string().nullable().default(null),
  fonts: z
    .object({
      display: FontSettingsSchema.default({ family: "Inter", sizePx: 14 }),
      code: FontSettingsSchema.default({ family: "IBM Plex Mono", sizePx: 13 }),
    })
    .default({}),
  recentWorkspaces: z.array(z.string()).default([]),
  lastActiveWorkspace: z.string().nullable().default(null),
  lastUsedModel: z.object({ provider: z.string(), modelId: z.string() }).nullable().default(null),
  lastUsedThinkingLevel: ThinkingLevelSchema.nullable().default(null),
  // Catppuccin flavor applied at runtime via CSS vars (and Shiki themes).
  // Enum literals must match the keys exported from catppuccin.ts.
  colorScheme: z.enum(["latte", "frappe", "macchiato", "mocha"]).default("mocha"),
  // Diff viewer preference (WP5d). Persisted across sessions; the
  // viewer seeds its own state from this on open and writes back on
  // toggle. Default is "unified" — split view is opt-in and only
  // used when the window is wide enough.
  diffViewMode: z.enum(["unified", "split"]).default("unified"),
  diffRailWidth: z.number().default(280),
  window: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const defaultSettings: AppSettings = AppSettingsSchema.parse({});
