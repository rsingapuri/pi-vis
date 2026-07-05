import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSubprocessEnv } from "../auth.js";

const execFileAsync = promisify(execFile);

let cached: { path: string; version: string } | null = null;

async function runCommand(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Minimal semver-ish numeric compare for Node version strings ("v22.5.0").
 *
 * Node versions are plain numeric `vMAJOR.MINOR.PATCH`, never pre-releases that
 * matter here, so this intentionally does NOT replicate the pre-release handling
 * of resources/pi-session-host/version.mjs (the host's comparator for pi's
 * version gate, which DOES see pi pre-releases). Kept local + dependency-free
 * rather than importing the host's ESM, so the main bundle doesn't reach across
 * into resources/ for a 4-line compare.
 *
 * @returns -1 if a<b, 1 if a>b, 0 if equal
 */
export function compareNodeVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Resolve the user's system `node` — the same Node that `pi` itself runs under
 * (pi is a `#!/usr/bin/env node` script on the login-shell PATH).
 *
 * Mirrors locate-pi.ts: macOS GUI apps don't inherit shell PATH, so we resolve
 * `node` via the login shell first (`command -v node`), then plain `which`, and
 * validate with `--version` under the login-shell env (getSubprocessEnv).
 *
 * Returns null if no `node` is found or `--version` fails. Cached for the
 * process lifetime (a Node install won't change while the app is open); a null
 * result is NOT cached, matching locate-pi, so a transiently-unresolvable node
 * is retried on the next session activation.
 */
export async function resolveSystemNode(): Promise<{ path: string; version: string } | null> {
  if (cached) return cached;

  const candidates: string[] = [];

  // macOS GUI apps don't inherit shell PATH — use login shell to resolve.
  // execFile avoids interpolating SHELL through a shell (environment values can
  // contain spaces/metacharacters and must never become shell syntax).
  const shell = process.env.SHELL || "/bin/bash";
  const shellPath = await runCommand(shell, ["-ilc", "command -v node"]);
  if (shellPath) candidates.push(shellPath);

  const whichPath = await runCommand("which", ["node"]);
  if (whichPath) candidates.push(whichPath);

  if (candidates.length === 0) return null;

  // Validate under the login-shell env (same rationale as locate-pi: a
  // GUI-launched app has a stripped PATH, and we want the same `node` the
  // login shell would hand to `pi`'s shebang).
  const validateEnv = await getSubprocessEnv();

  for (const candidate of candidates) {
    try {
      // execFile (not exec) so a path with spaces / shell metachars is safe.
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        timeout: 5000,
        env: validateEnv,
      });
      const version = stdout.trim(); // e.g. "v22.19.0"
      if (version) {
        cached = { path: candidate, version };
        return cached;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

export function clearNodeLocationCache(): void {
  cached = null;
}

/**
 * Why the SDK-host subprocess might run under a different (retargeted) Node.
 * Surfaced as a `reason` for diagnostics; the caller logs it once.
 */
export type HostExecDecision =
  /** System Node found and is newer than Electron's bundled Node → use it. */
  | "system-node"
  /** No usable system Node on PATH → stay on Electron's bundled Node. */
  | "electron-node-no-system"
  /** System Node exists but is NOT newer than Electron's → stay on Electron's. */
  | "electron-node-not-newer";

/**
 * Decide which executable should run the SDK-host subprocess.
 *
 * THE PARITY GAP THIS CLOSES:
 *
 * The host is forked from Electron's main process, so by default it runs under
 * Electron's bundled Node (e.g. Electron 31 → Node 20.14). That lags the user's
 * system Node, which breaks pi extensions that rely on newer Node built-ins.
 * The concrete failure: `@cursor/sdk`'s default `SqliteLocalAgentStore` needs
 * `node:sqlite`, a built-in added in Node v22.5.0. In terminal pi the
 * extension works because pi runs under the user's Node (22.5+); the forked
 * host runs under Electron's Node (20.x), where `node:sqlite` doesn't exist.
 *
 * The fix: when the user's system Node is newer than Electron's bundled Node,
 * retarget the host fork onto the system Node so the host sees the same runtime
 * `pi` does. This restores parity not just for `node:sqlite` but for ANY Node
 * feature newer than Electron's bundled version.
 *
 * WHY "STRICTLY NEWER":
 *
 * We retarget ONLY when system Node > Electron's bundled Node:
 *   - newer → switch (this is the case that helps; e.g. 22.x vs 20.14)
 *   - equal → no gain, so keep Electron's (avoids any oddity in the user's
 *     node setup — nvm shims, volta, etc. — for zero benefit)
 *   - older → would be a downgrade, so keep Electron's
 * This makes the switch self-justifying — it only fires when it actually helps
 * — and adapts automatically: if Pi-Vis later ships an Electron whose bundled
 * Node already covers the need (e.g. node:sqlite), the retarget simply stops
 * firing. No floor constant to maintain.
 *
 * Pure + unit-testable; {@link resolveHostExecPath} is the async wrapper.
 */
export function chooseHostExecPath(
  systemNode: { path: string; version: string } | null,
  electronNodeVersion: string,
): { execPath: string | undefined; reason: HostExecDecision } {
  if (!systemNode) {
    return { execPath: undefined, reason: "electron-node-no-system" };
  }
  if (compareNodeVersions(systemNode.version, electronNodeVersion) > 0) {
    return { execPath: systemNode.path, reason: "system-node" };
  }
  return { execPath: undefined, reason: "electron-node-not-newer" };
}

/**
 * Resolve and decide the SDK-host subprocess executable, end to end.
 *
 * Returns `{ execPath: undefined }` to mean "use the default (Electron's bundled
 * Node)" — i.e. today's behavior, the fallback that keeps everything except
 * newer-Node-built-in extensions (like @cursor/sdk's sqlite store) working.
 * Returns `{ execPath: <node path> }` to retarget the host onto the user's Node.
 *
 * Cached transitively via {@link resolveSystemNode} (one login-shell round-trip
 * per app lifetime).
 */
export async function resolveHostExecPath(): Promise<{
  execPath: string | undefined;
  reason: HostExecDecision;
}> {
  const systemNode = await resolveSystemNode();
  const electronNode = process.versions.node; // the Node Electron was built with
  return chooseHostExecPath(systemNode, electronNode);
}
