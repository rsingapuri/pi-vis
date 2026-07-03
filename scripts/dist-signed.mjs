#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { configureSigningEnvironment, resolveNotaryProfile } from "./signing-env.mjs";

const args = parseArgs(process.argv.slice(2));
const skipNotarization = args.has("skip-notarize");
const notaryProfile = skipNotarization
  ? null
  : resolveNotaryProfile({ explicit: args.get("notary-profile") });
if (notaryProfile) {
  process.env.APPLE_KEYCHAIN_PROFILE = notaryProfile;
}

main();

function main() {
  requireCommand("security", ["find-identity", "-v", "-p", "codesigning"]);
  requireCommand("xcrun", ["notarytool", "--help"]);
  requireCommand("spctl", ["--status"]);

  if (notaryProfile) {
    log(`Using notarytool keychain profile: ${notaryProfile}`);
  }
  configureSigningEnvironment({ notaryProfile, skipNotarization, log, fail });
  run("npm", ["run", "dist"]);
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "notary-profile") {
      const value = argv[++i];
      if (!value) fail("--notary-profile requires a value.");
      parsed.set(key, value);
    } else if (key === "skip-notarize") {
      parsed.set(key, true);
    } else {
      fail(`Unknown option: --${key}`);
    }
  }
  return parsed;
}

function requireCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "ignore" });
  if (result.error || result.status !== 0) fail(`Required command unavailable: ${command}`);
}

function run(command, commandArgs) {
  const rendered = [command, ...commandArgs].join(" ");
  log(`$ ${rendered}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env: process.env });
  if (result.status !== 0) fail(`Command failed: ${rendered}`);
}

function log(message) {
  console.log(`[dist:signed] ${message}`);
}

function fail(message) {
  console.error(`[dist:signed] ${message}`);
  process.exit(1);
}
