import { expect, test } from "@playwright/test";

type PreviewSession = { widgets: Map<string, string[]> };
type PreviewStore = {
  getState: () => { activeSessionId: string; sessions: Map<string, PreviewSession> };
  setState: (partial: unknown) => void;
};

function snapshotLine(snapshot: unknown): string {
  return `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`;
}

function baseSnapshot(): Record<string, unknown> {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
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
  };
}

async function waitForStoreReady(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => {
    const target = window as unknown as {
      __pivisStore?: PreviewStore;
      __pivisPreview?: { initialWorkspaceOpenCompletions: number };
    };
    const store = target.__pivisStore;
    const preview = target.__pivisPreview;
    if (!store || !preview) return false;
    const state = store.getState();
    return Boolean(
      state.activeSessionId &&
        state.sessions.has(state.activeSessionId) &&
        preview.initialWorkspaceOpenCompletions > 0,
    );
  });
}

async function setSubagentWidget(
  page: import("@playwright/test").Page,
  lines: string[],
): Promise<void> {
  await page.evaluate((snapshotLines) => {
    const store = (window as unknown as { __pivisStore: PreviewStore }).__pivisStore;
    const state = store.getState();
    const sessions = new Map(state.sessions);
    const session = sessions.get(state.activeSessionId)!;
    sessions.set(state.activeSessionId, {
      ...session,
      widgets: new Map([["subagent-async", snapshotLines]]),
    });
    store.setState({ sessions });
  }, lines);
}

test.describe("subagent fleet panel", () => {
  test("renders the live fleet card above the composer with real snapshot fields", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await waitForStoreReady(page);

    const line = snapshotLine({
      ...baseSnapshot(),
      runs: [
        {
          id: "parent-run",
          kind: "subagent",
          label: "researcher",
          state: "running",
          startedAt: 1704067200000,
          updatedAt: 1704067290000,
          activity: {
            currentTool: "search",
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
              endedAt: 1704067203000,
            },
          ],
        },
        {
          id: "failed-run",
          kind: "subagent",
          label: "validator",
          state: "failed",
        },
      ],
    });

    await setSubagentWidget(page, [line]);

    await expect(page.locator(".subagents-fleet")).toBeVisible();
    await expect(page.locator(".subagents-fleet")).toContainText("Subagents");
    await expect(page.locator(".subagents-fleet")).toContainText("researcher");
    await expect(page.locator(".subagents-fleet")).toContainText("parent-run");
    await expect(page.locator(".subagents-fleet")).toContainText("search");
    await expect(page.locator(".subagents-fleet")).toContainText("summarize");
    await expect(page.locator(".subagents-fleet__badge--running")).toHaveCount(1);
  });

  test("shows a truncation notice when the snapshot hit the byte limit", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await waitForStoreReady(page);

    const line = snapshotLine({
      ...baseSnapshot(),
      caps: {
        maxRuns: 20,
        maxChildrenPerNode: 8,
        maxDepth: 3,
        maxStringLength: 160,
        maxSerializedBytes: 4096,
      },
      omitted: { runs: 2, children: 5, byteLimitExceeded: true },
      runs: [{ id: "kept-run", kind: "subagent", label: "kept", state: "running" }],
    });

    await setSubagentWidget(page, [line]);

    await expect(page.locator(".subagents-fleet")).toBeVisible();
    await expect(page.locator(".subagents-fleet")).toContainText("truncated to 4.0 KiB budget");
    await expect(page.locator(".subagents-fleet")).toContainText("2 runs omitted");
  });

  test("shows an empty state for a malformed snapshot line", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await waitForStoreReady(page);

    await setSubagentWidget(page, ["PI_SUBAGENT_ASYNC_JSON:not valid"]);

    await expect(page.locator(".subagents-fleet")).toBeVisible();
    await expect(page.locator(".subagents-fleet")).toContainText("No active subagent runs");
  });

  test("retracts the panel when the widget is cleared", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await waitForStoreReady(page);

    await setSubagentWidget(page, [
      snapshotLine({
        ...baseSnapshot(),
        runs: [{ id: "run-1", kind: "subagent", label: "running", state: "running" }],
      }),
    ]);
    await expect(page.locator(".subagents-fleet")).toContainText("running");

    await setSubagentWidget(page, []);
    await expect(page.locator(".subagents-fleet")).toContainText("No active subagent runs");
  });
});
