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
  historyLog: string;
}

interface IpcLogEntry {
  channel?: string;
  payload?: {
    sessionId?: string;
    intentId?: string;
    expectedOwner?: {
      hostInstanceId: string;
      sessionEpoch: number;
    };
    intent?: {
      kind?: string;
      command?: string;
    };
  };
}

interface HostMessageLogEntry {
  type?: string;
  executionId?: string;
  sequence?: number;
  accepted?: boolean;
}

async function makeFolders(): Promise<Folders> {
  const settingsDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-cmds-")));
  return {
    settingsDir,
    workspaceDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-cmds-ws-"))),
    piSessionsDir: fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-e2e-cmds-pi-"))),
    historyLog: join(settingsDir, "history.log"),
  };
}

async function launchApp(
  folders: Folders,
  extraEnv: Record<string, string | undefined> = {},
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
      ...extraEnv,
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

function jsonlFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root);
  return files;
}

function countJsonlFiles(root: string): number {
  return jsonlFiles(root).length;
}

function readJsonLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as T] : [];
      } catch {
        return [];
      }
    });
}

test.describe("Slash commands", () => {
  test.beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.chmodSync(FAKE_SESSION_HOST, 0o755);
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
    // Font controls are grouped into their own sections (Chat, Titles)
    // following the Code section pattern: header carries context, rows are
    // plain "Font Family" / "Font Size". Chrome/interface font stays
    // app-owned (no family control in Interface); chat body + titles are
    // user-configurable (defaults Inter / Fraunces).
    // UI Zoom (fonts + spacing) stays in Interface; Chat holds only the
    // transcript font family.
    await expect(interfaceSection.getByText("UI Zoom", { exact: true })).toBeVisible();
    const chatSection = window.locator(".settings-section", {
      has: window.getByRole("heading", { name: "Chat" }),
    });
    const titlesSection = window.locator(".settings-section", {
      has: window.getByRole("heading", { name: "Titles" }),
    });
    const chatFontRow = chatSection.locator(".settings-row", { hasText: "Font Family" });
    const titleFontRow = titlesSection.locator(".settings-row", { hasText: "Font Family" });
    await expect(chatFontRow).toBeVisible();
    await expect(titleFontRow).toBeVisible();
    await expect(
      chatSection.locator(".settings-row", { hasText: "Font Size" }),
    ).toHaveCount(0);
    await expect(interfaceSection).not.toContainText("Pi-Vis owns interface font families");

    // Defaults render as Inter (interface + chat) / Fraunces (title) on :root.
    const defaultVars = await window.locator("html").evaluate((element) => ({
      display: (element as HTMLElement).style.getPropertyValue("--font-display"),
      chat: (element as HTMLElement).style.getPropertyValue("--font-chat"),
      accent: (element as HTMLElement).style.getPropertyValue("--font-accent"),
    }));
    expect(defaultVars.display).toContain("Inter");
    expect(defaultVars.chat).toContain("Inter");
    expect(defaultVars.accent).toContain("Fraunces");

    // Changing the chat font rewrites --font-chat live while the interface
    // font stays app-owned.
    const chatInput = chatFontRow.locator("input.settings-input");
    if ((await chatInput.count()) > 0) {
      await chatInput.fill("Georgia");
    } else {
      await chatFontRow.locator(".settings-select__trigger").click();
      await chatFontRow.getByRole("option", { name: "Georgia" }).click();
    }
    const chatVars = await window.locator("html").evaluate((element) => ({
      display: (element as HTMLElement).style.getPropertyValue("--font-display"),
      chat: (element as HTMLElement).style.getPropertyValue("--font-chat"),
    }));
    expect(chatVars.chat).toContain("Georgia");
    expect(chatVars.display).toContain("Inter");

    // Changing the title font rewrites --font-accent live, falling back to
    // the interface font.
    const titleInput = titleFontRow.locator("input.settings-input");
    if ((await titleInput.count()) > 0) {
      await titleInput.fill("IBM Plex Serif");
    } else {
      await titleFontRow.locator(".settings-select__trigger").click();
      await titleFontRow.getByRole("option", { name: "IBM Plex Serif" }).click();
    }
    const accentVar = await window
      .locator("html")
      .evaluate((element) => (element as HTMLElement).style.getPropertyValue("--font-accent"));
    expect(accentVar).toContain("IBM Plex Serif");
    expect(accentVar).toContain("var(--font-display)");

    const darkThemeRow = interfaceSection.locator(".settings-row", { hasText: "Dark theme" });
    await darkThemeRow.locator(".settings-select__trigger").click();
    for (const name of ["Cendre Hard", "Cendre Medium", "Cendre Soft"]) {
      await expect(darkThemeRow.getByRole("option", { name })).toBeVisible();
    }
    await darkThemeRow.getByRole("option", { name: "Cendre Soft" }).click();
    await expect(darkThemeRow.locator(".settings-select__trigger")).toContainText("Cendre Soft");
    await interfaceSection
      .getByRole("group", { name: "Theme mode" })
      .getByRole("button", { name: "Dark" })
      .click();
    const appliedThemeGrounds = await window.locator("html").evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        transcript: styles.getPropertyValue("--bg").trim(),
        sidebar: styles.getPropertyValue("--bg-sunken").trim(),
        popup: styles.getPropertyValue("--surface").trim(),
        popupHover: styles.getPropertyValue("--surface-2").trim(),
        strongestSurface: styles.getPropertyValue("--surface-3").trim(),
      };
    });
    expect(appliedThemeGrounds).toEqual({
      transcript: "#231f1d",
      sidebar: "#2d2725",
      popup: "#37312e",
      popupHover: "#443c39",
      strongestSurface: "#554c48",
    });

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

  test("Shell drafts replace Composer chrome, retain attachments, and settle as compact turns", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    try {
      await window.getByRole("button", { name: "New session" }).click();
      await expect(window.locator(".session-header__model-btn")).toContainText(
        "Fake Model [fake]",
        { timeout: 15_000 },
      );

      const composer = window.locator(".composer__textarea");
      const stagedFile = join(folders.workspaceDir, "kept-shell-attachment.txt");
      fs.writeFileSync(stagedFile, "retained attachment\n");
      await window.locator(".composer__file-input").setInputFiles(stagedFile);
      await expect(window.locator(".composer__attachment-item--file")).toHaveCount(1);

      await composer.fill("!");
      await expect(window.locator(".composer__shell-prefix")).toHaveText("!");
      await expect(window.locator(".composer__attach-btn")).toHaveCount(0);
      await expect(window.locator(".composer__attachment-item")).toHaveCount(0);
      await expect(window.locator(".composer__shell-guidance")).toHaveCount(0);
      await composer.press("Enter");
      await expect(composer).toHaveValue("!");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveAttribute("aria-invalid", "true");
      await expect(window.getByText("Type a shell command.", { exact: true })).toHaveCount(0);

      await window.evaluate(() => {
        const testWindow = window as unknown as {
          __fastShellViewportMounts?: number;
          __fastShellViewportObserver?: MutationObserver;
        };
        testWindow.__fastShellViewportMounts = 0;
        testWindow.__fastShellViewportObserver = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (
                node instanceof Element &&
                (node.matches(".shell-terminal") || node.querySelector(".shell-terminal"))
              ) {
                testWindow.__fastShellViewportMounts =
                  (testWindow.__fastShellViewportMounts ?? 0) + 1;
              }
            }
          }
        });
        testWindow.__fastShellViewportObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
      });
      await composer.fill("!!instant-shell");
      await composer.press("Enter");
      await expect(
        window.locator(".shell-turn").filter({ hasText: "instant-shell" }),
      ).toContainText("bash output for instant-shell", { timeout: 10_000 });
      expect(
        await window.evaluate(() => {
          const testWindow = window as unknown as {
            __fastShellViewportMounts?: number;
            __fastShellViewportObserver?: MutationObserver;
          };
          testWindow.__fastShellViewportObserver?.disconnect();
          return testWindow.__fastShellViewportMounts ?? 0;
        }),
      ).toBe(0);
      await expect(window.locator(".shell-terminal")).toHaveCount(0);

      await composer.fill("!!test-interactive-shell");
      await expect(window.locator(".composer__shell-prefix")).toHaveText("!!");
      await composer.press("Enter");

      const terminal = window.locator(".shell-terminal");
      await expect(terminal).toBeVisible({ timeout: 10_000 });
      await expect(terminal).toHaveAccessibleName("Active Shell Turn, context excluded");
      await expect(window.locator(".composer__textarea")).toHaveCount(0);
      await expect(terminal.locator(".shell-terminal__header")).toHaveCount(0);
      await expect(terminal.locator(".shell-terminal__footer")).toHaveCount(0);
      await expect(terminal).not.toContainText("Not in Pi context");
      await expect(terminal).not.toContainText("Ctrl+C interrupts");
      await expect(
        terminal.getByRole("button", { name: /(?:Interrupt|Force stop) shell command/ }),
      ).toHaveCount(0);
      await expect(window.getByRole("separator", { name: /Resize shell terminal/ })).toBeVisible();
      const liveCardStyle = await terminal.evaluate((element) => {
        const reference = document.createElement("div");
        reference.className = "custom-panel unified-panel";
        const referenceMount = document.createElement("div");
        referenceMount.className = "custom-panel__xterm";
        reference.append(referenceMount);
        document.body.append(reference);
        const actual = getComputedStyle(element);
        const expected = getComputedStyle(reference);
        const actualMount = getComputedStyle(
          element.querySelector<HTMLElement>(".shell-terminal__xterm")!,
        );
        const actualViewport = getComputedStyle(
          element.querySelector<HTMLElement>(".xterm-viewport")!,
        );
        const mountRect = element
          .querySelector<HTMLElement>(".shell-terminal__xterm")!
          .getBoundingClientRect();
        const viewportElement = element.querySelector<HTMLElement>(".shell-terminal__viewport")!;
        const viewportRect = viewportElement.getBoundingClientRect();
        const xtermViewport = element.querySelector<HTMLElement>(".xterm-viewport")!;
        const sessionRect = element.closest<HTMLElement>(".app__session")!.getBoundingClientRect();
        const expectedMount = getComputedStyle(referenceMount);
        const result = {
          card: {
            margin: actual.margin,
            backgroundColor: actual.backgroundColor,
            borderColor: actual.borderColor,
            borderRadius: actual.borderRadius,
          },
          reference: {
            margin: expected.margin,
            backgroundColor: expected.backgroundColor,
            borderColor: expected.borderColor,
            borderRadius: expected.borderRadius,
          },
          paddingInline: [actualMount.paddingLeft, actualMount.paddingRight],
          referencePaddingInline: [expectedMount.paddingLeft, expectedMount.paddingRight],
          viewportBackgroundColor: actualViewport.backgroundColor,
          boxShadow: actual.boxShadow,
          borderLeftColor: actual.borderLeftColor,
          borderRightColor: actual.borderRightColor,
          terminalRight: mountRect.right,
          viewportRight: viewportRect.right,
          viewportHeight: viewportRect.height,
          sessionHeight: sessionRect.height,
          scrollHeight: xtermViewport.scrollHeight,
          scrollClientHeight: xtermViewport.clientHeight,
        };
        reference.remove();
        return result;
      });
      expect(liveCardStyle.card).toEqual(liveCardStyle.reference);
      expect(liveCardStyle.paddingInline).toEqual(liveCardStyle.referencePaddingInline);
      expect(liveCardStyle.viewportBackgroundColor).toBe(liveCardStyle.card.backgroundColor);
      expect(liveCardStyle.boxShadow).toBe("none");
      expect(liveCardStyle.borderLeftColor).toBe(liveCardStyle.borderRightColor);
      expect(Math.abs(liveCardStyle.terminalRight - liveCardStyle.viewportRight)).toBeLessThan(0.2);
      expect(liveCardStyle.viewportHeight).toBeGreaterThan(liveCardStyle.sessionHeight * 0.35);
      expect(liveCardStyle.viewportHeight).toBeLessThanOrEqual(
        liveCardStyle.sessionHeight * 0.5 + 12,
      );
      expect(liveCardStyle.scrollHeight).toBeLessThanOrEqual(liveCardStyle.scrollClientHeight + 1);

      const terminalInput = terminal.locator(".xterm-helper-textarea");
      await terminalInput.evaluate((element) => (element as HTMLTextAreaElement).focus());
      await window.keyboard.type("Ada");
      await window.keyboard.press("Enter");

      await expect(terminal).toHaveCount(0, { timeout: 10_000 });
      const settled = window.locator(".shell-turn").filter({ hasText: "test-interactive-shell" });
      await expect(settled).toBeVisible();
      await expect(settled).toHaveAccessibleName("You, Shell, context excluded, exit 0");
      await expect(settled.locator(".shell-turn__prefix")).toHaveText("!!");
      await expect(settled.locator(".shell-turn__command")).toHaveText("test-interactive-shell");
      await expect(settled).toContainText("Hello, Ada");
      await expect(settled).not.toContainText("You · Shell");
      await expect(settled).not.toContainText("Context excluded");
      await expect(settled.getByRole("button", { name: "Copy command" })).toHaveCount(0);
      await expect(settled.getByRole("button", { name: "Copy output" })).toBeVisible();
      await expect(window.locator(".composer__textarea")).toBeFocused();
      await expect(window.locator(".composer__attachment-item--file")).toHaveCount(1);
      const disclosure = settled.getByRole("button", { name: /Shell Turn details/ });
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await disclosure.click();
      await expect(disclosure).toBeFocused();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(settled.locator(".shell-turn__output-section")).toHaveCount(0);
      await expect(settled.getByRole("button", { name: "Copy output" })).toBeVisible();
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(settled).toContainText("Hello, Ada");
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("live Shell Turns restore without a Composer flash or stealing focus on background completion", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const ipcLog = join(folders.settingsDir, "shell-switch-ipc.log");
    const hostLog = join(folders.settingsDir, "shell-switch-host.log");
    const { app, window } = await launchApp(folders, {
      PIVIS_TEST_IPC_INVOCATION_LOG: ipcLog,
      PIVIS_TEST_HOST_MESSAGE_LOG: hostLog,
      PIVIS_TEST_BACKGROUND_SHELL_DELAY_MS: "4000",
    });

    try {
      await window.getByRole("button", { name: "New session" }).click();
      await expect(window.locator(".session-header__model-btn")).toContainText(
        "Fake Model [fake]",
        { timeout: 15_000 },
      );

      const composer = window.locator(".composer__textarea");
      await composer.fill("/name Shell A");
      await composer.press("Enter");
      await expect(window.locator(".session-header__name-btn")).toContainText("Shell A");

      await composer.fill("!!test-interactive-shell");
      await composer.press("Enter");
      const terminal = window.locator(".shell-terminal");
      await expect(terminal).toBeVisible({ timeout: 10_000 });
      await expect(terminal).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });

      const findShellEnvelope = (): IpcLogEntry | undefined =>
        readJsonLines<IpcLogEntry>(ipcLog).find(
          (entry) =>
            entry.channel === "session.dispatchIntent" &&
            entry.payload?.intent?.kind === "runBash" &&
            entry.payload.intent.command === "test-interactive-shell",
        );
      await expect.poll(() => findShellEnvelope()).toBeTruthy();
      const shellEnvelope = findShellEnvelope()?.payload;
      if (!shellEnvelope?.sessionId || !shellEnvelope.intentId || !shellEnvelope.expectedOwner) {
        throw new Error("Shell dispatch did not expose an owner-bound E2E identity");
      }
      const shellExecutionId = shellEnvelope.intentId;

      await window.getByRole("button", { name: "New session" }).click();
      await expect(composer).toBeVisible();
      await expect(window.locator(".session-header__model-btn")).toContainText(
        "Fake Model [fake]",
        { timeout: 15_000 },
      );
      await expect(composer).toBeEnabled();
      await composer.fill("/name Shell B");
      await composer.press("Enter");
      await expect(window.locator(".session-header__name-btn")).toContainText("Shell B", {
        timeout: 15_000,
      });
      const retainedFile = join(folders.workspaceDir, "retained-session-b.txt");
      fs.writeFileSync(retainedFile, "keep session B alive across the switch\n");
      await window.locator(".composer__file-input").setInputFiles(retainedFile);
      await expect(window.locator(".composer__attachment-item--file")).toHaveCount(1);

      const shellARow = window.locator(".sidebar__session").filter({ hasText: "Shell A" });
      await expect(shellARow).toBeVisible();
      await expect(terminal).toHaveCount(0);
      const hostLogBoundary = readJsonLines<HostMessageLogEntry>(hostLog).length;
      await window.evaluate(() => {
        const trackedWindow = window as unknown as {
          __pivisShellComposerFlashed?: boolean;
          __pivisShellComposerObserver?: MutationObserver;
        };
        trackedWindow.__pivisShellComposerObserver?.disconnect();
        trackedWindow.__pivisShellComposerFlashed = false;
        trackedWindow.__pivisShellComposerObserver = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (
                node instanceof Element &&
                (node.matches(".composer__textarea") || node.querySelector(".composer__textarea"))
              ) {
                trackedWindow.__pivisShellComposerFlashed = true;
              }
            }
          }
        });
        trackedWindow.__pivisShellComposerObserver.observe(
          document.querySelector(".app__main") ?? document.body,
          { childList: true, subtree: true },
        );
      });

      await shellARow.click();
      await expect(terminal).toBeVisible({ timeout: 10_000 });
      await expect(window.locator(".composer__textarea")).toHaveCount(0);
      await expect(terminal).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
      const composerFlashed = await window.evaluate(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const trackedWindow = window as unknown as {
          __pivisShellComposerFlashed?: boolean;
          __pivisShellComposerObserver?: MutationObserver;
        };
        trackedWindow.__pivisShellComposerObserver?.disconnect();
        return trackedWindow.__pivisShellComposerFlashed === true;
      });
      expect(composerFlashed).toBe(false);

      await terminal
        .locator(".xterm-helper-textarea")
        .evaluate((element) => (element as HTMLTextAreaElement).focus());
      await window.keyboard.insertText("Ada");
      await expect
        .poll(() =>
          readJsonLines<HostMessageLogEntry>(hostLog)
            .slice(hostLogBoundary)
            .some(
              (entry) =>
                entry.type === "shell_input_result" &&
                entry.executionId === shellExecutionId &&
                entry.accepted === true,
            ),
        )
        .toBe(true);

      const restorationEvents = readJsonLines<HostMessageLogEntry>(hostLog).slice(hostLogBoundary);
      const acceptedAckIndex = restorationEvents.findIndex(
        (entry) =>
          entry.type === "shell_reconstruction_ack_result" &&
          entry.executionId === shellExecutionId &&
          entry.accepted === true,
      );
      const acceptedInputIndex = restorationEvents.findIndex(
        (entry) =>
          entry.type === "shell_input_result" &&
          entry.executionId === shellExecutionId &&
          entry.accepted === true,
      );
      expect(acceptedAckIndex).toBeGreaterThanOrEqual(0);
      expect(acceptedInputIndex).toBeGreaterThan(acceptedAckIndex);

      await window.keyboard.press("Enter");
      await expect(terminal).toHaveCount(0, { timeout: 10_000 });
      await expect(
        window.locator(".shell-turn").filter({ hasText: "test-interactive-shell" }),
      ).toContainText("Hello, Ada");
      await expect(composer).toBeFocused();

      await composer.fill("!!test-background-shell");
      await composer.press("Enter");
      await expect(terminal).toBeVisible({ timeout: 10_000 });
      await expect(shellARow.locator(".status-dot--streaming")).toHaveCount(1);

      const shellBRow = window.locator(".sidebar__session").filter({ hasText: "Shell B" });
      await expect(shellBRow).toBeVisible();
      await shellBRow.click();
      await expect(terminal).toHaveCount(0);
      await expect(window.locator(".session-header__name-btn")).toContainText("Shell B");
      await expect(composer).toBeFocused();
      await expect(window.locator(".composer__attachment-item--file")).toHaveCount(1);
      await expect(shellARow.locator(".status-dot--streaming")).toHaveCount(1);

      await expect(shellARow.locator(".status-dot--streaming")).toHaveCount(0, {
        timeout: 10_000,
      });
      await expect(window.locator(".session-header__name-btn")).toContainText("Shell B");
      await expect(composer).toBeFocused();
      await expect(window.locator(".composer__attachment-item--file")).toHaveCount(1);

      await shellARow.click();
      await expect(
        window.locator(".shell-turn").filter({ hasText: "test-background-shell" }),
      ).toContainText("background shell complete");
      await expect(
        window.locator(".shell-turn").filter({ hasText: "test-interactive-shell" }),
      ).toContainText("Hello, Ada");
      await expect(terminal).toHaveCount(0);
    } finally {
      await app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
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

  test("/login uses the active host provider and keeps API keys out of projections and diagnostics", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const ipcLog = join(folders.settingsDir, "ipc.log");
    const { app, window } = await launchApp(folders, {
      PIVIS_TEST_IPC_INVOCATION_LOG: ipcLog,
    });

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const textarea = window.locator(".composer__textarea");
    await textarea.fill("/login");
    await textarea.press("Enter");
    const picker = window.locator(".picker--login");
    await expect(picker).toBeVisible();
    await picker.getByRole("option").filter({ hasText: "API key" }).click();

    const dialog = window.getByRole("dialog", { name: "Sign in to Fake Provider" });
    const input = dialog.locator('input[type="password"]');
    await expect(input).toHaveAttribute("autocomplete", "off");
    const secret = "e2e-provider-secret-must-not-persist";
    await input.fill(secret);
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog).toBeHidden();
    await expect(textarea).toBeVisible();
    await expect(window.locator("body")).not.toContainText(secret);
    if (fs.existsSync(ipcLog)) expect(fs.readFileSync(ipcLog, "utf8")).not.toContain(secret);

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("a first prompt renders once in either host-echo/custody ordering", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const text = "first message [test:echo-before-custody]";
    const textarea = window.locator(".composer__textarea");
    await textarea.fill(text);
    await textarea.press("Enter");

    await expect(window.locator(".transcript-block--user")).toHaveCount(1);
    await expect(window.locator(".transcript-block--user")).toContainText(text);
    await expect(window.getByText(`Echo: ${text}`, { exact: true })).toBeVisible();

    // The fixture's normal path sends custody before message_start. A fresh
    // session verifies the inverse legal ordering in the same real IPC test.
    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });
    const secondText = "first message with custody before echo";
    const secondTextarea = window.locator(".composer__textarea");
    await secondTextarea.fill(secondText);
    await secondTextarea.press("Enter");
    await expect(window.locator(".transcript-block--user")).toHaveCount(1);
    await expect(window.locator(".transcript-block--user")).toContainText(secondText);

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("/compact clears only after the host persists a successful compaction", async () => {
    test.setTimeout(60_000);
    const folders = await makeFolders();
    const { app, window } = await launchApp(folders);

    await window.getByRole("button", { name: "New session" }).click();
    await expect(window.locator(".session-header__model-btn")).toContainText("Fake Model [fake]", {
      timeout: 15_000,
    });

    const textarea = window.locator(".composer__textarea");
    await textarea.fill("/compact");
    await textarea.press("Enter");

    await expect(textarea).toHaveValue("");
    await expect(window.getByText("Context compacted", { exact: false })).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(() =>
        jsonlFiles(folders.piSessionsDir).some((file) =>
          fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .some((line) => {
              try {
                return (JSON.parse(line) as { type?: unknown }).type === "compaction";
              } catch {
                return false;
              }
            }),
        ),
      )
      .toBe(true);

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
    await expect(textarea).toHaveValue("/model fake-model");
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
    const resultMetadata = card
      .locator(".tool-card__section-title")
      .filter({ hasText: /^Result metadata$/ })
      .locator("..")
      .locator("..");
    await expect(resultMetadata).toContainText('"outputLines": 240');
    await expect(resultMetadata).toContainText('"totalLines": 6400');
    await expect(resultMetadata).toContainText("fake-pi-long-output.log");
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
    // The full assistant text appears just before fake-pi sends agent_end and
    // the prompt RPC response. Wait for the turn to be fully idle before
    // submitting /new; otherwise the Composer's duplicate-submit guard can
    // legitimately ignore the next Enter on slower full-suite runs.
    await expect(window.locator(".status-dot--streaming")).toHaveCount(0, { timeout: 5_000 });

    const filesBeforeNew = countJsonlFiles(folders.piSessionsDir);

    // /new clears the transcript and adopts a fresh file.
    await textarea.fill("/new");
    // Close slash autocomplete so Enter submits the command instead of racing
    // the selected completion on slower full-suite runs.
    await textarea.press("Escape");
    await textarea.press("Enter");

    // Replacement success is the adopted file plus an empty editor and
    // transcript. The predecessor-owned toast can race the atomic owner swap
    // after the command has already completed, so it is not a safe boundary.
    await expect
      .poll(() => countJsonlFiles(folders.piSessionsDir), { timeout: 10_000 })
      .toBeGreaterThan(filesBeforeNew);
    await expect(textarea).toHaveValue("", { timeout: 5_000 });
    // Transcript is empty after /new.
    await expect(window.locator(".transcript-block--assistant")).toHaveCount(0, { timeout: 5_000 });

    await app.close();
    rmrf(folders.settingsDir);
    rmrf(folders.workspaceDir);
    rmrf(folders.piSessionsDir);
  });

  test("composer focuses and preserves drafts before pending and saved sessions attach", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const pendingDraft = "drafted before pending host attach";
    const savedDraft = "drafted before saved host attach";

    try {
      const first = await launchApp(folders, { PIVIS_TEST_HOST_READY_DELAY_MS: "3000" });
      try {
        // Boot creates the pending-new record. Clicking its selected entry is
        // the deliberate focus request a user makes before beginning to type.
        await first.window.getByRole("button", { name: "New session" }).click();
        const textarea = first.window.locator(".composer__textarea");
        const attach = first.window.locator(".composer__attach-btn");

        await expect(attach).toBeDisabled();
        await expect(textarea).toBeFocused();
        await first.window.keyboard.type(pendingDraft);
        await expect(textarea).toHaveValue(pendingDraft);

        // The authority baseline rebases the renderer-owned draft instead of
        // replacing it with the host's initially empty editor.
        await expect(attach).toBeEnabled({ timeout: 15_000 });
        await expect(textarea).toHaveValue(pendingDraft);

        // Persist one ordinary turn so the second launch can exercise the same
        // invariant when a cold saved-session row is selected.
        await textarea.press("Enter");
        await expect(first.window.locator(".transcript-block--user")).toContainText(pendingDraft);
        await expect(first.window.locator(".transcript-block--assistant")).toContainText(
          `Echo: ${pendingDraft}`,
          { timeout: 15_000 },
        );
        await expect(first.window.locator(".status-dot--streaming")).toHaveCount(0, {
          timeout: 5_000,
        });
        await expect.poll(() => countJsonlFiles(folders.piSessionsDir)).toBe(1);
      } finally {
        await first.app.close();
      }

      const second = await launchApp(folders, { PIVIS_TEST_HOST_READY_DELAY_MS: "3000" });
      try {
        const stored = second.window.getByRole("button", {
          name: new RegExp(`Not running ${pendingDraft}`),
        });
        await expect(stored).toBeVisible({ timeout: 15_000 });
        await stored.click();

        const textarea = second.window.locator(".composer__textarea");
        const attach = second.window.locator(".composer__attach-btn");
        await expect(attach).toBeDisabled();
        await expect(textarea).toBeFocused();
        await second.window.keyboard.type(savedDraft);
        await expect(textarea).toHaveValue(savedDraft);

        await expect(attach).toBeEnabled({ timeout: 15_000 });
        await expect(textarea).toHaveValue(savedDraft);
      } finally {
        await second.app.close();
      }
    } finally {
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });

  test("delayed same-file history cannot cross activation and retries against the live owner", async () => {
    test.setTimeout(90_000);
    const folders = await makeFolders();
    const first = await launchApp(folders);
    try {
      await first.window.getByRole("button", { name: "New session" }).click();
      const textarea = first.window.locator(".composer__textarea");
      await expect(first.window.locator(".composer__attach-btn")).toBeEnabled({ timeout: 15_000 });
      await expect(textarea).toBeEnabled();
      await textarea.fill("hello history owner");
      await textarea.press("Enter");
      await expect(first.window.locator(".transcript-block--assistant")).toContainText(
        "your pi coding agent",
        { timeout: 15_000 },
      );
      await expect(first.window.locator(".status-dot--streaming")).toHaveCount(0, {
        timeout: 5_000,
      });
      await expect.poll(() => countJsonlFiles(folders.piSessionsDir)).toBe(1);
    } finally {
      await first.app.close();
    }

    const second = await launchApp(folders, {
      PIVIS_TEST_HISTORY_DELAY_MS: "300",
      PIVIS_TEST_HISTORY_LOG: folders.historyLog,
      PIVIS_TEST_HOST_READY_DELAY_MS: "1800",
    });
    try {
      const sessionFile = jsonlFiles(folders.piSessionsDir)[0]!;
      const raced = await second.window.evaluate(
        async ({ workspacePath, file }) => {
          const invoke = (
            window as unknown as {
              pivis: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
            }
          ).pivis.invoke;
          const opened = (await invoke("session.open", {
            workspacePath,
            sessionFile: file,
          })) as { sessionId: string };
          const predecessorRead = invoke("session.loadHistory", {
            sessionId: opened.sessionId,
            expectedSessionFile: file,
            historyGeneration: 999,
            expectedHostInstanceId: null,
            expectedSessionEpoch: null,
          });
          const activation = invoke("session.activate", { sessionId: opened.sessionId });
          const result = await predecessorRead;
          void activation.catch(() => {});
          return result;
        },
        { workspacePath: folders.workspaceDir, file: sessionFile },
      );
      expect(raced).toMatchObject({ status: "stale", historyGeneration: 999 });

      const stored = second.window.getByRole("button", {
        name: /Not running hello history owner/,
      });
      await expect(stored).toBeVisible({ timeout: 15_000 });
      await stored.click();
      await expect(second.window.locator(".transcript-block--user")).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(second.window.locator(".transcript-block--assistant")).toHaveCount(1);
      await expect(second.window.locator(".transcript-block--assistant")).toContainText(
        "your pi coding agent",
      );
      await expect
        .poll(() => {
          if (!fs.existsSync(folders.historyLog)) return [];
          return fs
            .readFileSync(folders.historyLog, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  status: string;
                  expectedHostInstanceId?: string;
                },
            );
        })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ status: "stale" }),
            expect.objectContaining({
              status: "loaded",
              expectedHostInstanceId: expect.any(String),
            }),
          ]),
        );
    } finally {
      await second.app.close();
      rmrf(folders.settingsDir);
      rmrf(folders.workspaceDir);
      rmrf(folders.piSessionsDir);
    }
  });
});
