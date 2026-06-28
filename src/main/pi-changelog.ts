/**
 * /changelog — read pi's shipped CHANGELOG.md from the located pi
 * installation and return the raw markdown.
 *
 * Mirrors pi's TUI `handleChangelogCommand()` (interactive-mode.js:4498),
 * which reads `getChangelogPath()` = `resolve(join(getPackageDir(),
 * "CHANGELOG.md"))` and renders the parsed entries as markdown. pi's
 * `getChangelogPath` / `parseChangelog` / `getPackageDir` are NOT public
 * exports, so we compute the package dir ourselves from the located pi
 * binary (the directory containing the pi binary's package — CHANGELOG.md
 * sits at the package root next to dist/).
 *
 * The renderer renders the raw markdown as a custom_message block (the
 * closest analog to pi's in-TUI changelog rendering); we do NOT replicate
 * `parseChangelog`'s entry-splitting because the renderer already has a
 * full markdown renderer (markdown.tsx) used for assistant messages.
 */

import { realpathSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";

export interface ChangelogResult {
  ok: true;
  markdown: string;
}

export interface ChangelogError {
  ok: false;
  error: string;
}

/**
 * Resolve the pi package dir from the located pi binary path.
 *
 * Mirrors pi's getPackageDir (config.js): walk up from the binary's real
 * location until we find a package.json, so this is robust to layout changes
 * (e.g. a renamed entry file). Honors the `PI_PACKAGE_DIR` env override
 * (mirrors pi's own getPackageDir) so Nix/Guix store-path installs work too.
 */
function resolvePiPackageDir(piPath: string): string {
  const envDir = process.env["PI_PACKAGE_DIR"];
  if (envDir) return envDir;
  let dir = realpathSync(piPath);
  // The binary may itself be at the package root (rare) — check first.
  for (let cur = dir; cur !== path.dirname(cur); cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, "package.json"))) return cur;
    dir = cur;
  }
  // Fallback (shouldn't happen): grandparent of the resolved binary.
  return path.dirname(path.dirname(dir));
}

/**
 * Read pi's CHANGELOG.md. Returns the raw markdown on success, or an error
 * string suitable for toasting.
 */
export function readPiChangelog(piPath: string): ChangelogResult | ChangelogError {
  try {
    const pkgDir = resolvePiPackageDir(piPath);
    const changelogPath = path.join(pkgDir, "CHANGELOG.md");
    if (!fs.existsSync(changelogPath)) {
      return { ok: false, error: `CHANGELOG.md not found at ${changelogPath}` };
    }
    const markdown = fs.readFileSync(changelogPath, "utf8");
    return { ok: true, markdown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
