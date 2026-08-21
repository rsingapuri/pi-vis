import { expect, test } from "vitest";
import {
  ASYNC_STATUS_SNAPSHOT_KIND,
  ASYNC_STATUS_SNAPSHOT_VERSION,
  AsyncStatusSnapshotV1Schema,
  parseSubagentAsyncSnapshot,
} from "./subagents";

/**
 * Verify that the parser accepts a payload that exactly matches the
 * authoritative contract located at /tmp/AsyncStatusSnapshotV1.reference.ts.
 * The reference defines the required fields; we construct a minimal object
 * containing those fields and ensure the Zod schema validates it.
 */
test("parseSubagentAsyncSnapshot validates a correct payload", () => {
  const payload = {
    kind: ASYNC_STATUS_SNAPSHOT_KIND,
    version: ASYNC_STATUS_SNAPSHOT_VERSION,
    generatedAt: Date.now(),
    caps: {
      maxRuns: 10,
      maxChildrenPerNode: 5,
      maxDepth: 2,
      maxStringLength: 100,
      maxSerializedBytes: 1024,
    },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [],
  } as const;

  const result = AsyncStatusSnapshotV1Schema.safeParse(payload);
  expect(result.success).toBe(true);

  const line = `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(payload)}`;
  const parsed = parseSubagentAsyncSnapshot([line]);
  expect(parsed).toBeDefined();
  expect(parsed?.kind).toBe(payload.kind);
});

/**
 * Exhaustive regression guard for the schema contract. This payload exercises
 * every field declared in the reference types (caps, omitted, node activity,
 * and nested children) so that a missing or mistyped field fails the test.
 */
test("parseSubagentAsyncSnapshot accepts a full nested snapshot", () => {
  const payload = {
    kind: ASYNC_STATUS_SNAPSHOT_KIND,
    version: ASYNC_STATUS_SNAPSHOT_VERSION,
    generatedAt: 1704067200000,
    caps: {
      maxRuns: 20,
      maxChildrenPerNode: 8,
      maxDepth: 3,
      maxStringLength: 160,
      maxSerializedBytes: 32768,
    },
    omitted: { runs: 1, children: 2, byteLimitExceeded: true },
    runs: [
      {
        id: "parent-run",
        kind: "subagent",
        label: "researcher",
        state: "running",
        startedAt: 1704067200000,
        updatedAt: 1704067290000,
        activity: {
          state: "tool",
          currentTool: "search",
          lastActivityAt: 1704067290000,
          currentToolStartedAt: 1704067280000,
          turnCount: 5,
          toolCount: 3,
        },
        children: [
          {
            id: "child-step",
            kind: "step",
            label: "summarize",
            state: "complete",
            startedAt: 1704067201000,
            updatedAt: 1704067203000,
            endedAt: 1704067203000,
          },
          {
            id: "child-workflow",
            kind: "workflow",
            label: "plan",
            state: "queued",
            children: [
              {
                id: "grandchild-step",
                kind: "step",
                label: "deep",
                state: "rejected",
              },
            ],
          },
        ],
      },
    ],
  } as const;

  const line = `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(payload)}`;
  const parsed = parseSubagentAsyncSnapshot([line]);
  expect(parsed).toBeDefined();
  expect(parsed!.caps.maxRuns).toBe(20);
  expect(parsed!.caps.maxChildrenPerNode).toBe(8);
  expect(parsed!.caps.maxDepth).toBe(3);
  expect(parsed!.caps.maxStringLength).toBe(160);
  expect(parsed!.caps.maxSerializedBytes).toBe(32768);
  expect(parsed!.omitted).toEqual({ runs: 1, children: 2, byteLimitExceeded: true });
  expect(parsed!.runs).toHaveLength(1);
  expect(parsed!.runs[0]!.children).toHaveLength(2);
  expect(parsed!.runs[0]!.children![1]!.children).toHaveLength(1);
  expect(parsed!.runs[0]!.children![1]!.children![0]!.state).toBe("rejected");
});

/**
 * Required fields are enforced. Removing a required caps or top-level field
 * must fail parsing so malformed extension output is never silently accepted.
 */
test("parseSubagentAsyncSnapshot rejects a payload missing required fields", () => {
  const base = {
    kind: ASYNC_STATUS_SNAPSHOT_KIND,
    version: ASYNC_STATUS_SNAPSHOT_VERSION,
    generatedAt: 1704067200000,
    caps: {
      maxRuns: 20,
      maxChildrenPerNode: 8,
      maxDepth: 3,
      maxStringLength: 160,
      maxSerializedBytes: 32768,
    },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [],
  } as const;

  for (const key of ["kind", "version", "generatedAt", "caps", "omitted", "runs"] as const) {
    const incomplete = { ...base } as Record<string, unknown>;
    delete incomplete[key];
    expect(AsyncStatusSnapshotV1Schema.safeParse(incomplete).success).toBe(false);
  }

  const missingMaxRuns = {
    ...base,
    caps: { maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32768 },
  };
  expect(AsyncStatusSnapshotV1Schema.safeParse(missingMaxRuns).success).toBe(false);

  const missingMaxDepth = {
    ...base,
    caps: { maxRuns: 20, maxChildrenPerNode: 8, maxStringLength: 160, maxSerializedBytes: 32768 },
  };
  expect(AsyncStatusSnapshotV1Schema.safeParse(missingMaxDepth).success).toBe(false);
});
