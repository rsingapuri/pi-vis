import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_PI_PACKAGES,
  REMOVED_PI_PACKAGES,
  packagedPaths,
  verifyPackagedPiBundleCli,
} from "../scripts/verify-packaged-pty.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

    expect(paths.piPackagesRoot).toBe(path.join(modules, "@earendil-works"));
    expect(paths.packageDirectory).toBe(
      path.join(modules, "@homebridge", "node-pty-prebuilt-multiarch"),
    );
    expect(Object.keys(paths.piPackageDirectories)).toEqual(PACKAGED_PI_PACKAGES);
    expect(paths.piPackageDirectories["pi-coding-agent"]).toBe(
      path.join(paths.piPackagesRoot, "pi-coding-agent"),
    );
    expect(paths.piBundleCli).toBe(
      path.join(paths.piPackageDirectories["pi-coding-agent"], "dist", "bundle", "cli.js"),
    );
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

    expect(verifyPackagedPiBundleCli(bundledCli)).toBe("0.85.1");
    expect(() =>
      verifyPackagedPiBundleCli(path.join(projectRoot, "does-not-exist", "bundle", "cli.js")),
    ).toThrow("Packaged Pi bundled CLI failed to start");
  });
});
