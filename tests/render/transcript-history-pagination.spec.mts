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
      Array.from({ length: 250 }, (_, index) => ({
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

  await page.getByRole("button", { name: "Show 101 earlier messages" }).click();
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

test("successful pagination can be repeated until the start of history", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      setSessionFile: (sessionId: string, file: string) => void;
      seedHistory: (
        sessionId: string,
        history: { blocks: Array<Record<string, unknown>>; startIndex: number; total: number },
      ) => void;
    };
    const target = window as unknown as {
      __pivisStore: { getState: () => PreviewState };
      pivis: { invoke: (channel: string, payload?: unknown) => Promise<unknown> };
    };
    const state = target.__pivisStore.getState();
    const tail = Array.from({ length: 151 }, (_, index) => ({
      id: `tail-${index}`,
      type: "user",
      data: { content: `tail message ${index}` },
    }));
    state.setSessionFile(state.activeSessionId, "/preview/long-session.jsonl");
    state.seedHistory(state.activeSessionId, { blocks: tail, startIndex: 4, total: 155 });

    const originalInvoke = target.pivis.invoke;
    target.pivis.invoke = async (channel, payload) => {
      if (channel !== "session.loadHistory") return originalInvoke(channel, payload);
      const request = payload as { before: number; historyGeneration: number };
      const startIndex = Math.max(0, request.before - 2);
      return {
        status: "loaded",
        historyGeneration: request.historyGeneration,
        page: {
          blocks: Array.from({ length: request.before - startIndex }, (_, offset) => {
            const index = startIndex + offset;
            return {
              id: `earlier-${index}`,
              type: "user",
              data: { content: `earlier message ${index}` },
            };
          }),
          startIndex,
          total: 155,
        },
      };
    };
  });

  await page.getByRole("button", { name: "Show 4 earlier messages" }).click();
  await expect(page.getByRole("button", { name: "Show 2 earlier messages" })).toBeVisible();
  await page.getByRole("button", { name: "Show 2 earlier messages" }).click();
  await expect(page.getByRole("button", { name: /earlier messages/ })).toHaveCount(0);
  await expect(page.getByText("earlier message 0", { exact: true })).toBeVisible();
});

test("an unsuccessful earlier-history load keeps the retry control visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      setSessionFile: (sessionId: string, file: string) => void;
      seedHistory: (
        sessionId: string,
        history: { blocks: Array<Record<string, unknown>>; startIndex: number; total: number },
      ) => void;
    };
    type PreviewStore = {
      getState: () => PreviewState;
      setState: (partial: { loadEarlierHistory: (sessionId: string) => Promise<boolean> }) => void;
    };
    const target = window as unknown as {
      __pivisStore: PreviewStore;
      __historyLoadAttempts?: number;
    };
    const state = target.__pivisStore.getState();
    const blocks = Array.from({ length: 200 }, (_, index) => ({
      id: `history-${index}`,
      type: "user",
      data: { content: `history message ${index}` },
    }));
    state.setSessionFile(state.activeSessionId, "/preview/long-session.jsonl");
    state.seedHistory(state.activeSessionId, { blocks, startIndex: 25, total: 225 });
    target.__historyLoadAttempts = 0;
    target.__pivisStore.setState({
      loadEarlierHistory: async () => {
        target.__historyLoadAttempts = (target.__historyLoadAttempts ?? 0) + 1;
        return false;
      },
    });
  });

  const showEarlier = page.getByRole("button", { name: "Show 25 earlier messages" });
  await expect(showEarlier).toBeVisible();
  await showEarlier.click();
  await expect(showEarlier).toBeVisible();
  await showEarlier.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __historyLoadAttempts: number }).__historyLoadAttempts,
      ),
    )
    .toBe(2);
});
