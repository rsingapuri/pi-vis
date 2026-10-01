import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWorktreeDev } from "../scripts/ensure-worktree-dev.mjs";

const fixtures: string[] = [];

function worktree(name: string, lock = "same-lock"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pivis-${name}-`));
  fixtures.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-vis" }));
  fs.writeFileSync(path.join(root, "package-lock.json"), lock);
  return root;
}

function installDependencies(root: string, { electronBinary = true } = {}): string {
  const nodeModules = path.join(root, "node_modules");
  fs.mkdirSync(path.join(nodeModules, ".bin"), { recursive: true });
  fs.mkdirSync(path.join(nodeModules, "typescript"), { recursive: true });
  const electron = path.join(nodeModules, "electron");
  fs.mkdirSync(path.join(electron, "dist", "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(electron, "package.json"),
    JSON.stringify({ name: "electron", version: "43.0.0" }),
  );
  // If this were executed it would prove an accidental lazy-install path.
  fs.writeFileSync(path.join(electron, "install.js"), "throw new Error('must not run');\n");
  fs.writeFileSync(path.join(electron, "dist", "version"), "43.0.0");
  fs.writeFileSync(path.join(electron, "path.txt"), "runtime/electron");
  if (electronBinary) fs.writeFileSync(path.join(electron, "dist", "runtime", "electron"), "bin");
  return nodeModules;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ensure-worktree-dev Electron preflight", () => {
  it("accepts and preserves a same-lock sibling node_modules link after read-only verification", () => {
    const current = worktree("current");
    const sibling = worktree("sibling");
    const siblingModules = installDependencies(sibling);
    fs.symlinkSync(siblingModules, path.join(current, "node_modules"), "dir");
    const log = vi.fn();

    expect(ensureWorktreeDev({ root: current, roots: [current, sibling], log })).toEqual({
      root: current,
      dependencyRoot: fs.realpathSync(sibling),
      linked: true,
    });
    expect(fs.realpathSync(path.join(current, "node_modules"))).toBe(
      fs.realpathSync(siblingModules),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("creates a link only to a same-lock sibling whose Electron install is complete", () => {
    const current = worktree("current");
    const incomplete = worktree("incomplete");
    installDependencies(incomplete, { electronBinary: false });
    const ready = worktree("ready");
    const readyModules = installDependencies(ready);
    const log = vi.fn();

    expect(
      ensureWorktreeDev({ root: current, roots: [current, incomplete, ready], log }),
    ).toMatchObject({ dependencyRoot: ready, linked: true });
    expect(fs.realpathSync(path.join(current, "node_modules"))).toBe(fs.realpathSync(readyModules));
    expect(log).toHaveBeenCalledWith(
      `[ensure-worktree-dev] linked ${path.join(current, "node_modules")} -> ${readyModules}`,
    );
  });

  it("fails actionably without importing Electron when a local binary is missing", () => {
    const current = worktree("current");
    const nodeModules = installDependencies(current, { electronBinary: false });
    const installScript = path.join(nodeModules, "electron", "install.js");
    const before = fs.readFileSync(installScript, "utf8");

    expect(() => ensureWorktreeDev({ root: current, roots: [current] })).toThrow(
      /Electron is not provisioned[\s\S]*without `--ignore-scripts`/,
    );
    expect(fs.readFileSync(installScript, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(nodeModules, "electron", "dist", "runtime", "electron"))).toBe(
      false,
    );
  });

  it("preserves an unusable real local node_modules instead of linking over it", () => {
    const current = worktree("current");
    const localModules = path.join(current, "node_modules");
    fs.mkdirSync(localModules);
    const marker = path.join(localModules, "user-owned-marker");
    fs.writeFileSync(marker, "keep");
    const sibling = worktree("sibling");
    installDependencies(sibling);

    expect(() => ensureWorktreeDev({ root: current, roots: [current, sibling] })).toThrow(
      /not a complete dependency install[\s\S]*npm install/,
    );
    expect(fs.lstatSync(localModules).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  });

  it("removes only its newly-created sibling link when post-link verification fails", () => {
    const current = worktree("current");
    const sibling = worktree("sibling");
    installDependencies(sibling);
    const verifyElectron = vi
      .fn()
      .mockReturnValueOnce({ version: "43.0.0" })
      .mockImplementationOnce(() => {
        throw new Error("source changed during link");
      });

    expect(() =>
      ensureWorktreeDev({ root: current, roots: [current, sibling], verifyElectron }),
    ).toThrow("source changed during link");
    expect(fs.existsSync(path.join(current, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(sibling, "node_modules"))).toBe(true);
  });

  it("does not remove a replacement real path while rolling back a failed link verification", () => {
    const current = worktree("current");
    const sibling = worktree("sibling");
    installDependencies(sibling);
    const currentModules = path.join(current, "node_modules");
    const marker = path.join(currentModules, "replacement-marker");
    const verifyElectron = vi
      .fn()
      .mockReturnValueOnce({ version: "43.0.0" })
      .mockImplementationOnce(() => {
        fs.rmSync(currentModules, { force: true });
        fs.mkdirSync(currentModules);
        fs.writeFileSync(marker, "keep");
        throw new Error("source changed during link");
      });

    expect(() =>
      ensureWorktreeDev({ root: current, roots: [current, sibling], verifyElectron }),
    ).toThrow("source changed during link");
    expect(fs.lstatSync(currentModules).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  });

  it("does not remove a concurrently replaced symlink with the same target", () => {
    const current = worktree("current");
    const sibling = worktree("sibling");
    const siblingModules = installDependencies(sibling);
    const currentModules = path.join(current, "node_modules");
    let replacementIdentity: { dev: number; ino: number } | undefined;
    const verifyElectron = vi
      .fn()
      .mockReturnValueOnce({ version: "43.0.0" })
      .mockImplementationOnce(() => {
        fs.rmSync(currentModules, { force: true });
        fs.symlinkSync(siblingModules, currentModules, "dir");
        const replacement = fs.lstatSync(currentModules);
        replacementIdentity = { dev: replacement.dev, ino: replacement.ino };
        throw new Error("source changed during link");
      });

    expect(() =>
      ensureWorktreeDev({ root: current, roots: [current, sibling], verifyElectron }),
    ).toThrow("source changed during link");
    const preserved = fs.lstatSync(currentModules);
    expect(preserved.isSymbolicLink()).toBe(true);
    expect({ dev: preserved.dev, ino: preserved.ino }).toEqual(replacementIdentity);
    expect(fs.readlinkSync(currentModules)).toBe(siblingModules);
  });
});
