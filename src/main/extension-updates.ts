import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  ExtensionUpdateRunResult,
  ExtensionUpdateStatus,
  ExtensionUpdateTarget,
} from "@shared/extension-updates.js";
import { getSubprocessEnv } from "./auth.js";
import type {
  ExtensionUpdateWorkerRequest,
  ExtensionUpdateWorkerResponse,
} from "./extension-update-worker.js";
import { mergeUserPiEnv } from "./pi-env.js";
import { getPinnedPi } from "./pi/pinned-pi.js";
import { getSettings } from "./settings-store.js";

interface WorkerLike {
  postMessage(message: ExtensionUpdateWorkerRequest): void;
  once(event: "message", listener: (message: ExtensionUpdateWorkerResponse) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface ExtensionUpdateChild {
  readonly pid?: number | undefined;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ExtensionUpdateWorkerFactory = (env: Record<string, string>) => WorkerLike;
export type ExtensionUpdateSpawn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: ["ignore", "ignore", "ignore"];
    detached: boolean;
    windowsHide: boolean;
  },
) => ExtensionUpdateChild;

const CHECK_TIMEOUT_MS = 5 * 60_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const UPDATE_KILL_GRACE_MS = 5_000;
const UPDATE_FORCE_KILL_SETTLE_MS = 1_000;

let extensionUpdateTail: Promise<void> = Promise.resolve();
let extensionUpdateCheckInFlight: Promise<ExtensionUpdateStatus> | null = null;
let latestExtensionUpdateStatus: ExtensionUpdateStatus | null = null;
let extensionUpdateStatusListener: ((status: ExtensionUpdateStatus) => void) | null = null;

export function initExtensionUpdates(listener: (status: ExtensionUpdateStatus) => void): void {
  extensionUpdateStatusListener = listener;
}

export function getExtensionUpdateStatus(): ExtensionUpdateStatus | null {
  return latestExtensionUpdateStatus;
}

export function resolveExtensionUpdateWorkerPath(baseUrl: string | URL = import.meta.url): string {
  const basePath = fileURLToPath(baseUrl);
  const relativeWorker =
    path.basename(path.dirname(basePath)) === "chunks"
      ? "../extension-update-worker.js"
      : "./extension-update-worker.js";
  return fileURLToPath(new URL(relativeWorker, baseUrl)).replace(
    /app\.asar(?=[\\/])/u,
    "app.asar.unpacked",
  );
}

function defaultWorkerFactory(env: Record<string, string>): WorkerLike {
  return new Worker(resolveExtensionUpdateWorkerPath(), {
    name: "pivis-extension-updates",
    env,
  }) as WorkerLike;
}

async function performExtensionUpdateCheck(
  workerFactory: ExtensionUpdateWorkerFactory = defaultWorkerFactory,
): Promise<ExtensionUpdateStatus> {
  const settings = getSettings();
  const worker = workerFactory(mergeUserPiEnv(await getSubprocessEnv(), settings.piEnv));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { status: ExtensionUpdateStatus } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if ("status" in outcome) resolve(outcome.status);
      else reject(outcome.error);
    };
    const timer = setTimeout(
      () => finish({ error: new Error("Extension update check timed out") }),
      CHECK_TIMEOUT_MS,
    );

    worker.once("message", (message) => {
      if (message.ok) {
        finish({ status: { updates: message.updates, checkedAt: Date.now() } });
      } else {
        finish({ error: new Error(message.error) });
      }
    });
    worker.once("error", (error) => finish({ error }));
    worker.once("exit", (code) => {
      if (!settled)
        finish({ error: new Error(`Extension update worker exited with code ${code}`) });
    });
    worker.postMessage({ cwd: os.homedir() });
  });
}

/**
 * Share one network/package-manager pass across launch, Settings-open, and
 * manual callers. A failure clears only the in-flight claim so a later user
 * retry remains possible; the last successful result stays available.
 */
export function checkForExtensionUpdates(
  workerFactory: ExtensionUpdateWorkerFactory = defaultWorkerFactory,
): Promise<ExtensionUpdateStatus> {
  if (extensionUpdateCheckInFlight) return extensionUpdateCheckInFlight;

  const operation = performExtensionUpdateCheck(workerFactory)
    .then((status) => {
      latestExtensionUpdateStatus = status;
      try {
        extensionUpdateStatusListener?.(status);
      } catch {
        // Renderer publication is best-effort; callers still receive status.
      }
      return status;
    })
    .finally(() => {
      if (extensionUpdateCheckInFlight === operation) {
        extensionUpdateCheckInFlight = null;
      }
    });
  extensionUpdateCheckInFlight = operation;
  return operation;
}

export function buildExtensionUpdateArgs(target: ExtensionUpdateTarget): string[] {
  if (target === "all") return ["update", "--extensions", "--no-approve"];
  const source = target.extension.trim();
  if (!source || source.startsWith("-")) {
    throw new Error("Invalid extension update target");
  }
  return ["update", "--extension", source, "--no-approve"];
}

function signalExtensionUpdateTree(
  child: ExtensionUpdateChild,
  signal: "SIGTERM" | "SIGKILL",
): void {
  const pid = child.pid;
  if (pid && process.platform === "win32") {
    const result = spawnSync(
      "taskkill",
      // Windows has no reliable graceful process-group signal in Node. Make
      // the first timeout tree-wide and forceful; a later retry remains armed
      // in case taskkill itself failed before the direct CLI exited.
      ["/pid", String(pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    if (!result.error && result.status === 0) return;
  } else if (pid) {
    try {
      // The updater is a process-group leader, so npm/git descendants receive
      // the same deadline signal instead of continuing to mutate packages.
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through when the group exited between the timeout and signal.
    }
  }
  child.kill(signal);
}

function extensionUpdateTreeIsAlive(child: ExtensionUpdateChild): boolean {
  const pid = child.pid;
  // Conservatively retain the forced cleanup timer on Windows. If the first
  // taskkill failed and fallback child.kill closed only the CLI, treating its
  // close as tree completion would permit a concurrent package mutation.
  if (process.platform === "win32") return true;
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function performExtensionUpdate(
  target: ExtensionUpdateTarget,
  spawnUpdate: ExtensionUpdateSpawn,
): Promise<ExtensionUpdateRunResult> {
  const settings = getSettings();
  const piInfo = getPinnedPi(settings.piBinaryPath);
  if (!piInfo) throw new Error("Bundled pi runtime not found (broken install)");

  const env = mergeUserPiEnv(await getSubprocessEnv(), settings.piEnv);
  const child = spawnUpdate(piInfo.cliPath, buildExtensionUpdateArgs(target), {
    cwd: os.homedir(),
    env: { ...env, FORCE_COLOR: "0" },
    stdio: ["ignore", "ignore", "ignore"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      signalExtensionUpdateTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalExtensionUpdateTree(child, "SIGKILL");
        // A real killed child closes promptly. Keep a final bound for damaged
        // platform process APIs, but do not advertise completion immediately
        // after sending SIGKILL while the direct child may still be alive.
        forceKillSettleTimer = setTimeout(() => finish(1), UPDATE_FORCE_KILL_SETTLE_MS);
      }, UPDATE_KILL_GRACE_MS);
    }, UPDATE_TIMEOUT_MS);
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceKillSettleTimer) clearTimeout(forceKillSettleTimer);
      resolve({ exitCode, timedOut });
    };
    child.once("error", () => finish(1));
    child.once("close", (code) => {
      // The CLI can exit before an npm/git descendant that ignored SIGTERM.
      // Keep the group escalation armed until that process tree is gone.
      if (timedOut && extensionUpdateTreeIsAlive(child)) return;
      finish(code ?? 1);
    });
  });
}

/** Serialize package mutations in main even if multiple renderers invoke IPC. */
export function runExtensionUpdate(
  target: ExtensionUpdateTarget,
  spawnUpdate: ExtensionUpdateSpawn = (file, args, options) => spawn(file, args, options),
): Promise<ExtensionUpdateRunResult> {
  const operation = extensionUpdateTail.then(() => performExtensionUpdate(target, spawnUpdate));
  extensionUpdateTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
