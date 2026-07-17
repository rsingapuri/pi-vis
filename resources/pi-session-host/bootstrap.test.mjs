import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiDependency } from "./bootstrap.mjs";

/**
 * resolvePiDependency must find pi's deps in BOTH real-world layouts:
 *  - nested: pi-coding-agent/node_modules/<dep> (npm global/dev install,
 *    produced by pi's npm-shrinkwrap), and
 *  - hoisted: an ancestor node_modules/<dep> (electron-builder flattens the
 *    shrinkwrapped tree to the app's top-level node_modules at package time).
 * The nested-only version of this function broke every SDK-host start in the
 * packaged app (`npm run dist`) while `npm run dev` kept working.
 */
describe("resolvePiDependency", () => {
  let tmp;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function makePiInstall({ nestedDeps, hoistedDeps }) {
    // realpath: resolvePiDependency canonicalizes via realpathSync(piPath),
    // and macOS tmpdirs live behind the /var → /private/var symlink.
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pivis-bootstrap-")));
    const pkgDir = path.join(tmp, "node_modules", "@earendil-works", "pi-coding-agent");
    const cli = path.join(pkgDir, "dist", "cli.js");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, "// fake pi cli\n");
    for (const dep of nestedDeps) {
      const depFile = path.join(pkgDir, "node_modules", dep);
      mkdirSync(path.dirname(depFile), { recursive: true });
      writeFileSync(depFile, "// dep\n");
    }
    for (const dep of hoistedDeps) {
      const depFile = path.join(tmp, "node_modules", dep);
      mkdirSync(path.dirname(depFile), { recursive: true });
      writeFileSync(depFile, "// dep\n");
    }
    return { cli, pkgDir };
  }

  it("prefers the nested install (npm global/dev layout)", () => {
    const dep = path.join("@earendil-works", "pi-tui", "dist", "index.js");
    const { cli, pkgDir } = makePiInstall({ nestedDeps: [dep], hoistedDeps: [dep] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(pkgDir, "node_modules", dep));
  });

  it("falls back to a hoisted ancestor node_modules (packaged-app layout)", () => {
    const dep = path.join("undici", "index.js");
    const { cli } = makePiInstall({ nestedDeps: [], hoistedDeps: [dep] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(tmp, "node_modules", dep));
  });

  it("returns the nested path when the dep exists nowhere, so errors name the miss", () => {
    const dep = path.join("undici", "index.js");
    const { cli, pkgDir } = makePiInstall({ nestedDeps: [], hoistedDeps: [] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(pkgDir, "node_modules", dep));
  });
});
