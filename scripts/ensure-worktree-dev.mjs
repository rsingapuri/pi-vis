#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyElectronInstallation } from "./postinstall.mjs";

function execGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function repoRoot() {
  try {
    return fs.realpathSync(execGit(["rev-parse", "--show-toplevel"], process.cwd()));
  } catch {
    return fs.realpathSync(process.cwd());
  }
}

function packageName(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

function hasUsableNodeModules(root) {
  const nodeModules = path.join(root, "node_modules");
  return (
    fs.existsSync(path.join(nodeModules, ".bin")) &&
    fs.existsSync(path.join(nodeModules, "typescript"))
  );
}

function dependencyManifest(root) {
  try {
    return fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
  } catch {
    try {
      return fs.readFileSync(path.join(root, "package.json"), "utf8");
    } catch {
      return undefined;
    }
  }
}

function dependenciesMatch(leftRoot, rightRoot) {
  return dependencyManifest(leftRoot) === dependencyManifest(rightRoot);
}

function linkedDependencyRoot(root) {
  const nodeModules = path.join(root, "node_modules");
  try {
    if (!fs.lstatSync(nodeModules).isSymbolicLink()) return undefined;
    return path.dirname(fs.realpathSync(nodeModules));
  } catch {
    return undefined;
  }
}

function worktreeRoots(root) {
  try {
    const out = execGit(["worktree", "list", "--porcelain"], root);
    return out
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => fs.realpathSync(line.slice("worktree ".length)))
      .filter((p) => packageName(p) === packageName(root));
  } catch {
    return [root];
  }
}

function electronInstallError(root, error) {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `[ensure-worktree-dev] Electron is not provisioned in ${path.join(root, "node_modules")}: ${reason}\nRun \`npm install\` without \`--ignore-scripts\` in that dependency-owning worktree, then retry this command.`,
    { cause: error },
  );
}

function verifyWorktreeElectron(root, verifyElectron) {
  try {
    return verifyElectron({ packageDirectory: path.join(root, "node_modules", "electron") });
  } catch (error) {
    throw electronInstallError(root, error);
  }
}

export function ensureWorktreeDev({
  root = repoRoot(),
  roots = worktreeRoots(root),
  verifyElectron = verifyElectronInstallation,
  log = console.error,
} = {}) {
  const nodeModules = path.join(root, "node_modules");

  if (hasUsableNodeModules(root)) {
    const linkedRoot = linkedDependencyRoot(root);
    // A branch can change package-lock.json after this symlink was created.
    // Never silently run it against a sibling's incompatible dependency tree.
    if (!linkedRoot || dependenciesMatch(root, linkedRoot)) {
      // Electron 43 lazily installs from index.js. This preflight must remain
      // read-only so parallel workers never become competing installers when
      // a local or shared dependency tree skipped its root postinstall.
      verifyWorktreeElectron(linkedRoot ?? root, verifyElectron);
      return { root, dependencyRoot: linkedRoot ?? root, linked: linkedRoot !== undefined };
    }
    fs.rmSync(nodeModules, { force: true });
    log("[ensure-worktree-dev] removed an incompatible node_modules worktree link");
  } else {
    let stat;
    try {
      stat = fs.lstatSync(nodeModules);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(
          `[ensure-worktree-dev] ${nodeModules} could not be validated.\nRepair or move that path, then run \`npm install\` without \`--ignore-scripts\` in this worktree.`,
          { cause: error },
        );
      }
    }
    if (stat?.isSymbolicLink()) {
      fs.rmSync(nodeModules, { force: true });
    } else if (stat) {
      throw new Error(
        `[ensure-worktree-dev] ${nodeModules} exists but is not a complete dependency install.\nRun \`npm install\` without \`--ignore-scripts\` in this worktree, then retry this command.`,
      );
    }
  }

  let invalidElectronError;
  const sourceRoot = roots.find((candidate) => {
    if (
      candidate === root ||
      !hasUsableNodeModules(candidate) ||
      !dependenciesMatch(root, candidate)
    ) {
      return false;
    }
    try {
      verifyWorktreeElectron(candidate, verifyElectron);
      return true;
    } catch (error) {
      invalidElectronError ??= error;
      return false;
    }
  });
  if (!sourceRoot) {
    if (invalidElectronError) throw invalidElectronError;
    throw new Error(
      "[ensure-worktree-dev] node_modules is missing and no sibling worktree with installed dependencies was found.\n" +
        "Run `npm install` once in this worktree (or in a sibling with the same package-lock.json), then retry this command.",
    );
  }

  const target = path.join(sourceRoot, "node_modules");
  fs.symlinkSync(target, nodeModules, "dir");
  const createdLink = fs.lstatSync(nodeModules);
  const createdLinkTarget = fs.readlinkSync(nodeModules);
  if (!createdLink.isSymbolicLink() || createdLinkTarget !== target) {
    throw new Error(
      `[ensure-worktree-dev] ${nodeModules} changed while its dependency link was being created.`,
    );
  }
  // Re-resolve through the new link before returning. This turns a concurrent
  // source removal or incomplete link into the same actionable failure.
  try {
    verifyWorktreeElectron(root, verifyElectron);
  } catch (error) {
    try {
      const currentLink = fs.lstatSync(nodeModules);
      if (
        currentLink.isSymbolicLink() &&
        currentLink.dev === createdLink.dev &&
        currentLink.ino === createdLink.ino &&
        fs.readlinkSync(nodeModules) === createdLinkTarget
      ) {
        fs.rmSync(nodeModules, { force: true });
      }
    } catch {
      // Preserve the verification failure. Cleanup is deliberately limited to
      // the unchanged symlink created above; never remove a replacement path.
    }
    throw error;
  }
  log(`[ensure-worktree-dev] linked ${nodeModules} -> ${target}`);
  return { root, dependencyRoot: sourceRoot, linked: true };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    ensureWorktreeDev();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
