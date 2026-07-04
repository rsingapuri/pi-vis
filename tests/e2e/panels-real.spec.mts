/**
 * Opt-in E2E: real extension panel rendering.
 *
 * Requires a real pi installation and pi-mcp-adapter.
 * Run with: PI_E2E=1 npm run test:e2e -- --grep "Panel"
 */

import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectron } from "./electron-launch.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test.describe("Extension Panel Rendering (real pi)", () => {
  test("pi-mcp-adapter /mcp opens CustomPanelHost overlay", async () => {
    const settingsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-panel-"));
    const workspaceDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-ws-"));

    fs.writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        piBinaryPath: "pi",
        workspaceOrder: [workspaceDir],
        fonts: {
          display: { sizePx: 14 },
          code: { family: "monospace", sizePx: 13 },
        },
      }),
    );

    const app = await launchElectron({
      args: [join(__dirname, "../../out/main/index.js")],
      env: {
        ...process.env,
        PIVIS_SETTINGS_DIR: settingsDir,
        ELECTRON_RENDERER_URL: undefined,
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForTimeout(3000);

    const composeArea = window.locator(".composer__input");
    await expect(composeArea).toBeVisible({ timeout: 10_000 });

    await composeArea.click();
    await composeArea.fill("/mcp");
    await window.keyboard.press("Enter");

    const panel = window.locator(".custom-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator(".custom-panel__xterm .xterm")).toBeVisible();
    await expect(panel.locator(".xterm-screen")).toBeVisible();

    await window.keyboard.press("Tab");
    await window.keyboard.type("test-input");
    await window.keyboard.press("Enter");

    await expect(panel).not.toBeVisible({ timeout: 60_000 });
    await app.close();
  });
});
