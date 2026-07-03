#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

function main() {
  const root = repoRoot();
  const nodeModules = path.join(root, "node_modules");

  if (hasUsableNodeModules(root)) return;

  try {
    const stat = fs.lstatSync(nodeModules);
    if (stat.isSymbolicLink()) fs.rmSync(nodeModules, { force: true });
  } catch {
    // Missing is expected in fresh git worktrees.
  }

  const sourceRoot = worktreeRoots(root).find(
    (candidate) => candidate !== root && hasUsableNodeModules(candidate),
  );
  if (!sourceRoot) {
    console.error(
      "[ensure-worktree-dev] node_modules is missing and no sibling worktree with installed dependencies was found.\n" +
        "Run `npm install` once in any pi-vis worktree, then retry this command.",
    );
    process.exit(1);
  }

  const target = path.join(sourceRoot, "node_modules");
  fs.symlinkSync(target, nodeModules, "dir");
  console.error(`[ensure-worktree-dev] linked ${nodeModules} -> ${target}`);
}

main();
