/**
 * Pinned pi runtime resolution.
 *
 * Pi-Vis bundles an exact pi version (`@earendil-works/pi-coding-agent` in
 * package.json dependencies) instead of detecting a pi binary on the user's
 * machine. Upstream ships breaking SDK changes in patch releases, so every
 * subprocess (SDK host, pty terminals, changelog reads) runs against the
 * audited pin rather than whatever `pi` happens to be on PATH.
 *
 * `overridePath` is a TEST-ONLY seam (settings.piBinaryPath, never exposed in
 * the UI): e2e fixtures point it at fake-pi scripts or the dev-dependency pi.
 * If the override doesn't exist on disk, resolution falls back to the bundle.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PI_PACKAGE_SEGMENTS = ["node_modules", "@earendil-works", "pi-coding-agent"] as const;

// The bundled package must live on the real filesystem — the SDK host is
// forked (possibly under system Node) and pty spawns cli.js directly, neither
// of which can read inside app.asar — so electron-builder.yml asarUnpacks
// node_modules/@earendil-works/**. Electron's patched fs makes existsSync
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

let cached: { path: string; version: string } | null = null;

/**
 * Resolve the pinned pi runtime. Returns the bundled cli.js path and its
 * package.json version, or null only if the bundle is missing/corrupt (a
 * packaging error — callers surface it as an activation failure).
 */
export function getPinnedPi(
  overridePath?: string | null,
): { path: string; version: string } | null {
  if (overridePath && existsSync(overridePath)) {
    return { path: overridePath, version: "test-override" };
  }
  if (cached) return cached;

  const pkgDir = resolvePiPackageDir();
  const cliPath = path.join(pkgDir, "dist", "cli.js");
  if (!existsSync(cliPath)) return null;

  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // version stays "unknown"; the runtime itself is still usable
  }
  cached = { path: cliPath, version };
  return cached;
}
