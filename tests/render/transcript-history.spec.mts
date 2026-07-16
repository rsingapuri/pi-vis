import { expect, test } from "@playwright/test";

test("live compaction preserves earlier GUI scrollback", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
      applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    state.seedHistory(
      state.activeSessionId,
      Array.from({ length: 750 }, (_, index) => ({
        id: `before-compaction-${index}`,
        type: "user",
        data: { content: `before compaction ${index}` },
      })),
    );
    state.applyEvent(state.activeSessionId, {
      type: "compaction_end",
      result: { summary: "compact summary" },
    });
  });

  await expect(page.getByRole("button", { name: /earlier messages/i })).toHaveCount(0);
  await expect(page.locator(".transcript-block--user")).toHaveCount(750);
  await expect(page.getByText("before compaction 0", { exact: true })).toBeVisible();
  await expect(page.getByText("compact summary", { exact: false })).toBeVisible();

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    const assistant = { role: "assistant", content: [] };
    state.applyEvent(state.activeSessionId, { type: "message_start", message: assistant });
    for (let index = 0; index < 50; index += 1) {
      state.applyEvent(state.activeSessionId, {
        type: "message_update",
        message: assistant,
        assistantMessageEvent: { type: "text_delta", delta: "stream " },
      });
    }
  });

  await expect(page.getByText("before compaction 0", { exact: true })).toBeVisible();
  await expect(page.getByText(/stream stream stream/)).toBeVisible();
});

test("authoritative compaction activity uses the working row and clears at idle", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    (
      window as unknown as {
        __pivisPreview: { replaceCustomEntryRuntime: (available: boolean) => void };
      }
    ).__pivisPreview.replaceCustomEntryRuntime(true);
  });
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    type PreviewSession = {
      authorityProjection?: {
        authoritativeSnapshot?: Record<string, unknown> & {
          sdk: Record<string, unknown>;
          activity: Record<string, unknown>;
        };
      };
    };
    type PreviewState = { activeSessionId: string; sessions: Map<string, PreviewSession> };
    type PreviewStore = {
      getState: () => PreviewState;
      setState: (update: { sessions: Map<string, PreviewSession> }) => void;
    };
    const store = (window as unknown as { __pivisStore: PreviewStore }).__pivisStore;
    const state = store.getState();
    const session = state.sessions.get(state.activeSessionId)!;
    const projection = session.authorityProjection!;
    const snapshot = projection.authoritativeSnapshot!;
    const sessions = new Map(state.sessions);
    sessions.set(state.activeSessionId, {
      ...session,
      authorityProjection: {
        ...projection,
        authoritativeSnapshot: {
          ...snapshot,
          sdk: { ...snapshot.sdk, isCompacting: true },
          activity: {
            ...snapshot.activity,
            compaction: {
              kind: "compaction",
              state: "active",
              attempt: 0,
              startedAt: Date.now() - 2_000,
            },
          },
        },
      },
    });
    store.setState({ sessions });
  });

  await expect(page.locator(".working-row")).toContainText("Compacting…");

  await page.evaluate(() => {
    type PreviewSession = {
      authorityProjection?: {
        authoritativeSnapshot?: Record<string, unknown> & {
          sdk: Record<string, unknown>;
          activity: Record<string, unknown>;
        };
      };
    };
    type PreviewState = { activeSessionId: string; sessions: Map<string, PreviewSession> };
    type PreviewStore = {
      getState: () => PreviewState;
      setState: (update: { sessions: Map<string, PreviewSession> }) => void;
    };
    const store = (window as unknown as { __pivisStore: PreviewStore }).__pivisStore;
    const state = store.getState();
    const session = state.sessions.get(state.activeSessionId)!;
    const projection = session.authorityProjection!;
    const snapshot = projection.authoritativeSnapshot!;
    const sessions = new Map(state.sessions);
    sessions.set(state.activeSessionId, {
      ...session,
      authorityProjection: {
        ...projection,
        authoritativeSnapshot: {
          ...snapshot,
          sdk: { ...snapshot.sdk, isCompacting: false },
          activity: { ...snapshot.activity, compaction: undefined },
        },
      },
    });
    store.setState({ sessions });
  });

  await expect(page.locator(".working-row")).toHaveCount(0);
});

test("streaming history tool calls render as interrupted without a spinner", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "interrupted-tool",
        type: "tool_call",
        data: {
          toolCallId: "call-interrupted",
          toolName: "read",
          outputText: "",
          isError: false,
          isStreaming: true,
        },
      },
    ]);
  });

  const card = page.locator(".tool-card");
  await expect(card.locator(".tool-card__spinner")).toHaveCount(0);
  await expect(card.locator(".tool-card__badge--interrupted")).toHaveText("interrupted");
  await expect(card).not.toHaveClass(/tool-card--error/);
});

test("large compact activity stays grouped across the archive/live boundary", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Settings" }).click();
  const transcriptStyle = page.getByRole("group", { name: "Transcript style" });
  await transcriptStyle.getByRole("button", { name: "Compact" }).click();
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
      applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "archived-thinking",
        type: "assistant",
        data: { segments: [{ kind: "thinking", content: "archived thought" }] },
      },
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `archived-tool-${index}`,
        type: "tool_call",
        data: {
          toolCallId: `archived-call-${index}`,
          toolName: "read",
          outputText: "done",
          isError: false,
          isStreaming: false,
        },
      })),
    ]);
    state.applyEvent(state.activeSessionId, {
      type: "tool_execution_start",
      toolCallId: "live-tool",
      toolName: "read",
      args: { path: "src/index.ts" },
    });
  });

  await page.evaluate(() => {
    const target = window as unknown as {
      __compactGroupRenders?: Record<"archived" | "live" | "group", number>;
      __compactArchivedItemCount?: number;
      __pivisTestCompactGroupItemsRender?: (detail: {
        source: "archived" | "live" | "group";
        itemCount: number;
      }) => void;
    };
    target.__compactGroupRenders = { archived: 0, live: 0, group: 0 };
    target.__pivisTestCompactGroupItemsRender = ({ source, itemCount }) => {
      target.__compactGroupRenders![source] += 1;
      if (source === "archived") target.__compactArchivedItemCount = itemCount;
    };
  });

  const summaries = page.locator(".compact-transcript-group__summary");
  await expect(summaries).toHaveCount(1);
  await expect(summaries).toContainText("Thinking, 501 tool calls");
  await summaries.click();
  await expect.poll(() => page.locator(".tool-card").count()).toBeGreaterThanOrEqual(501);
  const renderBaseline = await page.evaluate(() => {
    const target = window as unknown as {
      __compactGroupRenders: Record<"archived" | "live" | "group", number>;
      __compactArchivedItemCount: number;
    };
    return {
      archived: target.__compactGroupRenders.archived,
      live: target.__compactGroupRenders.live,
      archivedItems: target.__compactArchivedItemCount,
    };
  });
  expect(renderBaseline.archived).toBeGreaterThan(0);
  expect(renderBaseline.live).toBeGreaterThan(0);
  expect(renderBaseline.archivedItems).toBe(501);

  // Force separate React frames while the disclosure is open. The live child
  // must update, but the 501 archived items stay behind their memo boundary.
  await page.evaluate(async () => {
    type PreviewState = {
      activeSessionId: string;
      applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    for (let index = 0; index < 12; index += 1) {
      state.applyEvent(state.activeSessionId, {
        type: "tool_execution_update",
        toolCallId: "live-tool",
        toolName: "read",
        partialResult: `chunk-${index}`,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const renders = (
          window as unknown as {
            __compactGroupRenders: Record<"archived" | "live" | "group", number>;
          }
        ).__compactGroupRenders;
        return renders.archived;
      }),
    )
    .toBe(renderBaseline.archived);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const renders = (
          window as unknown as {
            __compactGroupRenders: Record<"archived" | "live" | "group", number>;
          }
        ).__compactGroupRenders;
        return renders.live;
      }),
    )
    .toBeGreaterThan(renderBaseline.live);
});

test("terminal archived activity stays active until visible live output", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Settings" }).click();
  const transcriptStyle = page.getByRole("group", { name: "Transcript style" });
  await transcriptStyle.getByRole("button", { name: "Compact" }).click();
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
      applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "terminal-thinking",
        type: "assistant",
        data: { segments: [{ kind: "thinking", content: "prior thought" }] },
      },
    ]);
    state.applyEvent(state.activeSessionId, {
      type: "message_start",
      message: { role: "assistant" },
    });
    (
      window as unknown as { __pivisPreview: { startStreaming: () => void } }
    ).__pivisPreview.startStreaming();
  });

  const boundarySummary = page.locator(".compact-transcript-group__summary", {
    hasText: "Thinking",
  });
  await expect(boundarySummary).toHaveCount(1);
  await expect(boundarySummary.locator(".compact-transcript-group__spinner")).toBeVisible();

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    state.applyEvent(state.activeSessionId, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "visible answer" },
    });
  });

  await expect(page.getByText("visible answer", { exact: true })).toBeVisible();
  await expect(boundarySummary.locator(".compact-transcript-group__spinner")).toHaveCount(0);
});

test("queued steering has exactly one visible projection", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    (
      window as unknown as {
        __pivisPreview: { setQueuedSteering: (text: string, intentId: string) => void };
      }
    ).__pivisPreview.setQueuedSteering("extension prefix exactly once", "render-intent");
  });

  const queuedProjection = page.locator(".queued-bubble__content", {
    hasText: "extension prefix exactly once",
  });
  const deliveredProjection = page
    .locator(".transcript-block--user")
    .filter({ hasText: "exactly once" });
  await expect(queuedProjection).toHaveCount(1);
  await expect(deliveredProjection).toHaveCount(0);
  await expect(page.getByText("Steering — queued", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      addUserMessage: (
        sessionId: string,
        text: string,
        images: undefined,
        options: Record<string, unknown>,
      ) => void;
      applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    state.addUserMessage(state.activeSessionId, "exactly once", undefined, {
      registerEcho: true,
      afterUserMessageSequence: 0,
      intentId: "render-intent",
    });
  });

  await expect(queuedProjection).toHaveCount(0);
  await expect(deliveredProjection).toHaveCount(1);
  await expect(page.getByText("Steering — queued", { exact: true })).toHaveCount(0);

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
    };
    const target = window as unknown as {
      __pivisPreview: { clearQueuedSteering: () => void };
      __pivisStore: { getState: () => PreviewState };
    };
    // Real Pi removes the public queue slot before its delivered user event.
    // Keep the preview authority in that same state so a later read-only query
    // cannot legitimately replay the stale queued projection.
    target.__pivisPreview.clearQueuedSteering();
    const state = target.__pivisStore.getState();
    state.applyEvent(state.activeSessionId, {
      type: "message_start",
      message: { role: "user", content: "rewritten exactly once" },
      queueIntentId: "render-intent",
    });
  });

  await expect(queuedProjection).toHaveCount(0);
  await expect(deliveredProjection).toHaveCount(1);
});
