import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

interface PreviewStoreState {
  activeSessionId: string;
  setSessionName: (sessionId: string, name: string) => void;
  seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
}

async function setLongTitle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
      .__pivisStore;
    const state = store.getState();
    state.setSessionName(
      state.activeSessionId,
      "A very long session title that should fade instead of forcing the application grid wider than the viewport when the sidebar is collapsed",
    );
  });
}

async function seedHorizontalRuleMessage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __pivisStore: { getState: () => PreviewStoreState } })
      .__pivisStore;
    const state = store.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "hr-assistant",
        type: "assistant",
        data: { content: "Before\n\n* * *\n\nAfter" },
      },
    ]);
  });
}

test.describe("layout overflow and markdown separators", () => {
  test("collapsing the sidebar with a fading long title does not widen or clip the main grid", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 780, height: 620 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

    await setLongTitle(page);
    await expect(page.locator(".fade-text[data-overflow='true']").first()).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator(".app--sidebar-collapsed")).toBeVisible();

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const viewport = window.innerWidth;
          const selectors = [".titlebar", ".app__main", ".transcript-region", ".composer"];
          return selectors.map((selector) => {
            const el = document.querySelector(selector) as HTMLElement | null;
            if (!el) return { selector, ok: false, left: Number.NaN, right: Number.NaN, viewport };
            const rect = el.getBoundingClientRect();
            return {
              selector,
              ok: rect.left >= -1 && rect.right <= viewport + 1,
              left: rect.left,
              right: rect.right,
              viewport,
            };
          });
        });
      })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ selector: ".titlebar", ok: true }),
          expect.objectContaining({ selector: ".app__main", ok: true }),
          expect.objectContaining({ selector: ".transcript-region", ok: true }),
          expect.objectContaining({ selector: ".composer", ok: true }),
        ]),
      );
  });

  test("markdown thematic breaks render as the styled separator, not a default thick rule", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 620 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });
    await seedHorizontalRuleMessage(page);

    const hr = page.locator(".transcript-block__content hr");
    await expect(hr).toHaveCount(1);
    await expect
      .poll(() =>
        hr.evaluate((el) => {
          const style = getComputedStyle(el as HTMLElement);
          return {
            height: style.height,
            borderTopWidth: style.borderTopWidth,
            backgroundImage: style.backgroundImage,
          };
        }),
      )
      .toEqual(
        expect.objectContaining({
          height: "1px",
          borderTopWidth: "0px",
          backgroundImage: expect.stringContaining("linear-gradient"),
        }),
      );
  });
});
