import { execFileSync } from "node:child_process";

export const DEFAULT_NOTARY_PROFILE = "pivis-notary";

export function hasAppleCredentialEnv(env = process.env) {
  return Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
}

export function resolveNotaryProfile({ explicit, env = process.env } = {}) {
  if (explicit) return explicit;
  if (env.APPLE_KEYCHAIN_PROFILE) return env.APPLE_KEYCHAIN_PROFILE;
  if (hasAppleCredentialEnv(env)) return null;
  return DEFAULT_NOTARY_PROFILE;
}

export function configureSigningEnvironment({
  notaryProfile,
  skipNotarization = false,
  dryRun = false,
  log = () => {},
  fail = (message) => {
    throw new Error(message);
  },
} = {}) {
  if (skipNotarization) {
    delete process.env.APPLE_KEYCHAIN_PROFILE;
    delete process.env.APPLE_KEYCHAIN;
    delete process.env.APPLE_ID;
    delete process.env.APPLE_APP_SPECIFIC_PASSWORD;
    delete process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_API_KEY;
    delete process.env.APPLE_API_KEY_ID;
    delete process.env.APPLE_API_ISSUER;
  } else if (notaryProfile) {
    process.env.APPLE_KEYCHAIN_PROFILE = notaryProfile;
  }

  if (dryRun) return;

  if (skipNotarization) {
    log("Skipping notarization; build will be Developer ID signed but not notarized.");
  } else if (notaryProfile) {
    try {
      execFileSync("xcrun", ["notarytool", "history", "--keychain-profile", notaryProfile], {
        encoding: "utf8",
        env: process.env,
        stdio: "pipe",
      });
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      const notarytoolDetails = stderr.trim() ? `\nnotarytool said:\n${stderr.trim()}` : "";
      fail(`notarytool keychain profile "${notaryProfile}" was not found or is not usable.
This is separate from your Developer ID signing certificate. Create it once with:

  xcrun notarytool store-credentials "${notaryProfile}" --apple-id "you@example.com" --team-id "TEAMID" --password "app-specific-password"

If you used a different profile name, run with --notary-profile <name> or set APPLE_KEYCHAIN_PROFILE.
${notarytoolDetails}`);
    }
  } else if (!hasAppleCredentialEnv()) {
    fail(
      `APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must be set when APPLE_KEYCHAIN_PROFILE is not available. Run: xcrun notarytool store-credentials "${DEFAULT_NOTARY_PROFILE}" ...`,
    );
  }

  if (process.env.CSC_LINK) return;
  if (process.env.CSC_NAME) {
    process.env.CSC_NAME = toElectronBuilderQualifier(process.env.CSC_NAME);
    log(`Using signing identity qualifier: ${process.env.CSC_NAME}`);
    return;
  }

  const identities = findDeveloperIdIdentities();
  if (identities.length === 0) {
    const allIdentities = findCodeSigningIdentitiesOutput().trim() || "0 valid identities found";
    const keychainHint = process.env.CSC_KEYCHAIN
      ? `\nThe script searched CSC_KEYCHAIN=${process.env.CSC_KEYCHAIN}.`
      : "\nIf the certificate is in a custom keychain, set CSC_KEYCHAIN=/path/to/keychain-db.";
    fail(`No Developer ID Application signing identity found. Install your certificate in Keychain, set CSC_NAME, or set CSC_LINK.

codesign identities visible to this shell:
${allIdentities}${keychainHint}

For direct macOS distribution, the certificate must be named like:
  Developer ID Application: Your Name (TEAMID)

Apple Development, Apple Distribution, and Developer ID Certification Authority certificates are not sufficient for this release flow.`);
  }
  if (identities.length > 1) {
    fail(
      `Multiple Developer ID Application identities found. Set CSC_NAME to the identity qualifier to use, for example: CSC_NAME="${toElectronBuilderQualifier(identities[0])}"`,
    );
  }

  process.env.CSC_NAME = toElectronBuilderQualifier(identities[0]);
  log(`Using signing identity from Keychain: ${identities[0]}`);
  log(`Passing signing identity qualifier to electron-builder: ${process.env.CSC_NAME}`);
}

function toElectronBuilderQualifier(identity) {
  return identity.replace(/^Developer ID Application:\s*/, "");
}

export function findDeveloperIdIdentities() {
  const output = findCodeSigningIdentitiesOutput();
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.match(/"([^"]*Developer ID Application[^"]*)"/)?.[1])
        .filter(Boolean),
    ),
  ];
}

function findCodeSigningIdentitiesOutput() {
  const args = ["find-identity", "-v", "-p", "codesigning"];
  if (process.env.CSC_KEYCHAIN) args.push(process.env.CSC_KEYCHAIN);
  return execFileSync("security", args, {
    encoding: "utf8",
    env: process.env,
  });
}
