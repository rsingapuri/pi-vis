import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGED_PI_PACKAGES,
  REMOVED_PI_PACKAGES,
  packagedPaths,
  verifyPackagedCodemode,
  verifyPackagedElectronVersion,
  verifyPackagedPiBundleCli,
  verifyPackagedPiSecurityClosure,
} from "../scripts/verify-packaged-pty.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

function writePackage(directory: string, manifest: object): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
}

function packagedPiFixture({
  braceExpansionVersion = "5.0.12",
  layout = "hoisted",
  hoistedBraceExpansionVersion,
}: {
  braceExpansionVersion?: string;
  layout?: "ancestor" | "hoisted" | "nested";
  hoistedBraceExpansionVersion?: string;
} = {}): { appBundle: string; modulesRoot: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-packaged-pi-security-"));
  roots.push(root);
  const appBundle = path.join(root, "Pi-Vis.app");
  const paths = packagedPaths(appBundle);
  const piPackageDirectory = paths.piPackageDirectory;
  const modules = paths.modulesRoot;
  writePackage(piPackageDirectory, {
    name: "@earendil-works/pi-coding-agent",
    version: "1.0.0",
    dependencies: { minimatch: "10.2.6" },
  });
  const dependencyModules =
    layout === "nested"
      ? path.join(piPackageDirectory, "node_modules")
      : layout === "ancestor"
        ? path.join(root, "node_modules")
        : modules;
  writePackage(path.join(dependencyModules, "minimatch"), {
    name: "minimatch",
    version: "10.2.6",
    dependencies: { "brace-expansion": "^5.0.8" },
  });
  writePackage(path.join(dependencyModules, "brace-expansion"), {
    name: "brace-expansion",
    version: braceExpansionVersion,
  });
  if (hoistedBraceExpansionVersion) {
    writePackage(path.join(modules, "brace-expansion"), {
      name: "brace-expansion",
      version: hoistedBraceExpansionVersion,
    });
  }
  return { appBundle, modulesRoot: modules, root };
}

function packagedElectronFixture(lockedVersion: string, packagedVersion = lockedVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-packaged-electron-security-"));
  roots.push(root);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(project, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/electron": { version: lockedVersion } } }),
  );
  const appBundle = path.join(root, "Pi-Vis.app");
  const infoPath = packagedPaths(appBundle).electronFrameworkInfo;
  fs.mkdirSync(path.dirname(infoPath), { recursive: true });
  fs.writeFileSync(
    infoPath,
    `<?xml version="1.0"?><plist><dict><key>CFBundleVersion</key><string>${packagedVersion}</string></dict></plist>`,
  );
  return { appBundle, project };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("packaged Pi runtime paths", () => {
  it("enumerates the @earendil-works root rather than the unrelated native-package scope", () => {
    const appBundle = path.join(path.sep, "Applications", "Pi-Vis.app");
    const paths = packagedPaths(appBundle);
    const modules = path.join(
      appBundle,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
    );

    expect(paths.resourcesRoot).toBe(path.join(appBundle, "Contents", "Resources"));
    expect(paths.piPackagesRoot).toBe(path.join(modules, "@earendil-works"));
    expect(paths.modulesRoot).toBe(modules);
    expect(paths.packageDirectory).toBe(
      path.join(modules, "@homebridge", "node-pty-prebuilt-multiarch"),
    );
    expect(Object.keys(paths.piPackageDirectories)).toEqual(PACKAGED_PI_PACKAGES);
    expect(paths.piPackageDirectories["pi-coding-agent"]).toBe(
      path.join(paths.piPackagesRoot, "pi-coding-agent"),
    );
    expect(paths.piPackageDirectory).toBe(paths.piPackageDirectories["pi-coding-agent"]);
    expect(paths.piBundleCli).toBe(
      path.join(paths.piPackageDirectories["pi-coding-agent"], "dist", "bundle", "cli.js"),
    );
    expect(paths.piCodemodeEntry).toBe(
      path.join(paths.piPackageDirectories["pi-codemode"], "dist", "index.js"),
    );
    expect(paths.electronFrameworkInfo).toBe(
      path.join(
        appBundle,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Versions",
        "A",
        "Resources",
        "Info.plist",
      ),
    );
    expect(paths.quickJsWasm).toBe(path.join(modules, "quickjs-wasi", "quickjs.wasm"));
    expect(paths.quickJsExtensions).toHaveLength(5);
    expect(REMOVED_PI_PACKAGES).toEqual(["pi-client", "pi-protocol"]);
  });

  it("executes the published bundled CLI and requires its exact version", () => {
    const bundledCli = path.join(
      projectRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );

    expect(verifyPackagedPiBundleCli(bundledCli)).toBe("1.0.0");
    expect(() =>
      verifyPackagedPiBundleCli(path.join(projectRoot, "does-not-exist", "bundle", "cli.js")),
    ).toThrow("Packaged Pi bundled CLI failed to start");
  });

  it("executes the codemode worker and QuickJS WASM from the installed runtime", async () => {
    const codemodeEntry = path.join(
      projectRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@earendil-works",
      "pi-codemode",
      "dist",
      "index.js",
    );

    await expect(verifyPackagedCodemode(codemodeEntry)).resolves.toBe(42);
  });

  it("requires the safe brace-expansion through the packaged, re-hoisted minimatch path", () => {
    const safe = packagedPiFixture();
    expect(verifyPackagedPiSecurityClosure(safe.appBundle)).toMatchObject({
      minimatchVersion: "10.2.6",
      braceExpansionVersion: "5.0.12",
    });

    const stale = packagedPiFixture({ braceExpansionVersion: "5.0.9" });
    expect(() => verifyPackagedPiSecurityClosure(stale.appBundle)).toThrow(
      'Pi/minimatch-resolved brace-expansion version must be "5.0.12"',
    );
  });

  it("follows nested packaged dependencies before a misleading safe hoist", () => {
    const safeNested = packagedPiFixture({ layout: "nested" });
    expect(verifyPackagedPiSecurityClosure(safeNested.appBundle)).toMatchObject({
      minimatchVersion: "10.2.6",
      braceExpansionVersion: "5.0.12",
    });

    const staleNested = packagedPiFixture({
      braceExpansionVersion: "5.0.9",
      layout: "nested",
      hoistedBraceExpansionVersion: "5.0.12",
    });
    expect(() => verifyPackagedPiSecurityClosure(staleNested.appBundle)).toThrow(
      'Pi/minimatch-resolved brace-expansion version must be "5.0.12"',
    );
  });

  it("rejects resolution that walks out of a damaged artifact into an outer node_modules", () => {
    const escaped = packagedPiFixture({ layout: "ancestor" });

    expect(() => verifyPackagedPiSecurityClosure(escaped.appBundle)).toThrow(
      "Pi-resolved minimatch manifest escapes the allowed modules root",
    );
  });

  it("rejects a dependency symlink that escapes the packaged modules root", () => {
    const escaped = packagedPiFixture();
    const packagedBrace = path.join(escaped.modulesRoot, "brace-expansion");
    fs.rmSync(packagedBrace, { recursive: true });
    const externalBrace = path.join(escaped.root, "external", "brace-expansion");
    writePackage(externalBrace, { name: "brace-expansion", version: "5.0.12" });
    fs.symlinkSync(externalBrace, packagedBrace, "dir");

    expect(() => verifyPackagedPiSecurityClosure(escaped.appBundle)).toThrow(
      "Pi/minimatch-resolved brace-expansion manifest escapes the allowed modules root",
    );
  });

  it("rejects a packaged modules root symlinked outside the app bundle", () => {
    const escaped = packagedPiFixture();
    const externalModules = path.join(escaped.root, "external-node_modules");
    fs.renameSync(escaped.modulesRoot, externalModules);
    fs.symlinkSync(externalModules, escaped.modulesRoot, "dir");

    expect(() => verifyPackagedPiSecurityClosure(escaped.appBundle)).toThrow(
      "Packaged modules root escapes the packaged Resources root",
    );
  });

  it("rejects a packaged modules root symlinked into another in-bundle directory", () => {
    const escaped = packagedPiFixture();
    const frameworkModules = path.join(
      escaped.appBundle,
      "Contents",
      "Frameworks",
      "external-node_modules",
    );
    fs.mkdirSync(path.dirname(frameworkModules), { recursive: true });
    fs.renameSync(escaped.modulesRoot, frameworkModules);
    fs.symlinkSync(frameworkModules, escaped.modulesRoot, "dir");

    expect(() => verifyPackagedPiSecurityClosure(escaped.appBundle)).toThrow(
      "Packaged modules root escapes the packaged Resources root",
    );
  });

  it("rejects relocation of packaged modules elsewhere inside Resources", () => {
    const escaped = packagedPiFixture();
    const relocatedModules = path.join(
      packagedPaths(escaped.appBundle).resourcesRoot,
      "RelocatedModules",
    );
    fs.renameSync(escaped.modulesRoot, relocatedModules);
    fs.symlinkSync(relocatedModules, escaped.modulesRoot, "dir");

    expect(() => verifyPackagedPiSecurityClosure(escaped.appBundle)).toThrow(
      "Packaged modules root escapes the packaged Resources root or relocates",
    );
  });

  it("rejects relocation of the packaged Resources root through an in-bundle symlink", () => {
    const escaped = packagedPiFixture();
    const resourcesRoot = packagedPaths(escaped.appBundle).resourcesRoot;
    const relocatedResources = path.join(
      escaped.appBundle,
      "Contents",
      "Frameworks",
      "RelocatedResources",
    );
    fs.mkdirSync(path.dirname(relocatedResources), { recursive: true });
    fs.renameSync(resourcesRoot, relocatedResources);
    fs.symlinkSync(relocatedResources, resourcesRoot, "dir");

    expect(() => verifyPackagedPiSecurityClosure(escaped.appBundle)).toThrow(
      "Packaged Resources root escapes or relocates",
    );
  });

  it("requires the packaged Electron framework to match a safe exact lock version", () => {
    const safe = packagedElectronFixture("43.5.0");
    expect(verifyPackagedElectronVersion(safe.appBundle, { root: safe.project })).toBe("43.5.0");

    const vulnerable = packagedElectronFixture("43.4.9");
    expect(() =>
      verifyPackagedElectronVersion(vulnerable.appBundle, { root: vulnerable.project }),
    ).toThrow("below the minimum safe 43.5.0");

    const mismatched = packagedElectronFixture("43.5.0", "43.5.1");
    expect(() =>
      verifyPackagedElectronVersion(mismatched.appBundle, { root: mismatched.project }),
    ).toThrow("Packaged Electron 43.5.1 does not match locked Electron 43.5.0");
  });
});
