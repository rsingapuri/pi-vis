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
import { allowInvariant, expect, test } from "./support/invariants.mjs";
import {
  PINNED_PI_VERSION,
  REAL_SDK_PROVIDER_LATENCY,
  createRealSdkFixture,
  openNewRealSession,
  pinnedPiBinary,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import { createScriptedOpenAIProvider } from "./support/scripted-openai-provider.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ENTRY = join(__dirname, "../../out/main/index.js");
const PROJECT_WORKSPACE = join(__dirname, "../..");
const FIXTURE_EXTENSION = join(__dirname, "../fixtures/real-host-smoke-extension/smoke-e2e.ts");

const PI_BIN = pinnedPiBinary();
const PI_VERSION = execFileSync(PI_BIN, ["--version"], { encoding: "utf8" })
  .trim()
  .replace(/^v/, "");

function rmrf(path: string): void {
  try {
    fs.rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of throwaway SDK state.
  }
}

async function launchUserConfiguredHostApp(): Promise<{
  app: LaunchedElectronApplication;
  window: Page;
  stderr: string[];
  dirs: string[];
}> {
  const settingsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-user-host-settings-"));
  const sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-user-host-sessions-"));
  fs.writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      piBinaryPath: PI_BIN,
      workspaceOrder: [PROJECT_WORKSPACE],
      fonts: { display: { sizePx: 14 }, code: { family: "IBM Plex Mono", sizePx: 14 } },
    }),
  );
  const app = await launchElectron({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      PIVIS_SETTINGS_DIR: settingsDir,
      PIVIS_SESSIONS_DIR: sessionsDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  const stderr: string[] = [];
  app.process().stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  app
    .process()
    .stdout?.on("data", (chunk: Buffer) => stderr.push(`[stdout] ${chunk.toString("utf8")}`));
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({ timeout: 30_000 });
  return { app, window, stderr, dirs: [settingsDir, sessionsDir] };
}

function sessionHasCompaction(path: string, summary: string): boolean {
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        const entry = JSON.parse(line) as { type?: unknown };
        return entry.type === "compaction" && JSON.stringify(entry).includes(summary);
      } catch {
        return false;
      }
    });
}

test.describe("Real SDK-host smoke", () => {
  test.beforeAll(() => expect(PI_VERSION).toBe(PINNED_PI_VERSION));

  test("starts cleanly, executes an extension, and reports empty-session compaction as a domain failure", async () => {
    test.setTimeout(120_000);
    const fixture = createRealSdkFixture({ extensionFiles: [FIXTURE_EXTENSION] });
    const launch = await fixture.launch();
    const { window } = launch;
    try {
      const textarea = await openNewRealSession(window);
      await expect(
        window.getByText(
          "Pi public API cannot install the pi-vis palette globally; extension panels use a local semantic theme.",
          { exact: true },
        ),
      ).toHaveCount(0);

      // This is the asserted domain failure, not an unexpected UI error.
      allowInvariant("error-toast", /Nothing to compact/);
      // Exercise the domain-failure path before adding any extension-owned content.
      await textarea.fill("/compact");
      await textarea.press("Enter");
      await expect(window.getByText("Nothing to compact", { exact: false }).first()).toBeVisible();
      await expect(window.getByText("Context compacted", { exact: false })).toHaveCount(0);
      await expect(window.getByText("Compaction failed", { exact: false }).first()).toBeVisible();
      await expect(textarea).toHaveValue("");

      // A missing compaction_end leaves that authority conservatively fenced;
      // do not prove extension execution by overtaking its unknown boundary.
      // A fresh session verifies the independent extension command path.
      const freshTextarea = await openNewRealSession(window);
      await freshTextarea.fill("/smoke-e2e");
      await expect(
        window.locator(".composer__suggestion").filter({ hasText: "smoke-e2e" }),
      ).toBeVisible();
      await freshTextarea.press("Enter");
      await expect(freshTextarea).toHaveValue("");
      await expect(
        window.getByText("Real SDK host command completed", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(window.getByText(/Host process exited/)).toHaveCount(0);
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(window)}\nElectron output:\n${launch.output.join("")}`,
      );
    } finally {
      await launch.close();
      fixture.cleanup();
    }
  });

  test("successfully compacts through a deterministic localhost provider", async () => {
    test.setTimeout(180_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: {
            model: "pivis-test-model",
            promptIncludes: "First deterministic turn",
            compaction: false,
          },
          response: { type: "text", chunks: ["Deterministic local assistant response 1."] },
        },
        {
          expect: {
            model: "pivis-test-model",
            promptIncludes: "Second deterministic turn",
            compaction: false,
          },
          response: { type: "text", chunks: ["Deterministic local assistant response 2."] },
        },
        {
          expect: {
            model: "pivis-test-model",
            compaction: { includes: "First deterministic turn" },
          },
          response: {
            type: "text",
            chunks: [
              "## Goal\nDeterministic compacted summary.\n\n## Progress\n- Seeded local-provider turns were processed.",
            ],
          },
        },
        {
          expect: {
            model: "pivis-test-model",
            promptIncludes: [
              "Deterministic compacted summary",
              "Post-compaction deterministic turn",
            ],
            compaction: false,
          },
          response: { type: "text", chunks: ["Deterministic local assistant response 4."] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    const fixture = createRealSdkFixture({
      providerBaseUrl: provider.baseUrl,
      compactionEnabled: false,
    });
    let launch = await fixture.launch();
    try {
      let { window } = launch;
      const textarea = await openNewRealSession(window);
      await selectLocalTestModel(window, textarea);

      await textarea.fill(`First deterministic turn ${"alpha beta gamma ".repeat(80)}`);
      await textarea.press("Enter");
      await expect(
        window.getByText("Deterministic local assistant response 1.", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await textarea.fill(`Second deterministic turn ${"delta epsilon zeta ".repeat(80)}`);
      await textarea.press("Enter");
      await expect(
        window.getByText("Deterministic local assistant response 2.", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });

      await textarea.fill("/compact");
      await textarea.press("Enter");
      await expect(window.getByText("Context compacted", { exact: false }).first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(window.getByText("Nothing to compact", { exact: false })).toHaveCount(0);
      await expect(window.getByText("Compaction failed", { exact: false })).toHaveCount(0);
      await expect(textarea).toHaveValue("");
      await expect(window.locator(".working-row, .status-dot--streaming")).toHaveCount(0, {
        timeout: 30_000,
      });

      await provider.waitForRequestCount(3);
      const compactRequest = provider.requests[2]!;
      expect(compactRequest.method).toBe("POST");
      expect(compactRequest.url).toBe("/v1/chat/completions");
      expect(compactRequest.parsedBody).toMatchObject({ model: "pivis-test-model", stream: true });
      expect(JSON.stringify(compactRequest.parsedBody)).toContain("First deterministic turn");

      await expect
        .poll(() =>
          fixture
            .sessionFiles()
            .some((file) => sessionHasCompaction(file, "Deterministic compacted summary")),
        )
        .toBe(true);

      // Compaction changes model context, never GUI scrollback. The next real
      // turn must use a fresh live tail without reviving stale streaming IDs.
      await expect(
        window.getByText("Deterministic local assistant response 1.", { exact: true }),
      ).toHaveCount(1);
      await expect(
        window.getByText("Deterministic local assistant response 2.", { exact: true }),
      ).toHaveCount(1);
      await expect(textarea).toBeEnabled();
      await textarea.fill("Post-compaction deterministic turn");
      await textarea.press("Enter");
      await expect(
        window.getByText("Deterministic local assistant response 4.", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(window.locator(".working-row, .status-dot--streaming")).toHaveCount(0);
      provider.assertExhausted();

      // A full process relaunch must hydrate the complete GUI scrollback even
      // though Pi's model context now starts at the persisted compaction.
      await launch.close();
      launch = await fixture.launch();
      window = launch.window;
      const stored = window.locator(".sidebar__session:not(.sidebar__session--active)").first();
      await expect(stored).toBeVisible({ timeout: 30_000 });
      await stored.click();
      await expect(
        window.getByText("Deterministic local assistant response 4.", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(window.getByText("Context compacted", { exact: false }).first()).toBeVisible();
      await expect(
        window.getByText("Deterministic local assistant response 1.", { exact: true }),
      ).toHaveCount(1);
      await expect(
        window.getByText("Deterministic local assistant response 2.", { exact: true }),
      ).toHaveCount(1);
      await expect(window.getByText(/Host process exited/)).toHaveCount(0);
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(launch.window)}\nElectron output:\n${launch.output.join("")}\nProvider requests:\n${JSON.stringify(provider.requests, null, 2)}`,
      );
    } finally {
      await launch.close();
      await provider.close();
      fixture.cleanup();
    }
  });

  test("user extension environment survives built-in command traffic", async () => {
    test.skip(
      process.env.PIVIS_REAL_USER_HOST_SMOKE !== "1",
      "Opt in to load the developer's real global/project extensions",
    );
    test.setTimeout(120_000);
    const { app, window, stderr, dirs } = await launchUserConfiguredHostApp();
    try {
      await window.getByRole("button", { name: "New session" }).click();
      const textarea = window.locator(".composer__textarea");
      await expect(textarea).toBeEnabled({ timeout: 60_000 });

      await textarea.fill("/session");
      await textarea.press("Enter");
      await expect(textarea).toHaveValue("");
      await expect(window.getByText("Session", { exact: false }).first()).toBeVisible();

      await textarea.fill("/compact");
      await textarea.press("Enter");
      await expect(textarea).toHaveValue("");

      await textarea.fill("/session");
      await textarea.press("Enter");
      await expect(textarea).toHaveValue("");
      await expect(window.getByText(/Host process exited/)).toHaveCount(0);
    } catch (error) {
      const body = await window
        .locator("body")
        .innerText()
        .catch(() => "<body unavailable>");
      throw new Error(
        `${String(error)}\nVisible UI:\n${body.slice(-4_000)}\nElectron output:\n${stderr.join("")}`,
      );
    } finally {
      await app.close();
      for (const dir of dirs) rmrf(dir);
    }
  });
});
