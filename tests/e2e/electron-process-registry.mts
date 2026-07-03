import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { resolve } from "node:path";
import { scopedTmpPath } from "../isolation.mjs";

const REGISTRY_PATH =
  process.env["PIVIS_E2E_PROCESS_REGISTRY"] ?? scopedTmpPath("pivis-e2e-electron-pids", "txt");
const APP_ENTRY = resolve(import.meta.dirname, "../../out/main/index.js");

export function electronPidRegistryPath(): string {
  return REGISTRY_PATH;
}

export function registerElectronPid(pid: number): void {
  fs.appendFileSync(REGISTRY_PATH, `${pid}\n`);
}

export function unregisterElectronPid(pid: number): void {
  try {
    const remaining = fs
      .readFileSync(REGISTRY_PATH, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && Number.parseInt(line, 10) !== pid);
    if (remaining.length > 0) {
      fs.writeFileSync(REGISTRY_PATH, `${remaining.join("\n")}\n`);
    } else {
      fs.rmSync(REGISTRY_PATH, { force: true });
    }
  } catch {
    // Best effort. Global teardown validates command lines before killing.
  }
}

function commandForPid(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function isRegisteredPiVisElectron(pid: number): boolean {
  const command = commandForPid(pid);
  return !!command && command.includes(APP_ENTRY);
}

export async function killRegisteredElectronProcesses(): Promise<void> {
  let pids: number[] = [];
  try {
    pids = fs
      .readFileSync(REGISTRY_PATH, "utf8")
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return;
  }

  const uniquePids = [...new Set(pids)];
  for (const pid of uniquePids) {
    if (!isRegisteredPiVisElectron(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const alive = uniquePids.some((pid) => isRegisteredPiVisElectron(pid));
    if (!alive) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  for (const pid of uniquePids) {
    if (!isRegisteredPiVisElectron(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  fs.rmSync(REGISTRY_PATH, { force: true });
}
