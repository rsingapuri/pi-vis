/**
 * Render test: the custom() panel (CustomPanelHost) is a STABLE, deterministic
 * viewport box — NOT content-hugged.
 *
 * A custom() panel is always a full-frame pi-tui overlay (e.g. /rtk's centered
 * `maxHeight:"85%"` config modal). Its rendered height is a function of the grid
 * we report, so content-tracking it chases the overlay's centering padding and
 * thrashes (a huge mostly-blank box with the modal shoved to an edge, clipped —
 * the reported bug). Instead the panel is pinned to the display cap (~half the
 * transcript column), re-derived on resize, with the overlay self-scrolling
 * inside. This test pins:
 *   • the panel is ~half the column tall even for a short box (NOT hugged down);
 *   • it does not scroll at the card level (the overlay self-scrolls);
 *   • its height is a pure function of the column height — shrink then re-grow
 *     the window and it returns to the same size (no resize hysteresis).
 *
 * Drives the REAL renderer (served by `npm run dev:renderer` with the stubbed
 * window.pivis) with headless chromium — no Electron, no real pi. The preview
 * stub (?panel=1) emits the panel_open + panel_data events a custom() call
 * produces.
 */
import { expect, test } from "@playwright/test";

interface Metrics {
  scrollH: number;
  sessionH: number;
  overflowY: string;
  hasContent: boolean;
}

async function readMetrics(page: import("@playwright/test").Page): Promise<Metrics> {
  return page.evaluate(() => {
    const scroll = document.querySelector(".custom-panel__scroll") as HTMLElement;
    const session = document.querySelector(".app__session") as HTMLElement;
    const rows = document.querySelector(".custom-panel__xterm .xterm-rows") as HTMLElement | null;
    return {
      scrollH: scroll.getBoundingClientRect().height,
      sessionH: session.clientHeight,
      overflowY: scroll.style.overflowY,
      hasContent: !!rows && /RTK/.test(rows.innerText),
    };
  });
}

/** Read the box height once it has stopped changing (the sizer settles over a
 *  couple of animation frames + a ResizeObserver tick). */
async function settledHeight(page: import("@playwright/test").Page): Promise<number> {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const h = (await readMetrics(page)).scrollH;
    if (Math.abs(h - last) < 0.5 && h > 0) return h;
    last = h;
    await page.waitForTimeout(80);
  }
  return last;
}

test.describe("Custom() panel (CustomPanelHost) — stable viewport sizing", () => {
  test("a short overlay: the panel is a stable ~half-column box, not hugged to the content", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("/?panel=1");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".custom-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("RTK", { timeout: 15_000 });

    const m = await readMetrics(page);
    // The overlay box is only ~7 rows (~120px). If it were content-hugged the
    // panel would be ~that tall; instead it's pinned near the ~50% display cap —
    // far taller than the box. So it reads as a stable modal viewport.
    expect(m.hasContent).toBe(true);
    expect(m.scrollH).toBeGreaterThan(m.sessionH * 0.35);
    expect(m.scrollH).toBeLessThanOrEqual(m.sessionH * 0.5 + 8);
    // Pinned viewport → the card does NOT scroll (the overlay self-scrolls).
    expect(m.overflowY).toBe("hidden");
  });

  test("deterministic size: shrink then grow the window returns to the same size", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("/?panel=1");
    await page.waitForLoadState("domcontentloaded");

    const panel = page.locator(".custom-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("RTK", { timeout: 15_000 });

    const tallOpen = await settledHeight(page);

    // Shrink → the display cap (and the box) shrink with the column.
    await page.setViewportSize({ width: 1100, height: 560 });
    const shrunk = await settledHeight(page);
    expect(shrunk).toBeLessThan(tallOpen);

    // Grow back to the ORIGINAL size → the panel re-expands to the SAME height
    // (the reported bug: it shrank on shrink but never re-expanded). Size is a
    // pure function of the current column, with no dependence on the path taken.
    await page.setViewportSize({ width: 1100, height: 900 });
    const regrown = await settledHeight(page);
    expect(regrown).toBeGreaterThan(shrunk);
    expect(Math.abs(regrown - tallOpen)).toBeLessThanOrEqual(2);
  });
});

test.describe("Custom() panel — manual resize handle", () => {
  test("the handle is a visible row-resize strip", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("/?panel=1");
    await page.waitForLoadState("domcontentloaded");
    const panel = page.locator(".custom-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("RTK", { timeout: 15_000 });

    const handle = page.locator(".custom-panel-dock-resize");
    await expect(handle).toBeVisible();
    // The strip is now attached to the top of the widget tray/dock, not inside
    // the custom panel itself.
    const insidePanel = await handle.evaluate((el) => el.closest(".custom-panel") !== null);
    expect(insidePanel).toBe(false);
    const handleBox = await handle.boundingBox();
    const dockBox = await page.locator(".session-dock").boundingBox();
    expect(handleBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    // The handle is its own gutter directly above the dock, not an overlay on
    // top of it, so it cannot steal the dock's top-row clicks.
    expect((handleBox?.y ?? 0) + (handleBox?.height ?? 0)).toBeCloseTo(dockBox?.y ?? 0, 0);
    // The gutter itself is transparent, but it exposes a subtle centered pill
    // so the resize affordance is visible.
    const bg = await handle.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgba(0, 0, 0, 0)");
    const affordanceBg = await handle.evaluate((el) =>
      window.getComputedStyle(el, "::before").backgroundColor,
    );
    expect(affordanceBg).not.toBe("rgba(0, 0, 0, 0)");
    const cursor = await handle.evaluate((el) => window.getComputedStyle(el).cursor);
    expect(cursor).toBe("row-resize");
  });

  test("dragging the handle resizes the panel and persists the fraction", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("/?panel=1");
    await page.waitForLoadState("domcontentloaded");
    const panel = page.locator(".custom-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("RTK", { timeout: 15_000 });

    const handle = page.locator(".custom-panel-dock-resize");
    const before = await settledHeight(page);
    // Default cap is ~50% of the 900px column (~450px). Grow toward ~75% by
    // dragging the top edge up so the panel becomes ~675px.
    const box = await handle.boundingBox();
    const sessionH = await page.evaluate(
      () => (document.querySelector(".app__session") as HTMLElement).clientHeight,
    );
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    // Panel is bottom-anchored: new height = panelBottom − cursorY. Pick a Y that
    // targets ~0.75 of the column.
    const cardBottom = await page.evaluate(() => {
      const card = document.querySelector(".custom-panel") as HTMLElement;
      return card.getBoundingClientRect().bottom;
    });
    const targetY = cardBottom - sessionH * 0.75;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, targetY, { steps: 10 });
    await page.mouse.up();

    const afterDrag = await settledHeight(page);
    // Grew well past the ~50% default (toward 75%).
    expect(afterDrag).toBeGreaterThan(before + 100);

    // Persisted as a fraction (0.2–0.9) in app settings.
    const persisted = await page.evaluate(() =>
      (window as unknown as { pivis: { invoke: (c: string) => Promise<unknown> } }).pivis
        .invoke("settings.get")
        .then((s) => (s as { customPanelHeightFraction?: number }).customPanelHeightFraction),
    );
    expect(persisted).toBeGreaterThan(0.6);
    expect(persisted).toBeLessThan(0.9);
  });

  test("double-clicking the handle resets to the default height", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("/?panel=1");
    await page.waitForLoadState("domcontentloaded");
    const panel = page.locator(".custom-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".xterm-rows")).toContainText("RTK", { timeout: 15_000 });

    const handle = page.locator(".custom-panel-dock-resize");
    const defaultH = await settledHeight(page);

    // First grow the panel via a drag (toward ~75%).
    const box = await handle.boundingBox();
    const sessionH = await page.evaluate(
      () => (document.querySelector(".app__session") as HTMLElement).clientHeight,
    );
    const cardBottom = await page.evaluate(() => {
      const card = document.querySelector(".custom-panel") as HTMLElement;
      return card.getBoundingClientRect().bottom;
    });
    const startX = box.x + box.width / 2;
    await page.mouse.move(startX, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(startX, cardBottom - sessionH * 0.75, { steps: 10 });
    await page.mouse.up();
    const grown = await settledHeight(page);
    expect(grown).toBeGreaterThan(defaultH + 100);

    // Double-click → back to the default height, and the override is cleared.
    await handle.dblclick();
    const reset = await settledHeight(page);
    expect(Math.abs(reset - defaultH)).toBeLessThanOrEqual(4);
    const persisted = await page.evaluate(() =>
      (window as unknown as { pivis: { invoke: (c: string) => Promise<unknown> } }).pivis
        .invoke("settings.get")
        .then(
          (s) => (s as { customPanelHeightFraction?: number | null }).customPanelHeightFraction,
        ),
    );
    expect(persisted).toBeNull();
  });
});
