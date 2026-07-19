import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionUpdate } from "@shared/extension-updates.js";

const execFileAsync = promisify(execFile);
const VERSION_CHECK_TIMEOUT_MS = 30_000;
const VERSION_CHECK_MAX_BUFFER = 1024 * 1024;

type NpmSource = {
  spec: string;
  name: string;
  hasVersion: boolean;
};

type ExtensionSource = { type: "npm"; npm: NpmSource } | { type: "git" };

interface NpmCommandProvider {
  getNpmCommand(): string[] | undefined;
}

function parseNpmSource(source: string): NpmSource | null {
  if (!source.startsWith("npm:")) return null;
  const spec = source.slice("npm:".length).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/u);
  return {
    spec,
    name: match?.[1] ?? spec,
    hasVersion: Boolean(match?.[2]),
  };
}

function classifySource(source: string): ExtensionSource | null {
  const npm = parseNpmSource(source);
  if (npm) return { type: "npm", npm };
  if (/^(?:git:|git\+|https?:\/\/|ssh:\/\/|git@|github:)/u.test(source)) {
    return { type: "git" };
  }
  return null;
}

function readPackageMetadata(installedPath: string): {
  name?: string | undefined;
  version?: string | undefined;
} {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(installedPath, "package.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const packageJson = parsed as { name?: unknown; version?: unknown };
    return {
      name: typeof packageJson.name === "string" ? packageJson.name : undefined,
      version: typeof packageJson.version === "string" ? packageJson.version : undefined,
    };
  } catch {
    return {};
  }
}

async function captureCommand(file: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd,
      timeout: VERSION_CHECK_TIMEOUT_MS,
      maxBuffer: VERSION_CHECK_MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

function isOffline(): boolean {
  const value = process.env.PI_OFFLINE?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

async function getLatestNpmVersion(
  cwd: string,
  source: NpmSource,
  settingsManager: NpmCommandProvider,
): Promise<string | null> {
  if (isOffline()) return null;
  const command = settingsManager.getNpmCommand() ?? ["npm"];
  const [file, ...prefixArgs] = command;
  if (!file) return null;
  const stdout = await captureCommand(
    file,
    [...prefixArgs, "view", source.hasVersion ? source.spec : source.name, "version", "--json"],
    cwd,
  );
  if (!stdout) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed === "string" && parsed.length > 0) return parsed;
    if (Array.isArray(parsed)) {
      const versions = parsed.filter(
        (version): version is string => typeof version === "string" && version.length > 0,
      );
      return versions.at(-1) ?? null;
    }
  } catch {
    // Registry failures should not make the whole extension catalog fail.
  }
  return null;
}

async function getCurrentGitVersion(installedPath: string): Promise<string | null> {
  const current = await captureCommand("git", ["rev-parse", "--short=7", "HEAD"], installedPath);
  return current?.trim() || null;
}

async function getLatestGitVersion(installedPath: string): Promise<string | null> {
  if (isOffline()) return null;
  const upstream = await captureCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "@{upstream}"],
    installedPath,
  );
  const upstreamName = upstream?.trim();
  const ref = upstreamName?.startsWith("origin/")
    ? `refs/heads/${upstreamName.slice("origin/".length)}`
    : "HEAD";
  const remote = await captureCommand("git", ["ls-remote", "origin", ref], installedPath);
  const hash = remote?.match(/^([0-9a-f]{7,40})\s/mu)?.[1];
  return hash?.slice(0, 7) ?? null;
}

function gitDisplayName(source: string): string {
  return source
    .replace(/^git:/u, "")
    .replace(/^(?:git\+ssh|git\+https?):\/\//u, "")
    .replace(/^(?:https?|ssh):\/\//u, "")
    .replace(/\.git$/u, "");
}

/**
 * Check user-scoped packages through pi's public package-manager API, then
 * enrich the result with the installed and latest versions. The package
 * manager's update API intentionally returns only out-of-date packages, so
 * configured installed packages are used as the catalog source instead.
 *
 * The package is loaded with native dynamic import so the CJS Electron main
 * bundle/worker can consume pi's import-only package root.
 */
export async function checkUserExtensionUpdates(
  cwd: string,
  agentDir?: string,
): Promise<ExtensionUpdate[]> {
  const { DefaultPackageManager, SettingsManager, getAgentDir } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const resolvedAgentDir = agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(cwd, resolvedAgentDir, {
    projectTrusted: false,
  });
  const globalSettingsError = settingsManager.drainErrors().find(({ scope }) => scope === "global");
  if (globalSettingsError) throw globalSettingsError.error;

  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir: resolvedAgentDir,
    settingsManager,
  });
  const available = await packageManager.checkForAvailableUpdates();
  const availableBySource = new Map(
    available.filter((update) => update.scope === "user").map((update) => [update.source, update]),
  );

  const configured = packageManager
    .listConfiguredPackages()
    .filter(
      (pkg) => pkg.scope === "user" && typeof pkg.installedPath === "string" && pkg.installedPath,
    );

  const extensions = await Promise.all(
    configured.map(async (pkg): Promise<ExtensionUpdate | null> => {
      const sourceInfo = classifySource(pkg.source);
      if (!sourceInfo || !pkg.installedPath) return null;

      const metadata = readPackageMetadata(pkg.installedPath);
      const availableUpdate = availableBySource.get(pkg.source);
      const type = availableUpdate?.type ?? sourceInfo.type;
      const displayName =
        availableUpdate?.displayName ??
        (sourceInfo.type === "npm"
          ? (metadata.name ?? sourceInfo.npm.name)
          : gitDisplayName(pkg.source));
      const currentVersion =
        sourceInfo.type === "npm"
          ? (metadata.version ?? null)
          : await getCurrentGitVersion(pkg.installedPath);
      const latestVersion =
        sourceInfo.type === "npm"
          ? await getLatestNpmVersion(cwd, sourceInfo.npm, settingsManager)
          : await getLatestGitVersion(pkg.installedPath);
      // Keep pi's package-manager semantics authoritative here: pinned
      // npm versions and pinned git refs are intentionally not update targets.
      const updateAvailable = Boolean(availableUpdate);

      return {
        source: pkg.source,
        displayName,
        type,
        scope: "user" as const,
        currentVersion,
        latestVersion,
        updateAvailable,
      };
    }),
  );

  return extensions.filter((extension): extension is ExtensionUpdate => extension !== null);
}
