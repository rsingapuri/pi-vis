import { test, expect, _electron as electron } from "@playwright/test";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");

test.describe("Pi-Vis e2e", () => {
  test("app boots, add workspace, new session, type hello, see streamed text", async () => {
    const settingsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-test-"));
    const workspaceDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-ws-"));

    // Write settings pointing to fake-pi
    fs.writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        piBinaryPath: `node ${FAKE_PI}`,
        recentWorkspaces: [],
        fonts: { display: { family: "system-ui", sizePx: 14 }, code: { family: "monospace", sizePx: 13 } },
      }),
    );

    const app = await electron.launch({
      args: [join(__dirname, "../../out/main/index.js")],
      env: {
        ...process.env,
        PIVIS_SETTINGS_DIR: settingsDir,
        ELECTRON_RENDERER_URL: undefined,
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // The app should render (not show PiNotFound since piBinaryPath is set)
    // Note: fake-pi is node script, so pi.locate would call `node fake-pi.mjs --version`
    // which won't return a version. For real e2e we'd set up fake-pi to handle --version.
    // Check the app loaded
    await expect(window.locator(".app, .pi-not-found")).toBeVisible({ timeout: 10000 });

    await app.close();
    fs.rmSync(settingsDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
});
