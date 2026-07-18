import { expect, test } from "@playwright/test";

test.describe("runtime-native provider sign-in", () => {
  test("signs in with a secret prompt, refreshes models, and supports device-code OAuth", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message pi" });
    await expect(composer).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const store = (
            window as unknown as {
              __pivisStore?: {
                getState: () => {
                  activeSessionId?: string;
                  sessions: Map<string, { authorityProjection?: { semantic: { state: string } } }>;
                };
              };
            }
          ).__pivisStore?.getState();
          const id = store?.activeSessionId;
          return id ? store?.sessions.get(id)?.authorityProjection?.semantic.state : undefined;
        }),
      )
      .toBe("following");

    await composer.fill("/login");
    await composer.press("Enter");
    const picker = page.locator(".picker--login");
    await expect(picker).toBeVisible();
    await expect(picker.getByText("Preview")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("provider-picker.png"), fullPage: true });

    await picker.getByRole("option").filter({ hasText: "API key" }).click();
    const signIn = page.getByRole("dialog", { name: "Sign in to Preview" });
    await expect(signIn).toBeVisible();
    await expect(page.locator(".provider-login-dialog-slot")).toHaveCount(1);

    // Exercise the real connected-stack case: provider sign-in replaces the
    // Composer while an extension widget remains in the tray above it.
    await page.evaluate(() => {
      type PreviewSession = { widgets: Map<string, string[]> };
      type PreviewStore = {
        getState: () => { activeSessionId: string; sessions: Map<string, PreviewSession> };
        setState: (partial: unknown) => void;
      };
      const store = (window as unknown as { __pivisStore: PreviewStore }).__pivisStore;
      const state = store.getState();
      const sessions = new Map(state.sessions);
      const session = sessions.get(state.activeSessionId)!;
      sessions.set(state.activeSessionId, {
        ...session,
        widgets: new Map([["usage", ["Codex / 11% (6d 6h 17m)"]]]),
      });
      store.setState({ sessions });
    });
    await expect(page.locator(".dock")).toBeVisible();
    await page.locator(".provider-login-dialog-slot").evaluate(async (slot) => {
      await Promise.all(slot.getAnimations().map((animation) => animation.finished));
    });
    const connectedStack = await page.evaluate(() => {
      const dock = document.querySelector<HTMLElement>(".dock");
      const card = document.querySelector<HTMLElement>(".provider-login-dialog");
      if (!dock || !card) return null;
      const dockRect = dock.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return {
        leftDelta: Math.abs(dockRect.left - cardRect.left),
        rightDelta: Math.abs(dockRect.right - cardRect.right),
        seamDelta: Math.abs(dockRect.bottom - cardRect.top),
        topLeftRadius: style.borderTopLeftRadius,
        topRightRadius: style.borderTopRightRadius,
      };
    });
    expect(connectedStack).not.toBeNull();
    expect(connectedStack).toMatchObject({
      topLeftRadius: "0px",
      topRightRadius: "0px",
    });
    expect(connectedStack!.leftDelta).toBeLessThan(0.1);
    expect(connectedStack!.rightDelta).toBeLessThan(0.1);
    expect(connectedStack!.seamDelta).toBeLessThan(0.1);
    const secret = signIn.locator('input[type="password"]');
    await expect(secret).toHaveAttribute("autocomplete", "off");
    await page.screenshot({
      path: testInfo.outputPath("api-key-prompt-empty.png"),
      fullPage: true,
    });

    const secretValue = "render-secret-must-not-persist";
    await secret.fill(secretValue);
    await signIn.getByRole("button", { name: "Continue" }).click();
    await expect(signIn).toBeHidden();
    await expect(composer).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          (needle) => ({
            body: document.body.textContent?.includes(needle) ?? false,
            store: JSON.stringify(
              (
                window as unknown as { __pivisStore?: { getState: () => unknown } }
              ).__pivisStore?.getState(),
            ).includes(needle),
          }),
          secretValue,
        ),
      )
      .toEqual({ body: false, store: false });

    await composer.fill("/model");
    await composer.press("Enter");
    const modelPicker = page.locator(".picker--model");
    await expect(modelPicker).toContainText("Newly Available");
    await modelPicker.getByRole("button", { name: "Cancel" }).click();
    await expect(composer).toBeVisible();

    await composer.fill("/login");
    await composer.press("Enter");
    const oauth = page.locator(".picker--login").getByRole("option").filter({ hasText: "OAuth" });
    await oauth.click();
    const device = page.getByRole("dialog", { name: "Sign in to Preview" });
    await expect(device).toContainText("PI-VIS-80");
    await page.screenshot({ path: testInfo.outputPath("device-code.png"), fullPage: true });
    await device.getByRole("button", { name: "Copy code" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __previewClipboardWrites?: Array<{ text: string }>;
              }
            ).__previewClipboardWrites?.at(-1)?.text,
        ),
      )
      .toBe("PI-VIS-80");
    await device.getByRole("button", { name: "Open browser" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __previewExternalLinks?: Array<{ url: string }>;
              }
            ).__previewExternalLinks?.at(-1)?.url,
        ),
      )
      .toBe("https://example.com/device");
    await device.getByRole("button", { name: "Cancel" }).click();
    await expect(device).toBeHidden();
  });
});
