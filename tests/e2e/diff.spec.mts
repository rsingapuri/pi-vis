// E2E tests for the diff viewer (WP6).
//
// We make a real git repo on disk inside the workspace, commit a known
// file, then modify + add a couple of changes, and exercise the viewer:
//   1. Header button shows `± 2` and opens the viewer with 2 files.
//   2. Gap expanders increase row counts and click-to-expand fully opens.
//   3. Split mode toggles, persists across close/reopen.
//   4. Esc closes; ⌘G (Meta+g) opens from the session surface.
//   5. /diff typed in composer opens the viewer.
//   6. Clean repo: dimmed `±` only; /diff → "Working tree clean".
//   7. Rail filter narrows rows; clicking scrolls the section into view.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  type LaunchedElectronApplication,
  launchElectron,
} from "./support/instrumented-launch.mjs";
import { expect, test } from "./support/invariants.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");
const FAKE_SESSION_HOST = join(__dirname, "../fixtures/fake-session-host.mjs");
const APP_ENTRY = join(__dirname, "../../out/main/index.js");

interface Folders {
  settingsDir: string;
  workspaceDir: string;
  piSessionsDir: string;
}

async function makeFolders(): Promise<Folders> {
  return {
    settingsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-diff-"))),
    workspaceDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-diff-ws-"))),
    piSessionsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-diff-pi-"))),
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
      PIVIS_TEST_HOST_SCRIPT: FAKE_SESSION_HOST,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  app.process().stderr?.on("data", () => {
    // Drain so a misbehaving child never blocks on a full stderr.
  });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  // Resize the viewport to ensure split-view is enabled (> 880px content
  // width after the panel padding + rail are subtracted). The default
  // 1280×800 window leaves the diff content at ~787px (sidebar + rail
  // eat too much), which auto-disables split.
  await window.setViewportSize({ width: 1600, height: 900 });
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

/**
 * Initialize the workspace as a git repo with one tracked file
 * (a.ts, 60+ lines) and one untracked file (b.ts). Returns the
 * post-setup list of changed files (against HEAD).
 */
function setupRepoWithChanges(workspaceDir: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: workspaceDir });
  try {
    execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: workspaceDir });
  } catch {
    /* best effort */
  }
  const a: string[] = [];
  for (let i = 1; i <= 60; i++) a.push(`export const v${i} = ${i};`);
  fs.writeFileSync(join(workspaceDir, "a.ts"), `${a.join("\n")}\n`);
  execFileSync("git", ["add", "a.ts"], { cwd: workspaceDir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
    cwd: workspaceDir,
  });
  // Modify a few mid-file lines so the diff has both visible changes
  // and large gaps to exercise the expanders.
  const aModified = a.slice();
  aModified[9] = "export const v10 = 999;"; // change near top of file
  aModified[29] = "export const v30 = 8888;"; // change mid-file
  aModified[49] = "export const v50 = 7777;"; // change further down
  fs.writeFileSync(join(workspaceDir, "a.ts"), `${aModified.join("\n")}\n`);
  // Untracked file.
  fs.writeFileSync(join(workspaceDir, "b.ts"), "export const b = 1;\n");
}

function setupRepoWithCommitRange(workspaceDir: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: workspaceDir });
  execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: workspaceDir });
  fs.writeFileSync(join(workspaceDir, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: workspaceDir });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=Range Tester", "commit", "-m", "Base"],
    { cwd: workspaceDir },
  );
  execFileSync("git", ["checkout", "-b", "feature/range"], { cwd: workspaceDir });
  fs.writeFileSync(join(workspaceDir, "first.ts"), "export const first = true;\n");
  execFileSync("git", ["add", "first.ts"], { cwd: workspaceDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=Range Tester",
      "commit",
      "-m",
      "First feature commit",
    ],
    { cwd: workspaceDir },
  );
  fs.writeFileSync(join(workspaceDir, "second.ts"), "export const second = true;\n");
  execFileSync("git", ["add", "second.ts"], { cwd: workspaceDir });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=Range Tester",
      "commit",
      "-m",
      "Second feature commit",
    ],
    { cwd: workspaceDir },
  );
  fs.writeFileSync(join(workspaceDir, "working-only.ts"), "export const working = true;\n");
}

function setupRepoWithHugeDiff(workspaceDir: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: workspaceDir });
  execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: workspaceDir });
  fs.writeFileSync(join(workspaceDir, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: workspaceDir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
    cwd: workspaceDir,
  });
  const lines = Array.from({ length: 10_050 }, (_, index) =>
    index === 10_025
      ? "const productionIncidentNeedle = true;"
      : `const generated_${index} = ${index};`,
  );
  fs.writeFileSync(join(workspaceDir, "huge.ts"), `${lines.join("\n")}\n`);
}

test.describe("Diff viewer", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_SESSION_HOST, 0o755);
  });

  test("header button shows badge, opens viewer with 2 files; per-file section renders", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    setupRepoWithChanges(folders.workspaceDir);
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    // The changes button should show `± 2` (a.ts modified, b.ts untracked).
    const changesBtn = window.locator('[data-testid="changes-button"]');
    await expect(changesBtn).toBeVisible({ timeout: 10_000 });
    await expect(changesBtn).toContainText("2", { timeout: 10_000 });

    // Open the viewer.
    await changesBtn.click();
    const viewer = window.locator(".diff-viewer");
    await expect(viewer).toBeVisible({ timeout: 5_000 });

    // Rail rows: a.ts (M) and b.ts (A).
    const railItems = window.locator(".diff-tree__row--file");
    await expect(railItems).toHaveCount(2, { timeout: 5_000 });
    await expect(railItems.first()).toContainText("a.ts");
    await expect(railItems.last()).toContainText("b.ts");

    // Summary.
    await expect(viewer.locator(".diff-viewer__summary")).toContainText("2 files", {
      timeout: 5_000,
    });

    // Section for a.ts renders the M rows + a gap separator.
    const aSection = viewer.locator('[data-testid="diff-section-a.ts"]');
    await expect(aSection).toBeVisible({ timeout: 5_000 });
    await expect(
      aSection.locator(".diff-row--del").or(aSection.locator(".diff-row--add")),
    ).not.toHaveCount(0, { timeout: 5_000 });
    await expect(aSection.locator(".diff-gap").first()).toBeVisible();

    // Click every gap label to fully expand them. With 3 changes we
    // have 2 inter-hunk gaps (and a possible file-start gap, depending
    // on the first hunk's position).
    for (;;) {
      const labels = aSection.locator(".diff-gap__label");
      const count = await labels.count();
      if (count === 0) break;
      await labels.first().click();
    }

    // Untracked file b.ts renders as an A section.
    const bSection = viewer.locator('[data-testid="diff-section-b.ts"]');
    await expect(bSection).toBeVisible();
    await expect(bSection.locator(".diff-row--add")).not.toHaveCount(0);

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("code comments can be added, edited, deleted, submitted, and cleared", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    setupRepoWithChanges(folders.workspaceDir);
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const changesBtn = window.locator('[data-testid="changes-button"]');
    await expect(changesBtn).toContainText("2", { timeout: 10_000 });
    await changesBtn.click();

    const viewer = window.locator(".diff-viewer");
    const aSection = viewer.locator('[data-testid="diff-section-a.ts"]');
    await expect(aSection).toBeVisible({ timeout: 5_000 });
    await expect(
      aSection.locator('.diff-row--del [data-testid="diff-comment-button"]'),
    ).toHaveCount(0);

    const line10Button = viewer.locator(
      '[data-testid="diff-comment-button"][data-file="a.ts"][data-line="10"]',
    );
    await line10Button.click();
    let commentBox = viewer.getByRole("textbox", { name: "Code comment" });
    await commentBox.pressSequentially("jk\\ helper");
    await expect(commentBox).toHaveValue("jk\\ helper");
    await commentBox.press("Escape");
    await expect(viewer.getByRole("dialog", { name: "Comment on line 10" })).toHaveCount(0);
    await expect(viewer).toBeVisible();

    await line10Button.click();
    commentBox = viewer.getByRole("textbox", { name: "Code comment" });
    await commentBox.fill("Prefer the shared helper here.");
    await viewer.getByRole("button", { name: "Save" }).click();
    await expect(line10Button).toHaveClass(/diff-row__comment-btn--has-comment/);
    await expect(
      viewer.locator('[data-testid="diff-comment-thread"]').filter({
        hasText: "Prefer the shared helper here.",
      }),
    ).toBeVisible();
    const line10Row = line10Button.locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' diff-row ')][1]",
    );
    const [line10ButtonBox, line10RowBox] = await Promise.all([
      line10Button.boundingBox(),
      line10Row.boundingBox(),
    ]);
    expect(line10ButtonBox).not.toBeNull();
    expect(line10RowBox).not.toBeNull();
    if (!line10ButtonBox || !line10RowBox) throw new Error("missing comment button bounds");
    expect(
      Math.abs(
        line10ButtonBox.y + line10ButtonBox.height / 2 - (line10RowBox.y + line10RowBox.height / 2),
      ),
    ).toBeLessThan(3);

    const line30Button = viewer.locator(
      '[data-testid="diff-comment-button"][data-file="a.ts"][data-line="30"]',
    );
    await line30Button.click();
    await viewer.getByRole("textbox", { name: "Code comment" }).fill("This branch can be simpler.");
    await viewer.getByRole("button", { name: "Save" }).click();
    await expect(
      viewer.locator('[data-testid="diff-comment-thread"]').filter({
        hasText: "This branch can be simpler.",
      }),
    ).toBeVisible();

    await line10Button.click();
    await viewer.getByRole("textbox", { name: "Code comment" }).fill("Edited note for the helper.");
    await viewer.getByRole("button", { name: "Save" }).click();

    await line30Button.click();
    await viewer.getByRole("button", { name: "Delete" }).click();
    await expect(line30Button).not.toHaveClass(/diff-row__comment-btn--has-comment/);
    await expect(
      viewer.locator('[data-testid="diff-comment-thread"]').filter({
        hasText: "This branch can be simpler.",
      }),
    ).toHaveCount(0);

    await window.keyboard.press("Escape");
    await expect(viewer).toBeHidden({ timeout: 5_000 });

    const commentTile = window.locator(".composer__attachment-item--comments");
    await expect(commentTile).toBeVisible({ timeout: 5_000 });
    await expect(commentTile).toContainText("1");
    await expect(commentTile).toContainText("comment");
    const [countBox, clearBox] = await Promise.all([
      commentTile.locator(".composer__comment-attachment-count").boundingBox(),
      commentTile.getByRole("button", { name: "Clear code comments" }).boundingBox(),
    ]);
    expect(countBox).not.toBeNull();
    expect(clearBox).not.toBeNull();
    if (!countBox || !clearBox) throw new Error("missing comment tile bounds");
    expect(countBox.x + countBox.width).toBeLessThan(clearBox.x);

    await changesBtn.click();
    await expect(
      viewer.locator('[data-testid="diff-comment-thread"]').filter({
        hasText: "Edited note for the helper.",
      }),
    ).toBeVisible({ timeout: 5_000 });
    await window.keyboard.press("Escape");
    await expect(viewer).toBeHidden({ timeout: 5_000 });

    const textarea = window.locator(".composer__textarea");
    await textarea.fill("Please review this change.");
    await textarea.press("Enter");

    const userBlock = window.locator(".transcript-block--user").first();
    await expect(userBlock).toContainText("User comments on the code", { timeout: 10_000 });
    await expect(userBlock).toContainText("File: a.ts");
    await expect(userBlock).toContainText("Line: 10");
    await expect(userBlock).toContainText("Edited note for the helper.");
    await expect(userBlock).toContainText("Please review this change.");
    await expect(commentTile).toHaveCount(0, { timeout: 10_000 });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("selects an inclusive base-relative commit range and resets it on close", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    setupRepoWithCommitRange(folders.workspaceDir);
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const changesBtn = window.locator('[data-testid="changes-button"]');
    await expect(changesBtn).toContainText("1", { timeout: 10_000 });
    await changesBtn.click();
    const viewer = window.locator(".diff-viewer");
    await expect(viewer).toBeVisible({ timeout: 5_000 });

    // The base and range stay separate. A plain click applies a one-commit
    // comparison and closes the picker; dragging or Shift-clicking extends it
    // while keeping the chosen range visible in the picker.
    const base = viewer.getByRole("button", { name: "Compare against base branch" });
    await base.click();
    await window.keyboard.press("Escape");
    await expect(base).toHaveAttribute("aria-expanded", "false");
    await expect(viewer).toBeVisible();
    await base.click();
    await viewer.getByRole("option", { name: /main/ }).click();
    const range = viewer.getByRole("button", { name: "Choose commit range" });
    await expect(range).toBeVisible({ timeout: 10_000 });
    await range.click();
    await window.keyboard.press("Escape");
    await expect(viewer.getByRole("dialog", { name: "Commit range" })).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await range.click();
    await viewer.getByRole("option", { name: /Second feature commit/ }).click();
    await expect(range).toContainText("1 commit");
    await expect(viewer.getByRole("dialog", { name: "Commit range" })).toHaveCount(0);
    await range.click();
    await viewer
      .getByRole("option", { name: /Second feature commit/ })
      .dragTo(viewer.getByRole("option", { name: /First feature commit/ }));
    await expect(viewer.getByRole("dialog", { name: "Commit range" })).toBeVisible();

    await expect(viewer.locator(".diff-tree__row--file")).toHaveCount(2, { timeout: 10_000 });
    await expect(viewer.locator('[data-testid="diff-section-first.ts"]')).toContainText(
      "export const first = true;",
      { timeout: 10_000 },
    );
    await expect(viewer.locator('[data-testid="diff-section-second.ts"]')).toContainText(
      "export const second = true;",
      { timeout: 10_000 },
    );
    await expect(viewer.locator("[data-testid='diff-comment-button']")).toHaveCount(0);
    await expect(range).toContainText("2 commits");

    // Uncommitted changes are a pseudo-commit endpoint and can extend the
    // selected historical band through the live working tree.
    await viewer
      .getByRole("option", { name: "Uncommitted changes" })
      .click({ modifiers: ["Shift"] });
    await expect(range).toContainText("2 commits + uncommitted");
    await expect(viewer.getByRole("option", { name: /Uncommitted changes/ })).toContainText("End");
    await expect(viewer.getByRole("option", { name: /Second feature commit/ })).not.toContainText(
      "End",
    );
    await expect(viewer.getByRole("dialog", { name: "Commit range" })).toBeVisible();
    await expect(viewer.locator(".diff-tree__row--file")).toHaveCount(3, { timeout: 10_000 });
    await expect(viewer.locator('[data-testid="diff-section-working-only.ts"]')).toContainText(
      "export const working = true;",
    );

    await viewer.getByRole("button", { name: "Close diff viewer" }).click();
    await expect(viewer).toBeHidden({ timeout: 5_000 });
    await changesBtn.click();
    await expect(viewer).toBeVisible({ timeout: 5_000 });
    await expect(range).toContainText("All changes");

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("Split mode toggles, persists across close/reopen", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    setupRepoWithChanges(folders.workspaceDir);
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const changesBtn = window.locator('[data-testid="changes-button"]');
    await expect(changesBtn).toContainText("2", { timeout: 10_000 });
    await changesBtn.click();
    const viewer = window.locator(".diff-viewer");
    await expect(viewer).toBeVisible({ timeout: 5_000 });

    // Click SPLIT.
    const splitBtn = viewer.getByRole("button", { name: "Split" });
    await expect(splitBtn).toBeEnabled();
    await splitBtn.click();
    // The unified rows are now split-pair rows.
    await expect(viewer.locator(".diff-row--split").first()).toBeVisible({ timeout: 5_000 });

    const line10Button = viewer.locator(
      '[data-testid="diff-comment-button"][data-file="a.ts"][data-line="10"]',
    );
    await line10Button.click();
    await viewer.getByRole("textbox", { name: "Code comment" }).fill("Visible in split view.");
    await viewer.getByRole("button", { name: "Save" }).click();
    await expect(
      viewer
        .locator('[data-testid="diff-comment-thread"]')
        .filter({ hasText: "Visible in split view." }),
    ).toBeVisible();
    await expect(line10Button).toHaveClass(/diff-row__comment-btn--has-comment/);

    // Close and reopen.
    await viewer.locator(".diff-viewer__icon-btn").last().click(); // close
    await expect(viewer).toBeHidden({ timeout: 5_000 });
    await changesBtn.click();
    await expect(viewer).toBeVisible({ timeout: 5_000 });
    // Split and pending comment threads should be remembered.
    await expect(viewer.locator(".diff-row--split").first()).toBeVisible({ timeout: 5_000 });
    await expect(
      viewer
        .locator('[data-testid="diff-comment-thread"]')
        .filter({ hasText: "Visible in split view." }),
    ).toBeVisible();

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("Escape closes; ⌘G opens; /diff opens", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    setupRepoWithChanges(folders.workspaceDir);
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const viewer = window.locator(".diff-viewer");

    // /diff opens.
    const textarea = window.locator(".composer__textarea");
    await textarea.fill("/diff");
    await textarea.press("Enter");
    await expect(viewer).toBeVisible({ timeout: 10_000 });

    // Esc closes.
    await window.keyboard.press("Escape");
    await expect(viewer).toBeHidden({ timeout: 5_000 });

    // Meta+G (⌘G) opens the viewer from the session surface.
    await window.keyboard.press("Meta+g");
    await expect(viewer).toBeVisible({ timeout: 5_000 });
    await window.keyboard.press("Escape");
    await expect(viewer).toBeHidden({ timeout: 5_000 });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("Clean repo: dimmed badge; /diff → 'Working tree clean'", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    // Make a clean repo (commit everything, no further changes).
    execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: folders.workspaceDir });
    fs.writeFileSync(join(folders.workspaceDir, "a.ts"), "line\n");
    execFileSync("git", ["add", "a.ts"], { cwd: folders.workspaceDir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
      cwd: folders.workspaceDir,
    });

    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    // Badge renders dimmed (no count number).
    const changesBtn = window.locator('[data-testid="changes-button"]');
    await expect(changesBtn).toBeVisible({ timeout: 10_000 });
    await expect(changesBtn).not.toContainText("1");
    await changesBtn.click();

    const viewer = window.locator(".diff-viewer");
    await expect(viewer).toBeVisible({ timeout: 5_000 });
    await expect(viewer).toContainText("Working tree clean", { timeout: 5_000 });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("Rail filter narrows rows; clicking a rail row scrolls its section into view", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    setupRepoWithChanges(folders.workspaceDir);
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const changesBtn = window.locator('[data-testid="changes-button"]');
    await expect(changesBtn).toContainText("2", { timeout: 10_000 });
    await changesBtn.click();
    const viewer = window.locator(".diff-viewer");
    await expect(viewer).toBeVisible({ timeout: 5_000 });

    // Filter narrows to b.ts only.
    const search = viewer.locator(".diff-rail__search-input");
    await search.fill("b.ts");
    await expect(viewer.locator(".diff-tree__row--file")).toHaveCount(1, { timeout: 5_000 });
    await expect(viewer.locator(".diff-tree__row--file").first()).toContainText("b.ts");

    // Clear filter, click a.ts row → that section is the selected one.
    await search.fill("");
    await expect(viewer.locator(".diff-tree__row--file")).toHaveCount(2, { timeout: 5_000 });
    const aItem = viewer.locator('.diff-tree__row--file[data-path="a.ts"]');
    await aItem.click();
    await expect(aItem).toHaveClass(/diff-tree__row--active/, { timeout: 5_000 });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("find reaches a changed occurrence beyond the DOM ceiling without mounting its prefix", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    setupRepoWithHugeDiff(folders.workspaceDir);
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    await window.locator('[data-testid="changes-button"]').click();
    const viewer = window.locator(".diff-viewer");
    await expect(viewer).toBeVisible({ timeout: 10_000 });
    await expect(viewer.locator(".diff-row--add").first()).toBeVisible({ timeout: 15_000 });

    await window.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
    const find = viewer.locator(".diff-search__input");
    await expect(find).toBeVisible();
    await find.fill("productionIncidentNeedle");

    await expect(viewer.locator(".diff-search__count")).toContainText("1 of 1", {
      timeout: 30_000,
    });
    await expect(viewer.locator(".diff-search-mark--current")).toContainText(
      "productionIncidentNeedle",
      { timeout: 15_000 },
    );
    await expect(viewer.locator(".diff-row--cap-notice")).toContainText("Skipping hidden rows");
    const mountedRows = await viewer.locator(".diff-row").count();
    expect(mountedRows).toBeLessThan(1_100);

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });
});
