import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyInstalledPiSecurityClosure,
  verifyResolvedPiBraceExpansion,
} from "../scripts/verify-pi-security-closure.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];
type MutableLock = {
  packages: Record<
    string,
    {
      dependencies?: Record<string, string>;
      dev?: boolean;
      hasShrinkwrap?: boolean;
      integrity?: string;
      optional?: boolean;
      resolved?: string;
      version?: string;
    }
  >;
};

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file: string): MutableLock {
  return JSON.parse(fs.readFileSync(file, "utf8")) as MutableLock;
}

function securityClosureFixture({ braceVersion = "5.0.12" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-pi-security-"));
  roots.push(root);
  fs.copyFileSync(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"));
  fs.copyFileSync(
    path.join(repositoryRoot, "package-lock.json"),
    path.join(root, "package-lock.json"),
  );

  const sourcePi = path.join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const piPackageDirectory = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(piPackageDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(sourcePi, "package.json"),
    path.join(piPackageDirectory, "package.json"),
  );
  fs.copyFileSync(
    path.join(sourcePi, "npm-shrinkwrap.json"),
    path.join(piPackageDirectory, "npm-shrinkwrap.json"),
  );
  writeJson(path.join(piPackageDirectory, "node_modules", "minimatch", "package.json"), {
    name: "minimatch",
    version: "10.2.6",
    dependencies: { "brace-expansion": "^5.0.8" },
  });
  writeJson(path.join(piPackageDirectory, "node_modules", "brace-expansion", "package.json"), {
    name: "brace-expansion",
    version: braceVersion,
  });

  return { root, projectRoot: root, piPackageDirectory };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi production security closure", () => {
  it("accepts the official Pi bytes with the audited safe hoisted lock resolution", () => {
    const fixture = securityClosureFixture();

    expect(verifyInstalledPiSecurityClosure(fixture)).toMatchObject({
      piPackageDirectory: fixture.piPackageDirectory,
      minimatchVersion: "10.2.6",
      braceExpansionVersion: "5.0.12",
    });
  });

  it("also accepts the equivalent safe nested npm lock layout", () => {
    const fixture = securityClosureFixture();
    const lockPath = path.join(fixture.root, "package-lock.json");
    const lock = readJson(lockPath);
    lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch"] =
      lock.packages["node_modules/minimatch"];
    lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"] =
      lock.packages["node_modules/brace-expansion"];
    delete lock.packages["node_modules/minimatch"];
    delete lock.packages["node_modules/brace-expansion"];
    writeJson(lockPath, lock);

    expect(verifyInstalledPiSecurityClosure(fixture)).toMatchObject({
      minimatchVersion: "10.2.6",
      braceExpansionVersion: "5.0.12",
    });
  });

  it("rejects npm shrinkwrap inflation even when the root lock advertises the safe version", () => {
    const fixture = securityClosureFixture();
    const lockPath = path.join(fixture.root, "package-lock.json");
    const lock = readJson(lockPath);
    lock.packages["node_modules/@earendil-works/pi-coding-agent"].hasShrinkwrap = true;
    writeJson(lockPath, lock);

    expect(() => verifyInstalledPiSecurityClosure(fixture)).toThrow(
      "must omit hasShrinkwrap so the audited root lock remains authoritative",
    );
  });

  it("rejects a repacked Pi tarball and a changed embedded vulnerable baseline", () => {
    const repacked = securityClosureFixture();
    const lockPath = path.join(repacked.root, "package-lock.json");
    const lock = readJson(lockPath);
    lock.packages["node_modules/@earendil-works/pi-coding-agent"].integrity =
      "sha512-not-the-official-package";
    writeJson(lockPath, lock);
    expect(() => verifyInstalledPiSecurityClosure(repacked)).toThrow(
      "Locked @earendil-works/pi-coding-agent integrity",
    );

    const changedShrinkwrap = securityClosureFixture();
    const shrinkwrapPath = path.join(changedShrinkwrap.piPackageDirectory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson(shrinkwrapPath);
    shrinkwrap.packages["node_modules/brace-expansion"].version = "5.0.12";
    writeJson(shrinkwrapPath, shrinkwrap);
    expect(() => verifyInstalledPiSecurityClosure(changedShrinkwrap)).toThrow(
      'Published Pi brace-expansion version must be "5.0.9"',
    );
  });

  it("rejects a stale actual package even when both manifest and lock claim the safe closure", () => {
    const fixture = securityClosureFixture({ braceVersion: "5.0.9" });

    expect(() => verifyInstalledPiSecurityClosure(fixture)).toThrow(
      'Pi/minimatch-resolved brace-expansion version must be "5.0.12"',
    );
  });

  it("rejects an unsafe nested lock resolution hidden by safe hoisted entries", () => {
    const fixture = securityClosureFixture();
    const lockPath = path.join(fixture.root, "package-lock.json");
    const lock = readJson(lockPath);
    lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch"] = {
      ...lock.packages["node_modules/minimatch"],
    };
    lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"] = {
      ...lock.packages["node_modules/brace-expansion"],
      version: "5.0.9",
      resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
      integrity:
        "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
    };
    writeJson(lockPath, lock);

    expect(() => verifyInstalledPiSecurityClosure(fixture)).toThrow(
      'Locked Pi brace-expansion version must be "5.0.12"',
    );
  });

  it("rejects a safe-version hoist that is not production-reachable", () => {
    const fixture = securityClosureFixture();
    const lockPath = path.join(fixture.root, "package-lock.json");
    const lock = readJson(lockPath);
    lock.packages["node_modules/brace-expansion"].dev = true;
    writeJson(lockPath, lock);

    expect(() => verifyInstalledPiSecurityClosure(fixture)).toThrow(
      "Locked Pi brace-expansion must remain reachable as a required production dependency",
    );
  });

  it("resolves brace-expansion from minimatch rather than trusting a misleading Pi sibling", () => {
    const fixture = securityClosureFixture();
    writeJson(
      path.join(
        fixture.piPackageDirectory,
        "node_modules",
        "minimatch",
        "node_modules",
        "brace-expansion",
        "package.json",
      ),
      { name: "brace-expansion", version: "5.0.9" },
    );

    expect(() =>
      verifyResolvedPiBraceExpansion({ piPackageDirectory: fixture.piPackageDirectory }),
    ).toThrow("An allowed modules root is required");

    expect(() =>
      verifyResolvedPiBraceExpansion({
        piPackageDirectory: fixture.piPackageDirectory,
        allowedModulesRoot: path.join(fixture.root, "node_modules"),
      }),
    ).toThrow('Pi/minimatch-resolved brace-expansion version must be "5.0.12"');
  });
});
