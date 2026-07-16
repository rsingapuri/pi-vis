import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchElectron } from "./support/instrumented-launch.mjs";
import { expect, test } from "./support/invariants.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");
const FAKE_SESSION_HOST = join(__dirname, "../fixtures/fake-session-host.mjs");
const APP_ENTRY = join(__dirname, "../../out/main/index.js");

function rmrf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort fixture cleanup.
  }
}

function setupWorkspaceRepo(workspaceDir: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: workspaceDir });
  execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: workspaceDir });
  fs.writeFileSync(join(workspaceDir, "README.md"), "workspace\n");
  execFileSync("git", ["add", "README.md"], { cwd: workspaceDir });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=Worktree Tester", "commit", "-m", "Init"],
    { cwd: workspaceDir },
  );
}

function setupRepo(workspaceDir: string, worktreePath: string): void {
  setupWorkspaceRepo(workspaceDir);
  execFileSync("git", ["worktree", "add", "-b", "review/switch", worktreePath, "main"], {
    cwd: workspaceDir,
  });
}

test.describe("Active-session worktree switching", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_SESSION_HOST, 0o755);
  });

  test("creates from the current checkout and carries local changes", async () => {
    test.setTimeout(90_000);
    const settingsDir = fs.realpathSync(
      fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-wt-create-settings-")),
    );
    const workspaceDir = fs.realpathSync(
      fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-wt-create-repo-")),
    );
    const piSessionsDir = fs.realpathSync(
      fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-wt-create-pi-")),
    );
    setupWorkspaceRepo(workspaceDir);

    const settingsPath = join(settingsDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        piBinaryPath: FAKE_PI,
        workspaceOrder: [workspaceDir],
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
        PIVIS_SETTINGS_DIR: settingsDir,
        FAKE_PI_SESSIONS_DIR: piSessionsDir,
        PIVIS_SESSIONS_DIR: piSessionsDir,
        PIVIS_TEST_HOST_SCRIPT: FAKE_SESSION_HOST,
        ELECTRON_RENDERER_URL: undefined,
      },
    });
    app.process().stderr?.on("data", () => {});
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1440, height: 900 });
    await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({
      timeout: 15_000,
    });

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const composer = window.locator(".composer__textarea");
    await composer.fill("Keep this conversation while creating a worktree.");
    await composer.press("Enter");
    await expect(window.locator(".transcript-block--user").first()).toContainText(
      "Keep this conversation while creating a worktree.",
      { timeout: 15_000 },
    );
    await composer.fill("This draft survives with the local files.");

    fs.writeFileSync(join(workspaceDir, "README.md"), "staged change\n");
    execFileSync("git", ["add", "README.md"], { cwd: workspaceDir });
    fs.appendFileSync(join(workspaceDir, "README.md"), "unstaged change\n");
    fs.writeFileSync(join(workspaceDir, "local-notes.txt"), "untracked\n");
    const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: workspaceDir,
      encoding: "utf8",
    }).trim();

    const trigger = window.locator('[data-testid="worktree-switcher-trigger"]');
    await expect(trigger).toContainText("Workspace", { timeout: 15_000 });
    await trigger.click();
    const popup = window.getByRole("dialog", { name: "Switch worktree" });
    await expect(popup.getByLabel("Choose worktree base branch")).toHaveCount(0);
    await expect(popup).not.toContainText("restarts its host");
    await popup.getByRole("button", { name: "Create & switch" }).click();
    await expect(trigger).not.toContainText("Workspace", { timeout: 20_000 });
    await expect(composer).toHaveValue("This draft survives with the local files.");

    let generatedPath = "";
    let generatedBranch = "";
    await expect
      .poll(() => {
        const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
          worktrees?: Record<string, { branch: string }>;
        };
        const entry = Object.entries(persisted.worktrees ?? {})[0];
        generatedPath = entry?.[0] ?? "";
        generatedBranch = entry?.[1].branch ?? "";
        return generatedPath;
      })
      .not.toBe("");
    expect(
      execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: generatedPath,
        encoding: "utf8",
      }).trim(),
    ).toBe(sourceStatus);
    expect(fs.readFileSync(join(generatedPath, "README.md"), "utf8")).toContain("unstaged change");
    expect(fs.readFileSync(join(generatedPath, "local-notes.txt"), "utf8")).toBe("untracked\n");
    expect(
      execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: workspaceDir,
        encoding: "utf8",
      }).trim(),
    ).toBe(sourceStatus);

    await app.close();
    execFileSync("git", ["worktree", "remove", "--force", generatedPath], { cwd: workspaceDir });
    execFileSync("git", ["branch", "-D", generatedBranch], { cwd: workspaceDir });
    rmrf(settingsDir);
    rmrf(workspaceDir);
    rmrf(piSessionsDir);
  });

  test("switches an established session while preserving conversation and draft", async () => {
    test.setTimeout(90_000);
    const settingsDir = fs.realpathSync(
      fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-wt-settings-")),
    );
    const workspaceDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-wt-repo-")));
    const piSessionsDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-wt-pi-")));
    const worktreeParent = fs.realpathSync(
      fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-wt-target-")),
    );
    const worktreePath = join(worktreeParent, "review-tree");
    setupRepo(workspaceDir, worktreePath);

    const settingsPath = join(settingsDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        piBinaryPath: FAKE_PI,
        workspaceOrder: [workspaceDir],
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
        PIVIS_SETTINGS_DIR: settingsDir,
        FAKE_PI_SESSIONS_DIR: piSessionsDir,
        PIVIS_SESSIONS_DIR: piSessionsDir,
        PIVIS_TEST_HOST_SCRIPT: FAKE_SESSION_HOST,
        ELECTRON_RENDERER_URL: undefined,
      },
    });
    app.process().stderr?.on("data", () => {});
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1440, height: 900 });
    await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({
      timeout: 15_000,
    });

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const composer = window.locator(".composer__textarea");
    await composer.fill("Keep this conversation while switching.");
    await composer.press("Enter");
    await expect(window.locator(".transcript-block--user").first()).toContainText(
      "Keep this conversation while switching.",
      { timeout: 15_000 },
    );

    const trigger = window.locator('[data-testid="worktree-switcher-trigger"]');
    await expect(trigger).toContainText("Workspace", { timeout: 15_000 });
    await composer.fill("This draft must survive the restart.");
    await expect(composer).toHaveValue("This draft must survive the restart.");

    await trigger.click();
    const popup = window.getByRole("dialog", { name: "Switch worktree" });
    await popup.getByRole("button", { name: "Existing" }).click();
    await popup.getByRole("textbox", { name: "Worktree directory path" }).fill(worktreePath);
    await expect(popup).toContainText("On branch review/switch", { timeout: 10_000 });
    const apply = popup.getByRole("button", { name: "Switch worktree" });
    await expect(apply).toBeEnabled({ timeout: 15_000 });
    await apply.click();

    await expect(trigger).toContainText(basename(worktreePath), { timeout: 20_000 });
    await expect(popup).toBeHidden();
    await expect(window.locator(".transcript-block--user").first()).toContainText(
      "Keep this conversation while switching.",
    );
    await expect(composer).toHaveValue("This draft must survive the restart.");

    await expect
      .poll(() => {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
          worktrees?: Record<string, unknown>;
          sessionWorktrees?: Record<string, string>;
        };
        return {
          association: Object.hasOwn(settings.worktrees ?? {}, worktreePath),
          overrides: Object.values(settings.sessionWorktrees ?? {}).filter(
            (candidate) => candidate === worktreePath,
          ).length,
        };
      })
      .toEqual({ association: true, overrides: 1 });

    await trigger.click();
    const returnPopup = window.getByRole("dialog", { name: "Switch worktree" });
    await returnPopup.getByRole("button", { name: "Existing" }).click();
    await returnPopup.getByRole("textbox", { name: "Worktree directory path" }).fill(workspaceDir);
    await expect(returnPopup).toContainText("On branch main", { timeout: 10_000 });
    await returnPopup.getByRole("button", { name: "Switch worktree" }).click();
    await expect(trigger).toContainText("Workspace", { timeout: 20_000 });
    await expect(composer).toHaveValue("This draft must survive the restart.");
    await expect
      .poll(() => {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
          sessionWorktrees?: Record<string, string>;
        };
        return Object.values(settings.sessionWorktrees ?? {}).filter(
          (candidate) => candidate === worktreePath,
        ).length;
      })
      .toBe(0);

    await app.close();
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: workspaceDir });
    } catch {
      // App is already closed; direct removal below is sufficient for cleanup.
    }
    rmrf(settingsDir);
    rmrf(workspaceDir);
    rmrf(piSessionsDir);
    rmrf(worktreeParent);
  });
});
