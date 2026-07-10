// Shared row-rendering guardrails for the diff viewer.
//
// The viewer intentionally renders large diffs in bounded chunks instead of
// mounting tens of thousands of rows at once. These values are shared by the
// row renderer, search, and store so a search match never forces the DOM past
// the same safety ceiling used by the visible rows.

/** Number of diff rows rendered per file initially and per "show more" click. */
export const DIFF_ROW_RENDER_CHUNK = 1_000;

/** Hard per-file DOM row ceiling for pathological diffs. */
export const DIFF_ROW_RENDER_MAX = 10_000;

export function clampDiffRenderCap(cap: number): number {
  if (!Number.isFinite(cap)) return DIFF_ROW_RENDER_CHUNK;
  return Math.max(DIFF_ROW_RENDER_CHUNK, Math.min(DIFF_ROW_RENDER_MAX, Math.ceil(cap)));
}
