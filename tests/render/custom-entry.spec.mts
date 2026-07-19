import { expect, test } from "@playwright/test";

test.describe("Pi 0.80.10 extension entry inspectors", () => {
  test("shows a collapsed raw card only after the extension renderer accepts the entry", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/?customEntry=1");

    const entry = page.locator(".custom-entry");
    const card = entry.locator(".tool-card");
    const header = card.getByRole("button", { name: "status-card extension entry details" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    const controlledId = await header.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    await expect(card.locator(".tool-card__body")).toHaveCount(0);
    await expect(card.locator(".tool-card__extension-render")).toHaveCount(0);
    await expect(card).not.toContainText("Indexed files: 17");

    await header.click();

    const body = card.locator(".tool-card__body");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
    await expect(header).toHaveAttribute("aria-controls", await body.getAttribute("id"));
    await expect(card).toContainText("preview-custom-entry");
    await expect(card).toContainText('"title": "Indexed files"');
    await expect(card).toContainText('"count": 17');
    await expect(card.locator(".tool-card__extension-render")).toContainText("Indexed files: 17");
    await expect(card.locator(".tool-card__extension-render")).toContainText(
      /Rendered responsively at \d+ columns/,
    );
    await expect(card.locator(".tool-card__extension-render span").first()).toHaveCSS(
      "font-weight",
      "700",
    );
    await expect(card.locator("details")).toHaveCount(0);

    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(body).toHaveCount(0);
  });

  test("hides the raw record when renderer ownership disappears and restores it on rebind", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/?customEntry=1");

    const entry = page.locator(".custom-entry");
    const card = entry.locator(".tool-card");
    const header = card.getByRole("button", { name: "status-card extension entry details" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await header.click();
    await expect(card.locator(".tool-card__extension-render")).toContainText("renderer v1");
    await expect(card).toContainText('"count": 17');

    await page.evaluate(() => {
      const preview = (
        window as unknown as {
          __pivisPreview: {
            replaceCustomEntryRuntime: (available: boolean, version?: number) => void;
          };
        }
      ).__pivisPreview;
      preview.replaceCustomEntryRuntime(false);
    });
    await expect(card).toHaveCount(0);

    await page.evaluate(() => {
      const preview = (
        window as unknown as {
          __pivisPreview: {
            replaceCustomEntryRuntime: (available: boolean, version?: number) => void;
          };
        }
      ).__pivisPreview;
      preview.replaceCustomEntryRuntime(true, 2);
    });
    await expect(card).toBeVisible();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".tool-card__extension-render")).toContainText("renderer v2");
    await expect(card).toContainText('"count": 17');
  });

  test("keeps an entry hidden when no extension renderer owns it", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/?customEntry=1");
    await page.waitForFunction(
      () =>
        !!(
          window as unknown as {
            __pivisPreview?: { replaceCustomEntryRuntime?: unknown };
          }
        ).__pivisPreview?.replaceCustomEntryRuntime,
    );
    await page.evaluate(() => {
      (
        window as unknown as {
          __pivisPreview: {
            replaceCustomEntryRuntime: (available: boolean, version?: number) => void;
          };
        }
      ).__pivisPreview.replaceCustomEntryRuntime(false);
    });

    const entry = page.locator(".custom-entry");
    await expect(entry).toHaveCount(1, { timeout: 10_000 });
    await expect(entry.locator(".tool-card")).toHaveCount(0);
    await expect(page.getByText("status-card", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    const transcriptStyle = page.getByRole("group", { name: "Transcript style" });
    await transcriptStyle.getByRole("button", { name: "Compact" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".compact-transcript-group__summary")).toHaveCount(0);
    await expect(entry.locator(".tool-card")).toHaveCount(0);
  });

  test("measures extension columns using the configured code font", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/?customEntry=1");

    const entry = page.locator(".custom-entry");
    const card = entry.locator(".tool-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--font-size-code-root", "28px");
      document.documentElement.style.setProperty("--font-code", "monospace");
    });
    await card.getByRole("button", { name: "status-card extension entry details" }).click();

    const renderedCols = async (): Promise<number> => {
      const text = (await card.locator(".tool-card__extension-render").textContent()) ?? "";
      return Number(/Rendered responsively at (\d+) columns/.exec(text)?.[1] ?? 0);
    };
    await expect.poll(renderedCols).toBeLessThan(70);
    const largeFontCols = await renderedCols();

    await page.evaluate(() => {
      document.documentElement.style.setProperty("--font-size-code-root", "14px");
    });
    await page.setViewportSize({ width: 1099, height: 800 });
    await expect.poll(renderedCols).toBeGreaterThan(largeFontCols + 20);
  });
});
