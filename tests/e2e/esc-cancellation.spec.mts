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

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");
const FAKE_HOST = join(__dirname, "../fixtures/fake-session-host.mjs");
const APP_ENTRY = join(__dirname, "../../out/main/index.js");

interface Folders {
  settingsDir: string;
  workspaceDir: string;
  sessionsDir: string;
  operationLog: string;
}

function makeFolders(): Folders {
  const make = (prefix: string) => fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), prefix)));
  const settingsDir = make("pivis-esc-settings-");
  return {
    settingsDir,
    workspaceDir: make("pivis-esc-workspace-"),
    sessionsDir: make("pivis-esc-sessions-"),
    operationLog: join(settingsDir, "operations.jsonl"),
  };
}

function operationEntries(folders: Folders): Array<Record<string, unknown>> {
  if (!fs.existsSync(folders.operationLog)) return [];
  return fs
    .readFileSync(folders.operationLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function launchApp(
  folders: Folders,
): Promise<{ app: LaunchedElectronApplication; window: Page }> {
  fs.writeFileSync(
    join(folders.settingsDir, "settings.json"),
    JSON.stringify({
      piBinaryPath: FAKE_PI,
      workspaceOrder: [folders.workspaceDir],
      fonts: { display: { sizePx: 14 }, code: { family: "monospace", sizePx: 13 } },
    }),
  );
  const app = await launchElectron({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: folders.settingsDir,
      FAKE_PI_SESSIONS_DIR: folders.sessionsDir,
      PIVIS_SESSIONS_DIR: folders.sessionsDir,
      PIVIS_TEST_HOST_SCRIPT: FAKE_HOST,
      PIVIS_TEST_HOST_OPERATION_LOG: folders.operationLog,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  app.process().stderr?.on("data", () => {});
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 15_000 });
  return { app, window };
}

function cleanup(folders: Folders): void {
  for (const folder of [folders.settingsDir, folders.workspaceDir, folders.sessionsDir]) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

async function waitForOperation(
  folders: Folders,
  event: string,
  kind: string,
): Promise<Record<string, unknown>> {
  let match: Record<string, unknown> | undefined;
  await expect
    .poll(() => {
      match = operationEntries(folders).find(
        (entry) => entry.event === event && entry.kind === kind,
      );
      return match !== undefined;
    })
    .toBe(true);
  return match!;
}

test.describe("process-level ESC cancellation", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_HOST, 0o755);
  });

  test("streaming queue, compaction, and bash cancel without late completion or persistence", async () => {
    test.setTimeout(90_000);
    const folders = makeFolders();
    const { app, window } = await launchApp(folders);
    try {
      await window.getByRole("button", { name: "New session" }).click();
      await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model", {
        timeout: 15_000,
      });
      const textarea = window.locator(".composer__textarea");

      await textarea.fill("hello queue owner");
      await textarea.press("Enter");
      const streaming = await waitForOperation(folders, "started", "streaming");
      // Host logs can lead the authority frame; wait until the renderer has
      // reduced the streaming snapshot before editing the next queue item.
      await expect(window.locator(".status-dot--streaming")).toBeVisible();
      await textarea.fill("queued for explicit review");
      await textarea.press("Enter");
      await waitForOperation(folders, "queued", "steer");
      await textarea.press("Escape");
      await waitForOperation(folders, "cancelled", "streaming");
      // ESC cleared the queue before consumption (certainty not_processed), so
      // the text returns straight to the composer with no review decision —
      // the same custody contract real-sdk-transcript-lifecycle proves on real Pi.
      await expect(textarea).toHaveValue("queued for explicit review", { timeout: 10_000 });
      await expect(window.getByText(/Review interrupted (message|command)/)).toHaveCount(0);
      await window.waitForTimeout(500);
      expect(
        operationEntries(folders).some(
          (entry) => entry.event === "persisted" && entry.token === streaming.token,
        ),
      ).toBe(false);
      await textarea.fill("/compact");
      await textarea.press("Escape"); // close slash completion
      await textarea.press("Enter");
      const compaction = await waitForOperation(folders, "started", "compaction");
      await textarea.press("Escape");
      await waitForOperation(folders, "cancelled", "compaction");
      await window.waitForTimeout(600);
      expect(
        operationEntries(folders).some(
          (entry) => entry.event === "persisted" && entry.token === compaction.token,
        ),
      ).toBe(false);

      await textarea.fill("!test-long-bash");
      await textarea.press("Enter");
      const bash = await waitForOperation(folders, "started", "bash");
      await textarea.press("Escape");
      await waitForOperation(folders, "cancelled", "bash");
      await window.waitForTimeout(900);
      expect(
        operationEntries(folders).some(
          (entry) => entry.event === "completed" && entry.token === bash.token,
        ),
      ).toBe(false);
      await expect(window.locator(".status-dot--streaming")).toHaveCount(0);
    } finally {
      await app.close();
      cleanup(folders);
    }
  });

  test("navigation, retry, streaming, and bash obey priority; editor and idle stay explicit", async () => {
    test.setTimeout(90_000);
    const folders = makeFolders();
    const { app, window } = await launchApp(folders);
    try {
      await window.getByRole("button", { name: "New session" }).click();
      await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model", {
        timeout: 15_000,
      });
      const textarea = window.locator(".composer__textarea");

      await textarea.fill("/test-overlap");
      await textarea.press("Escape"); // close slash completion without interrupting the host
      await textarea.press("Enter");
      const kinds = ["navigation", "compaction", "retry", "streaming", "bash"];
      const tokens = new Map<string, unknown>();
      for (const kind of kinds) {
        tokens.set(kind, (await waitForOperation(folders, "started", kind)).token);
      }
      for (const target of kinds) {
        await textarea.press("Escape");
        await expect
          .poll(() =>
            operationEntries(folders).some(
              (entry) => entry.event === "escape" && entry.target === target,
            ),
          )
          .toBe(true);
      }
      await window.waitForTimeout(2_200);
      for (const [kind, token] of tokens) {
        expect(
          operationEntries(folders).some(
            (entry) =>
              entry.token === token && (entry.event === "completed" || entry.event === "persisted"),
          ),
          `${kind} must not complete after ESC`,
        ).toBe(false);
      }

      await textarea.fill("/test-editor-wait");
      await textarea.press("Escape");
      await textarea.press("Enter");
      const editor = await waitForOperation(folders, "started", "editor");
      await textarea.press("Escape");
      await expect
        .poll(() =>
          operationEntries(folders).some(
            (entry) => entry.event === "escape" && entry.target === "editor",
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          operationEntries(folders).some(
            (entry) => entry.event === "completed" && entry.token === editor.token,
          ),
        )
        .toBe(true);
      expect(
        operationEntries(folders).some(
          (entry) => entry.event === "cancelled" && entry.token === editor.token,
        ),
      ).toBe(false);

      const idleEscapesBefore = operationEntries(folders).filter(
        (entry) => entry.event === "escape" && entry.target === "idle",
      ).length;
      await textarea.press("Escape");
      await expect
        .poll(
          () =>
            operationEntries(folders).filter(
              (entry) => entry.event === "escape" && entry.target === "idle",
            ).length,
        )
        .toBe(idleEscapesBefore + 1);
      await expect(window.getByText(/Review interrupted (message|command)/)).toHaveCount(0);
      await expect(window.locator(".status-dot--streaming")).toHaveCount(0);
    } finally {
      await app.close();
      cleanup(folders);
    }
  });
});
