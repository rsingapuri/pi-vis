/**
 * Render tests for the transcript's bottom-follow invariant.
 *
 * Custom/unified TUI panels replace the Composer and are sized by xterm after
 * React commits. That shrinks the transcript viewport without being a user
 * scroll; the feed must remain pinned to the newest content unless the user
 * explicitly scrolls up.
 */
import { expect, test } from "@playwright/test";

const BOTTOM_EPSILON_PX = 1;
const SMALL_SCROLL_PX = 12;

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

async function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => (document.querySelector(".transcript-view") as HTMLElement).scrollTop);
}

async function simulateSmallArrowUp(page: Page): Promise<void> {
  await page.evaluate((amount) => {
    const el = document.querySelector(".transcript-view") as HTMLElement;
    // Keep this deterministic while exercising the same capture-phase intent
    // path as a real ArrowUp. Assigning scrollTop stands in for the browser's
    // native scroll, whose exact timing and step vary across platforms.
    el.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }),
    );
    el.scrollTop = Math.max(0, el.scrollTop - amount);
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, SMALL_SCROLL_PX);
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
  await expect
    .poll(() => bottomDistance(page), { timeout: 5_000 })
    .toBeLessThanOrEqual(BOTTOM_EPSILON_PX);
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

    // A layout-only movement must be corrected even when it is the same small
    // distance that would unpin after explicit user input.
    await page.evaluate((amount) => {
      const el = document.querySelector(".transcript-view") as HTMLElement;
      el.scrollTop = Math.max(0, el.scrollTop - amount);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, SMALL_SCROLL_PX);
    await waitPinned(page);
    await expectPinnedScrollbar(page, true);

    await simulateSmallArrowUp(page);
    await expect
      .poll(() => bottomDistance(page), { timeout: 5_000 })
      .toBeGreaterThan(BOTTOM_EPSILON_PX);
    expect(await bottomDistance(page)).toBeLessThan(24);
    await expectPinnedScrollbar(page, false);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              getComputedStyle(
                document.querySelector(".transcript-region") as HTMLElement,
                "::after",
              ).opacity,
          ),
        { timeout: 2_000 },
      )
      .toBe("1");
    const fadeGeometry = await page.evaluate(() => {
      const transcript = document.querySelector(".transcript-view") as HTMLElement;
      const region = document.querySelector(".transcript-region") as HTMLElement;
      const fade = getComputedStyle(region, "::after");
      return {
        transcriptMask: getComputedStyle(transcript).maskImage,
        transcriptWebkitMask: getComputedStyle(transcript).getPropertyValue("-webkit-mask-image"),
        fadeOpacity: fade.opacity,
        fadeRight: fade.right,
      };
    });
    expect(fadeGeometry).toEqual({
      transcriptMask: "none",
      transcriptWebkitMask: "none",
      fadeOpacity: "1",
      fadeRight: "10px",
    });
    const scrollbackGeometry = await readingColumnGeometry(page);
    expect(scrollbackGeometry.left).toBeCloseTo(pinnedGeometry.left, 5);
    expect(scrollbackGeometry.width).toBeCloseTo(pinnedGeometry.width, 5);

    const before = await bottomDistance(page);
    const readingAnchor = await scrollTop(page);
    await appendAssistantText(page, `\n\nUser-scrolled follow-up ${"more text ".repeat(80)}`);
    await expect
      .poll(() => bottomDistance(page), { timeout: 2_000 })
      .toBeGreaterThan(Math.min(BOTTOM_EPSILON_PX + 1, before));
    await expect.poll(() => scrollTop(page), { timeout: 2_000 }).toBeCloseTo(readingAnchor, 0);
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
