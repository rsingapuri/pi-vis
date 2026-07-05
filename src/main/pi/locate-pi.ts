import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSubprocessEnv } from "../auth.js";

const execFileAsync = promisify(execFile);

let cached: { key: string; path: string; version: string } | null = null;

async function runCommand(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function locatePi(
  overridePath?: string | null,
): Promise<{ path: string; version: string } | null> {
  const cacheKey = overridePath ?? "__auto__";
  if (cached && cached.key === cacheKey) {
    return { path: cached.path, version: cached.version };
  }
  const candidates: string[] = [];

  if (overridePath) {
    candidates.push(overridePath);
  }

  // macOS GUI apps don't inherit shell PATH — use login shell to resolve.
  // execFile avoids interpolating SHELL through a shell (environment values can
  // contain spaces/metacharacters and must never become shell syntax).
  const shell = process.env.SHELL || "/bin/bash";
  const shellPath = await runCommand(shell, ["-ilc", "command -v pi"]);
  if (shellPath) candidates.push(shellPath);

  const whichPath = await runCommand("which", ["pi"]);
  if (whichPath) candidates.push(whichPath);

  if (candidates.length === 0) return null;

  // GUI-launched apps (Finder/Dock) have a stripped PATH. `pi` is a
  // `#!/usr/bin/env node` script, so validating it with `--version` needs
  // `node` on PATH — use the login-shell env (the same env the rpc / pty /
  // update subprocesses run with). Without this, pi is wrongly reported
  // "not found" on every non-terminal launch.
  const validateEnv = await getSubprocessEnv();

  for (const candidate of candidates) {
    try {
      // Use execFile so we never interpolate a path into a shell string.
      // execFile is also the only safe way to pass a path with spaces or
      // shell metacharacters.
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        timeout: 5000,
        env: validateEnv,
      });
      const version = stdout.trim();
      if (version) {
        const successfulKey = overridePath && candidate === overridePath ? cacheKey : "__auto__";
        cached = { key: successfulKey, path: candidate, version };
        return { path: candidate, version };
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

export function clearPiLocationCache(): void {
  cached = null;
}
