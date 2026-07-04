import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectron } from "./electron-launch.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test.describe("Extension Panel Rendering", () => {
  test("host fallback shows notice when pi not found", async () => {
    const settingsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-fallback-"));
    const workspaceDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-ws2-"));

    fs.writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        piBinaryPath: "/nonexistent/pi",
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
        PATH: "/nonexistent",
        SHELL: "/nonexistent/shell",
        PIVIS_SETTINGS_DIR: settingsDir,
        ELECTRON_RENDERER_URL: undefined,
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // Should show PiNotFound component
    const notFound = window.locator(".pi-not-found, .setup");
    await expect(notFound).toBeVisible({ timeout: 10_000 });

    await app.close();
  });
});
