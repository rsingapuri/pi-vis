import { z } from "zod";

/**
 * Typed source of truth for the pi-subagents live status widget.
 *
 * The extension emits snapshot updates on the widget key `subagent-async` as
 * lines prefixed with `PI_SUBAGENT_ASYNC_JSON:`. The payload is a versioned
 * `AsyncStatusSnapshotV1` describing the current run tree and capacity limits.
 *
 * The Zod types below are a faithful port of the authoritative TypeScript
 * contract in `pi-subagents/src/runs/background/async-status-snapshot.ts`:
 * same field names, types, and required/optional shape. Keep them in sync
 * with that file; do not invent ad-hoc fields here or in the renderer.
 */

export const SUBAGENT_ASYNC_WIDGET_KEY = "subagent-async";
export const SUBAGENT_ASYNC_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

export const ASYNC_STATUS_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
export const ASYNC_STATUS_SNAPSHOT_VERSION = 1;

export const AsyncStatusSnapshotStateSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "paused",
  "stopped",
  "rejected",
]);
export type AsyncStatusSnapshotState = z.infer<typeof AsyncStatusSnapshotStateSchema>;

export const AsyncStatusSnapshotKindSchema = z.enum(["subagent", "workflow", "step"]);
export type AsyncStatusSnapshotKind = z.infer<typeof AsyncStatusSnapshotKindSchema>;

export const AsyncStatusSnapshotActivitySchema = z.object({
  state: z.string().optional(),
  currentTool: z.string().optional(),
  lastActivityAt: z.number().optional(),
  currentToolStartedAt: z.number().optional(),
  turnCount: z.number().optional(),
  toolCount: z.number().optional(),
});
export type AsyncStatusSnapshotActivity = z.infer<typeof AsyncStatusSnapshotActivitySchema>;

export type AsyncStatusSnapshotNodeV1 = {
  id: string;
  kind: AsyncStatusSnapshotKind;
  label: string;
  state: AsyncStatusSnapshotState;
  startedAt?: number | undefined;
  updatedAt?: number | undefined;
  endedAt?: number | undefined;
  activity?: AsyncStatusSnapshotActivity | undefined;
  children?: AsyncStatusSnapshotNodeV1[] | undefined;
};

export const AsyncStatusSnapshotNodeSchema: z.ZodType<AsyncStatusSnapshotNodeV1> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: AsyncStatusSnapshotKindSchema,
    label: z.string(),
    state: AsyncStatusSnapshotStateSchema,
    startedAt: z.number().optional(),
    updatedAt: z.number().optional(),
    endedAt: z.number().optional(),
    activity: AsyncStatusSnapshotActivitySchema.optional(),
    children: z.array(AsyncStatusSnapshotNodeSchema).optional(),
  }),
);

export const AsyncStatusSnapshotCapsSchema = z.object({
  maxRuns: z.number(),
  maxChildrenPerNode: z.number(),
  maxDepth: z.number(),
  maxStringLength: z.number(),
  maxSerializedBytes: z.number(),
});
export type AsyncStatusSnapshotCapsV1 = z.infer<typeof AsyncStatusSnapshotCapsSchema>;

export const AsyncStatusSnapshotOmittedSchema = z.object({
  runs: z.number(),
  children: z.number(),
  byteLimitExceeded: z.boolean(),
});
export type AsyncStatusSnapshotOmittedV1 = z.infer<typeof AsyncStatusSnapshotOmittedSchema>;

export const AsyncStatusSnapshotV1Schema = z.object({
  kind: z.literal(ASYNC_STATUS_SNAPSHOT_KIND),
  version: z.literal(ASYNC_STATUS_SNAPSHOT_VERSION),
  generatedAt: z.number(),
  caps: AsyncStatusSnapshotCapsSchema,
  omitted: AsyncStatusSnapshotOmittedSchema,
  runs: z.array(AsyncStatusSnapshotNodeSchema),
});
export type AsyncStatusSnapshotV1 = z.infer<typeof AsyncStatusSnapshotV1Schema>;

/**
 * Parse the first `PI_SUBAGENT_ASYNC_JSON:` line from a widget's lines into a
 * typed snapshot. Returns `undefined` when no valid snapshot is present so
 * callers can fall back to an empty state without crashing on malformed
 * extension output.
 */
export function parseSubagentAsyncSnapshot(lines: string[]): AsyncStatusSnapshotV1 | undefined {
  const line = lines.find((l) => l.startsWith(SUBAGENT_ASYNC_PREFIX));
  if (!line) return undefined;
  const json = line.slice(SUBAGENT_ASYNC_PREFIX.length);
  try {
    const parsed = JSON.parse(json);
    const result = AsyncStatusSnapshotV1Schema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
