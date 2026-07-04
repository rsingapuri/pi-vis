import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { type LaunchedElectronApplication, launchElectron } from "./electron-launch.mjs";

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
    settingsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-cmds-"))),
    workspaceDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-cmds-ws-"))),
    piSessionsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-cmds-pi-"))),
  };
}

async function launchApp(
  folders: Folders,
): Promise<{ app: LaunchedElectronApplication; window: Page }> {
  const settingsPath = join(folders.settingsDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        piBinaryPath: FAKE_PI,
        workspaceOrder: [folders.workspaceDir],
        fonts: {
          display: { sizePx: 14 },
          code: { family: "monospace", sizePx: 13 },
        },
      }),
    );
  }
  const app = await launchElectron({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: folders.settingsDir,
      FAKE_PI_SESSIONS_DIR: folders.piSessionsDir,
      PIVIS_SESSIONS_DIR: folders.piSessionsDir,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  app.process().stderr?.on("data", () => {
    // Drain the pipe so a misbehaving fake-pi doesn't block on a full
    // stderr buffer. The data itself is intentionally discarded — these
    // tests don't need to assert on stderr.
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

test.describe("Slash commands", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
  });

  test("settings put interface controls together while code font remains configurable", async () => {
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "Settings" }).click();
    const interfaceSection = window.locator(".settings-section", {
      has: window.getByRole("heading", { name: "Interface" }),
    });
    await expect(interfaceSection.getByText("Light theme", { exact: true })).toBeVisible();
    await expect(interfaceSection.getByText("Dark theme", { exact: true })).toBeVisible();
    await expect(interfaceSection.getByText("Mode", { exact: true })).toBeVisible();
    await expect(interfaceSection.getByText("Font Size", { exact: true })).toBeVisible();
    await expect(interfaceSection.getByText("Family", { exact: true })).toHaveCount(0);
    await expect(interfaceSection).not.toContainText("Pi-Vis owns interface font families");

    const codeSection = window.locator(".settings-section", {
      has: window.getByRole("heading", { name: "Code" }),
    });
    await expect(codeSection.getByText("Font Family", { exact: true })).toBeVisible();
    await expect(codeSection.getByText("Font Size", { exact: true })).toBeVisible();

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("/name Foo updates the header without a user bubble (parity: pi emits session_info_changed)", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const textarea = window.locator(".composer__textarea");
    await textarea.fill("/name Foo");
    await textarea.press("Enter");

    // The session name should appear in the header (no user bubble — TUI
    // parity, the `set_session_name` command triggers a session_info_changed
    // event that the SessionHeader subscribes to).
    await expect(window.locator(".session-header__name-btn")).toContainText("Foo", {
      timeout: 10_000,
    });
    // No user bubble — slash commands don't add a user message.
    await expect(window.locator(".transcript-block--user")).toHaveCount(0);

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("/model picker opens, picks a model, header updates; /model exact-id bypasses picker", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const textarea = window.locator(".composer__textarea");
    // /model (no arg) opens the picker.
    await textarea.fill("/model");
    await textarea.press("Enter");
    const picker = window.locator(".picker--model");
    await expect(picker).toBeVisible({ timeout: 5_000 });
    // Search and pick the second model.
    await picker.locator(".picker__search-input").fill("Two");
    const secondModel = picker.locator(".picker__item").filter({ hasText: "Fake Model Two" });
    await expect(secondModel).toBeVisible();
    await secondModel.click();
    // Header reflects the new model.
    await expect(window.locator(".session-header__model-btn")).toContainText(
      "Fake Model Two [fake]",
      { timeout: 5_000 },
    );

    // /model <exact-id> bypasses the picker and sets the model directly.
    await textarea.fill("/model fake-model");
    await textarea.press("Enter");
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 5_000,
    });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("/ask-user-question: select dialog round-trips keyboard pick", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const textarea = window.locator(".composer__textarea");
    // ask-user-question is a fake extension that emits a select dialog.
    await textarea.fill("/ask-user-question");
    await textarea.press("Enter");
    const dialog = window.locator(".ext-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    // Click the second option ("Deny"). The keyboard nav is exercised
    // by the same dialog's onKeyDown (real users get it for free);
    // a click keeps the test stable across electron-flavoured focus
    // edge cases.
    await dialog.locator(".ext-dialog__option").nth(1).click();
    // The dialog closes; the agent echoes the chosen answer.
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(window.locator("body")).toContainText("ask-user-question chose:", {
      timeout: 10_000,
    });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("/set-editor: composer receives injected text from extension_ui_request", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const textarea = window.locator(".composer__textarea");
    // Type some text first so the effect can replace it.
    await textarea.fill("placeholder");
    // Run the extension.
    await textarea.fill("/set-editor");
    await textarea.press("Enter");

    // The composer should be re-populated with the injected text.
    await expect(textarea).toHaveValue("injected by extension", { timeout: 5_000 });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("expanded tool output shows all retained data through a virtualized output well", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const textarea = window.locator(".composer__textarea");
    await textarea.fill("long-tool");
    await textarea.press("Enter");

    const card = window.locator(".tool-card").filter({ hasText: "generate-long-report" }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator(".tool-card__subject")).toHaveAttribute(
      "title",
      /value-value-value.*tail/,
    );

    await card.locator("button.tool-card__header").click();
    await expect(card.locator(".tool-card__output-panel")).toBeVisible({ timeout: 5_000 });
    await expect(card.locator(".tool-card__metadata-summary")).toContainText(
      "pi retained 240 of 6,400 lines",
    );
    await expect(
      card.locator(".tool-card__section-meta").filter({ hasText: "240 lines" }),
    ).toBeVisible();
    await expect(card.locator(".tool-card__output-line").first()).toContainText(
      "long-tool-line-001",
    );
    await expect.poll(() => card.locator(".tool-card__output-line").count()).toBeLessThan(80);

    await card.locator(".tool-card__virtual-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(card.locator(".tool-card__output-line").last()).toContainText(
      "long-tool-line-240",
      { timeout: 5_000 },
    );
    await expect.poll(() => card.locator(".tool-card__output-line").count()).toBeLessThan(80);

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("/timeout-select: dialog auto-dismisses in ≈1.5s (the seconds-bug would have held 1500s)", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const textarea = window.locator(".composer__textarea");
    await textarea.fill("/timeout-select");
    await textarea.press("Enter");
    const dialog = window.locator(".ext-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Should disappear shortly after 1.5s. We allow 6s of slack for test
    // scheduling; the buggy 1500s regression would never dismiss in this
    // window.
    await expect(dialog).toBeHidden({ timeout: 6_000 });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("/widget-on then /widget-off: widget strip + status segment appear and clear (TUI parity for /plan exit)", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const textarea = window.locator(".composer__textarea");

    // --- on: the extension pushes a widget + a status segment ------------
    await textarea.fill("/widget-on");
    await textarea.press("Enter");

    // Widget chips render one per key in the Dock (above-composer chip rail),
    // with one line per entry.
    const dock = window.locator(".dock");
    await expect(dock).toBeVisible({ timeout: 5_000 });
    await expect(dock.locator(".dock__widget-line")).toHaveText([
      "Plan mode: planning",
      "Tools: read_file",
      "Produce a <proposed_plan> block.",
    ]);

    // Status segment is one of the .statusbar__line entries (others are
    // workspace / usage). The strip at the bottom of the composer renders
    // all segments; we filter to the one with the plan status text.
    await expect(window.locator(".statusbar__line").filter({ hasText: "plan active" })).toHaveCount(
      1,
      { timeout: 5_000 },
    );

    // --- off: same extension pushes clears --------------------------------
    await textarea.fill("/widget-off");
    await textarea.press("Enter");

    // Both pieces of UI are gone (the TUI parity contract for /plan exit).
    await expect(dock).toBeHidden({ timeout: 5_000 });
    await expect(window.locator(".statusbar__line").filter({ hasText: "plan active" })).toHaveCount(
      0,
      { timeout: 5_000 },
    );

    // Clearing a non-existent key on the next prompt is a no-op (no
    // regression, and the previous widgetLines/statusText should not have
    // been left as `undefined` in the maps, which would have thrown in
    // StatusBar / Composer on render).
    await textarea.fill("hello there");
    await textarea.press("Enter");
    await expect(window.locator("body")).toContainText("your pi coding agent", { timeout: 15_000 });
    await expect(window.locator(".dock__widget-line")).toHaveCount(0);

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("/new: transcript clears and a new file is adopted", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const textarea = window.locator(".composer__textarea");
    await textarea.fill("hello there");
    await textarea.press("Enter");
    await expect(window.locator("body")).toContainText("your pi coding agent", { timeout: 15_000 });

    // /new clears the transcript and adopts a fresh file.
    await textarea.fill("/new");
    // Close slash autocomplete so Enter submits the command instead of racing
    // the selected completion on slower full-suite runs.
    await textarea.press("Escape");
    await textarea.press("Enter");
    // Transcript is empty after /new.
    await expect(window.locator(".transcript-block--assistant")).toHaveCount(0, { timeout: 5_000 });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });
});
