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
      applyRuntimeState: (sessionId: string, state: Record<string, unknown>) => void;
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
    const snapshot = {
      hostInstanceId: "render-host",
      sessionEpoch: 1,
      snapshotSequence: 1,
      capturedAt: Date.now(),
      isStreaming: true,
      isIdle: false,
      isCompacting: false,
      isRetrying: false,
      retryAttempt: 0,
      isBashRunning: false,
      model: null,
      thinkingLevel: "off",
      sessionId: "render-session",
      pendingMessageCount: 0,
      steering: [],
      followUp: [],
      steeringIntentIds: [],
      followUpIntentIds: [],
      hostFacts: {
        submitting: false,
        actualCompaction: false,
        navigation: false,
        pendingDialogs: 0,
        custodyCount: 0,
      },
      catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
      editor: { revision: 0, text: "", attachments: [] },
    };
    state.applyRuntimeState(state.activeSessionId, {
      availability: "available",
      hostInstanceId: snapshot.hostInstanceId,
      sessionEpoch: snapshot.sessionEpoch,
      receivedAt: Date.now(),
      snapshot,
    });
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
    type PreviewState = {
      activeSessionId: string;
      applyRuntimeState: (sessionId: string, state: Record<string, unknown>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    const snapshot = {
      hostInstanceId: "render-host",
      sessionEpoch: 1,
      snapshotSequence: 1,
      capturedAt: Date.now(),
      isStreaming: true,
      isIdle: false,
      isCompacting: false,
      isRetrying: false,
      retryAttempt: 0,
      isBashRunning: false,
      model: null,
      thinkingLevel: "off",
      sessionId: "render-session",
      pendingMessageCount: 1,
      steering: ["extension prefix exactly once"],
      followUp: [],
      steeringIntentIds: ["render-intent"],
      followUpIntentIds: [],
      hostFacts: {
        submitting: false,
        actualCompaction: false,
        navigation: false,
        pendingDialogs: 0,
        custodyCount: 0,
      },
      catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
      editor: { revision: 0, text: "", attachments: [] },
    };
    state.applyRuntimeState(state.activeSessionId, {
      availability: "available",
      hostInstanceId: snapshot["hostInstanceId"],
      sessionEpoch: snapshot["sessionEpoch"],
      receivedAt: Date.now(),
      snapshot,
    });
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
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    state.applyEvent(state.activeSessionId, {
      type: "message_start",
      message: { role: "user", content: "rewritten exactly once" },
      queueIntentId: "render-intent",
    });
  });

  await expect(queuedProjection).toHaveCount(0);
  await expect(deliveredProjection).toHaveCount(1);
});
