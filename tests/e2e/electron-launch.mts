import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import { registerElectronPid, unregisterElectronPid } from "./electron-process-registry.mjs";

const require = createRequire(import.meta.url);

interface LaunchOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface LaunchedElectronApplication {
  firstWindow(): Promise<Page>;
  close(): Promise<void>;
  process(): ChildProcess;
}

function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}`));
    }, timeoutMs);
    const onData = (data: Buffer) => {
      buffer += data.toString();
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
      reject(new Error(`Electron exited before ${pattern} (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

export async function launchElectron(options: LaunchOptions): Promise<LaunchedElectronApplication> {
  const electronPath = String(require("electron"));
  const env = {
    ...process.env,
    ...options.env,
    // Electron 43 rejects Playwright's old top-level --remote-debugging-port=0
    // argument. The app installs this value through app.commandLine instead.
    PIVIS_TEST_REMOTE_DEBUGGING_PORT: "0",
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
  });
  if (child.pid) {
    registerElectronPid(child.pid);
    child.once("exit", () => unregisterElectronPid(child.pid!));
  }

  const cdpUrl = await waitForLine(child, /^DevTools listening on (ws:\/\/.*)$/, 15_000);
  const browser = await chromium.connectOverCDP(cdpUrl);

  const app: LaunchedElectronApplication = {
    async firstWindow() {
      const context = browser.contexts()[0] ?? (await waitForContext(browser));
      const existing = context.pages()[0];
      if (existing) return existing;
      return context.waitForEvent("page", { timeout: 15_000 });
    },
    async close() {
      await browser.close().catch(() => undefined);
      if (!child.killed) child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          resolve();
        }, 2_000).unref();
      });
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
