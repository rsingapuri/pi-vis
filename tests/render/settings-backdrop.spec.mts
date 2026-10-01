import { expect, test } from "@playwright/test";

test("Cendre Settings keeps the app visible beneath a blurred scrim", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });

  await page.getByRole("button", { name: "Settings" }).click();
  const overlay = page.locator(".settings-overlay");
  await expect(overlay).toBeVisible();

  await page
    .getByRole("group", { name: "Theme mode" })
    .getByRole("button", { name: "Dark" })
    .click();
  const darkThemeRow = page.locator(".settings-row").filter({ hasText: "Dark theme" });
  await darkThemeRow.locator(".settings-select__trigger").click();
  await darkThemeRow.getByRole("option", { name: "Cendre Hard" }).click();

  const backdrop = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backdropFilter: style.backdropFilter,
    };
  });

  expect(backdrop.backgroundColor).toBe("rgba(15, 12, 10, 0.7)");
  expect(backdrop.backdropFilter).toContain("blur(");
});

test("Settings listboxes support keyboard navigation and restore focus", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "Settings" }).click();

  const titleFont = page.getByRole("button", { name: "Title font family" });
  await titleFont.focus();
  await titleFont.press("ArrowDown");
  await expect(page.getByRole("option", { selected: true })).toBeFocused();

  await page.locator("[role='option']:focus").press("End");
  await expect(page.getByRole("option", { name: "IBM Plex Mono", exact: true })).toBeFocused();
  await page.locator("[role='option']:focus").press("Home");
  await expect(page.getByRole("option", { name: "Inter", exact: true })).toBeFocused();
  await page.locator("[role='option']:focus").press("f");
  await expect(page.getByRole("option", { name: "Fraunces", exact: true })).toBeFocused();

  await page.locator("[role='option']:focus").press("Escape");
  await expect(page.getByRole("listbox", { name: "Title font family" })).toHaveCount(0);
  await expect(titleFont).toBeFocused();
  await expect(page.locator(".settings-overlay")).toBeVisible();

  await titleFont.press("ArrowDown");
  await page.locator("[role='option']:focus").press("Tab");
  await expect(page.getByRole("listbox", { name: "Title font family" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Transcript header and thinking font family" }),
  ).toBeFocused();
});
