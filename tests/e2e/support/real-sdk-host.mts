import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Locator, type Page, expect } from "@playwright/test";
import { type LaunchedElectronApplication, launchElectron } from "../electron-launch.mjs";

const supportDir = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(supportDir, "../../..");
export const APP_ENTRY = join(PROJECT_ROOT, "out/main/index.js");
export const PINNED_PI_VERSION = "0.80.6";

const packagePi = join(
  PROJECT_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const shimPi = join(
  PROJECT_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "pi.cmd" : "pi",
);

/**
 * The normal real-SDK suite deliberately ignores PATH and a developer's Pi.
 * Its executable must come from the exact test-only package-lock entry.
 */
export function pinnedPiBinary(): string {
  const candidate = process.platform === "win32" ? shimPi : packagePi;
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Pinned Pi ${PINNED_PI_VERSION} is missing at ${candidate}. Run npm ci before the E2E suite.`,
    );
  }
  const version = execFileSync(candidate, ["--version"], { encoding: "utf8" })
    .trim()
    .replace(/^v/, "");
  if (version !== PINNED_PI_VERSION) {
    throw new Error(
      `Pinned real-Pi tests require ${PINNED_PI_VERSION}, but ${candidate} reported ${version}.`,
    );
  }
  return candidate;
}

export interface RealSdkFixtureOptions {
  providerBaseUrl?: string;
  extensionFiles?: string[];
  workspaceDir?: string;
  compactionEnabled?: boolean;
  modelInput?: Array<"text" | "image">;
  retry?: {
    enabled: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
  };
}

export interface RealSdkDirectories {
  root: string;
  settings: string;
  workspace: string;
  agent: string;
  sessions: string;
  piSessions: string;
  home: string;
}

export interface RealSdkLaunch {
  app: LaunchedElectronApplication;
  window: Page;
  output: string[];
  close: () => Promise<void>;
}

export interface RealSdkFixture {
  readonly piBinary: string;
  readonly dirs: RealSdkDirectories;
  readonly providerBaseUrl?: string;
  launch: () => Promise<RealSdkLaunch>;
  sessionFiles: () => string[];
  diagnostics: (window?: Page) => Promise<string>;
  cleanup: () => void;
}

function makeDirectories(workspaceDir?: string): RealSdkDirectories {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-real-sdk-")));
  const settings = join(root, "settings");
  const workspace = workspaceDir ? fs.realpathSync(workspaceDir) : join(root, "workspace");
  const agent = join(root, "agent");
  const sessions = join(root, "sessions");
  // Pi's default layout stores JSONL inside workspace buckets, and Pi-Vis
  // discovery intentionally scans one bucket level. Keep the explicit test
  // session override in an equivalent child directory rather than writing
  // files directly at the discovery root.
  const piSessions = join(sessions, "real-sdk");
  const home = join(root, "home");
  for (const path of [settings, workspace, agent, sessions, piSessions, home]) {
    fs.mkdirSync(path, { recursive: true });
  }
  return { root, settings, workspace, agent, sessions, piSessions, home };
}

function findJsonl(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...findJsonl(path));
    else if (path.endsWith(".jsonl")) files.push(path);
  }
  return files.sort();
}

function copyExtensions(agentDir: string, extensionFiles: string[]): void {
  if (extensionFiles.length === 0) return;
  const target = join(agentDir, "extensions");
  fs.mkdirSync(target, { recursive: true });
  for (const source of extensionFiles) {
    fs.copyFileSync(source, join(target, basename(source)));
  }
}

function writeModels(agentDir: string, baseUrl: string, input: Array<"text" | "image">): void {
  fs.writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pivis-local": {
          baseUrl,
          api: "openai-completions",
          apiKey: "pivis-local-test-key",
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
          },
          models: [
            {
              id: "pivis-test-model",
              name: "Pi-Vis Test Model",
              reasoning: false,
              input,
              contextWindow: 128_000,
              maxTokens: 512,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
}

function cleanEnvironment(dirs: RealSdkDirectories): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The local model has its own inert key. A developer's credentials, proxy,
  // user Pi resources, and fake-host seams must not participate in this suite.
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "PIVIS_TEST_HOST_SCRIPT",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    PIVIS_SETTINGS_DIR: dirs.settings,
    PIVIS_SESSIONS_DIR: dirs.sessions,
    PI_CODING_AGENT_DIR: dirs.agent,
    PI_CODING_AGENT_SESSION_DIR: dirs.piSessions,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ELECTRON_RENDERER_URL: undefined,
  };
}

export function createRealSdkFixture(options: RealSdkFixtureOptions = {}): RealSdkFixture {
  const piBinary = pinnedPiBinary();
  const dirs = makeDirectories(options.workspaceDir);
  copyExtensions(dirs.agent, options.extensionFiles ?? []);
  if (options.providerBaseUrl) {
    writeModels(dirs.agent, options.providerBaseUrl, options.modelInput ?? ["text"]);
  }
  fs.writeFileSync(
    join(dirs.agent, "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: options.compactionEnabled ?? false,
        reserveTokens: 256,
        keepRecentTokens: 200,
      },
      retry: {
        enabled: options.retry?.enabled ?? false,
        maxRetries: options.retry?.maxRetries ?? 0,
        baseDelayMs: options.retry?.baseDelayMs ?? 10,
        provider: { timeoutMs: 10_000, maxRetries: 0, maxRetryDelayMs: 1_000 },
      },
      defaultThinkingLevel: "off",
      defaultProjectTrust: "never",
    }),
  );
  fs.writeFileSync(
    join(dirs.settings, "settings.json"),
    JSON.stringify({
      piBinaryPath: piBinary,
      workspaceOrder: [dirs.workspace],
      fonts: {
        display: { sizePx: 14 },
        code: { family: "IBM Plex Mono", sizePx: 14 },
      },
    }),
  );

  const fixture: RealSdkFixture = {
    piBinary,
    dirs,
    providerBaseUrl: options.providerBaseUrl,
    launch: async () => {
      const app = await launchElectron({
        args: [APP_ENTRY],
        env: cleanEnvironment(dirs),
      });
      const output: string[] = [];
      app.process().stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
      app
        .process()
        .stdout?.on("data", (chunk: Buffer) => output.push(`[stdout] ${chunk.toString("utf8")}`));
      const window = await app.firstWindow();
      window.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error") {
          output.push(`[renderer ${message.type()}] ${message.text()}\n`);
        }
      });
      await window.waitForLoadState("domcontentloaded");
      await expect(window.locator(".sidebar, .pi-not-found").first()).toBeVisible({
        timeout: 30_000,
      });
      return {
        app,
        window,
        output,
        close: async () => {
          await app.close();
        },
      };
    },
    sessionFiles: () => findJsonl(dirs.sessions),
    diagnostics: async (window?: Page) => {
      const body = window
        ? await window
            .locator("body")
            .innerText()
            .catch(() => "<body unavailable>")
        : "<window unavailable>";
      const sessions = findJsonl(dirs.sessions)
        .map((file) => {
          const content = fs.readFileSync(file, "utf8");
          return `${file}\n${content.slice(-8_000)}`;
        })
        .join("\n---\n");
      return `Visible UI:\n${body.slice(-8_000)}\nSession files:\n${sessions || "<none>"}`;
    },
    cleanup: () => {
      try {
        fs.rmSync(dirs.root, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the Electron process registry is the process backstop.
      }
    },
  };
  return fixture;
}

export async function openNewRealSession(window: Page): Promise<Locator> {
  await window.getByRole("button", { name: "New session" }).click();
  const textarea = window.locator(".composer__textarea");
  await expect(textarea).toBeEnabled({ timeout: 60_000 });
  await expect(window.getByText(/Host process exited/)).toHaveCount(0);
  return textarea;
}

export async function selectLocalTestModel(window: Page, textarea: Locator): Promise<void> {
  await textarea.fill("/model pivis-local/pivis-test-model");
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("");
  await expect(
    window.getByText(/Model:.*Pi-Vis Test Model|Model:.*pivis-test-model/).first(),
  ).toBeVisible({ timeout: 30_000 });
}

export function parseSessionEntries(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}
