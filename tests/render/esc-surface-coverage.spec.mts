/**
 * Render test: ESC-surface coverage matrix (§5.6 of the ESC-to-interrupt plan).
 *
 * Regression net for "a surface forgot to claim ESC." For each ESC-owning
 * surface that is reachable in the preview: open it with a background
 * streaming session, press ESC, and assert the surface closed/acted AND the
 * abort did NOT fire. When a new ESC-owning surface is added, add a row here.
 *
 * Drives the REAL renderer (served by `npm run dev:renderer`) with the
 * stubbed `window.pivis`. Abort count is observed via `window.__pivisPreview`
 * (see preview-stub.ts).
 *
 * NOTE: surfaces that require pi-side state not reproducible in the preview
 * (extension dialogs, custom() panels, the unified-TUI editor autocomplete)
 * have their claim wiring covered by the unit tests in
 * useEscapeClaim/overlay-store and their behavioral contract by the
 * host-side unified-tui.test.mjs gate. The rows here cover the surfaces
 * directly openable from the renderer UI.
 */
import { expect, test } from "@playwright/test";

type PreviewHooks = {
  abortCalls: number;
  startStreaming: () => void;
  stopStreaming: () => void;
};

type PreviewStore = {
  getState: () => {
    activeSessionId: string | null;
    addUserMessage: (sessionId: string, content: string, images?: string[]) => void;
  };
};

async function abortCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    return (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview.abortCalls;
  });
}

async function startStreaming(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview.startStreaming();
  });
}

test.describe("ESC surface coverage — claims prevent abort", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".composer__textarea")).toBeVisible({ timeout: 20_000 });
  });

  test("Composer autocomplete: ESC closes suggestions, does NOT abort (even streaming)", async ({
    page,
  }) => {
    // An open autocomplete ALWAYS consumes the first ESC (the two-press model) —
    // even while streaming. The abort only happens once suggestions are closed,
    // so the first ESC here must close them and NOT abort the background turn.
    await startStreaming(page);
    const textarea = page.locator(".composer__textarea");
    await textarea.focus();
    await textarea.fill("/");
    await expect(page.locator(".composer__suggestion").first()).toBeVisible({
      timeout: 5_000,
    });

    const before = await abortCount(page);
    await textarea.press("Escape");
    // Suggestions closed.
    await expect(page.locator(".composer__suggestion")).toHaveCount(0);
    // No abort fired.
    expect(await abortCount(page)).toBe(before);
  });

  test("Settings: ESC closes Settings, does NOT abort a background session", async ({ page }) => {
    await startStreaming(page);
    // Open settings via the sidebar button. This exercises the same user-visible
    // surface that claims ESC in the real shell.
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator(".settings-overlay")).toBeVisible({ timeout: 10_000 });

    const before = await abortCount(page);
    await page.keyboard.press("Escape");
    // Settings closed.
    await expect(page.locator(".settings-overlay")).toHaveCount(0);
    expect(await abortCount(page)).toBe(before);
  });

  test("Diff viewer: ESC closes the viewer, does NOT abort", async ({ page }) => {
    await startStreaming(page);
    // Cmd/Ctrl+G toggles the diff viewer.
    await page.keyboard.press("Meta+g");
    await expect(page.locator(".diff-overlay")).toBeVisible({ timeout: 15_000 });

    const before = await abortCount(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".diff-overlay")).toHaveCount(0);
    expect(await abortCount(page)).toBe(before);
  });

  test("Image lightbox: ESC closes the preview, does NOT abort", async ({ page }) => {
    await page.evaluate(() => {
      const store = (window as unknown as { __pivisStore: PreviewStore }).__pivisStore.getState();
      const sessionId = store.activeSessionId;
      if (!sessionId) throw new Error("missing active session");
      store.addUserMessage(sessionId, "Attached screenshot", [
        "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='80'%20height='48'%3E%3Crect%20width='80'%20height='48'%20fill='%2389b4fa'/%3E%3C/svg%3E",
      ]);
    });
    await page.locator(".transcript-block__image-button").last().click();
    await expect(page.locator(".image-lightbox")).toBeVisible({ timeout: 5_000 });

    await startStreaming(page);
    const before = await abortCount(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".image-lightbox")).toHaveCount(0);
    expect(await abortCount(page)).toBe(before);
  });

  test("no surface open + streaming: ESC DOES abort (the positive case)", async ({ page }) => {
    await startStreaming(page);
    const before = await abortCount(page);
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".composer__textarea")!;
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(await abortCount(page)).toBeGreaterThan(before);
  });
});
