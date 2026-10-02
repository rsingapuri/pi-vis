/**
 * Pinned pi runtime resolution.
 *
 * Pi-Vis bundles an exact pi version (`@earendil-works/pi-coding-agent` in
 * package.json dependencies) instead of detecting a pi binary on the user's
 * machine. Upstream ships breaking SDK changes in patch releases, so every
 * subprocess (SDK host, PTY terminals, changelog reads) runs against the
 * audited pin rather than whatever `pi` happens to be on PATH. The package's
 * bundled bin and modular SDK anchor are verified separately below.
 *
 * `overridePath` is a TEST-ONLY seam (settings.piBinaryPath, never exposed in
 * the UI). It is honored only when the E2E launcher sets the explicit test
 * activation environment variable below; stale or hand-edited production
 * settings can therefore never bypass the audited bundle.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PI_PACKAGE_SEGMENTS = ["node_modules", "@earendil-works", "pi-coding-agent"] as const;
export const PINNED_PI_VERSION = "0.99.2";
export const TEST_PI_BINARY_OVERRIDE_ENV = "PIVIS_TEST_ALLOW_PI_BINARY_OVERRIDE";

// The bundled package must live on the real filesystem — the SDK host is
// forked (possibly under system Node) and PTY spawns the bundled CLI directly,
// neither of which can read inside app.asar — so electron-builder.yml unpacks
// node_modules. Electron's patched fs makes existsSync
// succeed for paths INSIDE app.asar, so any asar hit from the walk below must
// be remapped to its app.asar.unpacked mirror before children consume it.
function toUnpackedPath(p: string): string {
  return p.includes(`app.asar${path.sep}`)
    ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    : p;
}

function resolvePiPackageDir(): string {
  // Walk up from this module (app.asar/out/main in production, out/main in a
  // dev build, src/main/pi under vitest) to the nearest node_modules holding
  // the package. In production the hit is inside app.asar (visible through
  // Electron's patched fs) and is remapped to the unpacked mirror.
  let dir = __dirname;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, ...PI_PACKAGE_SEGMENTS);
    if (existsSync(candidate)) return toUnpackedPath(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  let asarRoot: string;
  try {
    // Lazily import Electron's app — only available in the main process.
    const { app } = require("electron");
    asarRoot = app.getAppPath();
  } catch {
    asarRoot = path.join(__dirname, "..", "..");
  }
  return path.join(toUnpackedPath(path.join(asarRoot, path.sep)), ...PI_PACKAGE_SEGMENTS);
}

export interface PinnedPiRuntime {
  /** Modular entry anchor consumed by the SDK host to derive dist/index.js. */
  path: string;
  /** Upstream package bin consumed by interactive PTY/update subprocesses. */
  cliPath: string;
  version: string;
}

let cached: PinnedPiRuntime | null = null;

/**
 * Resolve the pinned pi runtime. Returns the modular SDK anchor, published CLI
 * bundle, and package version, or null only if one is missing/corrupt (a
 * packaging error — callers surface it as an activation failure).
 */
export function getPinnedPi(overridePath?: string | null): PinnedPiRuntime | null {
  if (
    process.env[TEST_PI_BINARY_OVERRIDE_ENV] === "1" &&
    overridePath &&
    existsSync(overridePath)
  ) {
    return { path: overridePath, cliPath: overridePath, version: "test-override" };
  }
  if (cached) return cached;

  const pkgDir = resolvePiPackageDir();
  const hostEntryPath = path.join(pkgDir, "dist", "cli.js");
  if (!existsSync(hostEntryPath)) return null;

  let version: unknown;
  let binPath: unknown;
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    version = pkg.version;
    binPath = pkg.bin?.pi;
  } catch {
    return null;
  }
  // The SDK host and typed compatibility layer are audited against one exact
  // Pi release. A stale/corrupt packaged dependency is a broken installation,
  // not a runtime we can safely launch. The explicit override above remains a
  // test-only seam for fake-host and fault-injection journeys.
  if (version !== PINNED_PI_VERSION || binPath !== "dist/bundle/cli.js") return null;
  const cliPath = path.join(pkgDir, binPath);
  if (!existsSync(cliPath)) return null;
  cached = { path: hostEntryPath, cliPath, version: PINNED_PI_VERSION };
  return cached;
}
