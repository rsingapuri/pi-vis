/**
 * E2E: Unified-TUI panel (factory `setWidget`) — the pi-subagents "FleetView" flow.
 *
 * Self-contained (no real pi / no real SDK / no PI_E2E gate): launches the REAL
 * app with two test fixtures:
 *   - fake-pi.mjs            → piBinaryPath test-seam target (overrides the bundled pi)
 *   - fake-unified-host.mjs  → substituted for host.mjs via PIVIS_TEST_HOST_SCRIPT,
 *                              speaks the SessionHost wire protocol and drives the
 *                              factory-setWidget flow: panel_open{unified:true} +
 *                              streaming panel_data, just like ensureUnifiedTui().
 *
 * This exercises the exact path that delivers a unified panel to the user:
 * SessionHost wire → registry forwarding → IPC → store reducer → UnifiedTuiHost →
 * xterm.js render, plus keystroke input routing back to the host. It is the
 * regression gate for "the composer was replaced by nothing" regressions.
 */
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
const FAKE_HOST = join(__dirname, "../fixtures/fake-unified-host.mjs");
const APP_ENTRY = join(__dirname, "../../out/main/index.js");

interface Folders {
  settingsDir: string;
  workspaceDir: string;
  piSessionsDir: string;
  inputFile: string;
  hostLog: string;
}

async function makeFolders(): Promise<Folders> {
  const base = (s: string) => fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), s)));
  const folders: Folders = {
    settingsDir: base("pivis-e2e-unified-"),
    workspaceDir: base("pivis-e2e-unified-ws-"),
    piSessionsDir: base("pivis-e2e-unified-pi-"),
    inputFile: "",
    hostLog: "",
  };
  folders.inputFile = join(folders.settingsDir, "host-input.log");
  folders.hostLog = join(folders.settingsDir, "host-messages.log");
  return folders;
}

async function launchApp(
  folders: Folders,
  extraEnv: Record<string, string | undefined> = {},
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
      // The seams that make this test deterministic:
      PIVIS_TEST_HOST_SCRIPT: FAKE_HOST,
      PIVIS_TEST_HOST_INPUT_FILE: folders.inputFile,
      PIVIS_TEST_HOST_MESSAGE_LOG: folders.hostLog,
      ...extraEnv,
      ELECTRON_RENDERER_URL: undefined,
    },
  });
  app.process().stderr?.on("data", () => {
    /* drain so a chatty fake never blocks on a full stderr pipe */
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

test.describe("Unified-TUI panel (factory setWidget)", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_HOST, 0o755);
  });

  test("a factory setWidget mounts UnifiedTuiHost with rendered content, and routes keystrokes to the host", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    try {
      // Open a session → registry forks the fake host → it reaches ready and
      // opens the unified panel ~300ms later.
      await window.getByRole("button", { name: "New session" }).click();

      // 1. The Composer slot is replaced by UnifiedTuiHost (NOT the native
      //    composer). This is the "no new component was rendered" regression.
      const panel = window.locator(".unified-panel");
      await expect(panel).toBeVisible({ timeout: 20_000 });

      // The native composer must be absent while the unified panel is live.
      await expect(window.locator(".composer__textarea")).toHaveCount(0);

      // 2. xterm.js mounted inside the unified panel.
      const xterm = panel.locator(".xterm");
      await expect(xterm).toBeVisible({ timeout: 10_000 });

      // 3. The streamed panel_data (the fake roster) actually rendered as text.
      //    xterm writes glyphs into .xterm-rows; assert the recognizable content.
      await expect(panel.locator(".xterm-rows")).toContainText("Fleet", { timeout: 15_000 });
      await expect(panel.locator(".xterm-rows")).toContainText("swift-otter");

      // 4. Keystrokes route back to the host over panel_input (the side channel
      //    file proves the wire round-trip, not just a visible cursor). xterm 6.1
      //    emits a release CSI-u after each press (kitty flag 2); strip them so
      //    the assertion targets the press bytes the user intended.
      // Strict authority mode fences input until the post-mount keyframe has
      // been acknowledged. Waiting for that boundary tests real key routing,
      // rather than racing intentionally buffered startup protocol replies.
      await expect(panel).toHaveAttribute("data-input-enabled", "true", { timeout: 15_000 });
      await panel.locator(".xterm").click();
      await window.keyboard.insertText("xyz");
      await expect
        .poll(
          () =>
            fs.existsSync(folders.inputFile)
              ? stripKittyReleases(fs.readFileSync(folders.inputFile, "utf8"))
              : "",
          {
            timeout: 10_000,
          },
        )
        .toContain("xyz");
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("a hanging claimed unified action is silently dropped and never dispatched twice", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders, {
      PIVIS_TEST_HANG_UNIFIED_SUBMIT: "1",
      PIVIS_TEST_UNIFIED_CLAIM_TIMEOUT_MS: "200",
    });

    try {
      await window.getByRole("button", { name: "New session" }).click();
      const panel = window.locator(".unified-panel");
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await panel.locator(".xterm").click();
      await window.keyboard.type("hang exactly once");
      await window.keyboard.press("Enter");

      await expect(
        window.getByText("Interrupted command was not restored.", { exact: true }),
      ).toBeVisible({
        timeout: 10_000,
      });
      await expect(window.getByText(/Review interrupted (message|command)/)).toHaveCount(0);

      await expect
        .poll(() => {
          if (!fs.existsSync(folders.hostLog)) return 0;
          return fs
            .readFileSync(folders.hostLog, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type?: string; intent?: { kind?: string } })
            .filter((entry) => entry.type === "dispatch_intent" && entry.intent?.kind === "submit")
            .length;
        })
        .toBe(1);
      await window.waitForTimeout(400);
      const submitCount = fs
        .readFileSync(folders.hostLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; intent?: { kind?: string } })
        .filter(
          (entry) => entry.type === "dispatch_intent" && entry.intent?.kind === "submit",
        ).length;
      expect(submitCount).toBe(1);
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("extension self-close retains the unified editor while unsent text exists, then closes after submit", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders, {
      // Deterministic self-close trigger: once the fake editor draft contains
      // this text, the fake extension removes its final factory widget. This
      // avoids racing a fixed timer against slow CI typing/focus startup.
      PIVIS_TEST_UNIFIED_AUTO_CLOSE_AFTER_DRAFT: "do not lose me",
    });

    try {
      await window.getByRole("button", { name: "New session" }).click();
      const panel = window.locator(".unified-panel");
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await panel.locator(".xterm").click();

      await window.keyboard.insertText("do not lose me");
      await expect
        .poll(() => stripKittyReleases(readInput(folders)), { timeout: 10_000 })
        .toContain("do not lose me");

      // The fake extension has now cleared its last factory widget. Because the
      // unified editor has unsent text, the panel stays visible instead of the
      // app being shoved back to the native Composer.
      await expect(panel).toBeVisible();
      await expect(window.locator(".composer__textarea")).toHaveCount(0);
      await expect(panel.locator(".xterm-rows")).toContainText("unified editor retained", {
        timeout: 10_000,
      });

      // Submitting drains the draft + pending-submit roots. Since no factory
      // widget remains, the host may finally close and return to the Composer.
      await panel.locator(".xterm").click();
      await window.keyboard.press("Enter");
      await expect(window.locator(".unified-panel")).toHaveCount(0, { timeout: 15_000 });
      await expect(window.locator(".composer__textarea")).toBeVisible({ timeout: 10_000 });
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("a composer-origin extension custom view replaces the composer, not the unified TUI", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    try {
      await window.getByRole("button", { name: "New session" }).click();
      await expect(window.locator(".unified-panel")).toBeVisible({ timeout: 20_000 });

      await window.getByRole("tab", { name: "Input" }).click();
      const composer = window.locator(".composer__textarea");
      await expect(composer).toBeVisible({ timeout: 10_000 });

      await composer.fill("/custom-panel");
      await composer.press("Enter");

      const customPanel = window.locator(".custom-panel");
      await expect(customPanel).toBeVisible({ timeout: 15_000 });
      await expect(customPanel.locator(".xterm-rows")).toContainText("Composer custom panel", {
        timeout: 15_000,
      });
      await expect(window.locator(".unified-panel")).toHaveCount(0);
      await expect(window.locator(".composer__textarea")).toHaveCount(0);
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  // ── Kitty keyboard protocol (renderer half) ──────────────────────────
  // xterm 6.1 with vtExtensions.kittyKeyboard encodes Shift+Enter as
  // \x1b[13;2u and answers the host's handshake. These prove the RENDERER emits
  // the right bytes (the host half — decoding — is covered by the unit +
  // host-render suites). Keystrokes + xterm's replies are captured to
  // PIVIS_TEST_HOST_INPUT_FILE for byte-level assertion.

  /** Read the host-input capture file (empty string until the first write). */
  function readInput(f: Folders): string {
    return fs.existsSync(f.inputFile) ? fs.readFileSync(f.inputFile, "utf8") : "";
  }

  /**
   * Strip Kitty key-RELEASE sequences (the `:3` event-type marker) so a test
   * can assert on the PRESS bytes a human intends. xterm 6.1 with flag 2 emits
   * a release CSI-u after every key (`a` → `a` + `\x1b[97;1:3u`), so the raw
   * capture interleaves presses with releases. The REAL TUI filters releases
   * before the editor (isKeyRelease); the fake host records raw bytes, so this
   * mirrors that filter for byte-level assertions.
   */
  function stripKittyReleases(s: string): string {
    return s.replace(/\x1b\[[\d:;]*:3[u~]/g, "");
  }

  test("xterm 6.1 emits CSI-u for Shift+Enter and answers the kitty handshake (I2/I3/I4)", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    try {
      await window.getByRole("button", { name: "New session" }).click();
      const panel = window.locator(".unified-panel");
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(panel.locator(".xterm")).toBeVisible({ timeout: 10_000 });

      // Wait for xterm to ANSWER the handshake the fake host pushed on open.
      // A nonzero kitty-flags reply (\x1b[?<n>u, n>0) proves xterm granted kitty.
      await expect.poll(() => readInput(folders), { timeout: 15_000 }).toMatch(/\x1b\[\?[1-9]\d*u/);
      // And a Device Attributes reply (terminator 'c') arrives too. The host
      // can record the two handshake replies in separate writes, so wait for
      // this second response instead of sampling the file once.
      await expect.poll(() => readInput(folders), { timeout: 15_000 }).toMatch(/\x1b\[\?[\d;]+c/);

      // Focus the terminal and drive real DOM keys through real xterm 6.1.
      await panel.locator(".xterm").click();

      // Plain printable bytes arrive unchanged (I3). xterm emits a release
      // CSI-u after each press (flag 2); strip them to assert the press bytes.
      await window.keyboard.type("abc");
      await expect
        .poll(() => stripKittyReleases(readInput(folders)), { timeout: 10_000 })
        .toContain("abc");

      // Plain Enter → \r (I2).
      await window.keyboard.press("Enter");
      await expect
        .poll(() => stripKittyReleases(readInput(folders)), { timeout: 10_000 })
        .toContain("\r");

      // Shift+Enter → \x1b[13;2u — THE fix. Under legacy encoding this would be
      // an indistinguishable \r; under kitty it is a distinct CSI-u (I4).
      await window.keyboard.press("Shift+Enter");
      await expect
        .poll(() => stripKittyReleases(readInput(folders)), { timeout: 10_000 })
        .toContain("\x1b[13;2u");
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("kitty survives a hidden Input view without remounting xterm and Shift+Enter still works (I6)", async () => {
    test.setTimeout(120_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    try {
      await window.getByRole("button", { name: "New session" }).click();
      const panel = window.locator(".unified-panel");
      await expect(panel).toBeVisible({ timeout: 20_000 });

      // First kitty reply (handshake from panel open).
      await expect.poll(() => readInput(folders), { timeout: 15_000 }).toMatch(/\x1b\[\?[1-9]\d*u/);
      const firstReplies = (readInput(folders).match(/\x1b\[\?[1-9]\d*u/g) ?? []).length;

      // Switch away to the native composer while preserving the xterm node.
      await panel.evaluate((element) => {
        element.setAttribute("data-e2e-mount", "preserved");
      });
      await window.getByRole("tab", { name: "Input" }).click();
      await expect(window.locator(".composer__textarea")).toBeVisible({ timeout: 10_000 });
      await expect(panel).toBeHidden();
      await expect(panel).toHaveAttribute("data-e2e-mount", "preserved");

      // …and back. The same xterm survives; a reveal-time resize may repeat
      // kitty negotiation, but must not replace the DOM identity.
      await window.getByRole("tab", { name: "Extension" }).click();
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel.locator(".xterm")).toBeVisible({ timeout: 10_000 });
      await expect(panel).toHaveAttribute("data-e2e-mount", "preserved");
      await expect
        .poll(() => (readInput(folders).match(/\x1b\[\?[1-9]\d*u/g) ?? []).length)
        .toBeGreaterThanOrEqual(firstReplies);

      // Shift+Enter must STILL encode as CSI-u after the reveal (I6).
      expect(
        stripKittyReleases(readInput(folders)),
        "baseline has no shift+enter yet",
      ).not.toContain("\x1b[13;2u");
      await panel.locator(".xterm").click();
      await window.keyboard.press("Shift+Enter");
      await expect
        .poll(() => stripKittyReleases(readInput(folders)), { timeout: 10_000 })
        .toContain("\x1b[13;2u");
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });
});
