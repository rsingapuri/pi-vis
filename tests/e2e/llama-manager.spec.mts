import { type FakeLlamaRouter, createFakeLlamaRouter } from "./support/fake-llama-router.mjs";
import { expect, test } from "./support/invariants.mjs";
import {
  type RealSdkFixture,
  type RealSdkLaunch,
  createRealSdkFixture,
  openNewRealSession,
} from "./support/real-sdk-host.mjs";

async function closeFixture(
  launch: RealSdkLaunch | undefined,
  fixture: RealSdkFixture,
  router: FakeLlamaRouter,
): Promise<void> {
  await launch?.close();
  await router.close();
  fixture.cleanup();
}

test.describe("Pinned Pi llama.cpp manager exception", () => {
  test("loads the private built-in through the public host hook and renders its real TUI", async () => {
    test.setTimeout(120_000);
    const router = await createFakeLlamaRouter();
    const fixture = createRealSdkFixture({ llamaServerBaseUrl: router.baseUrl });
    let launch: RealSdkLaunch | undefined;

    try {
      launch = await fixture.launch();
      const { window } = launch;
      let textarea = await openNewRealSession(window);

      await textarea.fill("/llama");
      await textarea.press("Enter");

      const panel = window.locator(".custom-panel");
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator(".xterm-rows")).toContainText("llama.cpp models", {
        timeout: 30_000,
      });
      await expect(panel.locator(".xterm-rows")).toContainText(router.baseUrl);
      await expect(panel.locator(".xterm-rows")).toContainText("pivis-e2e.gguf");
      expect(router.requests.some((request) => request.startsWith("GET /models"))).toBe(true);
      expect(router.requests).toContain("GET /props?model=pivis-e2e.gguf&autoload=false");

      await window.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      textarea = window.locator(".composer__textarea");
      await expect(textarea).toBeVisible();
      await expect(textarea).toBeFocused();

      // This proves the hidden command also registered its native provider and
      // synchronized the router catalog into Pi's public ModelRuntime.
      await textarea.fill("/model");
      await textarea.press("Enter");
      const modelOption = window
        .locator(".picker--model")
        .getByRole("option", { name: "pivis-e2e.gguf [llama.cpp]" });
      await expect(modelOption).toBeVisible({ timeout: 30_000 });
      await modelOption.click();
      await expect(window.locator(".session-header__model-btn")).toContainText(
        "pivis-e2e.gguf [llama.cpp]",
        { timeout: 30_000 },
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}\nRouter requests:\n${router.requests.join("\n") || "<none>"}`,
      );
    } finally {
      await closeFixture(launch, fixture, router);
    }
  });
});
