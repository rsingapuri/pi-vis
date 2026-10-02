#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

export function macArtifactPaths(root, version) {
  const releaseDirectory = path.join(root, "release", version);
  return {
    appBundle: path.join(releaseDirectory, "mac-arm64", "Pi-Vis.app"),
    zipArchive: path.join(releaseDirectory, `Pi-Vis-${version}-arm64-mac.zip`),
    dmgArchive: path.join(releaseDirectory, `Pi-Vis-${version}-arm64.dmg`),
  };
}

export function runChecked(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${String(result.status)}${detail ? `:\n${detail}` : "."}`,
    );
  }
  return result;
}

export function verifyCodeSignature(appBundle, run = runChecked) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appBundle]);
}

export function hasCodeSignature(appBundle, spawn = spawnSync) {
  const result = spawn("codesign", ["--display", "--verbose=2", appBundle], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`codesign failed to inspect ${appBundle}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status === 0) return true;
  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (detail.includes("code object is not signed at all")) return false;
  throw new Error(
    `codesign could not inspect ${appBundle} (status ${String(result.status)}): ${detail.trim()}`,
  );
}

export function verifyMacArtifactPortability(
  { appBundle, zipArchive, dmgArchive },
  {
    run = runChecked,
    inspectSignature = hasCodeSignature,
    platform = process.platform,
    requireSigned = false,
    temporaryRoot = os.tmpdir(),
  } = {},
) {
  if (platform !== "darwin") {
    throw new Error("The macOS artifact verifier can only run on macOS.");
  }
  for (const artifact of [appBundle, zipArchive, dmgArchive]) {
    if (!fs.existsSync(artifact)) throw new Error(`Missing macOS release artifact: ${artifact}`);
  }
  if (!inspectSignature(appBundle)) {
    if (requireSigned) {
      throw new Error(`Required signed macOS artifact is unsigned: ${appBundle}`);
    }
    console.log("[mac-artifacts] Skipped signature-transfer checks for an unsigned local build.");
    return { skipped: true };
  }

  const scratch = fs.mkdtempSync(path.join(temporaryRoot, "pivis-mac-artifacts-"));
  const extractedDirectory = path.join(scratch, "zip");
  const mountPoint = path.join(scratch, "dmg");
  const copiedApp = path.join(scratch, "copied", path.basename(appBundle));
  let mounted = false;
  let primaryError;
  try {
    fs.mkdirSync(extractedDirectory);
    fs.mkdirSync(mountPoint);

    verifyCodeSignature(appBundle, run);

    // This is the exact container and extractor path used by install.sh and
    // the updater. It must preserve a valid bundle after leaving the build
    // filesystem, not merely verify while electron-builder still owns it.
    run("unzip", ["-q", zipArchive, "-d", extractedDirectory]);
    verifyCodeSignature(path.join(extractedDirectory, path.basename(appBundle)), run);

    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgArchive]);
    mounted = true;
    const mountedApp = path.join(mountPoint, path.basename(appBundle));
    verifyCodeSignature(mountedApp, run);

    fs.mkdirSync(path.dirname(copiedApp), { recursive: true });
    run("ditto", [mountedApp, copiedApp]);
    verifyCodeSignature(copiedApp, run);
  } catch (error) {
    primaryError = error;
  } finally {
    if (mounted) {
      try {
        run("hdiutil", ["detach", mountPoint]);
        mounted = false;
      } catch (detachError) {
        if (!primaryError) primaryError = detachError;
      }
    }
    if (!mounted) fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (primaryError) throw primaryError;

  console.log(
    "[mac-artifacts] Verified strict code signatures in the exploded app, extracted ZIP, mounted DMG, and copied DMG payload.",
  );
  return { skipped: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  verifyMacArtifactPortability(macArtifactPaths(projectRoot, manifest.version), {
    requireSigned: process.env.PIVIS_REQUIRE_SIGNED_ARTIFACTS === "1",
  });
}
