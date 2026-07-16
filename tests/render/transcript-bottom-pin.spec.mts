/**
 * Render tests for the transcript's bottom-follow invariant.
 *
 * Custom/unified TUI panels replace the Composer and are sized by xterm after
 * React commits. That shrinks the transcript viewport without being a user
 * scroll; the feed must remain pinned to the newest content unless the user
 * explicitly scrolls up.
 */
import { expect, test } from "@playwright/test";

const RESTICK_PX = 24;

type Page = import("@playwright/test").Page;

interface PreviewStoreState {
  activeSessionId: string;
  applyEvent: (sessionId: string, event: Record<string, unknown>) => void;
}

async function bottomDistance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector(".transcript-view") as HTMLElement;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

async function appendAssistantText(page: Page, text: string): Promise<void> {
  await page.evaluate((delta) => {
    const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
      .__pivisStore;
    const state = store.getState();
    const sid = state.activeSessionId;
    state.applyEvent(sid, { type: "message_start", message: { role: "assistant" } });
    state.applyEvent(sid, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta },
    });
    state.applyEvent(sid, { type: "message_end", message: { role: "assistant" } });
  }, text);
}

async function waitPinned(page: Page): Promise<void> {
  await expect.poll(() => bottomDistance(page), { timeout: 5_000 }).toBeLessThanOrEqual(RESTICK_PX);
}

async function expectPinnedScrollbar(page: Page, pinned: boolean): Promise<void> {
  const transcript = page.locator(".transcript-view");
  if (pinned) {
    await expect(transcript).toHaveClass(/transcript-view--pinned/);
  } else {
    await expect(transcript).not.toHaveClass(/transcript-view--pinned/);
  }
  // The pinned state makes the thumb transparent but retains the shared
  // scrollbar width, reserving the reading-column gutter before scrollback.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector(".transcript-view") as HTMLElement;
        return getComputedStyle(el, "::-webkit-scrollbar").width;
      }),
    )
    .toBe("10px");
}

async function readingColumnGeometry(page: Page): Promise<{ left: number; width: number }> {
  return page.evaluate(() => {
    const rect = document.querySelector(".transcript-blocks")?.getBoundingClientRect();
    if (!rect) throw new Error("Missing transcript reading column");
    return { left: rect.left, width: rect.width };
  });
}

test.describe("Transcript bottom pinning across Composer replacements", () => {
  test("a JS-sized custom panel opening does not unpin the transcript", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.goto("/?panel=1");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator(".custom-panel")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".custom-panel .xterm-rows")).toContainText("RTK", {
      timeout: 15_000,
    });
    await waitPinned(page);
    await expectPinnedScrollbar(page, true);

    await appendAssistantText(
      page,
      `\n\nPanel-open follow-up ${"more text ".repeat(80)}\n\n- one\n- two\n- three`,
    );
    await waitPinned(page);
  });

  test("layout-only scroll movement is corrected, but real user scroll-up is preserved", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.goto("/?unified=1");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator(".unified-panel")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".unified-panel .xterm-rows")).toContainText("Fleet", {
      timeout: 15_000,
    });
    await waitPinned(page);
    await appendAssistantText(
      page,
      `\n\nOverflow setup ${Array.from({ length: 30 }, (_, i) => `- setup line ${i + 1}`).join("\n")}`,
    );
    await waitPinned(page);
    await expectPinnedScrollbar(page, true);
    const pinnedGeometry = await readingColumnGeometry(page);

    // Simulate a browser/layout scrollTop correction without any wheel/touch/key
    // input. This used to be enough to clear pinnedRef, after which streaming
    // tokens no longer followed the bottom.
    await page.evaluate(() => {
      const el = document.querySelector(".transcript-view") as HTMLElement;
      el.scrollTop = Math.max(0, el.scrollTop - 120);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitPinned(page);
    await expectPinnedScrollbar(page, true);

    const transcript = page.locator(".transcript-view");
    await transcript.hover();
    await page.mouse.wheel(0, -500);
    await expect.poll(() => bottomDistance(page), { timeout: 5_000 }).toBeGreaterThan(RESTICK_PX);
    await expectPinnedScrollbar(page, false);
    const scrollbackGeometry = await readingColumnGeometry(page);
    expect(scrollbackGeometry.left).toBeCloseTo(pinnedGeometry.left, 5);
    expect(scrollbackGeometry.width).toBeCloseTo(pinnedGeometry.width, 5);

    const before = await bottomDistance(page);
    await appendAssistantText(page, `\n\nUser-scrolled follow-up ${"more text ".repeat(80)}`);
    await expect
      .poll(() => bottomDistance(page), { timeout: 2_000 })
      .toBeGreaterThan(Math.min(RESTICK_PX + 1, before));
    await expectPinnedScrollbar(page, false);

    await page.evaluate(() => {
      const el = document.querySelector(".transcript-view") as HTMLElement;
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitPinned(page);
    await expectPinnedScrollbar(page, true);
  });
});
