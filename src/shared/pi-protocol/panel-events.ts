import { z } from "zod";

export const PanelBaselineSchema = z.object({
  revision: z.number().int().positive(),
  /** No ANSI tail is a keyframe; a fresh renderer must request a repaint. */
  repaintRequired: z.boolean(),
});

/**
 * Panel lifecycle events for custom() → xterm.js rendering.
 *
 * These are emitted by the SessionHost (not by pi itself) when an extension
 * calls ctx.ui.custom(factory). The panel opens → receives ANSI data →
 * closes when done(result) is called.
 *
 * The `unified` flag on `panel_open` distinguishes the **unified TUI panel**
 * (a persistent Composer-replacement hosting the editor + factory `setWidget`
 * widgets) from a transient custom() overlay panel. The renderer renders a
 * `UnifiedTuiHost` for a unified panel and treats it as non-blocking; a plain
 * panel_open (overlay) renders the existing `CustomPanelHost`.
 */

export const PanelOpenEventSchema = z.object({
  type: z.literal("panel_open"),
  panelId: z.number(),
  overlay: z.boolean(),
  hostInstanceId: z.string().uuid().optional(),
  sessionEpoch: z.number().int().nonnegative().optional(),
  /** True for the persistent unified-TUI panel (factory `setWidget`); false/absent
   *  for a transient custom() overlay panel. */
  unified: z.boolean().optional(),
  baseline: PanelBaselineSchema.optional(),
});

export const PanelDataEventSchema = z.object({
  type: z.literal("panel_data"),
  panelId: z.number(),
  data: z.string(),
});

export const PanelCloseEventSchema = z.object({
  type: z.literal("panel_close"),
  panelId: z.number(),
});

/** Sent after a forced terminal reset plus public pi-tui full render. */
export const PanelRepaintEventSchema = z.object({
  type: z.literal("panel_repaint"),
  panelId: z.number(),
  revision: z.number().int().positive(),
});

/**
 * The unified-TUI panel switched display modes. Emitted by the SessionHost when
 * an extension shows/hides a pi-tui **overlay** on the unified TUI (e.g. the
 * pi-subagents "inspect" box).
 *
 * - `"viewport"`: an overlay/full-screen component is up whose rendered geometry
 *   is a function of the terminal `rows` it's given (pi-tui centers/sizes
 *   overlays to the viewport). The renderer must pin a **fixed** grid here —
 *   the normal content-tracking sizer would feed a resize→re-layout→re-measure
 *   loop (the "wiggle"), because the content height it measures depends on the
 *   rows it just reported.
 * - `"content"`: normal content-hugging mode (editor + widget stack). The
 *   renderer tracks the intrinsic content height.
 *
 * Absent ⇒ `"content"` (the default before any overlay is shown).
 */
export const PanelModeEventSchema = z.object({
  type: z.literal("panel_mode"),
  panelId: z.number(),
  mode: z.enum(["content", "viewport"]),
});

export const PanelClearAllEventSchema = z.object({
  type: z.literal("panel_clear_all"),
});

/**
 * The unified-TUI panel's host process is gone (host restart, `/reload`, or
 * session close). The dying host cannot emit a reliable `panel_close` for the
 * unified panel, so the main process emits this to tell the renderer to drop
 * stale `unifiedPanel` state and restore the native Composer. Distinct from
 * `panel_clear_all` (which clears custom() overlay panels) so each can be
 * handled independently.
 */
export const UnifiedPanelResetEventSchema = z.object({
  type: z.literal("unified_panel_reset"),
});

/**
 * A non-fatal warning that should surface to the user (e.g. a toast) but does
 * NOT indicate that the runtime is unavailable. It surfaces ordinary
 * non-fatal conditions such as advisory lock contention.
 */
export const SessionWarningEventSchema = z.object({
  type: z.literal("session_warning"),
  message: z.string(),
});

export const PanelEventSchema = z.discriminatedUnion("type", [
  PanelOpenEventSchema,
  PanelDataEventSchema,
  PanelCloseEventSchema,
  PanelRepaintEventSchema,
  PanelModeEventSchema,
  PanelClearAllEventSchema,
  UnifiedPanelResetEventSchema,
  SessionWarningEventSchema,
]);

export type PanelOpenEvent = z.infer<typeof PanelOpenEventSchema>;
export type PanelDataEvent = z.infer<typeof PanelDataEventSchema>;
export type PanelCloseEvent = z.infer<typeof PanelCloseEventSchema>;
export type PanelRepaintEvent = z.infer<typeof PanelRepaintEventSchema>;
export type PanelModeEvent = z.infer<typeof PanelModeEventSchema>;
export type PanelClearAllEvent = z.infer<typeof PanelClearAllEventSchema>;
export type UnifiedPanelResetEvent = z.infer<typeof UnifiedPanelResetEventSchema>;
export type SessionWarningEvent = z.infer<typeof SessionWarningEventSchema>;
export type PanelEvent = z.infer<typeof PanelEventSchema>;
