import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");
const APP_ENTRY = join(__dirname, "../../out/main/index.js");

interface Folders {
  settingsDir: string;
  workspaceDir: string;
  piSessionsDir: string;
}

async function makeFolders(): Promise<Folders> {
  return {
    settingsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-settings-"))),
    workspaceDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-ws-"))),
    piSessionsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-pi-"))),
  };
}

async function launchApp(folders: Folders): Promise<{ app: ElectronApplication; window: Page }> {
  // Seed the settings file the first time we launch in this test. A relaunch
  // must NOT overwrite it: the first run persists openTabs / activeSessionFile
  // and we need them to survive into the second run.
  const settingsPath = join(folders.settingsDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        piBinaryPath: FAKE_PI,
        recentWorkspaces: [folders.workspaceDir],
        fonts: { display: { family: "system-ui", sizePx: 14 }, code: { family: "monospace", sizePx: 13 } },
      }),
    );
  }

  const app = await electron.launch({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: folders.settingsDir,
      FAKE_PI_SESSIONS_DIR: folders.piSessionsDir,
      PIVIS_SESSIONS_DIR: folders.piSessionsDir,
      ELECTRON_RENDERER_URL: undefined,
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 15_000 });
  return { app, window };
}

async function readSettings(settingsDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(join(settingsDir, "settings.json"), "utf8"));
}

function rmrf(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

test.describe("Pi-Vis restore + name round trip", () => {
  test("tabs and names survive restart; cold tab spawns on focus", async () => {
    test.setTimeout(120_000);
    fs.chmodSync(FAKE_PI, 0o755);

    const folders = await makeFolders();

    // ── First run: create two named sessions ──────────────────────────
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "+ New session" }).click();
    await expect(window.locator(".session-header__picker-btn").first()).toContainText("fake-model", { timeout: 15_000 });

    const textarea = window.locator(".composer__textarea");
    await textarea.fill("hello there friend");
    await textarea.press("Enter");
    await expect(window.locator("body")).toContainText("your pi coding agent", { timeout: 15_000 });

    await window.locator(".session-header__name-btn").click();
    const nameInput = window.locator(".session-header__name-input");
    await nameInput.fill("Renamed Tab One");
    await nameInput.press("Enter");
    await expect(window.locator(".session-header__name-btn")).toContainText("Renamed Tab One", { timeout: 5_000 });
    await expect(window.locator(".sidebar__session--live .sidebar__session-name").first()).toContainText(
      "Renamed Tab One",
      { timeout: 5_000 },
    );

    await window.getByRole("button", { name: "+ New session" }).click();
    await expect(window.locator(".session-header__picker-btn").first()).toContainText("fake-model", { timeout: 15_000 });
    await textarea.fill("say something else");
    await textarea.press("Enter");
    await expect(window.locator("body")).toContainText("Echo: say something else", { timeout: 15_000 });

    await window.locator(".sidebar__session--live", { hasText: "Renamed Tab One" }).click();
    await expect(window.locator(".session-header__name-btn")).toContainText("Renamed Tab One", { timeout: 5_000 });

    await expect
      .poll(async () => {
        const s = await readSettings(folders.settingsDir);
        const tabs = (s["openTabs"] as Array<unknown> | undefined) ?? [];
        return tabs.length === 2 && typeof s["activeSessionFile"] === "string" && (s["activeSessionFile"] as string).endsWith(".jsonl");
      }, { timeout: 15_000 })
      .toBe(true);

    await app.close();

    // ── Second run: re-launch, verify cold restore + name round trip ──
    const second = await launchApp(folders);
    const { window: w2, app: app2 } = second;
    await expect(w2.locator(".sidebar__session--live")).toHaveCount(2, { timeout: 15_000 });

    const liveRows = w2.locator(".sidebar__session--live");
    const allText = await liveRows.allTextContents();
    expect(allText.some((t) => t.includes("Renamed Tab One"))).toBe(true);
    expect(allText.some((t) => t.includes("say something else"))).toBe(true); // unnamed tab shows its first-prompt preview, not "New session"

    const nonActiveRow = liveRows.filter({ has: w2.locator(".status-dot--cold") }).first();
    await expect(nonActiveRow.locator(".status-dot--cold")).toHaveCount(1);
    const activeRow = w2.locator(".sidebar__session--active");
    await expect(activeRow.locator(".status-dot--cold")).toHaveCount(0);

    await expect(w2.locator("body")).toContainText("hello there friend", { timeout: 5_000 });
    await expect(w2.locator("body")).toContainText("your pi coding agent", { timeout: 5_000 });

    const coldRow = liveRows.filter({ has: w2.locator(".status-dot--cold") }).first();
    await coldRow.click();
    await expect(coldRow.locator(".status-dot--cold")).toHaveCount(0, { timeout: 10_000 });
    await expect(w2.locator(".session-header__picker-btn").first()).toContainText("fake-model", { timeout: 15_000 });

    await app2.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("missing session file is skipped and pruned at restore", async () => {
    test.setTimeout(120_000);
    fs.chmodSync(FAKE_PI, 0o755);

    const folders = await makeFolders();
    const first = await launchApp(folders);
    const { window, app } = first;

    await window.getByRole("button", { name: "+ New session" }).click();
    await expect(window.locator(".session-header__picker-btn").first()).toContainText("fake-model", { timeout: 15_000 });
    const textarea = window.locator(".composer__textarea");
    await textarea.fill("echo me please");
    await textarea.press("Enter");
    await expect(window.locator("body")).toContainText("Echo: echo me please", { timeout: 15_000 });

    await expect
      .poll(async () => {
        const s = await readSettings(folders.settingsDir);
        const tabs = (s["openTabs"] as Array<{ sessionFile: string }> | undefined) ?? [];
        return tabs.length === 1;
      }, { timeout: 15_000 })
      .toBe(true);

    const settings = await readSettings(folders.settingsDir);
    const tabs = settings["openTabs"] as Array<{ sessionFile: string }>;
    const filePath = tabs[0]?.sessionFile;
    expect(typeof filePath).toBe("string");
    fs.rmSync(filePath as string, { force: true });

    await app.close();

    // Second run: the restore loop's openSessionTab will throw (missing file);
    // the tab is silently skipped, and the final persistOpenTabs() prunes it.
    const second = await launchApp(folders);
    const { window: w2, app: app2 } = second;
    await expect(w2.locator(".sidebar__session--live")).toHaveCount(0, { timeout: 10_000 });

    await expect
      .poll(async () => {
        const s = await readSettings(folders.settingsDir);
        const t = (s["openTabs"] as Array<unknown> | undefined) ?? [];
        return t.length === 0;
      }, { timeout: 15_000 })
      .toBe(true);

    await app2.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });
});
