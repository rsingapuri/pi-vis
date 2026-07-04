/**
 * E2E: Unified-TUI panel (factory `setWidget`) — the pi-subagents "FleetView" flow.
 *
 * Self-contained (no real pi / no real SDK / no PI_E2E gate): launches the REAL
 * app with two test fixtures:
 *   - fake-pi.mjs            → satisfies locate-pi (the app needs a pi binary)
 *   - fake-unified-host.mjs  → substituted for host.mjs via PIVIS_TEST_HOST_SCRIPT,
 *                              speaks the SessionHost wire protocol and drives the
 *                              factory-setWidget flow: panel_open{unified:true} +
 *                              streaming panel_data, just like ensureUnifiedTui().
 *
 * This exercises the exact path that delivers a unified panel to the user:
 * SessionHost wire → registry forwarding → IPC → store reducer → UnifiedTuiHost →
 * xterm.js render, plus keystroke input routing back to the host. It is the
 * regression gate for "the composer was replaced by nothing" regressions.
 */
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { type LaunchedElectronApplication, launchElectron } from "./electron-launch.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");
const FAKE_HOST = join(__dirname, "../fixtures/fake-unified-host.mjs");
const APP_ENTRY = join(__dirname, "../../out/main/index.js");

interface Folders {
  settingsDir: string;
  workspaceDir: string;
  piSessionsDir: string;
  inputFile: string;
}

async function makeFolders(): Promise<Folders> {
  const base = (s: string) => fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), s)));
  const folders: Folders = {
    settingsDir: base("pivis-e2e-unified-"),
    workspaceDir: base("pivis-e2e-unified-ws-"),
    piSessionsDir: base("pivis-e2e-unified-pi-"),
    inputFile: "",
  };
  folders.inputFile = join(folders.settingsDir, "host-input.log");
  return folders;
}

async function launchApp(
  folders: Folders,
): Promise<{ app: LaunchedElectronApplication; window: Page }> {
  fs.writeFileSync(
    join(folders.settingsDir, "settings.json"),
    JSON.stringify({
      piBinaryPath: FAKE_PI,
      workspaceOrder: [folders.workspaceDir],
      fonts: {
        display: { sizePx: 14 },
        code: { family: "monospace", sizePx: 13 },
      },
    }),
  );

  const app = await launchElectron({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: folders.settingsDir,
      FAKE_PI_SESSIONS_DIR: folders.piSessionsDir,
      PIVIS_SESSIONS_DIR: folders.piSessionsDir,
      // The seams that make this test deterministic:
      PIVIS_TEST_HOST_SCRIPT: FAKE_HOST,
      PIVIS_TEST_HOST_INPUT_FILE: folders.inputFile,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  app.process().stderr?.on("data", () => {
    /* drain so a chatty fake never blocks on a full stderr pipe */
  });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 15_000 });
  return { app, window };
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

test.describe("Unified-TUI panel (factory setWidget)", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_HOST, 0o755);
  });

  test("a factory setWidget mounts UnifiedTuiHost with rendered content, and routes keystrokes to the host", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    try {
      // Open a session → registry forks the fake host → it reaches ready and
      // opens the unified panel ~300ms later.
      await window.getByRole("button", { name: "New session" }).click();

      // 1. The Composer slot is replaced by UnifiedTuiHost (NOT the native
      //    composer). This is the "no new component was rendered" regression.
      const panel = window.locator(".unified-panel");
      await expect(panel).toBeVisible({ timeout: 20_000 });

      // The native composer must be absent while the unified panel is live.
      await expect(window.locator(".composer__textarea")).toHaveCount(0);

      // 2. xterm.js mounted inside the unified panel.
      const xterm = panel.locator(".xterm");
      await expect(xterm).toBeVisible({ timeout: 10_000 });

      // 3. The streamed panel_data (the fake roster) actually rendered as text.
      //    xterm writes glyphs into .xterm-rows; assert the recognizable content.
      await expect(panel.locator(".xterm-rows")).toContainText("Fleet", { timeout: 15_000 });
      await expect(panel.locator(".xterm-rows")).toContainText("swift-otter");

      // 4. Keystrokes route back to the host over panel_input (the side channel
      //    file proves the wire round-trip, not just a visible cursor).
      await panel.locator(".xterm").click();
      await window.keyboard.type("xyz");
      await expect
        .poll(
          () => fs.existsSync(folders.inputFile) && fs.readFileSync(folders.inputFile, "utf8"),
          {
            timeout: 10_000,
          },
        )
        .toContain("xyz");
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });
});
