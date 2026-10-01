#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { patchNodePty } from "./patch-node-pty.mjs";

const require = createRequire(import.meta.url);

export function resolveInstalledElectronDirectory() {
  let manifestPath;
  try {
    manifestPath = require.resolve("electron/package.json");
  } catch (error) {
    throw new Error("Cannot resolve Electron; run npm ci before building.", { cause: error });
  }
  return path.dirname(manifestPath);
}

function readElectronManifest(packageDirectory) {
  const manifestPath = path.join(packageDirectory, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Electron manifest at ${manifestPath}.`, { cause: error });
  }
  if (manifest.name !== "electron" || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(
      `Refusing to provision ${manifest.name ?? "unknown package"}@${manifest.version ?? "unknown version"}; expected Electron.`,
    );
  }
  return manifest;
}

export function verifyElectronInstallation({
  packageDirectory = resolveInstalledElectronDirectory(),
  overrideDistPath = process.env.ELECTRON_OVERRIDE_DIST_PATH,
} = {}) {
  const manifest = readElectronManifest(packageDirectory);
  const versionPath = path.join(packageDirectory, "dist", "version");
  const pathFile = path.join(packageDirectory, "path.txt");
  let installedVersion;
  let platformPath;
  try {
    installedVersion = fs.readFileSync(versionPath, "utf8").replace(/^v/, "").trim();
    platformPath = fs.readFileSync(pathFile, "utf8");
  } catch (error) {
    throw new Error(`Electron ${manifest.version} was not installed completely.`, { cause: error });
  }
  if (installedVersion !== manifest.version) {
    throw new Error(
      `Electron binary version ${installedVersion || "unknown"} does not match package ${manifest.version}.`,
    );
  }
  if (!platformPath || platformPath !== platformPath.trim() || path.isAbsolute(platformPath)) {
    throw new Error("Electron path.txt does not contain a safe relative executable path.");
  }

  const binaryRoot = overrideDistPath
    ? path.resolve(overrideDistPath)
    : path.join(packageDirectory, "dist");
  const binaryPath = path.resolve(binaryRoot, platformPath);
  const relativeBinaryPath = path.relative(binaryRoot, binaryPath);
  if (
    !relativeBinaryPath ||
    relativeBinaryPath === ".." ||
    relativeBinaryPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeBinaryPath)
  ) {
    throw new Error("Electron path.txt resolves outside its binary directory.");
  }
  try {
    if (!fs.statSync(binaryPath).isFile()) throw new Error("not a file");
  } catch (error) {
    throw new Error(`Electron executable is missing at ${binaryPath}.`, { cause: error });
  }
  return { packageDirectory, version: manifest.version, binaryPath };
}

function runElectronInstaller({ executable, installScript, env }) {
  return spawnSync(executable, [installScript], { stdio: "inherit", env });
}

export function provisionElectron({
  packageDirectory = resolveInstalledElectronDirectory(),
  executable = process.execPath,
  env = process.env,
  runInstaller = runElectronInstaller,
} = {}) {
  const manifest = readElectronManifest(packageDirectory);
  const installScript = path.join(packageDirectory, "install.js");
  if (!fs.existsSync(installScript)) {
    throw new Error(
      `Electron ${manifest.version} does not contain its installer at ${installScript}.`,
    );
  }

  // Electron 43 has no package install lifecycle and lazily invokes this file
  // from index.js. Run it once here so parallel test workers can only read the
  // completed installation instead of racing two extractions into dist/.
  const result = runInstaller({ executable, installScript, env });
  if (result?.error) {
    throw new Error(`Electron ${manifest.version} installer could not start.`, {
      cause: result.error,
    });
  }
  if (result?.status !== 0) {
    const detail = result?.signal
      ? `signal ${result.signal}`
      : `exit ${result?.status ?? "unknown"}`;
    throw new Error(`Electron ${manifest.version} installer failed (${detail}).`);
  }
  return verifyElectronInstallation({
    packageDirectory,
    overrideDistPath: env.ELECTRON_OVERRIDE_DIST_PATH,
  });
}

export function runPostinstall({
  provisionElectronFn = provisionElectron,
  patchNodePtyFn = patchNodePty,
} = {}) {
  const electron = provisionElectronFn();
  // Preserve the exact-version/source fail-closed native patch after Electron
  // provisioning; a successful Electron download must never mask patch drift.
  const nodePty = patchNodePtyFn();
  return { electron, nodePty };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = runPostinstall();
    console.log(
      `[postinstall] Provisioned Electron ${result.electron.version} at ${result.electron.binaryPath}`,
    );
    console.log(
      `[postinstall] ${result.nodePty.changed ? "Patched" : "Verified"} node-pty at ${result.nodePty.packageDirectory}`,
    );
  } catch (error) {
    console.error(`[postinstall] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
