/**
 * Update checker and runner for pi-vis.
 *
 * Mirrors pi's version-check.js:
 *   - Fetches https://pi.dev/api/latest-version, compares semver
 *   - Checks npm packages in ~/.pi/agent/npm/node_modules
 *   - Runs `pi update` via child_process, streaming output
 *
 * Honors PI_OFFLINE and PI_SKIP_VERSION_CHECK env vars.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { locatePi, clearPiLocationCache } from "./pi/locate-pi.js";
import { getLoginShellEnv } from "./auth.js";
import { getSettings } from "./settings-store.js";

import type { UpdateStatus, PiUpdateStatus, ExtensionUpdate } from "@shared/updates.js";

const execFileAsync = promisify(execFile);

// ── Semver helpers (ported from pi's version-check.js) ────────────────────

function parseVersion(ver: string): number[] {
  return ver
    .replace(/^v/, "")
    .split(".")
    .map((s) => {
      const n = Number.parseInt(s, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

export function comparePackageVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export function isNewerPackageVersion(current: string, latest: string): boolean {
  return comparePackageVersions(latest, current) > 0;
}

// ── Config paths ─────────────────────────────────────────────────────────

function getPiSettingsPath(): string {
  return path.join(os.homedir(), ".pi/agent/settings.json");
}

function getNpmModulesDir(): string {
  return path.join(os.homedir(), ".pi/agent/npm/node_modules");
}

// ── Check for pi update ──────────────────────────────────────────────────

async function checkPiUpdate(piVersion: string): Promise<PiUpdateStatus> {
  // Respect offline/disable env vars
  if (process.env["PI_OFFLINE"] === "1" || process.env["PI_SKIP_VERSION_CHECK"] === "1") {
    return { current: piVersion, updateAvailable: false };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch("https://pi.dev/api/latest-version", {
      headers: {
        accept: "application/json",
        "User-Agent": "pi-vis/0.1.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { current: piVersion, updateAvailable: false };
    }

    const data = (await res.json()) as {
      version?: string;
      packageName?: string;
      note?: string;
    };

    if (!data.version) {
      return { current: piVersion, updateAvailable: false };
    }

    const updateAvailable = isNewerPackageVersion(piVersion, data.version);
    return {
      current: piVersion,
      latest: data.version,
      updateAvailable,
      note: data.note,
    };
  } catch {
    return { current: piVersion, updateAvailable: false };
  }
}

// ── Check extensions ────────────────────────────────────────────────────

async function checkExtensions(loginShellEnv: Record<string, string>): Promise<ExtensionUpdate[]> {
  const packages = readPackagesConfig();
  if (packages.length === 0) return [];

  const results: ExtensionUpdate[] = [];

  // Process with concurrency ≤ 4
  const pool: Promise<void>[] = [];
  const queue = [...packages];

  const processNext = async () => {
    while (queue.length > 0) {
      const pkg = queue.shift()!;
      try {
        const update = await checkSingleExtension(pkg, loginShellEnv);
        results.push(update);
      } catch {
        results.push({ source: pkg, name: pkg, updateAvailable: false, kind: "npm" });
      }
    }
  };

  const concurrency = Math.min(4, packages.length);
  for (let i = 0; i < concurrency; i++) {
    pool.push(processNext());
  }
  await Promise.all(pool);

  return results;
}

function readPackagesConfig(): string[] {
  try {
    const raw = fs.readFileSync(getPiSettingsPath(), "utf8");
    const config = JSON.parse(raw);
    if (Array.isArray(config.packages)) {
      return config.packages.map((p: string) => p.trim()).filter(Boolean);
    }
  } catch {
    // settings.json may not exist
  }
  return [];
}

async function checkSingleExtension(
  source: string,
  loginShellEnv: Record<string, string>,
): Promise<ExtensionUpdate> {
  // Detect kind from source string
  const kind: "npm" | "git" | "local" = source.startsWith("git+")
    ? "git"
    : source === "." || source.startsWith("/") || source.startsWith("file:")
      ? "local"
      : source.startsWith("npm:") || !source.includes(":")
        ? "npm"
        : "npm";

  // For npm packages, read current version from node_modules
  let name = source;
  let current: string | undefined;

  if (kind === "npm") {
    name = source.replace(/^npm:/, "");
    const pkgJsonPath = path.join(getNpmModulesDir(), name, "package.json");
    try {
      const raw = fs.readFileSync(pkgJsonPath, "utf8");
      const pkg = JSON.parse(raw);
      current = pkg.version;
    } catch {
      // package not installed locally
    }

    // Check latest from npm registry
    try {
      const { stdout } = await execFileAsync("npm", ["view", name, "version"], {
        timeout: 10000,
        env: { ...loginShellEnv },
      });
      const latest = stdout.trim();
      const updateAvailable = current ? isNewerPackageVersion(current, latest) : false;
      return { source, name, current, latest, updateAvailable, kind };
    } catch {
      return { source, name, current, updateAvailable: false, kind };
    }
  }

  // git and local — no remote check for v1
  return { source, name, current, updateAvailable: false, kind };
}

// ── Public API ──────────────────────────────────────────────────────────

export async function checkForUpdates(): Promise<UpdateStatus> {
  const settings = getSettings();
  const piInfo = await locatePi(settings.piBinaryPath);
  const piVersion = piInfo?.version ?? "0.0.0";

  const [piUpdate, loginShellEnv] = await Promise.all([
    checkPiUpdate(piVersion),
    getLoginShellEnv(),
  ]);

  const extensions = await checkExtensions(loginShellEnv);

  return {
    pi: piUpdate,
    extensions,
    checkedAt: Date.now(),
  };
}

// ── Update runner ───────────────────────────────────────────────────────

export type UpdateProgressCallback = (runId: string, chunk: string) => void;
export type UpdateDoneCallback = (runId: string, exitCode: number, status: UpdateStatus) => void;

export async function runUpdate(
  target: "all" | "pi" | { extension: string },
  runId: string,
  onProgress: UpdateProgressCallback,
  onDone: UpdateDoneCallback,
): Promise<void> {
  const settings = getSettings();
  const piInfo = await locatePi(settings.piBinaryPath);
  if (!piInfo) {
    onDone(runId, 1, await checkForUpdates());
    return;
  }

  const loginShellEnv = await getLoginShellEnv();
  const args: string[] = ["update"];

  if (target === "pi") {
    args.push("pi");
  } else if (typeof target === "object" && "extension" in target) {
    args.push("--extension", target.extension);
  }
  // "all" → just `pi update` (updates pi + all extensions)

  args.push("--no-approve");

  try {
    const child = execFile(piInfo.path, args, {
      env: { ...loginShellEnv, FORCE_COLOR: "1" },
      timeout: 120000,
    });

    child.stdout?.on("data", (chunk: string) => {
      onProgress(runId, chunk);
    });

    child.stderr?.on("data", (chunk: string) => {
      onProgress(runId, chunk);
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(1));
    });

    // Clear cached pi location so version re-check picks up the new binary
    clearPiLocationCache();

    const status = await checkForUpdates();
    onDone(runId, exitCode, status);
  } catch {
    onDone(runId, 1, await checkForUpdates());
  }
}

let runCounter = 0;

export function startUpdate(
  target: "all" | "pi" | { extension: string },
  onProgress: UpdateProgressCallback,
  onDone: UpdateDoneCallback,
): { runId: string } {
  const runId = `update-${++runCounter}`;
  runUpdate(target, runId, onProgress, onDone).catch((err) => {
    onDone(runId, 1, {
      pi: { current: "unknown", updateAvailable: false },
      extensions: [],
      checkedAt: Date.now(),
    });
  });
  return { runId };
}
