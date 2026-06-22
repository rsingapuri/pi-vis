// OPT-IN REAL-PI VERIFICATION
// ────────────────────────────
// This suite is the automated form of the mandatory manual "real pi" check.
// It launches the built app against the user's REAL settings + sessions and
// spawns the REAL `pi` binary (real API spend, real session files).
//
// It is SKIPPED in default runs. Opt in with:
//
//   REAL_PI_VERIFY=1 npx playwright test -c tests/e2e/playwright.config.mts real-pi-verify
//
// WARNING: the suite temporarily rewrites the real settings.json with a
// minimal known shape. A .bak is taken in beforeAll and restored in afterAll,
// but only if the run completes — a hard kill may leave settings.json as
// the minimal reset. process counts are computed as a delta from a baseline
// captured at the start of each test, so other `pi` processes on the host
// (e.g. a `pi` running in a terminal) do not fail the suite.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";

const APP_ENTRY = join(import.meta.dirname, "../../out/main/index.js");
const SETTINGS_DIR = join(os.homedir(), "Library/Application Support/Pi-Vis");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");
// The workspace the suite opens — the repo root, so this is portable across
// clone locations rather than hardcoded to one machine.
const WORKSPACE = resolve(import.meta.dirname, "../..");
// pi derives a session subdir from the cwd: same encoding as fake-pi.mjs.
const ENCODED_CWD = `-${WORKSPACE.replaceAll("/", "-")}--`;
const SESSIONS_DIR = join(os.homedir(), ".pi/agent/sessions", ENCODED_CWD);

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
}

function resetSettings(): void {
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify(
      {
        piBinaryPath: null,
        fonts: {
          display: { family: "Inter", sizePx: 14 },
          code: { family: "IBM Plex Mono", sizePx: 14 },
        },
        workspaceOrder: [WORKSPACE],
      },
      null,
      2,
    ),
  );
}

function countPiProcs(): number {
  return Number.parseInt(execSync("pgrep -fl 'pi --mode rpc' | wc -l").toString().trim(), 10);
}

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [APP_ENTRY],
    env: { ...process.env, ELECTRON_RENDERER_URL: undefined },
  });
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      const t = msg.text();
      if (t.includes("Security Warning")) return;
      console.log(`[renderer ${msg.type()}]`, t.slice(0, 200));
    }
  });
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 30_000 });
  return { app, window };
}

test.describe("Real-pi verification (mandatory manual check, automated)", () => {
  test.skip(
    process.env["REAL_PI_VERIFY"] !== "1",
    "Opt-in: set REAL_PI_VERIFY=1 to run against the real pi binary and real user data",
  );
  test.beforeAll(() => {
    // Snapshot the settings so we can restore them at the end.
    if (fs.existsSync(SETTINGS_PATH)) {
      fs.copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak`);
    }
  });

  test.afterAll(() => {
    if (fs.existsSync(`${SETTINGS_PATH}.bak`)) {
      fs.copyFileSync(`${SETTINGS_PATH}.bak`, SETTINGS_PATH);
      fs.unlinkSync(`${SETTINGS_PATH}.bak`);
    }
  });

  test("(a) stored-sessions list is non-empty with previews and msg counts", async () => {
    test.setTimeout(60_000);
    const baseline = countPiProcs();
    resetSettings();

    const { app, window } = await launchApp();
    // The recents-load effect auto-expands the first recent workspace.
    const storedSessions = window.locator(".sidebar__session--stored");
    await expect(storedSessions.first()).toBeVisible({ timeout: 15_000 });
    const storedCount = await storedSessions.count();
    console.log(`[a] stored session count: ${storedCount}`);
    expect(storedCount).toBeGreaterThan(0);

    // First stored row has a non-empty preview AND a non-zero msg count.
    const firstPreview =
      (await storedSessions.first().locator(".sidebar__session-preview").textContent()) ?? "";
    const firstMeta =
      (await storedSessions.first().locator(".sidebar__session-meta").textContent()) ?? "";
    console.log(`[a] first preview: "${firstPreview.slice(0, 60)}"`);
    console.log(`[a] first meta: "${firstMeta}"`);
    expect(firstPreview.trim().length).toBeGreaterThan(0);
    expect(firstMeta).toMatch(/[1-9]\d*msg/);

    // No pi processes spawned by the app at this point — we haven't activated anything.
    expect(countPiProcs() - baseline).toBe(0);

    await app.close();
  });

  test("(b) click an old stored session → transcript renders", async () => {
    test.setTimeout(60_000);
    const baseline = countPiProcs();
    resetSettings();
    const { app, window } = await launchApp();

    const storedSessions = window.locator(".sidebar__session--stored");
    await expect(storedSessions.first()).toBeVisible({ timeout: 15_000 });

    // Pick a stored session with > 1 message (more interesting to render).
    let picked = storedSessions.first();
    let pickedTitle = "";
    for (let i = 0; i < (await storedSessions.count()); i++) {
      const meta =
        (await storedSessions.nth(i).locator(".sidebar__session-meta").textContent()) ?? "";
      const m = meta.match(/^(\d+)msg/);
      if (m && Number.parseInt(m[1] ?? "0", 10) >= 5) {
        picked = storedSessions.nth(i);
        pickedTitle = (await picked.getAttribute("title")) ?? "";
        console.log(`[b] picking stored session ${i} with ${meta}`);
        console.log(`[b] title: ${pickedTitle.slice(0, 100)}`);
        break;
      }
    }
    await picked.click();
    // Wait for the picker to show a model — proves activation + get_state worked.
    await expect(window.locator(".session-header__picker-btn").first()).toContainText("/", {
      timeout: 60_000,
    });
    console.log("[b] picker populated — session activated");
    // Check procs RIGHT after activation
    for (let i = 0; i < 5; i++) {
      const c = countPiProcs();
      console.log(`[b] +${i * 100}ms after picker: procs=${c - baseline}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    // Wait for transcript blocks to appear (loadHistory runs on session.open for a resume).
    await expect(window.locator(".transcript-block--user").first()).toBeVisible({
      timeout: 15_000,
    });
    const userCount = await window.locator(".transcript-block--user").count();
    const assistantCount = await window.locator(".transcript-block--assistant").count();
    console.log(`[b] transcript blocks: ${userCount} user, ${assistantCount} assistant`);
    expect(userCount).toBeGreaterThan(0);
    expect(assistantCount).toBeGreaterThan(0);

    // One pi process should be alive now.
    const procCount = countPiProcs();
    console.log(`[b] pi procs delta: ${procCount - baseline}`);
    expect(procCount - baseline).toBe(1);

    await app.close();
  });

  test("(c) new session, prompt, rename, quit, relaunch → 1 process, click cold spawns 2nd", async () => {
    test.setTimeout(240_000);
    const baseline = countPiProcs();
    resetSettings();
    const { app, window } = await launchApp();

    // Create a new session.
    await window.getByRole("button", { name: "+ New session" }).click();
    // Wait for the picker to show an actual model (a name with "/", e.g. "minimax/minimax-m3").
    await expect(window.locator(".session-header__picker-btn").first()).toContainText("/", {
      timeout: 60_000,
    });
    console.log("[c] model picker populated");

    // Send a prompt.
    const textarea = window.locator(".composer__textarea");
    await textarea.fill("Reply with only the word: smoke");
    await textarea.press("Enter");
    // Wait for the user + assistant blocks.
    await expect(window.locator(".transcript-block--user").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.locator(".transcript-block--assistant").first()).toBeVisible({
      timeout: 90_000,
    });
    const assistantText =
      (await window.locator(".transcript-block--assistant").first().textContent()) ?? "";
    console.log(`[c] assistant response: "${assistantText.slice(0, 80)}"`);

    // Rename.
    await window.locator(".session-header__name-btn").click();
    const nameInput = window.locator(".session-header__name-input");
    const RENAME = `R2 Verify ${Date.now()}`;
    await nameInput.fill(RENAME);
    await nameInput.press("Enter");
    await expect(window.locator(".session-header__name-btn")).toContainText(RENAME, {
      timeout: 10_000,
    });
    console.log(`[c] renamed to ${RENAME}`);

    // Wait for the freshly-written session file to appear on disk.
    // We no longer track openTabs / activeSessionFile in settings (tab
    // restore was removed in this release), so the proof of life for
    // a successful prompt is just "a jsonl file for this session
    // exists in the sessions dir". Match any `*.jsonl` (don't pin a
    // date prefix).
    await expect
      .poll(
        async () => {
          const all = fs.readdirSync(SESSIONS_DIR).flatMap((sub) => {
            try {
              return fs
                .readdirSync(join(SESSIONS_DIR, sub))
                .filter((f) => f.endsWith(".jsonl"))
                .map((f) => join(SESSIONS_DIR, sub, f));
            } catch {
              return [];
            }
          });
          return all.length > 0 ? all : null;
        },
        { timeout: 30_000 },
      )
      .toEqual(expect.arrayContaining([expect.stringMatching(/\.jsonl$/)]));

    const procCountBeforeQuit = countPiProcs();
    console.log(`[c] pi procs before quit: ${procCountBeforeQuit - baseline}`);
    await app.close();

    // Relaunch.
    const { app: app2, window: w2 } = await launchApp();
    const procCountAfterRelaunch = countPiProcs();
    console.log(`[c] pi procs after relaunch: ${procCountAfterRelaunch - baseline}`);
    expect(procCountAfterRelaunch - baseline).toBe(1);

    // The renamed session is restored.
    await expect(w2.locator(".session-header__name-btn")).toContainText(RENAME, {
      timeout: 30_000,
    });
    // Transcript is restored.
    await expect(w2.locator(".transcript-block--user").first()).toBeVisible({ timeout: 15_000 });
    await expect(w2.locator(".transcript-block--assistant").first()).toContainText("smoke", {
      timeout: 15_000,
    });
    console.log("[c] relaunched with transcript intact");

    // Click a stored (cold) session from the sidebar.
    const stored = w2.locator(".sidebar__session--stored");
    if ((await stored.count()) > 0) {
      await stored.first().click();
      // Wait for it to activate.
      await expect(w2.locator(".session-header__picker-btn").first()).toContainText("/", {
        timeout: 60_000,
      });
      const procCountAfterClick = countPiProcs();
      console.log(`[c] pi procs after clicking cold: ${procCountAfterClick - baseline}`);
      expect(procCountAfterClick - baseline).toBe(2);
    } else {
      console.log("[c] no cold stored sessions to click (only the new one is open)");
    }

    await app2.close();
  });
});
