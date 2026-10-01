#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NODE_PTY_PACKAGE, NODE_PTY_VERSION, patchNodePty } from "./patch-node-pty.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const require = createRequire(import.meta.url);
const PINNED_PI_VERSION = "0.85.1";
export const PACKAGED_PI_PACKAGES = [
  "chord",
  "pi-agent-core",
  "pi-ai",
  "pi-coding-agent",
  "pi-telemetry",
  "pi-tui",
];
export const REMOVED_PI_PACKAGES = ["pi-client", "pi-protocol"];

export function packagedPaths(appBundle) {
  const resources = path.join(appBundle, "Contents", "Resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const packageDirectory = path.join(
    unpacked,
    "node_modules",
    "@homebridge",
    "node-pty-prebuilt-multiarch",
  );
  const piPackagesRoot = path.join(unpacked, "node_modules", "@earendil-works");
  const piPackageDirectories = Object.fromEntries(
    PACKAGED_PI_PACKAGES.map((name) => [name, path.join(piPackagesRoot, name)]),
  );
  const piPackageDirectory = piPackageDirectories["pi-coding-agent"];
  return {
    executable: path.join(appBundle, "Contents", "MacOS", "Pi-Vis"),
    asar: path.join(resources, "app.asar"),
    hostScript: path.join(unpacked, "out", "resources", "pi-session-host", "host.mjs"),
    privateAdapter: path.join(
      unpacked,
      "out",
      "resources",
      "pi-session-host",
      "pinned-pi-private.mjs",
    ),
    packageDirectory,
    helper: path.join(packageDirectory, "build", "Release", "spawn-helper"),
    piCli: path.join(piPackageDirectory, "dist", "cli.js"),
    piBundleCli: path.join(piPackageDirectory, "dist", "bundle", "cli.js"),
    piPackagesRoot,
    piPackageDirectories,
  };
}

export function verifyPackagedPiBundleCli(piBundleCli) {
  const result = spawnSync(process.execPath, [piBundleCli, "--version"], {
    cwd: path.dirname(piBundleCli),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`Packaged Pi bundled CLI failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Packaged Pi bundled CLI exited with status ${String(result.status)}: ${(result.stderr ?? "").trim()}`,
    );
  }
  const reportedVersion = (result.stdout ?? "").trim();
  if (reportedVersion !== PINNED_PI_VERSION) {
    throw new Error(
      `Packaged Pi bundled CLI version mismatch: expected ${PINNED_PI_VERSION}, found ${reportedVersion || "<empty>"}.`,
    );
  }
  return reportedVersion;
}

function runPackagedJourney(executable) {
  const playwrightCli = require.resolve("@playwright/test/cli");
  const result = spawnSync(
    process.execPath,
    [playwrightCli, "test", "-c", "tests/e2e/playwright.config.mts", "packaged-pty.spec.mts"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PIVIS_E2E_WORKERS: "1",
        PIVIS_PACKAGED_EXECUTABLE: executable,
        PIVIS_TEST_SKIP_FRESHNESS: "1",
      },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 150_000,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Packaged PTY journey exited with status ${result.status}.`);
  }
}

export async function verifyPackagedApp(appBundle) {
  if (process.platform !== "darwin") {
    throw new Error("The packaged PTY verifier currently supports macOS application bundles only.");
  }
  const paths = packagedPaths(appBundle);
  for (const required of [
    paths.executable,
    paths.asar,
    paths.hostScript,
    paths.privateAdapter,
    paths.helper,
    paths.piCli,
    paths.piBundleCli,
    ...Object.values(paths.piPackageDirectories).map((directory) =>
      path.join(directory, "package.json"),
    ),
  ]) {
    if (!fs.existsSync(required)) throw new Error(`Missing packaged artifact: ${required}`);
  }
  for (const [name, directory] of Object.entries(paths.piPackageDirectories)) {
    const version = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    ).version;
    if (version !== PINNED_PI_VERSION) {
      throw new Error(
        `Packaged ${name} version mismatch: expected ${PINNED_PI_VERSION}, found ${String(version)}.`,
      );
    }
  }
  const packagedPiNames = fs
    .readdirSync(paths.piPackagesRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(paths.piPackagesRoot, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(packagedPiNames) !== JSON.stringify(PACKAGED_PI_PACKAGES)) {
    throw new Error(
      `Packaged Pi closure mismatch: expected ${PACKAGED_PI_PACKAGES.join(", ")}; found ${packagedPiNames.join(", ")}.`,
    );
  }
  for (const removedName of REMOVED_PI_PACKAGES) {
    if (packagedPiNames.includes(removedName)) {
      throw new Error(`Removed Pi runtime package unexpectedly shipped: ${removedName}.`);
    }
  }

  // Existence is insufficient for esbuild's published bundle: a missing or
  // corrupt adjacent chunk can leave the entry file present but unusable.
  // Execute the completed artifact under this verifier's plain Node runtime.
  verifyPackagedPiBundleCli(paths.piBundleCli);

  const adapter = await import(pathToFileURL(paths.privateAdapter).href);
  const llamaExtension = await adapter.importPinnedLlamaExtension(paths.piCli, PINNED_PI_VERSION);
  if (
    llamaExtension?.name !== "llama.cpp" ||
    typeof llamaExtension.factory !== "function" ||
    llamaExtension.hidden !== true ||
    !Object.isFrozen(llamaExtension)
  ) {
    throw new Error("Packaged private llama.cpp adapter returned an unexpected entry.");
  }
  fs.accessSync(paths.helper, fs.constants.X_OK);
  patchNodePty({ packageDirectory: paths.packageDirectory, verifyOnly: true });
  console.log(
    `[packaged-pty] Verified packaged Pi ${PINNED_PI_VERSION} runtime closure and bundled CLI, private llama.cpp adapter, patched ${NODE_PTY_PACKAGE}@${NODE_PTY_VERSION}, and executable spawn-helper in ${appBundle}`,
  );

  // The journey launches the completed app. pty.start resolves from Electron's
  // logical app.asar, while a real Shell Turn resolves from the unpacked SDK
  // host running under system Node. Both must actually spawn and settle.
  runPackagedJourney(paths.executable);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const appBundle = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(projectRoot, `release/${manifest.version}/mac-arm64/Pi-Vis.app`);
  await verifyPackagedApp(appBundle);
}
