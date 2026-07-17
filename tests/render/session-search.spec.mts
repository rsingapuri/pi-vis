import { expect, test } from "@playwright/test";

type PreviewHooks = {
  abortCalls: number;
  searchOpenCalls: number;
  startStreaming(): void;
};

type PreviewStore = {
  getState(): {
    activeSessionId: string | null;
    activeWorkspacePath: string | null;
    sessionDrafts: Map<string, string>;
  };
};

test.describe("workspace session search", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });
  });

  test("workspace actions reveal on hover, preserve slots, and restore focus", async ({ page }) => {
    const workspaceHeader = page
      .locator(".sidebar__workspace-header")
      .filter({ hasText: "pi-vis" });
    const button = page.getByRole("button", { name: "Search sessions in pi-vis" });
    const chevron = workspaceHeader.locator(".sidebar__workspace-chevron");
    await expect(button).toHaveCSS("width", "0px");
    await expect(chevron).toHaveCSS("width", "0px");
    await expect(button).toHaveCSS("opacity", "0");
    await workspaceHeader.hover();
    await expect(button).toBeVisible();
    await expect(button.evaluate((node) => getComputedStyle(node).opacity)).resolves.not.toBe("0");
    const order = await button.evaluate((node) => ({
      previous: node.previousElementSibling?.className,
      next: node.nextElementSibling?.className,
    }));
    expect(order.next).toContain("sidebar__workspace-chevron");

    await button.click();
    await expect(page.getByRole("dialog", { name: "Search sessions in pi-vis" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Search saved sessions" })).toHaveAttribute(
      "placeholder",
      "Search",
    );
    await expect(page.locator(".session-search__results-pane")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".session-search-overlay")).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test("preview is read-only and Escape never interrupts the active session", async ({ page }) => {
    const before = await page.evaluate(() => {
      const hooks = (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview;
      hooks.startStreaming();
      const state = (window as unknown as { __pivisStore: PreviewStore }).__pivisStore.getState();
      return {
        abortCalls: hooks.abortCalls,
        searchOpenCalls: hooks.searchOpenCalls,
        activeSessionId: state.activeSessionId,
        activeWorkspacePath: state.activeWorkspacePath,
        drafts: [...state.sessionDrafts.entries()],
      };
    });

    await page.keyboard.press("Meta+Shift+f");
    const input = page.getByRole("combobox", { name: "Search saved sessions" });
    await expect(input).toBeFocused();
    await input.fill("lifecycle");
    const option = page.getByRole("option", { name: /Lifecycle investigation/u });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator(".session-search__context-item--target")).toContainText(
      "activation lifecycle",
    );
    await expect(page.getByRole("button", { name: "Return to results" })).toBeFocused();
    await page.keyboard.press("Meta+Shift+f");
    await expect(input).toBeFocused();
    await option.click();
    await expect(page.getByRole("button", { name: "Return to results" })).toBeFocused();

    const afterPreview = await page.evaluate(() => {
      const hooks = (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview;
      const state = (window as unknown as { __pivisStore: PreviewStore }).__pivisStore.getState();
      return {
        abortCalls: hooks.abortCalls,
        searchOpenCalls: hooks.searchOpenCalls,
        activeSessionId: state.activeSessionId,
        activeWorkspacePath: state.activeWorkspacePath,
        drafts: [...state.sessionDrafts.entries()],
      };
    });
    expect(afterPreview).toEqual(before);

    await page.keyboard.press("Escape");
    await expect(page.locator(".session-search__results-pane")).toBeVisible();
    await expect(page.locator(".session-search-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".session-search-overlay")).toHaveCount(0);
    const abortAfter = await page.evaluate(
      () => (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview.abortCalls,
    );
    expect(abortAfter).toBe(before.abortCalls);
  });

  test("default-on setting persists but launch availability changes only after restart", async ({
    page,
  }) => {
    const workspaceHeader = page
      .locator(".sidebar__workspace-header")
      .filter({ hasText: "pi-vis" });
    await page.getByRole("button", { name: "Settings" }).click();
    const row = page.locator(".settings-row").filter({ hasText: "Saved session search" });
    const toggle = page.getByRole("button", { name: "Saved session search" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAccessibleDescription("Takes effect after restarting Pi-Vis.");
    await expect(row).toContainText("Takes effect after restarting Pi-Vis.");

    await toggle.focus();
    await page.keyboard.press("Space");

    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const settings = await window.pivis.invoke("settings.get", undefined);
          return settings.sessionSearchEnabled;
        }),
      )
      .toBe(false);
    await page.getByRole("button", { name: "Close settings" }).click();
    await workspaceHeader.hover();
    await expect(page.getByRole("button", { name: "Search sessions in pi-vis" })).toBeVisible();
  });

  test("narrow layout uses two-step Escape and explicit open uses normal orchestration", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 400 });
    await page.keyboard.press("Meta+Shift+f");
    await page.getByRole("combobox").fill("alternate");
    const option = page.getByRole("option", { name: /Session registry cleanup/u });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator(".session-search__context-pane")).toBeVisible();
    await expect(page.getByText("Other saved branch.")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".session-search__results-pane")).toBeVisible();
    await expect(page.locator(".session-search-overlay")).toBeVisible();
    await option.click();
    await page.getByRole("button", { name: "Open session" }).click();
    await expect(page.locator(".session-search-overlay")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview.searchOpenCalls,
        ),
      )
      .toBe(1);
  });
});
