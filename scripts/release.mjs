#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { configureSigningEnvironment, resolveNotaryProfile } from "./signing-env.mjs";

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const dryRun = args.has("dry-run");
const noPush = args.has("no-push");
const draft = args.has("draft");
const skipTests = args.has("skip-tests");
const yes = args.has("yes");
const notaryProfile = resolveNotaryProfile({ explicit: args.get("notary-profile") });
if (notaryProfile) {
  process.env.APPLE_KEYCHAIN_PROFILE = notaryProfile;
}

main();

function main() {
  const bump = getBump(args);
  preflight();

  const currentVersion = readPackage().version;
  const nextVersion = resolveNextVersion(currentVersion, bump);
  const tag = `v${nextVersion}`;

  log(`Releasing Pi-Vis ${tag}${dryRun ? " (dry run)" : ""}`);
  if (notaryProfile) {
    log(`Using notarytool keychain profile: ${notaryProfile}`);
  }
  if (!dryRun && !yes) {
    fail("Pass --yes to confirm that you want to build, tag, push, and publish this release.");
  }

  run("npm", ["version", nextVersion, "--no-git-tag-version"]);

  if (!skipTests) {
    run("npm", ["run", "typecheck"]);
    run("npm", ["run", "lint"]);
    run("npm", ["test"]);
    run("npm", ["run", "test:e2e"]);
  }

  run("npm", ["run", "dist"]);
  verifyArtifacts(nextVersion);
  createStableReleaseAliases(nextVersion);

  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `chore: release ${tag}`]);
  run("git", ["tag", "-a", tag, "-m", tag]);

  if (noPush) {
    log("--no-push set: skipping git push and GitHub Release creation.");
    log(
      dryRun
        ? `Dry run: local release commit and tag ${tag} would be ready.`
        : `Local release commit and tag ${tag} are ready.`,
    );
    return;
  }

  run("git", ["push", "origin", "HEAD", "--follow-tags"]);

  const assets = [
    `release/${nextVersion}/Pi-Vis-${nextVersion}-arm64-mac.zip`,
    `release/${nextVersion}/Pi-Vis-${nextVersion}-arm64.dmg`,
    `release/${nextVersion}/Pi-Vis-arm64.dmg`,
  ];

  const releaseArgs = [
    "release",
    "create",
    tag,
    ...assets,
    "--title",
    tag,
    "--notes",
    `Pi-Vis ${tag}`,
  ];
  if (draft) releaseArgs.push("--draft");
  run("gh", releaseArgs);

  log(`Release ${tag} complete.`);
}

function preflight() {
  requireCommand("git", ["--version"]);
  requireCommand("npm", ["--version"]);
  if (!noPush) {
    requireCommand("gh", ["--version"]);
  }
  requireCommand("security", ["find-identity", "-v", "-p", "codesigning"]);
  requireCommand("xcrun", ["notarytool", "--help"]);
  requireCommand("spctl", ["--status"]);

  if (dryRun) {
    log("Dry run: skipping credential, Git cleanliness, GitHub auth, and certificate enforcement.");
    return;
  }

  const status = exec("git", ["status", "--porcelain"]).trim();
  if (status) fail("Git working tree is not clean. Commit or stash changes before releasing.");

  if (!noPush) {
    run("gh", ["auth", "status"], { quiet: true });
  }

  configureSigningEnvironment({ notaryProfile, log, fail });
}

function verifyArtifacts(version) {
  const appPath = `release/${version}/mac-arm64/Pi-Vis.app`;
  const zipPath = `release/${version}/Pi-Vis-${version}-arm64-mac.zip`;
  const dmgPath = `release/${version}/Pi-Vis-${version}-arm64.dmg`;

  for (const artifact of [appPath, zipPath, dmgPath]) {
    if (!dryRun && !fs.existsSync(path.join(root, artifact))) fail(`Missing artifact: ${artifact}`);
  }

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  run("spctl", ["-a", "-vv", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
}

function createStableReleaseAliases(version) {
  const versionedDmg = path.join(root, `release/${version}/Pi-Vis-${version}-arm64.dmg`);
  const stableDmg = path.join(root, `release/${version}/Pi-Vis-arm64.dmg`);
  log(`Creating stable GitHub Pages download alias: ${path.relative(root, stableDmg)}`);
  if (!dryRun) fs.copyFileSync(versionedDmg, stableDmg);
}

function getBump(parsed) {
  const explicit = parsed.get("version");
  const bumps = ["patch", "minor", "major"].filter((name) => parsed.has(name));
  if (explicit && bumps.length > 0) fail("Use either --version or one of --patch/--minor/--major.");
  if (bumps.length > 1) fail("Use only one of --patch, --minor, or --major.");
  if (explicit) return { kind: "version", value: explicit };
  if (bumps.length === 1) return { kind: bumps[0] };
  return { kind: "patch" };
}

function resolveNextVersion(current, bump) {
  if (bump.kind === "version") return normalizeVersion(bump.value);
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) fail(`Cannot ${bump.kind}-bump non-standard version ${current}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump.kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump.kind === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function normalizeVersion(version) {
  const clean = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(clean)) {
    fail(`Invalid version: ${version}`);
  }
  return clean;
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "version" || key === "notary-profile") {
      const value = argv[++i];
      if (!value) fail(`--${key} requires a value.`);
      parsed.set(key, value);
    } else {
      parsed.set(key, true);
    }
  }
  return parsed;
}

function requireCommand(command, checkArgs) {
  const result = spawnSync(command, checkArgs, { stdio: "ignore" });
  if (result.error || result.status !== 0) fail(`Required command unavailable: ${command}`);
}

function run(command, commandArgs, opts = {}) {
  const rendered = [command, ...commandArgs].join(" ");
  log(`$ ${rendered}`);
  if (dryRun) return "";
  const stdio = opts.quiet ? "pipe" : "inherit";
  const result = spawnSync(command, commandArgs, { stdio, env: process.env });
  if (result.status !== 0) fail(`Command failed: ${rendered}`);
  return result.stdout?.toString() ?? "";
}

function exec(command, commandArgs) {
  if (dryRun) return "";
  return execFileSync(command, commandArgs, { encoding: "utf8", env: process.env });
}

function log(message) {
  console.log(`[release] ${message}`);
}

function fail(message) {
  console.error(`[release] ${message}`);
  if (!yes && !dryRun) {
    console.error("[release] Aborting. Re-run with --yes only after reviewing the failure.");
  }
  process.exit(1);
}
