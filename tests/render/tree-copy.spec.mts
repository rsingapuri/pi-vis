import { expect, test } from "@playwright/test";

test.describe("conversation-tree copy", () => {
  test("copies a selected entry's complete payload without taking focus or text selection", async ({
    page,
  }) => {
    await page.goto("/");
    const composer = page.locator(".composer__textarea");
    await expect(composer).toBeVisible();
    await composer.fill("/tree");
    await composer.press("Enter");

    const tree = page.locator(".tree-viewer");
    await expect(tree).toBeVisible();
    const userRow = tree.locator(".tree-viewer__row").filter({ hasText: "Fix the config loader." });
    await expect(userRow).toBeVisible();

    await page.evaluate(() => {
      const target = window as unknown as {
        __treeClipboardWrites?: Array<{ text: string }>;
        pivis: { invoke: (channel: string, args?: unknown) => Promise<unknown> };
      };
      target.__treeClipboardWrites = [];
      const invoke = target.pivis.invoke;
      target.pivis.invoke = (channel, args) => {
        if (channel === "clipboard.writeText") {
          target.__treeClipboardWrites?.push(args as { text: string });
          return Promise.resolve({ ok: true });
        }
        return invoke(channel, args);
      };
    });

    await userRow.click();
    await page.keyboard.press("ControlOrMeta+C");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __treeClipboardWrites?: Array<{ text: string }> })
              .__treeClipboardWrites?.[0]?.text,
        ),
      )
      .toBe("Fix the config loader.");
    await expect(userRow).toHaveAttribute("aria-selected", "true");
    await expect(tree).toBeVisible();
    await expect(userRow.getByRole("button", { name: "Copied entry" })).toBeVisible();

    const search = tree.getByRole("textbox", { name: "Search tree" });
    await search.fill("config");
    await search.selectText();
    await page.keyboard.press("ControlOrMeta+C");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("config");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __treeClipboardWrites?: Array<{ text: string }> })
              .__treeClipboardWrites?.length,
        ),
      )
      .toBe(1);

    await tree
      .locator(".tree-viewer__row-text")
      .first()
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
    await tree.focus();
    await page.keyboard.press("ControlOrMeta+C");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __treeClipboardWrites?: Array<{ text: string }> })
              .__treeClipboardWrites?.length,
        ),
      )
      .toBe(1);
  });
});
