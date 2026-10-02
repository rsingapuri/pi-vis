#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NODE_PTY_PACKAGE, NODE_PTY_VERSION, patchNodePty } from "./patch-node-pty.mjs";
import { verifyResolvedPiBraceExpansion } from "./verify-pi-security-closure.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const require = createRequire(import.meta.url);
const PINNED_PI_VERSION = "0.99.2";
const MINIMUM_SAFE_ELECTRON_VERSION = "43.5.0";
export const PACKAGED_PI_PACKAGES = [
  "chord",
  "pi-agent-core",
  "pi-ai",
  "pi-codemode",
  "pi-coding-agent",
  "pi-mcp",
  "pi-telemetry",
  "pi-tui",
];
export const REMOVED_PI_PACKAGES = ["pi-client", "pi-protocol"];

export function packagedPaths(appBundle) {
  const resources = path.join(appBundle, "Contents", "Resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const modulesRoot = path.join(unpacked, "node_modules");
  const packageDirectory = path.join(modulesRoot, "@homebridge", "node-pty-prebuilt-multiarch");
  const piPackagesRoot = path.join(modulesRoot, "@earendil-works");
  const piPackageDirectories = Object.fromEntries(
    PACKAGED_PI_PACKAGES.map((name) => [name, path.join(piPackagesRoot, name)]),
  );
  const piPackageDirectory = piPackageDirectories["pi-coding-agent"];
  const quickJsPackageDirectory = path.join(modulesRoot, "quickjs-wasi");
  return {
    executable: path.join(appBundle, "Contents", "MacOS", "Pi-Vis"),
    resourcesRoot: resources,
    asar: path.join(resources, "app.asar"),
    hostScript: path.join(unpacked, "out", "resources", "pi-session-host", "host.mjs"),
    privateAdapter: path.join(
      unpacked,
      "out",
      "resources",
      "pi-session-host",
      "pinned-pi-private.mjs",
    ),
    electronFrameworkInfo: path.join(
      appBundle,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Resources",
      "Info.plist",
    ),
    packageDirectory,
    helper: path.join(packageDirectory, "build", "Release", "spawn-helper"),
    piCli: path.join(piPackageDirectory, "dist", "cli.js"),
    piBundleCli: path.join(piPackageDirectory, "dist", "bundle", "cli.js"),
    piCodemodeEntry: path.join(piPackageDirectories["pi-codemode"], "dist", "index.js"),
    quickJsWasm: path.join(quickJsPackageDirectory, "quickjs.wasm"),
    quickJsExtensions: ["crypto", "encoding", "headers", "structured-clone", "url"].map((name) =>
      path.join(quickJsPackageDirectory, "extensions", name, `${name}.so`),
    ),
    modulesRoot,
    piPackageDirectory,
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

/** Execute the real worker + WASM path that the built-in codemode tool uses. */
export async function verifyPackagedCodemode(piCodemodeEntry) {
  const { CodemodeSandbox } = await import(pathToFileURL(piCodemodeEntry).href);
  const sandbox = new CodemodeSandbox({ timeoutMs: 5_000 });
  try {
    const result = await sandbox.execute('text("packaged codemode"); return 6 * 7;');
    if (
      result?.ok !== true ||
      result.value !== 42 ||
      result.output?.[0]?.type !== "text" ||
      result.output[0].text !== "packaged codemode"
    ) {
      throw new Error(`Packaged codemode smoke test returned ${JSON.stringify(result)}.`);
    }
    return result.value;
  } finally {
    await sandbox.close();
  }
}

export function verifyPackagedPiSecurityClosure(appBundle) {
  if (!appBundle) throw new Error("A packaged app bundle is required for security verification.");

  let resolvedAppBundle;
  let resolvedResourcesRoot;
  let resolvedModulesRoot;
  try {
    resolvedAppBundle = fs.realpathSync(path.resolve(appBundle));
    const paths = packagedPaths(resolvedAppBundle);
    resolvedResourcesRoot = fs.realpathSync(paths.resourcesRoot);
    resolvedModulesRoot = fs.realpathSync(paths.modulesRoot);
  } catch (error) {
    throw new Error(`Cannot resolve the packaged app security boundary at ${appBundle}.`, {
      cause: error,
    });
  }
  const relativeResourcesRoot = path.relative(resolvedAppBundle, resolvedResourcesRoot);
  const expectedResourcesRoot = path.join("Contents", "Resources");
  if (relativeResourcesRoot !== expectedResourcesRoot) {
    throw new Error(
      `Packaged Resources root escapes or relocates from ${expectedResourcesRoot} in ${resolvedAppBundle}: resolved to ${resolvedResourcesRoot}.`,
    );
  }
  const relativeModulesRoot = path.relative(resolvedResourcesRoot, resolvedModulesRoot);
  const expectedModulesRoot = path.join("app.asar.unpacked", "node_modules");
  if (relativeModulesRoot !== expectedModulesRoot) {
    throw new Error(
      `Packaged modules root escapes the packaged Resources root or relocates from ${expectedModulesRoot} in ${resolvedResourcesRoot}: resolved to ${resolvedModulesRoot}.`,
    );
  }

  const paths = packagedPaths(resolvedAppBundle);
  return verifyResolvedPiBraceExpansion({
    piPackageDirectory: paths.piPackageDirectory,
    allowedModulesRoot: resolvedModulesRoot,
  });
}

function parseReleaseVersion(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`${label} is not an exact release version: ${String(version)}.`);
  return match.slice(1).map(Number);
}

function compareReleaseVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function verifyPackagedElectronVersion(
  appBundle,
  { root = projectRoot, minimumVersion = MINIMUM_SAFE_ELECTRON_VERSION } = {},
) {
  const lockPath = path.join(root, "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the Electron release lock at ${lockPath}.`, { cause: error });
  }
  const lockedVersion = lock?.packages?.["node_modules/electron"]?.version;
  const lockedRelease = parseReleaseVersion(lockedVersion, "Locked Electron version");
  const minimumRelease = parseReleaseVersion(minimumVersion, "Minimum safe Electron version");
  if (compareReleaseVersions(lockedRelease, minimumRelease) < 0) {
    throw new Error(
      `Locked Electron ${lockedVersion} is below the minimum safe ${minimumVersion}.`,
    );
  }

  const infoPath = packagedPaths(appBundle).electronFrameworkInfo;
  let info;
  try {
    info = fs.readFileSync(infoPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read packaged Electron framework metadata at ${infoPath}.`, {
      cause: error,
    });
  }
  const packagedVersion = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1];
  parseReleaseVersion(packagedVersion, "Packaged Electron framework version");
  if (packagedVersion !== lockedVersion) {
    throw new Error(
      `Packaged Electron ${packagedVersion} does not match locked Electron ${lockedVersion}.`,
    );
  }
  return packagedVersion;
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
    paths.electronFrameworkInfo,
    paths.helper,
    paths.piCli,
    paths.piBundleCli,
    paths.piCodemodeEntry,
    paths.quickJsWasm,
    ...paths.quickJsExtensions,
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

  const piSecurity = verifyPackagedPiSecurityClosure(appBundle);
  const electronVersion = verifyPackagedElectronVersion(appBundle);

  // Existence is insufficient for esbuild's published bundle: a missing or
  // corrupt adjacent chunk can leave the entry file present but unusable.
  // Execute the completed artifact under this verifier's plain Node runtime.
  verifyPackagedPiBundleCli(paths.piBundleCli);
  await verifyPackagedCodemode(paths.piCodemodeEntry);

  const adapter = await import(pathToFileURL(paths.privateAdapter).href);
  const llamaExtension = await adapter.importPinnedLlamaExtension(paths.piCli, PINNED_PI_VERSION);
  if (
    llamaExtension?.name !== "llama.cpp" ||
    typeof llamaExtension.factory !== "function" ||
    llamaExtension.builtin !== true ||
    "hidden" in llamaExtension ||
    "replaceable" in llamaExtension ||
    !Object.isFrozen(llamaExtension)
  ) {
    throw new Error("Packaged private llama.cpp adapter returned an unexpected entry.");
  }
  fs.accessSync(paths.helper, fs.constants.X_OK);
  patchNodePty({ packageDirectory: paths.packageDirectory, verifyOnly: true });
  console.log(
    `[packaged-pty] Verified packaged Electron ${electronVersion}, Pi ${PINNED_PI_VERSION} runtime closure with brace-expansion@${piSecurity.braceExpansionVersion}, bundled CLI, codemode worker/WASM, private llama.cpp adapter, patched ${NODE_PTY_PACKAGE}@${NODE_PTY_VERSION}, and executable spawn-helper in ${appBundle}`,
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
