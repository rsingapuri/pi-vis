import { expect, test } from "@playwright/test";

type PreviewHooks = {
  extensionUpdateCheckCalls: number;
  extensionUpdateTargets: Array<"all" | { extension: string }>;
};

test("Settings lists every installed extension with version status", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "Settings" }).click();

  const check = page.getByRole("button", { name: "Check extensions" });
  await expect(check).toBeVisible();
  await expect
    .poll(() =>
      page.locator(".settings-section--updates").evaluate((updates) => {
        const top = updates.getBoundingClientRect().top;
        const sectionTops = [...document.querySelectorAll(".settings-section")].map(
          (section) => section.getBoundingClientRect().top,
        );
        return top === Math.min(...sectionTops);
      }),
    )
    .toBe(true);

  await expect(page.getByText("@pi/mcp", { exact: true })).toBeVisible();
  await expect(page.getByText("github.com/example/pi-tools", { exact: true })).toBeVisible();
  await expect(page.getByText("@pi/format", { exact: true })).toBeVisible();
  await expect(page.getByText("2 updates available", { exact: true })).toBeVisible();
  await expect(page.getByText("Installed extensions", { exact: true })).toBeVisible();
  await expect(page.getByText("1.0.0", { exact: true })).toBeVisible();
  await expect(page.getByText("1.1.0", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update all" })).toBeVisible();
  await expect(page.locator(".sidebar__settings-update-count")).toHaveText("2");
  await expect(page.locator(".settings-extension-update")).toHaveCount(3);
  await expect
    .poll(() =>
      page.locator(".settings-extension-updates").evaluate((updates) => {
        const bulkAction = updates.querySelector<HTMLButtonElement>(
          ".settings-extension-updates__header button",
        );
        const rowActions = [
          ...updates.querySelectorAll<HTMLButtonElement>(".settings-extension-update > button"),
        ];
        if (!bulkAction || rowActions.length === 0) return false;
        return rowActions.every(
          (action) =>
            Math.abs(
              action.getBoundingClientRect().right - bulkAction.getBoundingClientRect().right,
            ) < 1,
        );
      }),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Update pi" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview
            .extensionUpdateCheckCalls,
      ),
    )
    .toBe(1);

  // Reopening consumes the launch/first-open cache instead of duplicating the
  // package-manager pass. The explicit button remains a fresh manual check.
  await page.locator(".settings-panel__close").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("2 updates available", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview
            .extensionUpdateCheckCalls,
      ),
    )
    .toBe(1);

  await check.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview
            .extensionUpdateCheckCalls,
      ),
    )
    .toBe(2);

  await page.getByRole("button", { name: "Update @pi/mcp" }).click();
  await expect(page.getByText("@pi/mcp", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update @pi/mcp" })).toHaveCount(0);
  await expect(page.getByText("Up to date", { exact: true })).toHaveCount(2);
  await expect(page.locator(".sidebar__settings-update-count")).toHaveText("1");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview
            .extensionUpdateTargets,
      ),
    )
    .toEqual([{ extension: "npm:@pi/mcp" }]);
});
