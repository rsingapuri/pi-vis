import { expect, test } from "@playwright/test";

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
