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

const SESSION_LABEL = "Large hydration regression session";
const FIRST_MESSAGE = "LARGE_SESSION_FIRST_MESSAGE";
const LAST_MESSAGE = "LARGE_SESSION_LAST_MESSAGE";
const MESSAGE_COUNT = 2_500;
// This payload must survive validation and IPC conversion. The earlier fixture
// put its bytes in an unknown field that Zod stripped, so it tested a large
// input file but only a tiny renderer payload and missed the real UI freeze.
const RENDERED_OUTPUT_PADDING = "x".repeat(4_000);

interface Folders {
  settingsDir: string;
  workspaceDir: string;
  piSessionsDir: string;
}

async function makeFolders(): Promise<Folders> {
  const settingsDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-large-")));
  return {
    settingsDir,
    workspaceDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-large-ws-"))),
    piSessionsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-large-pi-"))),
  };
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
      PIVIS_TEST_HOST_SCRIPT: FAKE_SESSION_HOST,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  app.process().stderr?.on("data", () => {
    // Avoid letting a noisy fixture fill the child-process pipe.
  });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 15_000 });
  return { app, window };
}

function writeLargeSession(folders: Folders): string {
  const directory = join(folders.piSessionsDir, "large-session");
  const file = join(directory, "large-hydration.jsonl");
  fs.mkdirSync(directory, { recursive: true });
  const fd = fs.openSync(file, "w");
  let parentId = "session-root";
  let entryNumber = 0;
  const write = (entry: Record<string, unknown>): void => {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
  };
  const nextId = (): string => `entry-${++entryNumber}`;

  try {
    write({
      type: "session",
      version: 3,
      id: parentId,
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd: folders.workspaceDir,
    });
    const sessionInfoId = nextId();
    write({
      id: sessionInfoId,
      parentId,
      timestamp: 1_704_067_200_000,
      type: "session_info",
      name: SESSION_LABEL,
    });
    parentId = sessionInfoId;

    // Deliberately defer every result until after every tool call. This keeps
    // the fixture's JSON size realistic while making the old linear back-scan
    // quadratic, so the pre-fix converter blocks main long enough for the
    // responsiveness probe below to catch it.
    for (let index = 0; index < MESSAGE_COUNT; index++) {
      const userId = nextId();
      write({
        id: userId,
        parentId,
        timestamp: 1_704_067_200_001 + index * 3,
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: index === 0 ? FIRST_MESSAGE : `large user ${index}` }],
        },
      });
      parentId = userId;

      const assistantId = nextId();
      write({
        id: assistantId,
        parentId,
        timestamp: 1_704_067_200_002 + index * 3,
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: index === MESSAGE_COUNT - 1 ? LAST_MESSAGE : `large assistant ${index}`,
            },
            {
              type: "toolCall",
              id: `fixture-tool-${index}`,
              name: "fixture_tool",
              arguments: { index },
            },
          ],
        },
      });
      parentId = assistantId;
    }
    for (let index = 0; index < MESSAGE_COUNT; index++) {
      const resultId = nextId();
      write({
        id: resultId,
        parentId,
        timestamp: 1_704_067_200_003 + index * 3,
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `fixture-tool-${index}`,
          toolName: "fixture_tool",
          isError: false,
          content: [
            {
              type: "text",
              text: `fixture output ${index}\n${RENDERED_OUTPUT_PADDING}`,
            },
          ],
        },
      });
      parentId = resultId;
    }
  } finally {
    fs.closeSync(fd);
  }

  // The rendered tool-result payload keeps both the source file and the
  // main→renderer transcript response in the 10–20 MiB class. Keep this
  // explicit so unknown-field stripping cannot shrink the actual workload.
  const size = fs.statSync(file).size;
  expect(size).toBeGreaterThan(10 * 1024 * 1024);
  expect(size).toBeLessThan(20 * 1024 * 1024);
  return file;
}

function rmrf(path: string): void {
  fs.rmSync(path, { recursive: true, force: true });
}

test.describe("Large stored-session hydration", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_SESSION_HOST, 0o755);
  });

  test("keeps main responsive, its label stable, and complete history reachable", async () => {
    test.setTimeout(120_000);
    const folders = await makeFolders();
    writeLargeSession(folders);
    const { app, window } = await launchApp(folders);
    const consoleOutput: string[] = [];
    const captureOutput = (chunk: Buffer | string): void => consoleOutput.push(chunk.toString());
    app.process().stdout?.on("data", captureOutput);
    app.process().stderr?.on("data", captureOutput);
    window.on("console", (message) => consoleOutput.push(message.text()));

    try {
      const stored = window.locator(".sidebar__session").filter({ hasText: SESSION_LABEL });
      await expect(stored).toBeVisible({ timeout: 15_000 });

      // Sample only non-empty labels. The active row replaces the stored row
      // during open, so this catches any later fallback to "Untitled session".
      await window.evaluate(() => {
        const state = {
          labels: [] as string[],
          timer: 0,
          lastTick: performance.now(),
          maxTickGap: 0,
        };
        state.timer = window.setInterval(() => {
          const now = performance.now();
          state.maxTickGap = Math.max(state.maxTickGap, now - state.lastTick);
          state.lastTick = now;
          const label = document.querySelector(".sidebar__session--active .sidebar__session-name");
          const text = label?.textContent?.trim();
          if (text) state.labels.push(text);
        }, 20);
        (
          window as typeof window & { __largeSessionResponsiveness?: typeof state }
        ).__largeSessionResponsiveness = state;
      });

      await stored.click();
      const activeLabel = window.locator(".sidebar__session--active .sidebar__session-name");
      await expect(activeLabel).toHaveText(SESSION_LABEL, { timeout: 15_000 });
      await expect(window.locator(".history-loading-row")).toBeVisible({ timeout: 15_000 });

      // These IPCs run while conversion/hydration is in flight. A synchronous
      // main-process conversion delays them by seconds; each cooperative slice
      // must leave enough room for a sub-second settings round trip.
      const roundTrips = await window.evaluate(async () => {
        const invoke = (
          window as unknown as {
            pivis: { invoke: (channel: string, payload: undefined) => Promise<unknown> };
          }
        ).pivis.invoke;
        const timings: number[] = [];
        for (let index = 0; index < 12; index++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const started = performance.now();
          await invoke("settings.get", undefined);
          timings.push(performance.now() - started);
        }
        return timings;
      });
      // This is intentionally stricter than the one-second responsiveness
      // budget: the pre-fix quadratic converter misses this bound.
      for (const roundTrip of roundTrips) expect(roundTrip).toBeLessThan(200);

      // The newest archive batch appears first. Wait for the presentation
      // scheduler to mount every earlier batch before checking completeness.
      await expect(window.locator(".history-loading-row")).toBeHidden({ timeout: 60_000 });
      await expect(window.getByText(LAST_MESSAGE, { exact: true })).toBeVisible();
      // Include post-mount ResizeObserver, FadeText, and custom-entry follow-up
      // work in the renderer heartbeat rather than stopping at the last commit.
      await window.waitForTimeout(500);
      const responsiveness = await window.evaluate(() => {
        const state = (
          window as typeof window & {
            __largeSessionResponsiveness?: {
              labels: string[];
              timer: number;
              maxTickGap: number;
            };
          }
        ).__largeSessionResponsiveness;
        if (!state) return { labels: [], maxTickGap: Number.POSITIVE_INFINITY };
        window.clearInterval(state.timer);
        return { labels: state.labels, maxTickGap: state.maxTickGap };
      });
      expect(responsiveness.labels.length).toBeGreaterThan(0);
      expect(responsiveness.labels.every((label) => label === SESSION_LABEL)).toBe(true);
      // This catches renderer freezes. The old test only timed main IPC calls,
      // which can all finish before one multi-second React/layout commit starts.
      expect(responsiveness.maxTickGap).toBeLessThan(500);
      const output = consoleOutput.join("\n");
      expect(output).not.toContain("Host request timeout for authority_attach");
      expect(output).not.toContain("Error occurred in handler for 'session.rendererAttach'");

      const transcript = window.locator(".transcript-view");
      await transcript.evaluate((element) => {
        element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await expect(window.getByText(FIRST_MESSAGE, { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      await transcript.evaluate((element) => {
        element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }));
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await expect(window.getByText(LAST_MESSAGE, { exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });
});
