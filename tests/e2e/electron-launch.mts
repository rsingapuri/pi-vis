import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import { registerElectronPid, terminateElectronProcessTree } from "./electron-process-registry.mjs";

const require = createRequire(import.meta.url);

export interface LaunchOptions {
  executablePath?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Internal instrumentation seam; invoked immediately after spawn. */
  onProcessStarted?: (process: ChildProcess) => void;
  /** Internal instrumentation seam; invoked for every Electron renderer page. */
  onPage?: (page: Page) => void | Promise<void>;
}

export interface LaunchedElectronApplication {
  firstWindow(): Promise<Page>;
  close(): Promise<void>;
  process(): ChildProcess;
}

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_HOST_DIRECTORY = join(PROJECT_ROOT, "resources/pi-session-host");
const COPIED_HOST_DIRECTORY = join(PROJECT_ROOT, "out/resources/pi-session-host");
const MAIN_BUNDLE = join(PROJECT_ROOT, "out/main/index.js");
export const BUILD_STALE_MESSAGE = "Build is stale; run npm run build.";

export interface BuildFreshnessPaths {
  sourceDirectories: string[];
  mainBundle: string;
  copiedHostDirectory: string;
}

function recursiveFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? recursiveFiles(path) : entry.isFile() ? [path] : [];
  });
}

function hostMjsFiles(directory: string): string[] {
  return recursiveFiles(directory).filter((path) => path.endsWith(".mjs"));
}

export function assertBuildFreshness(
  skipFreshness: boolean,
  paths: BuildFreshnessPaths = {
    sourceDirectories: [join(PROJECT_ROOT, "src"), SOURCE_HOST_DIRECTORY],
    mainBundle: MAIN_BUNDLE,
    copiedHostDirectory: COPIED_HOST_DIRECTORY,
  },
): void {
  if (skipFreshness) return;
  try {
    const newestSourceMtime = Math.max(
      ...paths.sourceDirectories.flatMap(recursiveFiles).map((path) => fs.statSync(path).mtimeMs),
    );
    const outputs = [paths.mainBundle, ...hostMjsFiles(paths.copiedHostDirectory)];
    if (!Number.isFinite(newestSourceMtime) || outputs.length === 1)
      throw new Error(BUILD_STALE_MESSAGE);
    if (outputs.some((path) => fs.statSync(path).mtimeMs < newestSourceMtime)) {
      throw new Error(BUILD_STALE_MESSAGE);
    }
  } catch (error) {
    if (error instanceof Error && error.message === BUILD_STALE_MESSAGE) throw error;
    throw new Error(BUILD_STALE_MESSAGE);
  }
}

function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let outputTail = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${pattern}${outputTail ? `\nElectron output:\n${outputTail}` : ""}`,
        ),
      );
    }, timeoutMs);
    const onData = (data: Buffer) => {
      const text = data.toString();
      outputTail = `${outputTail}${text}`.slice(-8_000);
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(pattern);
        if (match?.[1]) {
          cleanup();
          resolve(match[1]);
          return;
        }
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Electron exited before ${pattern} (code=${code}, signal=${signal})${outputTail ? `\nElectron output:\n${outputTail}` : ""}`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForCdpPort(child: ChildProcess, port: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (child.exitCode !== null) throw new Error("Electron exited before CDP was ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const version = (await response.json()) as { webSocketDebuggerUrl?: string };
        if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for packaged Electron CDP port ${port}`);
}

export async function launchElectron(options: LaunchOptions): Promise<LaunchedElectronApplication> {
  assertBuildFreshness(
    (options.env?.PIVIS_TEST_SKIP_FRESHNESS ?? process.env.PIVIS_TEST_SKIP_FRESHNESS) === "1",
  );
  const appEntry = options.args?.[0];
  if (appEntry && !appEntry.startsWith("-") && !fs.existsSync(appEntry)) {
    throw new Error(
      `Electron app entry does not exist: ${appEntry}. Run \`npm run build\` before launching E2E.`,
    );
  }

  const electronPath = options.executablePath ?? String(require("electron"));
  const packagedCdpPort = options.executablePath ? await reserveLoopbackPort() : null;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    // Packaged Electron suppresses the `DevTools listening` line, so use a
    // reserved fixed port that the harness can probe. Development keeps port 0
    // and discovers the selected endpoint from stderr.
    PIVIS_TEST_REMOTE_DEBUGGING_PORT: String(packagedCdpPort ?? 0),
    ...(options.executablePath ? { PIVIS_TEST_ALLOW_MULTIPLE_INSTANCES: "1" } : {}),
  };
  env.PIVIS_TEST_HIDE_WINDOW ??= env.PIVIS_TEST_SHOW_WINDOW === "1" ? "0" : "1";
  // pi runs tools under Electron's bundled Node mode. A child Electron app must
  // not inherit that flag, or the app's main process runs as plain Node and
  // require("electron") resolves to the npm package path.
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, options.args ?? [], {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // A dedicated process group lets cleanup terminate Electron helpers and
    // app-owned subprocesses instead of only the browser process.
    detached: process.platform !== "win32",
  });
  const pid = child.pid;
  if (pid) registerElectronPid(pid);
  // Register stderr instrumentation before waiting for the DevTools endpoint:
  // startup diagnostics otherwise disappear before the caller receives app.
  try {
    options.onProcessStarted?.(child);
  } catch (error) {
    child.stdout?.resume();
    child.stderr?.resume();
    if (pid) await terminateElectronProcessTree(pid);
    throw error;
  }

  let browser: Browser | undefined;
  const pageRegistrations = new Map<Page, Promise<void>>();
  const observedContexts = new Set<BrowserContext>();
  const registerPage = (page: Page): Promise<void> => {
    const existing = pageRegistrations.get(page);
    if (existing) return existing;
    let registration: Promise<void>;
    try {
      registration = Promise.resolve(options.onPage?.(page)).then(() => undefined);
    } catch (error) {
      registration = Promise.reject(error);
    }
    pageRegistrations.set(page, registration);
    return registration;
  };
  const attachContext = (context: BrowserContext): void => {
    if (observedContexts.has(context)) return;
    observedContexts.add(context);
    for (const page of context.pages()) registerPage(page);
    context.on("page", (page) => {
      void registerPage(page);
    });
  };

  try {
    const cdpUrl = packagedCdpPort
      ? await waitForCdpPort(child, packagedCdpPort)
      : await waitForLine(child, /^DevTools listening on (ws:\/\/.*)$/, 15_000);
    // Keep draining both pipes after finding the CDP URL. An unread full pipe
    // can block Electron and make an otherwise healthy test appear hung.
    child.stdout?.resume();
    child.stderr?.resume();
    browser = await chromium.connectOverCDP(cdpUrl);
    const initialContext = browser.contexts()[0] ?? (await waitForContext(browser));
    attachContext(initialContext);
    await Promise.all([...pageRegistrations.values()]);
  } catch (error) {
    child.stdout?.resume();
    child.stderr?.resume();
    await browser?.close().catch(() => undefined);
    if (pid) await terminateElectronProcessTree(pid);
    throw error;
  }

  const app: LaunchedElectronApplication = {
    async firstWindow() {
      const context = browser!.contexts()[0] ?? (await waitForContext(browser!));
      attachContext(context);
      const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 15_000 }));
      await registerPage(page);
      return page;
    },
    async close() {
      await browser!.close().catch(() => undefined);
      if (pid) await terminateElectronProcessTree(pid);
    },
    process() {
      return child;
    },
  };

  return app;
}

async function waitForContext(browser: Browser) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const context = browser.contexts()[0];
    if (context) return context;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Electron browser context");
}
