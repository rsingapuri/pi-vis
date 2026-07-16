import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchElectron } from "./support/instrumented-launch.mjs";
import { expect, test } from "./support/invariants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(__dirname, "../fixtures/fake-pi.mjs");
const FAKE_SESSION_HOST = join(__dirname, "../fixtures/fake-session-host.mjs");
const APP_ENTRY = join(__dirname, "../../out/main/index.js");
const SESSION_LABEL = "Interrupted tool recovery";

function writeInterruptedSession(piSessionsDir: string, workspaceDir: string): void {
  const directory = join(piSessionsDir, "interrupted-tool");
  fs.mkdirSync(directory, { recursive: true });
  const rows = [
    {
      type: "session",
      version: 3,
      id: "session-root",
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd: workspaceDir,
    },
    {
      id: "session-info",
      parentId: "session-root",
      timestamp: 1_704_067_200_000,
      type: "session_info",
      name: SESSION_LABEL,
    },
    {
      id: "user-message",
      parentId: "session-info",
      timestamp: 1_704_067_200_001,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "start a tool and then crash" }],
      },
    },
    {
      id: "assistant-message",
      parentId: "user-message",
      timestamp: 1_704_067_200_002,
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "interrupted-call",
            name: "read",
            arguments: { path: "/tmp/never-finished" },
          },
        ],
      },
    },
  ];
  fs.writeFileSync(
    join(directory, "interrupted-tool.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

test.describe("Interrupted stored tool recovery", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_SESSION_HOST, 0o755);
  });

  test("settles an unmatched persisted tool call and labels it interrupted", async () => {
    const settingsDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-interrupt-")));
    const workspaceDir = fs.realpathSync(
      fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-interrupt-ws-")),
    );
    const piSessionsDir = fs.realpathSync(
      fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-interrupt-pi-")),
    );
    writeInterruptedSession(piSessionsDir, workspaceDir);
    fs.writeFileSync(
      join(settingsDir, "settings.json"),
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
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      const stored = window.locator(".sidebar__session").filter({ hasText: SESSION_LABEL });
      await expect(stored).toBeVisible({ timeout: 15_000 });
      await stored.click();

      const card = window.locator(".tool-card").filter({ hasText: "read" });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.locator(".tool-card__spinner")).toHaveCount(0);
      await expect(card.locator(".tool-card__badge--interrupted")).toHaveText("interrupted");
      await expect(card).not.toHaveClass(/tool-card--error/);
      await expect(window.locator(".working-row")).toHaveCount(0);
    } finally {
      await app.close();
      fs.rmSync(settingsDir, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(piSessionsDir, { recursive: true, force: true });
    }
  });
});
