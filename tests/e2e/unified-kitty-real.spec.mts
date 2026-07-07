/**
 * Opt-in E2E (flagship): the FULL kitty keyboard chain against REAL pi.
 *
 * Real `pi` binary + real `pi-session-host` (real `ensureUnifiedTui()` → real
 * pi-tui `TUI` + `Editor`) + the unified-widget-extension fixture, driven
 * through the REAL renderer (xterm 6.1 with `vtExtensions.kittyKeyboard`).
 * This is the one test that proves the USER-VISIBLE fix end-to-end: every
 * other test proves a half (xterm emits CSI-u; pi-tui decodes CSI-u).
 *
 * Skipped by default. Run with:
 *
 *   PI_E2E=1 npx playwright test -c tests/e2e/playwright.config.mts --grep kitty-real
 *
 * Requires: a real `pi` on PATH and valid provider auth (real API spend — the
 * Enter→submit assertion drives one prompt). Uses a THROWAWAY agent dir via
 * `PI_CODING_AGENT_DIR` so the fixture extension loads as a GLOBAL extension
 * (no project-trust prompt) and the user's real env is untouched. Per the
 * change's release gate, this spec MUST be run (and pass) before a release if
 * the CI `PI_E2E` lane is not available — see RELEASING.md.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { type LaunchedElectronApplication, launchElectron } from "./electron-launch.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ENTRY = join(__dirname, "../../out/main/index.js");
const FIXTURE_EXT = join(__dirname, "../fixtures/unified-widget-extension/unified-widget-e2e.ts");

function locatePiBin(): string | null {
  const candidates = [process.env.PIVIS_TEST_PI_BIN];
  try {
    candidates.push(execSync("command -v pi", { encoding: "utf8" }).trim());
  } catch {
    /* pi not on PATH */
  }
  candidates.push("/opt/homebrew/bin/pi", "/usr/local/bin/pi");
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const PI_BIN = locatePiBin();

test.describe("Unified TUI Kitty keyboard (real pi, full chain)", () => {
  test.skip(
    process.env["PI_E2E"] !== "1",
    "Opt-in: set PI_E2E=1 (requires real pi + provider auth; real API spend)",
  );
  test.skip(!PI_BIN, "no `pi` binary found (set PIVIS_TEST_PI_BIN)");

  function rmrf(p: string): void {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  async function launchApp(): Promise<{
    app: LaunchedElectronApplication;
    window: Page;
    dirs: string[];
  }> {
    const settingsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-kitty-real-"));
    const workspaceDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-kitty-real-ws-"));
    // Throwaway agent dir: the fixture extension loads here as a GLOBAL
    // extension (no trust prompt, no user-env pollution).
    const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-kitty-real-agent-"));
    const sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-kitty-real-sessions-"));
    fs.mkdirSync(join(agentDir, "extensions"), { recursive: true });
    fs.copyFileSync(FIXTURE_EXT, join(agentDir, "extensions", "unified-widget-e2e.ts"));

    fs.writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        piBinaryPath: PI_BIN,
        workspaceOrder: [workspaceDir],
        fonts: { display: { sizePx: 14 }, code: { family: "IBM Plex Mono", sizePx: 14 } },
      }),
    );

    const app = await launchElectron({
      args: [APP_ENTRY],
      env: {
        ...process.env,
        PIVIS_SETTINGS_DIR: settingsDir,
        PIVIS_SESSIONS_DIR: sessionsDir,
        // Route pi's agent dir + session dir to the throwaway dirs.
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: sessionsDir,
        ELECTRON_RENDERER_URL: undefined,
      },
    });
    app.process().stderr?.on("data", () => {
      /* drain */
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({
      timeout: 30_000,
    });
    return { app, window, dirs: [settingsDir, workspaceDir, agentDir, sessionsDir] };
  }

  test("Shift+Enter inserts a newline (no submit); Enter submits (I1/I2 full-chain)", async () => {
    test.setTimeout(180_000);
    const { app, window, dirs } = await launchApp();

    try {
      await window.getByRole("button", { name: "New session" }).click();

      // The fixture extension's session_start handler calls setWidget(factory),
      // so the host's real ensureUnifiedTui() opens a unified panel.
      const panel = window.locator(".unified-panel");
      await expect(panel, "the fixture widget must open the real unified TUI").toBeVisible({
        timeout: 40_000,
      });
      await expect(panel.locator(".xterm")).toBeVisible({ timeout: 10_000 });

      // The transcript starts empty (no user messages yet).
      const userMessages = () =>
        window.locator('[data-role="user-message"], .message--user').count();

      await panel.locator(".xterm").click();
      await window.keyboard.type("first line");

      // Shift+Enter → a newline in the editor (a second rendered line), and
      // CRUCIALLY no submit (the transcript must stay empty). Under legacy
      // encoding Shift+Enter would be indistinguishable from Enter and would
      // submit here — this is the user-visible bug being fixed.
      const before = await userMessages();
      await window.keyboard.press("Shift+Enter");
      await window.keyboard.type("second line");
      await window.waitForTimeout(1000);
      expect(await userMessages(), "Shift+Enter must NOT submit").toBe(before);

      // Enter → submit. The typed text becomes a transcript user message (the
      // submit pipeline runs over the real host + real pi). Real API spend.
      await window.keyboard.press("Enter");
      await expect
        .poll(
          async () => {
            // The submitted text (first line) must surface as a user message.
            const body = await window.locator("body").innerText();
            return body.includes("first line");
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    } finally {
      await app.close();
      for (const d of dirs) rmrf(d);
    }
  });
});
