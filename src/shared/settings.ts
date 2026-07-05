import { z } from "zod";
import { ThinkingLevelSchema } from "./pi-protocol/thinking.js";

export const ThemeModeSchema = z.enum(["light", "dark", "system"]);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;
export type ThemeAppearance = "light" | "dark";

const DisplayFontSettingsSchema = z.object({
  // The interface font family is intentionally app-owned (currently Inter) so
  // layout can be tuned against stable font metrics. Users can still scale the
  // UI for accessibility/readability.
  sizePx: z.number().min(8).max(48).default(14),
});

const CodeFontSettingsSchema = z.object({
  family: z.string(),
  sizePx: z.number().min(8).max(48),
});

export const AppSettingsSchema = z.object({
  piBinaryPath: z.string().nullable().default(null),
  // User-configured environment variables merged into every pi session spawn
  // (SDK-host and --mode rpc fallback), after the login-shell env and before
  // Pi-Vis's reserved PIVIS_* control variables. Values are strings, matching
  // Node's child_process env contract. Invalid/reserved names are filtered at
  // spawn time so a hand-edited settings.json can't break internal plumbing.
  piEnv: z.record(z.coerce.string()).default({}),
  fonts: z
    .object({
      display: DisplayFontSettingsSchema.default({ sizePx: 14 }),
      code: CodeFontSettingsSchema.default({ family: "IBM Plex Mono", sizePx: 14 }),
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
  lastUsedModel: z
    .object({ provider: z.string().optional(), modelId: z.string() })
    .nullable()
    .default(null),
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
  // User-selected theme ids for each luminance family. Free strings (not
  // enums) because themes are a registry: bundled themes (src/shared/theme)
  // plus user-droppable ones (<userData>/themes). An id that no longer
  // resolves falls back by slot appearance at apply/load time, so stale
  // persisted ids can't break startup or cross light/dark families.
  lightColorScheme: z.string().default("latte"),
  darkColorScheme: z.string().default("mocha"),
  // Which theme family is active. "system" resolves via the OS/browser
  // preferred color scheme in the renderer and Electron nativeTheme in main.
  themeMode: ThemeModeSchema.default("system"),
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
  // Pinned sessions (by session-file path), in manual pinned order. Pinned
  // rows float to the top of their workspace's session list, above the
  // standard activity-sorted rows. A newly pinned session is appended to the
  // end of this array (so it lands at the bottom of the pinned group);
  // drag-reorder rewrites it. Unpinning removes the key and the row returns
  // to its activity-sorted place. Keyed by file path (stable across
  // relaunch and shared by the live row and its stored counterpart). The
  // array is GLOBAL across all workspaces; each workspace view sees only its
  // own keys, in their relative order within this array (so pinning order
  // can interleave across workspaces). Stale keys (deleted/moved session
  // files) are filtered out at render rather than pruned here, matching
  // archivedSessions' trade-off.
  pinnedSessions: z.array(z.string()).default([]),
  archivedSessions: z.array(z.string()).default([]),
  lastDismissedPiVersion: z.string().nullable().default(null),
  // Checks for updates to the user's pi binary and installed pi extensions.
  updateCheckEnabled: z.boolean().default(true),
  // Checks for updates to the packaged Pi-Vis desktop app via Electron's
  // built-in autoUpdater. Separate from pi/extension updates because it uses
  // a signed app release feed and installs by restarting the app.
  appUpdateCheckEnabled: z.boolean().default(true),
  diffRailWidth: z.number().default(280),
  // Whether the diff viewer's file-listing sidebar is shown. Toggled from
  // the viewer header; persisted so the preference survives reopen/relaunch.
  diffRailVisible: z.boolean().default(true),
  // Preferred height for extension custom() panels (CustomPanelHost), as a
  // FRACTION of the transcript column (0.2–0.9). Set by dragging the panel's
  // top resize handle; `null` = the default (~half the column). Persisted so
  // the preference applies to every custom() panel across sessions and
  // windows (it is a global preference about how big you like these panels,
  // not per-content). Does NOT affect the unified TUI panel, which
  // content-tracks. Double-clicking the handle clears this (back to default).
  customPanelHeightFraction: z.number().min(0.2).max(0.9).nullable().default(null),
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

export type ColorScheme = AppSettings["lightColorScheme"] | AppSettings["darkColorScheme"];

export function resolveActiveColorScheme(
  settings: Pick<AppSettings, "lightColorScheme" | "darkColorScheme" | "themeMode">,
  systemAppearance: ThemeAppearance,
): string {
  if (settings.themeMode === "light") return settings.lightColorScheme;
  if (settings.themeMode === "dark") return settings.darkColorScheme;
  return systemAppearance === "light" ? settings.lightColorScheme : settings.darkColorScheme;
}

// The pi-theme mapping (which pi built-in theme the SDK host loads for a given
// app theme) now lives in @shared/theme as `piThemeForTheme`, keyed off the
// resolved theme's declared `appearance` rather than a hardcoded flavor check —
// so it generalizes to any bundled or user theme. The main process resolves the
// active theme from its registry (bundled + user) before mapping.
