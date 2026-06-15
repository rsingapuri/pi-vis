/**
 * Auth file management for pi-vis.
 *
 * Reads/writes ~/.pi/agent/auth.json with proper locking and atomic
 * writes. Detects environment variables from the login shell (GUI apps
 * don't inherit ~/.zshrc) and watches for external changes (e.g. pi's
 * own token refresh).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lock, unlock } from "proper-lockfile";

import type { AuthCredential, ProviderAuthStatus, ProviderDef } from "@shared/auth.js";
import { PROVIDERS, findProvider, getProviderDisplayName } from "@shared/auth.js";

const execFileAsync = promisify(execFile);

// ── Paths ────────────────────────────────────────────────────────────────

export function getAuthDir(): string {
  return path.join(os.homedir(), ".pi/agent");
}

export function getAuthPath(): string {
  return path.join(getAuthDir(), "auth.json");
}

// ── Login shell env (cached) ─────────────────────────────────────────────

let cachedLoginShellEnv: Record<string, string> | null = null;

/**
 * Read environment variables from the user's login shell. GUI apps on
 * macOS do not inherit the shell's PATH or env vars from ~/.zshrc;
 * this mirrors the approach used by locate-pi.ts to resolve the pi
 * binary, but captures the full environment.
 *
 * Cached after the first call since the env doesn't change during a
 * session. Cleared by clearLoginShellEnvCache().
 */
export async function getLoginShellEnv(): Promise<Record<string, string>> {
  if (cachedLoginShellEnv) return cachedLoginShellEnv;

  const shell = process.env["SHELL"] ?? "/bin/bash";
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", "env"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const env: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx);
        const val = line.slice(eqIdx + 1);
        env[key] = val;
      }
    }
    cachedLoginShellEnv = env;
    return env;
  } catch {
    cachedLoginShellEnv = {};
    return cachedLoginShellEnv;
  }
}

export function clearLoginShellEnvCache(): void {
  cachedLoginShellEnv = null;
}

// ── Read auth.json ───────────────────────────────────────────────────────

export function readAuth(): Record<string, AuthCredential> {
  const authPath = getAuthPath();
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, AuthCredential>;
    }
    return {};
  } catch {
    return {};
  }
}

// ── Build provider entry from credential ─────────────────────────────────

function toStatusEntry(key: string, credential: AuthCredential | undefined): ProviderAuthStatus {
  const def = findProvider(key);
  let source: ProviderAuthStatus["source"] = "none";

  if (credential) {
    source = credential.type === "oauth" ? "oauth" : "api_key";
  }

  return {
    key,
    displayName: getProviderDisplayName(key),
    source,
    envVar: def?.envVar,
    supportsOAuth: def?.supportsOAuth,
  };
}

// ── List auth status (merge file entries + known providers + env) ────────

export function listAuthStatus(
  auth: Record<string, AuthCredential>,
  loginShellEnv: Record<string, string>,
): ProviderAuthStatus[] {
  const fileKeys = new Set(Object.keys(auth));
  const result: ProviderAuthStatus[] = [];

  // 1. Entries from auth.json
  for (const key of fileKeys) {
    result.push(toStatusEntry(key, auth[key]));
  }

  // 2. Known providers not in auth.json — check env vars
  for (const def of PROVIDERS) {
    if (fileKeys.has(def.key)) {
      // Update existing with env var detection + OAuth flag
      const existing = result.find((p) => p.key === def.key);
      if (existing) {
        // Don't override file source if present
        if (existing.source === "none" && def.envVar) {
          const envVal = loginShellEnv[def.envVar];
          if (envVal) {
            existing.source = "environment";
            existing.envVar = def.envVar;
          }
        }
        if (def.supportsOAuth && !existing.supportsOAuth) {
          existing.supportsOAuth = true;
        }
      }
    } else {
      let source: ProviderAuthStatus["source"] = "none";
      if (def.envVar) {
        const envVal = loginShellEnv[def.envVar];
        if (envVal) {
          source = "environment";
        }
      }
      result.push({
        key: def.key,
        displayName: def.displayName,
        source,
        envVar: def.envVar,
        supportsOAuth: def.supportsOAuth,
      });
    }
  }

  return result;
}

// ── Write auth.json (atomic, locked) ────────────────────────────────────

async function writeAuth(auth: Record<string, AuthCredential>): Promise<void> {
  const authPath = getAuthPath();
  const authDir = getAuthDir();

  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true, mode: 0o755 });
  }

  // Acquire the same lock pi uses (default retry).
  const release = await lock(authPath, {
    lockfilePath: authPath + ".lock",
    retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
  });

  try {
    const tmpPath = authPath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2), "utf8");
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, authPath);
  } finally {
    await unlock(authPath, {
      lockfilePath: authPath + ".lock",
    }).catch(() => {
      // Best-effort release
    });
  }
}

// ── Public mutations ─────────────────────────────────────────────────────

export async function saveApiKey(
  provider: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const auth = readAuth();
    auth[provider] = { type: "api_key", key };
    await writeAuth(auth);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function removeProvider(
  provider: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const auth = readAuth();
    delete auth[provider];
    await writeAuth(auth);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Watch for external changes ──────────────────────────────────────────

export type AuthChangeCallback = (providers: ProviderAuthStatus[]) => void;

let watchAbortController: AbortController | null = null;

/**
 * Start watching ~/.pi/agent/ for changes to auth.json. Calls onChange
 * with the current status whenever the file is modified externally
 * (e.g. by pi's token refresh or the user editing the file).
 *
 * Watches the directory (not the file) so atomic rename replacements
 * are detected. Debounces at ~150ms.
 */
export function startAuthWatch(onChange: AuthChangeCallback): void {
  stopAuthWatch();

  const abortController = new AbortController();
  watchAbortController = abortController;
  const signal = abortController.signal;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const dir = getAuthDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    const watcher = fs.watch(dir, (eventType, filename) => {
      if (signal.aborted) return;
      if (filename !== "auth.json") return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        if (signal.aborted) return;
        const auth = readAuth();
        const loginShellEnv = await getLoginShellEnv();
        const providers = listAuthStatus(auth, loginShellEnv);
        onChange(providers);
      }, 150);
    });

    signal.addEventListener("abort", () => {
      watcher.close();
    });
  } catch {
    // fs.watch may fail; that's fine
  }
}

export function stopAuthWatch(): void {
  if (watchAbortController) {
    watchAbortController.abort();
    watchAbortController = null;
  }
}

// ── Convenience: get full status list (for startup/refresh) ────────────

export async function getAuthStatus(): Promise<ProviderAuthStatus[]> {
  const auth = readAuth();
  const loginShellEnv = await getLoginShellEnv();
  return listAuthStatus(auth, loginShellEnv);
}
