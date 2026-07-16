import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSessionSearchCorpus } from "./session-search-corpus.mjs";
import {
  type LaunchedElectronApplication,
  launchElectron,
} from "./support/instrumented-launch.mjs";
import { allowInvariant, expect, test } from "./support/invariants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ENTRY = join(__dirname, "../../out/main/index.js");
const PACKAGED_EXECUTABLE = process.env.PIVIS_PACKAGED_EXECUTABLE;
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");
const FAKE_SESSION_HOST = join(__dirname, "../fixtures/fake-session-host.mjs");

function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
}

function ipcCalls(file: string): Array<{ channel: string; payload: Record<string, unknown> }> {
  return lines(file).map((line) => JSON.parse(line));
}

test.describe("workspace saved-session search", () => {
  test("disabled launch starts no search service and exposes no search chrome", async () => {
    fs.chmodSync(FAKE_PI, 0o755);
    const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-search-disabled-")));
    const settingsDir = join(root, "user-data");
    const sessionsDir = join(root, "sessions");
    fs.mkdirSync(settingsDir);
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        piBinaryPath: FAKE_PI,
        sessionSearchEnabled: false,
        workspaceOrder: [],
      }),
    );

    let app: LaunchedElectronApplication | undefined;
    try {
      app = await launchElectron({
        ...(PACKAGED_EXECUTABLE ? { executablePath: PACKAGED_EXECUTABLE } : {}),
        args: PACKAGED_EXECUTABLE ? [] : [APP_ENTRY],
        env: {
          ...process.env,
          PIVIS_SETTINGS_DIR: settingsDir,
          PIVIS_SESSIONS_DIR: sessionsDir,
          ELECTRON_RENDERER_URL: undefined,
        },
      });
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByRole("button", { name: "Settings" })).toBeVisible({
        timeout: 20_000,
      });
      await expect
        .poll(() => page.evaluate(() => window.pivis.invoke("sessionSearch.available", undefined)))
        .toBe(false);
      await expect(page.locator(".sidebar__workspace-search")).toHaveCount(0);
      await page.keyboard.press("Meta+Shift+f");
      await expect(page.locator(".session-search-overlay")).toHaveCount(0);
      expect(fs.existsSync(join(settingsDir, "session-search"))).toBe(false);
    } finally {
      await app?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("scopes, previews without hosts, indexes branches/appends, and opens normally", async () => {
    fs.chmodSync(FAKE_PI, 0o755);
    const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-search-")));
    const settingsDir = join(root, "user-data");
    fs.mkdirSync(settingsDir);
    const corpus = generateSessionSearchCorpus(root);
    const spawnLog = join(root, "spawn.log");
    const operationLog = join(root, "operations.log");
    const ipcLog = join(root, "ipc.log");
    fs.writeFileSync(ipcLog, "");
    fs.writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        piBinaryPath: FAKE_PI,
        workspaceOrder: [corpus.workspaceA, corpus.workspaceB],
        expandedWorkspaces: [corpus.workspaceA, corpus.workspaceB],
        lastActiveWorkspace: corpus.workspaceB,
        archivedSessions: [corpus.archivedFile],
        worktrees: {
          [corpus.worktreeA]: {
            workspacePath: corpus.workspaceA,
            branch: "search-worktree",
            name: "rustic-gnome",
            base: "main",
          },
        },
        fonts: {
          display: { sizePx: 14 },
          code: { family: "monospace", sizePx: 13 },
        },
      }),
    );

    let app: LaunchedElectronApplication | undefined;
    try {
      app = await launchElectron({
        ...(PACKAGED_EXECUTABLE ? { executablePath: PACKAGED_EXECUTABLE } : {}),
        args: PACKAGED_EXECUTABLE ? [] : [APP_ENTRY],
        env: {
          ...process.env,
          PIVIS_SETTINGS_DIR: settingsDir,
          PIVIS_SESSIONS_DIR: corpus.sessionsRoot,
          FAKE_PI_SESSIONS_DIR: corpus.sessionsRoot,
          PIVIS_TEST_HOST_SCRIPT: FAKE_SESSION_HOST,
          PIVIS_TEST_HOST_SPAWN_LOG: spawnLog,
          PIVIS_TEST_HOST_OPERATION_LOG: operationLog,
          PIVIS_TEST_IPC_INVOCATION_LOG: ipcLog,
          ELECTRON_RENDERER_URL: undefined,
        },
      });
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });
      await expect(
        page.locator(".sidebar__workspace--active .sidebar__workspace-name"),
      ).toContainText("workspace-beta");
      // Ignore the normal boot activation. Search preview must add no spawn or
      // lifecycle operation of its own.
      fs.writeFileSync(spawnLog, "");
      fs.writeFileSync(operationLog, "");
      fs.writeFileSync(ipcLog, "");

      const searchA = page.getByRole("button", { name: "Search sessions in workspace-alpha" });
      await searchA.click();
      await expect(
        page.getByRole("dialog", { name: "Search sessions in workspace-alpha" }),
      ).toBeVisible();
      const input = page.getByRole("combobox");

      await input.fill("zircon");
      await expect(page.getByText(/No saved-session matches|No matches yet/u)).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole("option")).toHaveCount(0);

      await input.fill("cobalt");
      const worktreeResult = page.getByRole("option", { name: /Mapped worktree history/u });
      await expect(worktreeResult).toBeVisible({ timeout: 20_000 });
      await expect(worktreeResult).toContainText("rustic-gnome");

      // Arrival and arrow selection are inert: preview is the sole context IPC trigger.
      await input.fill("quartz");
      await page.keyboard.press("ArrowDown");
      expect(ipcCalls(ipcLog).filter((call) => call.channel === "sessionSearch.context")).toEqual(
        [],
      );
      const oldResult = page
        .getByRole("option", { name: /Ancient lifecycle investigation/u })
        .filter({ hasText: "quartz precompaction" });
      await expect(oldResult).toBeVisible({ timeout: 20_000 });
      await oldResult.click();
      await expect(page.locator(".session-search__context-item--target")).toContainText(
        "quartz precompaction",
      );
      await expect(page.locator(".session-search__context-items")).toContainText(
        "saved summary after quartz evidence",
      );
      await page.keyboard.press("Escape");
      await expect(input).toBeFocused();

      await input.fill("juniper");
      const branchResult = page.getByRole("option", { name: /Ancient lifecycle investigation/u });
      await expect(branchResult).toBeVisible({ timeout: 20_000 });
      await branchResult.click();
      await expect(page.getByText(/Other saved branch\. Opening the session/u)).toBeVisible();

      expect(lines(spawnLog)).toHaveLength(0);
      expect(lines(operationLog)).toHaveLength(0);
      expect(
        ipcCalls(ipcLog).filter((call) =>
          ["session.open", "session.activate", "session.releaseActivationVisit"].includes(
            call.channel,
          ),
        ),
      ).toEqual([]);
      await expect(
        page.locator(".sidebar__workspace--active .sidebar__workspace-name"),
      ).toContainText("workspace-beta");

      // Preview Escape returns to results; the next Escape belongs to search
      // and cannot escape/interrupt the underlying host.
      await page.keyboard.press("Escape");
      await expect(page.locator(".session-search__results-pane")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".session-search-overlay")).toHaveCount(0);
      expect(lines(operationLog)).toHaveLength(0);

      // Completed appends become visible through bounded reconciliation; an
      // incomplete row remains absent until its newline is committed.
      await searchA.click();
      await input.fill("saffronfresh");
      await expect(page.getByText(/No saved-session matches|No matches yet/u)).toBeVisible({
        timeout: 20_000,
      });
      const appended = JSON.stringify({
        type: "message",
        id: "fresh-append",
        parentId: "append-root",
        timestamp: Date.now(),
        message: { role: "user", content: "saffronfresh completed append" },
      });
      fs.appendFileSync(corpus.appendFile, appended.slice(0, -1));
      await expect(page.getByRole("option")).toHaveCount(0);
      const appendCommittedAt = performance.now();
      fs.appendFileSync(corpus.appendFile, `${appended.slice(-1)}\n`);
      await expect(page.getByRole("option", { name: /Append target/u })).toBeVisible({
        timeout: 2_000,
      });
      expect(performance.now() - appendCommittedAt).toBeLessThan(2_000);

      await input.fill("topaz");
      await expect(page.getByText(/No saved-session matches|No matches yet/u)).toBeVisible({
        timeout: 20_000,
      });
      await input.fill("juniper");
      await expect(branchResult).toBeVisible({ timeout: 20_000 });
      await branchResult.click();
      await page.getByRole("button", { name: "Open session" }).click();
      await expect(page.locator(".session-search-overlay")).toHaveCount(0);
      await expect.poll(() => lines(spawnLog).length, { timeout: 15_000 }).toBe(1);
      await expect
        .poll(() => ipcCalls(ipcLog).find((call) => call.channel === "session.activate"), {
          timeout: 15_000,
        })
        .not.toBeUndefined();
      const lifecycle = ipcCalls(ipcLog);
      const activateCalls = lifecycle.filter((call) => call.channel === "session.activate");
      expect(activateCalls).toHaveLength(1);
      const visitId = activateCalls[0]?.payload["activationVisitId"];
      expect(visitId).toEqual(expect.any(String));
      expect(lifecycle.filter((call) => call.channel === "sessionSearch.open")).toHaveLength(1);
      expect(lifecycle.filter((call) => call.channel === "session.open")).toHaveLength(0);

      // Search opening enters the same narrow activation-visit ownership as a
      // stored-session row. A rapid untouched switch uses the shared release
      // path with the exact visit token—there is no search-specific reaper.
      await page.getByText("Beta secrets", { exact: true }).click();
      await expect
        .poll(
          () =>
            ipcCalls(ipcLog).find((call) => call.channel === "session.releaseActivationVisit")
              ?.payload["activationVisitId"],
          { timeout: 10_000 },
        )
        .toBe(visitId);
    } finally {
      await app?.close().catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps verified preview and the previous activation visit when target activation fails", async () => {
    // The fixture deliberately exits this target host before ready; the UI
    // assertion below verifies activation failure is contained.
    allowInvariant("main-stderr", "Host process exited with code 23 before ready");
    fs.chmodSync(FAKE_PI, 0o755);
    const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-search-fail-")));
    const settingsDir = join(root, "user-data");
    fs.mkdirSync(settingsDir);
    const corpus = generateSessionSearchCorpus(root);
    const spawnLog = join(root, "spawn.log");
    const ipcLog = join(root, "ipc.log");
    fs.writeFileSync(ipcLog, "");
    fs.writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        piBinaryPath: FAKE_PI,
        workspaceOrder: [corpus.workspaceA, corpus.workspaceB],
        expandedWorkspaces: [corpus.workspaceA, corpus.workspaceB],
        lastActiveWorkspace: corpus.workspaceB,
        archivedSessions: [corpus.archivedFile],
        worktrees: {
          [corpus.worktreeA]: {
            workspacePath: corpus.workspaceA,
            branch: "search-worktree",
            name: "rustic-gnome",
            base: "main",
          },
        },
        fonts: {
          display: { sizePx: 14 },
          code: { family: "monospace", sizePx: 13 },
        },
      }),
    );

    let app: LaunchedElectronApplication | undefined;
    try {
      app = await launchElectron({
        ...(PACKAGED_EXECUTABLE ? { executablePath: PACKAGED_EXECUTABLE } : {}),
        args: PACKAGED_EXECUTABLE ? [] : [APP_ENTRY],
        env: {
          ...process.env,
          PIVIS_SETTINGS_DIR: settingsDir,
          PIVIS_SESSIONS_DIR: corpus.sessionsRoot,
          FAKE_PI_SESSIONS_DIR: corpus.sessionsRoot,
          PIVIS_TEST_HOST_SCRIPT: FAKE_SESSION_HOST,
          PIVIS_TEST_HOST_SPAWN_LOG: spawnLog,
          PIVIS_TEST_HOST_FAIL_SESSION_ID: "old-exact-alpha",
          PIVIS_TEST_IPC_INVOCATION_LOG: ipcLog,
          ELECTRON_RENDERER_URL: undefined,
        },
      });
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });
      await expect(
        page.locator(".sidebar__workspace--active .sidebar__workspace-name"),
      ).toContainText("workspace-beta");
      fs.writeFileSync(spawnLog, "");
      fs.writeFileSync(ipcLog, "");

      await page.getByRole("button", { name: "Search sessions in workspace-alpha" }).click();
      await page.getByRole("combobox").fill("juniper");
      const result = page.getByRole("option", { name: /Ancient lifecycle investigation/u });
      await expect(result).toBeVisible({ timeout: 20_000 });
      await result.click();
      await page.getByRole("button", { name: "Open session" }).click();

      await expect(page.locator(".session-search-overlay")).toBeVisible();
      await expect(page.locator(".session-search__notice--error")).toContainText(
        "Could not open this session",
        { timeout: 20_000 },
      );
      await expect(page.locator(".session-search__context-item--target")).toContainText(
        "juniper alternate-only branch evidence",
      );
      await expect(
        page.locator(".sidebar__workspace--active .sidebar__workspace-name"),
      ).toContainText("workspace-beta");
      await expect.poll(() => lines(spawnLog).length, { timeout: 15_000 }).toBe(1);
      const calls = ipcCalls(ipcLog);
      expect(calls.filter((call) => call.channel === "session.activate")).toHaveLength(1);
      expect(
        calls.filter((call) => call.channel === "session.releaseActivationVisit"),
      ).toHaveLength(0);
    } finally {
      await app?.close().catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
