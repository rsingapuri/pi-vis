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
      code: FontSettingsSchema.default({ family: "IBM Plex Mono", sizePx: 14 }),
    })
    .default({}),
  // Manual workspace ordering. The sidebar renders workspaces in this
  // order; the user reorders via drag. A newly-picked workspace is appended
  // to the end (never prepended) so it never displaces a manually-positioned
  // entry. Capped at MAX_WORKSPACES. Supersedes the old `recentWorkspaces`
  // field (recency-sorted); `loadSettings` migrates any saved
  // `recentWorkspaces` into this on first read.
  workspaceOrder: z.array(z.string()).default([]),
  // Workspaces whose session lists are expanded in the sidebar. Multiple
  // may be expanded at once so the user can monitor sessions across
  // workspaces. Independent of `lastActiveWorkspace` (which tracks focus).
  expandedWorkspaces: z.array(z.string()).default([]),
  lastActiveWorkspace: z.string().nullable().default(null),
  lastUsedModel: z.object({ provider: z.string(), modelId: z.string() }).nullable().default(null),
  lastUsedThinkingLevel: ThinkingLevelSchema.nullable().default(null),
  // Worktree associations: worktreePath → identity. Persisted so worktree
  // sessions survive app relaunch (their session-file cwd is the worktree,
  // not the parent workspace, so discovery needs this map to re-attach
  // them to the right workspace and re-spawn pi in the worktree cwd).
  worktrees: z
    .record(
      z.string(),
      z.object({
        workspacePath: z.string(),
        branch: z.string(),
        name: z.string(),
        base: z.string(),
      }),
    )
    .default({}),
  // Catppuccin flavor applied at runtime via CSS vars (and Shiki themes).
  // Enum literals must match the keys exported from catppuccin.ts.
  colorScheme: z.enum(["latte", "frappe", "macchiato", "mocha"]).default("mocha"),
  // Diff viewer preference (WP5d). Persisted across sessions; the
  // viewer seeds its own state from this on open and writes back on
  // toggle. Default is "unified" — split view is opt-in and only
  // used when the window is wide enough.
  diffViewMode: z.enum(["unified", "split"]).default("unified"),
  diffIncludeRemoteBranches: z.boolean().default(false),
  // Largest working-tree file the diff viewer will read and render, in MiB
  // (fractional allowed — the settings UI parses freeform sizes like "5 MiB"
  // or "500 KiB" into this). Above it, getFileDiff returns a `tooLarge` marker
  // and the viewer shows a "File too large to diff" notice instead of diffing
  // the contents (jsdiff cost grows with file size). Clamped to [1 KiB, 1 GiB]
  // — a low floor lets someone keep the viewer snappy on a slow machine;
  // default 5 MiB.
  diffMaxFileSizeMiB: z
    .number()
    .min(1 / 1024)
    .max(1024)
    .default(5),
  statusBarVisible: z.boolean().default(true),
  // Sidebar chrome (user-controlled layout). Persisted so the width and
  // collapsed state survive relaunch. Width is clamped to [160, 500] by the
  // resize handle; the grid additionally caps it to a fraction of the window
  // so it can never dominate a narrow window.
  sidebarWidth: z.number().default(220),
  sidebarCollapsed: z.boolean().default(false),
  archivedSessions: z.array(z.string()).default([]),
  lastDismissedPiVersion: z.string().nullable().default(null),
  updateCheckEnabled: z.boolean().default(true),
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

export type ColorScheme = AppSettings["colorScheme"];

/**
 * Map a pi-vis Catppuccin flavor to the pi theme name the SDK host should load.
 *
 * pi ships exactly two built-in themes — "dark" and "light" — and resolves an
 * extension's semantic colors (`theme.fg("text"|"muted"|"borderMuted", …)`) plus
 * all pi-tui rendering (the unified TUI, custom() panels) against the active one.
 * Those colors must be readable on the surface pi-vis paints them on, so the host
 * theme has to track pi-vis's scheme by luminance: Latte is the only light flavor;
 * Frappé/Macchiato/Mocha are dark. Without this the host would always use pi's
 * default (dark) theme, so a light pi-vis scheme (Latte) showed dark-tuned,
 * low-contrast extension text — the "looked good in Mocha, bad in Latte" bug.
 */
export function piThemeForColorScheme(scheme: ColorScheme): "dark" | "light" {
  return scheme === "latte" ? "light" : "dark";
}
