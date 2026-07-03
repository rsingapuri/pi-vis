import { expect, test } from "@playwright/test";

test.describe("tool output detail UI", () => {
  test("short input summaries keep the same spaced card layout", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => {
      const store = (
        window as unknown as {
          __pivisStore?: { getState: () => { activeSessionId?: string | null } };
        }
      ).__pivisStore;
      return !!store?.getState().activeSessionId;
    });
    await page.waitForTimeout(800);

    await page.evaluate(() => {
      interface PreviewStoreState {
        activeSessionId: string;
        applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
      }
      const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
        .__pivisStore;
      const state = store.getState();
      const sessionId = state.activeSessionId;
      state.applyEvent(sessionId, {
        type: "tool_execution_start",
        toolCallId: "short-input",
        toolName: "read",
        args: { path: "short.txt" },
      });
      state.applyEvent(sessionId, {
        type: "tool_execution_end",
        toolCallId: "short-input",
        toolName: "read",
        result: { content: [] },
        isError: false,
      });
    });

    const card = page.locator(".tool-card").filter({ hasText: "short.txt" }).first();
    await card.locator("button.tool-card__header").click();
    const input = card.locator(".tool-card__args--inline");
    await expect(input).toContainText("input");
    await expect(input).toContainText("path=short.txt");
    await expect(input).toHaveCSS("display", "flex");
  });

  test("lossy compact input summaries expose the full input JSON", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => {
      const store = (
        window as unknown as {
          __pivisStore?: { getState: () => { activeSessionId?: string | null } };
        }
      ).__pivisStore;
      return !!store?.getState().activeSessionId;
    });
    await page.waitForTimeout(800);

    await page.evaluate(() => {
      interface PreviewStoreState {
        activeSessionId: string;
        applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
      }
      const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
        .__pivisStore;
      const state = store.getState();
      const sessionId = state.activeSessionId;
      state.applyEvent(sessionId, {
        type: "tool_execution_start",
        toolCallId: "lossy-input",
        toolName: "multi_input",
        args: {
          prompt: "first line\nsecond line",
          payload: "x".repeat(140),
        },
      });
      state.applyEvent(sessionId, {
        type: "tool_execution_end",
        toolCallId: "lossy-input",
        toolName: "multi_input",
        result: { content: [] },
        isError: false,
      });
    });

    const card = page.locator(".tool-card").filter({ hasText: "multi_input" }).first();
    await card.locator("button.tool-card__header").click();
    await card.locator(".tool-card__args-summary").click();
    await expect(card.locator(".tool-card__args-full")).toContainText("second line");
    await expect(card.locator(".tool-card__args-full")).toContainText("x".repeat(140));
  });

  test("metadata-only tool results are still expandable", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => {
      const store = (
        window as unknown as {
          __pivisStore?: { getState: () => { activeSessionId?: string | null } };
        }
      ).__pivisStore;
      return !!store?.getState().activeSessionId;
    });
    await page.waitForTimeout(800);

    await page.evaluate(() => {
      interface PreviewStoreState {
        activeSessionId: string;
        applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
      }
      const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
        .__pivisStore;
      const state = store.getState();
      const sessionId = state.activeSessionId;
      state.applyEvent(sessionId, {
        type: "tool_execution_start",
        toolCallId: "metadata-only",
        toolName: "metadata_only",
      });
      state.applyEvent(sessionId, {
        type: "tool_execution_end",
        toolCallId: "metadata-only",
        toolName: "metadata_only",
        result: {
          content: [],
          details: { fullOutputPath: "/tmp/metadata-only-full.log" },
        },
        isError: false,
      });
    });

    const card = page.locator(".tool-card").filter({ hasText: "metadata_only" }).first();
    await expect(card).toBeVisible();
    await card.locator("button.tool-card__header").click();
    await expect(card.locator(".tool-card__metadata-summary")).toContainText(
      "full output saved on disk",
    );
  });

  test("expanded long output uses a compact virtualized inspector", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto("/?toolOutput=1");
    await page.waitForLoadState("domcontentloaded");

    const card = page.locator(".tool-card").filter({ hasText: "generate-report" }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator("button.tool-card__header").click();

    await expect(card.locator(".tool-card__metadata-summary")).toContainText(
      "pi retained 180 of 4,200 lines",
    );
    await expect(card.locator(".tool-card__output-panel")).toBeVisible();
    const outputRegion = card.getByRole("region", { name: "output (180 lines)" });
    await expect(outputRegion).toHaveAttribute("tabindex", "0");
    await outputRegion.focus();
    await expect(outputRegion).toBeFocused();
    await expect(card.locator(".tool-card__output-line").first()).toContainText("preview-line-001");
    await expect.poll(() => card.locator(".tool-card__output-line").count()).toBeLessThan(90);

    await outputRegion.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(card.locator(".tool-card__output-line").last()).toContainText("preview-line-180");
    await expect(card.locator(".tool-card__output-frame")).toHaveClass(/fade-top/);
  });
});
