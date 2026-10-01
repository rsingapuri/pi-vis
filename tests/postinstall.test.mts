import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  provisionElectron,
  runPostinstall,
  verifyElectronInstallation,
} from "../scripts/postinstall.mjs";

const roots: string[] = [];

function fixture(version = "43.0.0"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-electron-install-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "electron", version }));
  fs.writeFileSync(path.join(root, "install.js"), "// fixture installer\n");
  return root;
}

function completeInstallation(root: string, version = "43.0.0"): string {
  const binaryPath = path.join(root, "dist", "runtime", "electron");
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "version"), `v${version}\n`);
  fs.writeFileSync(path.join(root, "path.txt"), "runtime/electron");
  fs.writeFileSync(binaryPath, "binary");
  return binaryPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("root postinstall", () => {
  it("provisions Electron synchronously before applying the fail-closed node-pty patch", () => {
    const order: string[] = [];
    const result = runPostinstall({
      provisionElectronFn: vi.fn(() => {
        order.push("electron");
        return { version: "43.0.0", binaryPath: "/electron", packageDirectory: "/package" };
      }),
      patchNodePtyFn: vi.fn(() => {
        order.push("node-pty");
        return { changed: false, packageDirectory: "/node-pty" };
      }),
    });

    expect(order).toEqual(["electron", "node-pty"]);
    expect(result.nodePty).toEqual({ changed: false, packageDirectory: "/node-pty" });
  });

  it("does not patch after failed provisioning and does not hide a node-pty patch failure", () => {
    const patchAfterProvisionFailure = vi.fn();
    expect(() =>
      runPostinstall({
        provisionElectronFn: () => {
          throw new Error("electron failed");
        },
        patchNodePtyFn: patchAfterProvisionFailure,
      }),
    ).toThrow("electron failed");
    expect(patchAfterProvisionFailure).not.toHaveBeenCalled();

    expect(() =>
      runPostinstall({
        provisionElectronFn: () => ({
          version: "43.0.0",
          binaryPath: "/electron",
          packageDirectory: "/package",
        }),
        patchNodePtyFn: () => {
          throw new Error("node-pty drift");
        },
      }),
    ).toThrow("node-pty drift");
  });

  it("runs Electron's shipped installer exactly once and verifies its completed binary", () => {
    const packageDirectory = fixture();
    const runInstaller = vi.fn(() => {
      completeInstallation(packageDirectory);
      return { status: 0 };
    });

    expect(provisionElectron({ packageDirectory, runInstaller })).toMatchObject({
      packageDirectory,
      version: "43.0.0",
      binaryPath: path.join(packageDirectory, "dist", "runtime", "electron"),
    });
    expect(runInstaller).toHaveBeenCalledOnce();
    expect(runInstaller).toHaveBeenCalledWith(
      expect.objectContaining({
        installScript: path.join(packageDirectory, "install.js"),
      }),
    );
  });

  it("fails when the installer fails or reports success without a complete binary", () => {
    const failedPackage = fixture();
    expect(() =>
      provisionElectron({ packageDirectory: failedPackage, runInstaller: () => ({ status: 7 }) }),
    ).toThrow("installer failed (exit 7)");

    const incompletePackage = fixture();
    expect(() =>
      provisionElectron({
        packageDirectory: incompletePackage,
        runInstaller: () => ({ status: 0 }),
      }),
    ).toThrow("was not installed completely");
  });

  it("rejects mismatched versions and executable paths outside Electron's binary directory", () => {
    const mismatched = fixture();
    completeInstallation(mismatched, "42.0.0");
    expect(() => verifyElectronInstallation({ packageDirectory: mismatched })).toThrow(
      "does not match package 43.0.0",
    );

    const escaped = fixture();
    fs.mkdirSync(path.join(escaped, "dist"), { recursive: true });
    fs.writeFileSync(path.join(escaped, "dist", "version"), "43.0.0");
    fs.writeFileSync(path.join(escaped, "path.txt"), "../outside-electron");
    fs.writeFileSync(path.join(escaped, "outside-electron"), "binary");
    expect(() => verifyElectronInstallation({ packageDirectory: escaped })).toThrow(
      "resolves outside its binary directory",
    );
  });

  it("keeps the repository postinstall wired to the serialized provisioner", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    );
    expect(manifest.scripts.postinstall).toBe("node scripts/postinstall.mjs");
  });
});
