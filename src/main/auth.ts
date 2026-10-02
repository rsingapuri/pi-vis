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
import { lock, unlock } from "proper-lockfile";

import type { AuthCredential, ProviderAuthStatus, ProviderDef } from "@shared/auth.js";
import {
  PROVIDERS,
  PROVIDER_API_KEY_ENV_VARS,
  findProvider,
  getProviderDisplayName,
} from "@shared/auth.js";
import { boundedProcessFailureKind, captureProcessOutput } from "./bounded-process.js";
import { appendDiagnostic } from "./diagnostics.js";
import { mergeUserPiEnv } from "./pi-env.js";

// ── Paths ────────────────────────────────────────────────────────────────

export function getAuthDir(): string {
  return path.join(os.homedir(), ".pi/agent");
}

export function getAuthPath(): string {
  return path.join(getAuthDir(), "auth.json");
}

// ── Login shell env (cached) ─────────────────────────────────────────────

let cachedLoginShellEnv: Record<string, string> | null = null;
let loginShellEnvInFlight: Promise<Record<string, string>> | null = null;

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
  // Deterministic fake-host E2E must not execute a developer or CI user's
  // interactive startup files. Besides making the fixture environment
  // non-hermetic, a background process started by shell initialization can
  // retain capture pipes and strand session activation before SessionHost is
  // constructed. The launched Electron process already carries the complete
  // fixture environment, and SessionHost merges it again at fork time, so use
  // that exact inherited environment for this test-only host seam.
  if (process.env.PIVIS_TEST_HOST_SCRIPT) {
    cachedLoginShellEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      }),
    );
    return cachedLoginShellEnv;
  }
  if (cachedLoginShellEnv) return cachedLoginShellEnv;
  if (loginShellEnvInFlight) return loginShellEnvInFlight;

  const configuredShell = process.env["SHELL"];
  // Never ask spawn() to resolve an environment-controlled shell through PATH;
  // that lookup happens before the capture timer can begin.
  const shell = configuredShell && path.isAbsolute(configuredShell) ? configuredShell : "/bin/bash";
  const operation = (async (): Promise<Record<string, string>> => {
    try {
      const { stdout } = await captureProcessOutput(shell, ["-ilc", "env"], {
        timeoutMs: 5_000,
        maxBufferBytes: 1024 * 1024,
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
    } catch (error) {
      appendDiagnostic("host-startup", "login-shell-env-failed", undefined, {
        reason: boundedProcessFailureKind(error),
        timeoutMs: 5_000,
      });
      const env = {};
      cachedLoginShellEnv = env;
      return env;
    }
  })().finally(() => {
    if (loginShellEnvInFlight === operation) loginShellEnvInFlight = null;
  });
  loginShellEnvInFlight = operation;
  return operation;
}

export function clearLoginShellEnvCache(): void {
  cachedLoginShellEnv = null;
}

/**
 * Combine process.env with login-shell env for child processes.
 * GUI apps on macOS (and Linux) inherit a stripped PATH; the
 * login-shell env fills in paths/tools the user expects.
 *
 * Call this once per operation and pass the result to every
 * spawn/execFile call, so env is consistent across all subprocesses
 * (pi, git, npm, pty).
 */
export async function getSubprocessEnv(): Promise<Record<string, string>> {
  return { ...(process.env as Record<string, string>), ...(await getLoginShellEnv()) };
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[auth] failed to read auth.json:", err);
    }
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

const ANTHROPIC_FEDERATION_ENV = [
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
] as const;

function hasEnvironmentValue(environment: Record<string, string>, variable: string): boolean {
  return Boolean(environment[variable]);
}

function detectAnthropicEnvironmentSource(environment: Record<string, string>): string | undefined {
  // This order is authentication semantics, not presentation preference. It
  // exactly mirrors Pi's anthropic provider: bearer, OAuth token, API key,
  // then workload-identity federation.
  for (const variable of PROVIDER_API_KEY_ENV_VARS.anthropic ?? []) {
    if (hasEnvironmentValue(environment, variable)) return `${variable} env var`;
  }
  if (ANTHROPIC_FEDERATION_ENV.every((variable) => hasEnvironmentValue(environment, variable))) {
    return "Anthropic workload identity";
  }
  return undefined;
}

function detectBedrockEnvironmentSource(environment: Record<string, string>): string | undefined {
  if (hasEnvironmentValue(environment, "AWS_BEARER_TOKEN_BEDROCK")) {
    return "AWS_BEARER_TOKEN_BEDROCK env var";
  }
  if (hasEnvironmentValue(environment, "AWS_PROFILE")) return "AWS profile";
  if (
    hasEnvironmentValue(environment, "AWS_ACCESS_KEY_ID") &&
    hasEnvironmentValue(environment, "AWS_SECRET_ACCESS_KEY")
  ) {
    return "AWS access keys";
  }
  if (
    hasEnvironmentValue(environment, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
    hasEnvironmentValue(environment, "AWS_CONTAINER_CREDENTIALS_FULL_URI")
  ) {
    return "AWS ECS task role";
  }
  if (hasEnvironmentValue(environment, "AWS_WEB_IDENTITY_TOKEN_FILE")) {
    return "AWS web identity token";
  }
  return undefined;
}

function detectCloudflareEnvironmentSource(
  provider: ProviderDef,
  environment: Record<string, string>,
): string | undefined {
  if (
    !hasEnvironmentValue(environment, "CLOUDFLARE_API_KEY") ||
    !hasEnvironmentValue(environment, "CLOUDFLARE_ACCOUNT_ID")
  ) {
    return undefined;
  }
  if (
    provider.key === "cloudflare-ai-gateway" &&
    !hasEnvironmentValue(environment, "CLOUDFLARE_GATEWAY_ID")
  ) {
    return undefined;
  }
  return "Cloudflare environment";
}

function detectVertexEnvironmentSource(environment: Record<string, string>): string | undefined {
  if (hasEnvironmentValue(environment, "GOOGLE_CLOUD_API_KEY")) {
    return "GOOGLE_CLOUD_API_KEY env var";
  }

  const credentialsPath = environment.GOOGLE_APPLICATION_CREDENTIALS;
  const hasCredentials = credentialsPath
    ? fs.existsSync(credentialsPath)
    : fs.existsSync(
        path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
      );
  const hasProject =
    hasEnvironmentValue(environment, "GOOGLE_CLOUD_PROJECT") ||
    hasEnvironmentValue(environment, "GCLOUD_PROJECT");
  if (hasCredentials && hasProject && hasEnvironmentValue(environment, "GOOGLE_CLOUD_LOCATION")) {
    return "Google application default credentials";
  }
  return undefined;
}

function detectEnvironmentSource(
  provider: ProviderDef,
  environment: Record<string, string>,
): string | undefined {
  switch (provider.key) {
    case "anthropic":
      return detectAnthropicEnvironmentSource(environment);
    case "amazon-bedrock":
      return detectBedrockEnvironmentSource(environment);
    case "cloudflare-ai-gateway":
    case "cloudflare-workers-ai":
      return detectCloudflareEnvironmentSource(provider, environment);
    case "google-vertex":
      return detectVertexEnvironmentSource(environment);
    default:
      break;
  }

  const variable = PROVIDER_API_KEY_ENV_VARS[provider.key]?.[0];
  if (variable && hasEnvironmentValue(environment, variable)) return `${variable} env var`;
  return undefined;
}

/** Build the exact environment an SDK host receives before Pi-Vis-owned
 * control variables are appended. Advanced Settings overrides the recovered
 * login-shell value, matching getHostEnv(). */
export function mergeAuthEnvironment(
  loginShellEnv: Record<string, string>,
  piEnv: Record<string, string> | undefined,
): Record<string, string> {
  return mergeUserPiEnv(loginShellEnv, piEnv);
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
        const environmentLabel = detectEnvironmentSource(def, loginShellEnv);
        if (existing.source === "none" && environmentLabel) {
          existing.source = "environment";
          existing.envVar = def.envVar;
          existing.environmentLabel = environmentLabel;
        }
        if (def.supportsOAuth && !existing.supportsOAuth) {
          existing.supportsOAuth = true;
        }
      }
    } else {
      const environmentLabel = detectEnvironmentSource(def, loginShellEnv);
      const source: ProviderAuthStatus["source"] = environmentLabel ? "environment" : "none";
      result.push({
        key: def.key,
        displayName: def.displayName,
        source,
        envVar: def.envVar,
        environmentLabel,
        supportsOAuth: def.supportsOAuth,
      });
    }
  }

  return result;
}

// ── Write auth.json (atomic, locked) ────────────────────────────────────

// ── Public mutations ─────────────────────────────────────────────────────

async function mutateAuth(mutator: (auth: Record<string, AuthCredential>) => void): Promise<void> {
  const authPath = getAuthPath();
  const authDir = getAuthDir();
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true, mode: 0o755 });
  await lock(authPath, {
    lockfilePath: `${authPath}.lock`,
    realpath: false,
    retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
  });
  try {
    const auth = readAuth(); // read INSIDE the lock
    mutator(auth);
    const tmpPath = `${authPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2), "utf8");
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, authPath);
  } finally {
    await unlock(authPath, { lockfilePath: `${authPath}.lock`, realpath: false }).catch(() => {});
  }
}

function isValidProviderName(provider: string): boolean {
  const forbidden = new Set(["__proto__", "constructor", "prototype"]);
  return provider.trim().length > 0 && !forbidden.has(provider.trim());
}

export async function saveApiKey(
  provider: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidProviderName(provider)) {
    return { ok: false, error: "Invalid provider name" };
  }
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return { ok: false, error: "API key cannot be empty" };
  }
  try {
    await mutateAuth((a) => {
      a[provider] = { type: "api_key", key: trimmedKey };
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function removeProvider(
  provider: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidProviderName(provider)) {
    return { ok: false, error: "Invalid provider name" };
  }
  try {
    await mutateAuth((a) => {
      delete a[provider];
    });
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
export function startAuthWatch(
  onChange: AuthChangeCallback,
  getPiEnv: () => Record<string, string> | undefined = () => undefined,
): void {
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
        const providers = await getAuthStatus(getPiEnv());
        if (signal.aborted) return;
        onChange(providers);
      }, 150);
    });

    signal.addEventListener("abort", () => {
      watcher.close();
    });

    watcher.on("error", () => {
      // fs.watch can emit transient FS errors; ignore rather than crash.
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

export async function getAuthStatus(
  piEnv?: Record<string, string> | undefined,
): Promise<ProviderAuthStatus[]> {
  const auth = readAuth();
  const loginShellEnv = await getLoginShellEnv();
  return listAuthStatus(auth, mergeAuthEnvironment(loginShellEnv, piEnv));
}

/** Publish a fresh auth projection after a committed Settings patch changes
 * piEnv. Kept here as a directly testable seam so IPC cannot accidentally
 * refresh from the pre-commit environment or forget removals represented by an
 * empty object. */
export async function publishAuthStatusForSettingsUpdate(
  updates: object,
  committedPiEnv: Record<string, string> | undefined,
  onChange: AuthChangeCallback,
  readStatus: typeof getAuthStatus = getAuthStatus,
): Promise<boolean> {
  if (!Object.prototype.hasOwnProperty.call(updates, "piEnv")) return false;
  onChange(await readStatus(committedPiEnv));
  return true;
}
