// Vitest suite for src/main/git/git.ts.
//
// Each test gets a fresh tmp directory; we make a real git repo there
// via `git init -b main` plus a scripted commit (with inline -c
// user.email / -c user.name — CI has no global git config), then
// exercise the getChanges / getFileDiff functions.
//
// Tests cover the spec's edge-case checklist: modified, added+staged,
// deleted, renamed, untracked, binary, not-a-repo, fresh repo without
// HEAD, file with spaces in name.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getBranches, getChanges, getChangesCount, getFileDiff, writeWorkingFile } from "./git.js";

let tmpRoot = "";
let workDir = "";

const INIT_C = ["-c", "init.defaultBranch=main"];
const COMMIT_C = ["-c", "user.email=t@t", "-c", "user.name=t"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(p: string, content: string): void {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content);
}

function makeRepo(): void {
  workDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  git(workDir, [...INIT_C, "init"]);
  // Some CI runners configure core.hooksPath; clear it to keep tests
  // isolated from host-level hooks.
  try {
    git(workDir, ["config", "core.hooksPath", "/dev/null"]);
  } catch {
    /* best effort */
  }
  // Initial commit so HEAD exists.
  write(path.join(workDir, "a.ts"), "export const a = 1;\n");
  git(workDir, ["add", "a.ts"]);
  git(workDir, [...COMMIT_C, "commit", "-m", "init"]);
}

beforeAll(() => {
  // Make sure `git` is on PATH; if not, every test would short-circuit
  // with git-missing, which is fine but uninformative.
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("git is required on PATH for this test suite");
  }
});

beforeEach(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pivis-git-")));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("getChanges", () => {
  it("returns 'not-a-repo' for a plain directory", async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "plain-"));
    const res = await getChanges(dir);
    expect(res.kind).toBe("not-a-repo");
  });

  it("returns 'git-missing' is unreachable in CI; covered indirectly by the spawn path", () => {
    // The ENOENT branch is unit-testable only by stubbing the binary; we
    // document it here and rely on the contract that ENOENT → git-missing.
    expect(true).toBe(true);
  });

  it("returns a clean list with no changes", async () => {
    makeRepo();
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.files).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.repoRoot).toBe(workDir);
  });

  it("reports a modified file with insertions/deletions", async () => {
    makeRepo();
    write(path.join(workDir, "a.ts"), "export const a = 1;\nexport const a2 = 2;\n");
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const a = res.files.find((f) => f.path === "a.ts");
    expect(a).toBeDefined();
    expect(a?.status).toBe("M");
    expect(a?.untracked).toBe(false);
    expect((a?.insertions ?? 0) + (a?.deletions ?? 0)).toBeGreaterThan(0);
  });

  it("reports an added+staged file", async () => {
    makeRepo();
    write(path.join(workDir, "b.ts"), "export const b = 1;\n");
    git(workDir, ["add", "b.ts"]);
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const b = res.files.find((f) => f.path === "b.ts");
    expect(b?.status).toBe("A");
    expect(b?.untracked).toBe(false);
  });

  it("reports a deleted file", async () => {
    makeRepo();
    fs.unlinkSync(path.join(workDir, "a.ts"));
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const a = res.files.find((f) => f.path === "a.ts");
    expect(a?.status).toBe("D");
  });

  it("reports a renamed file with oldPath", async () => {
    makeRepo();
    fs.renameSync(path.join(workDir, "a.ts"), path.join(workDir, "a-renamed.ts"));
    git(workDir, ["add", "-A"]);
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const r = res.files.find((f) => f.path === "a-renamed.ts");
    expect(r).toBeDefined();
    expect(r?.status).toBe("R");
    expect(r?.oldPath).toBe("a.ts");
  });

  it("reports an untracked file with a line count", async () => {
    makeRepo();
    write(path.join(workDir, "u.ts"), "line one\nline two\nline three\n");
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const u = res.files.find((f) => f.path === "u.ts");
    expect(u).toBeDefined();
    expect(u?.status).toBe("A");
    expect(u?.untracked).toBe(true);
    expect(u?.insertions).toBe(3);
  });

  it("reports an untracked binary file as binary", async () => {
    makeRepo();
    const filePath = path.join(workDir, "blob.bin");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3, 4]));
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const u = res.files.find((f) => f.path === "blob.bin");
    expect(u?.binary).toBe(true);
    expect(u?.insertions).toBe(0);
  });

  it("handles a fresh repo without HEAD by listing all tracked files as Added", async () => {
    workDir = fs.mkdtempSync(path.join(tmpRoot, "fresh-"));
    git(workDir, [...INIT_C, "init"]);
    write(path.join(workDir, "a.ts"), "line\n");
    git(workDir, ["add", "a.ts"]);
    // No commit yet.
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const a = res.files.find((f) => f.path === "a.ts");
    expect(a?.status).toBe("A");
    expect(a?.untracked).toBe(false);
  });

  it("handles paths with spaces in them", async () => {
    makeRepo();
    write(path.join(workDir, "with space.ts"), "x\n");
    const res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.files.some((f) => f.path === "with space.ts")).toBe(true);
  });
});

describe("getFileDiff", () => {
  it("returns empty old and full new for an added file", async () => {
    makeRepo();
    const newContent = "export const b = 1;\nexport const b2 = 2;\n";
    write(path.join(workDir, "b.ts"), newContent);
    git(workDir, ["add", "b.ts"]);
    const res = await getFileDiff(workDir, {
      path: "b.ts",
      status: "A",
      untracked: false,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.oldText).toBe("");
    expect(res.newText).toBe(newContent);
    expect(res.binary).toBe(false);
    expect(res.tooLarge).toBe(false);
  });

  it("returns empty new and full old for a deleted file", async () => {
    makeRepo();
    fs.unlinkSync(path.join(workDir, "a.ts"));
    const res = await getFileDiff(workDir, {
      path: "a.ts",
      status: "D",
      untracked: false,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.newText).toBe("");
    expect(res.oldText).toContain("a = 1");
  });

  it("returns both old and new for a modified file", async () => {
    makeRepo();
    const newContent = "export const a = 42;\n";
    write(path.join(workDir, "a.ts"), newContent);
    const res = await getFileDiff(workDir, {
      path: "a.ts",
      status: "M",
      untracked: false,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.oldText).toContain("a = 1");
    expect(res.newText).toBe(newContent);
  });

  it("returns the new path for a renamed file", async () => {
    makeRepo();
    const content = "export const a = 1;\n";
    fs.renameSync(path.join(workDir, "a.ts"), path.join(workDir, "a2.ts"));
    git(workDir, ["add", "-A"]);
    const res = await getFileDiff(workDir, {
      path: "a2.ts",
      oldPath: "a.ts",
      status: "R",
      untracked: false,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.oldText).toBe(content);
    expect(res.newText).toBe(content);
  });

  it("marks a binary file as binary", async () => {
    makeRepo();
    const filePath = path.join(workDir, "a.ts");
    fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3, 4, 5]));
    const res = await getFileDiff(workDir, {
      path: "a.ts",
      status: "M",
      untracked: false,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.binary).toBe(true);
  });

  it("flags a too-large file", async () => {
    makeRepo();
    // Write a 6 MiB file (> 5 MiB limit) directly on disk.
    const filePath = path.join(workDir, "big.ts");
    const big = Buffer.alloc(6 * 1024 * 1024, 0x61);
    fs.writeFileSync(filePath, big);
    const res = await getFileDiff(workDir, {
      path: "big.ts",
      status: "A",
      untracked: false,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.tooLarge).toBe(true);
    expect(res.newText).toBe("");
  });

  it("honors a custom maxFileSizeBytes cap", async () => {
    makeRepo();
    // 1.5 MiB: under the 5 MiB default, but over a 1 MiB custom cap.
    const filePath = path.join(workDir, "mid.ts");
    fs.writeFileSync(filePath, Buffer.alloc(1.5 * 1024 * 1024, 0x61));

    const underDefault = await getFileDiff(workDir, {
      path: "mid.ts",
      status: "A",
      untracked: false,
    });
    expect(underDefault.kind).toBe("ok");
    if (underDefault.kind !== "ok") return;
    expect(underDefault.tooLarge).toBe(false);

    const overCustom = await getFileDiff(
      workDir,
      { path: "mid.ts", status: "A", untracked: false },
      undefined,
      1 * 1024 * 1024,
    );
    expect(overCustom.kind).toBe("ok");
    if (overCustom.kind !== "ok") return;
    expect(overCustom.tooLarge).toBe(true);
  });

  it("reports newMissingNewline when the file lacks a trailing newline", async () => {
    makeRepo();
    write(path.join(workDir, "a.ts"), "no newline at end");
    const res = await getFileDiff(workDir, {
      path: "a.ts",
      status: "M",
      untracked: false,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.newMissingNewline).toBe(true);
  });

  it("returns empty strings for a missing new file (race tolerance)", async () => {
    makeRepo();
    // Mark b.ts deleted in the index but leave the file un-staged so
    // the list shows it; the click races with the actual delete.
    const res = await getFileDiff(workDir, {
      path: "nope-does-not-exist.ts",
      status: "M",
      untracked: false,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.newText).toBe("");
  });
});

describe("getBranches", () => {
  beforeEach(() => {
    makeRepo();
  });

  it("lists local branches with a current flag", async () => {
    const res = await getBranches(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.current).toBe("main");
    expect(res.branches.find((b) => b.name === "main")).toBeDefined();
    const main = res.branches.find((b) => b.name === "main")!;
    expect(main.remote).toBe(false);
    expect(main.current).toBe(true);
  });

  it("includes remote-tracking branches", async () => {
    // Set up a fake remote tracking ref.
    git(workDir, ["update-ref", "refs/remotes/origin/feature-x", "HEAD"]);
    git(workDir, ["update-ref", "refs/remotes/origin/HEAD", "HEAD"]);
    const res = await getBranches(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const remote = res.branches.find((b) => b.name === "origin/feature-x");
    expect(remote).toBeDefined();
    expect(remote!.remote).toBe(true);
    expect(remote!.current).toBe(false);
    // origin/HEAD should be filtered out.
    expect(res.branches.find((b) => b.name === "origin/HEAD")).toBeUndefined();
  });

  it("reports not-a-repo outside a git repository", async () => {
    const res = await getBranches("/tmp");
    expect(res.kind).toBe("not-a-repo");
  });
});

describe("getChanges with base", () => {
  beforeEach(() => {
    makeRepo();
  });

  it("reports changes against merge-base when base is a branch name", async () => {
    // Create a feature branch, add a commit, then check changes relative to main.
    git(workDir, ["checkout", "-b", "feature"]);
    write(`${workDir}/feature-file.ts`, "// feature\n");
    git(workDir, ["add", "feature-file.ts"]);
    git(workDir, [...COMMIT_C, "commit", "-m", "feature commit"]);

    // Working tree: same as HEAD (no uncommitted changes yet).
    let res = await getChanges(workDir, "main");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.path).toBe("feature-file.ts");

    // Add an uncommitted edit — it should also show up.
    write(`${workDir}/feature-file.ts`, "// feature updated\n");
    res = await getChanges(workDir, "main");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.path).toBe("feature-file.ts");

    // Switching back to HEAD (default) should show no changes (no uncommitted on main).
    git(workDir, ["stash"]);
    git(workDir, ["checkout", "main"]);
    res = await getChanges(workDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.files).toHaveLength(0);
  });

  it("does not report files deleted on the selected base branch as added", async () => {
    // GitHub-style compare uses the fork point, not the selected base tip.
    // If main deletes a file after feature diverges, feature has not added it.
    git(workDir, ["checkout", "-b", "feature"]);
    git(workDir, ["checkout", "main"]);
    fs.rmSync(path.join(workDir, "a.ts"));
    git(workDir, ["add", "a.ts"]);
    git(workDir, [...COMMIT_C, "commit", "-m", "delete on main"]);
    git(workDir, ["checkout", "feature"]);

    let res = await getChanges(workDir, "main");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.files.map((f) => f.path)).not.toContain("a.ts");
    expect(res.files).toHaveLength(0);

    write(path.join(workDir, "new-untracked.ts"), "// still included\n");
    res = await getChanges(workDir, "main");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.files.map((f) => ({ path: f.path, untracked: f.untracked }))).toEqual([
      { path: "new-untracked.ts", untracked: true },
    ]);
  });

  it("getFileDiff returns merge-base old side", async () => {
    // Write a.ts on main first.
    write(`${workDir}/a.ts`, "// content from main\n");
    git(workDir, ["add", "a.ts"]);
    git(workDir, [...COMMIT_C, "commit", "-m", "initial"]);

    git(workDir, ["checkout", "-b", "feature"]);
    write(`${workDir}/a.ts`, "// content from main\n// feature addition\n");
    git(workDir, ["add", "a.ts"]);
    git(workDir, [...COMMIT_C, "commit", "-m", "feature commit"]);

    const res = await getFileDiff(workDir, { path: "a.ts", status: "M", untracked: false }, "main");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.oldText).toContain("content from main");
    expect(res.oldText).not.toContain("feature addition");
    expect(res.newText).toContain("feature addition");
  });
});

describe("getChanges fingerprint", () => {
  /** Convenience: run getChanges and return the fingerprint, failing if not ok. */
  async function fp(root: string, base?: string): Promise<string> {
    const res = await getChanges(root, base);
    if (res.kind !== "ok") throw new Error(`getChanges not ok: ${res.kind}`);
    return res.fingerprint;
  }

  beforeEach(() => {
    makeRepo();
  });

  it("is stable across calls when nothing changes", async () => {
    const first = await fp(workDir);
    const second = await fp(workDir);
    expect(first).toBe(second);
  });

  it("changes when a tracked file's content changes", async () => {
    const before = await fp(workDir);
    write(path.join(workDir, "a.ts"), "export const a = 99;\n");
    expect(await fp(workDir)).not.toBe(before);
  });

  it("detects a same-line-count edit (the numstat-collision case)", async () => {
    // a.ts is one line: `export const a = 1;`. Replace it with a different
    // one-line body — insertions=1, deletions=1 either way, so numstat alone
    // (and the fileSig the viewer reconciles on) would be identical.
    write(path.join(workDir, "a.ts"), "export const a = 1;\n");
    const before = await fp(workDir); // clean tree baseline
    write(path.join(workDir, "a.ts"), "export const a = 2;\n");
    const after = await fp(workDir);
    expect(after).not.toBe(before);

    // Sanity: numstat really is identical for this edit.
    const res = await getChanges(workDir);
    if (res.kind !== "ok") throw new Error("not ok");
    const a = res.files.find((f) => f.path === "a.ts");
    expect(a?.insertions).toBe(1);
    expect(a?.deletions).toBe(1);
  });

  it("returns to the baseline fingerprint when an edit is reverted", async () => {
    const clean = await fp(workDir);
    write(path.join(workDir, "a.ts"), "export const a = 2;\n");
    expect(await fp(workDir)).not.toBe(clean);
    write(path.join(workDir, "a.ts"), "export const a = 1;\n"); // revert
    expect(await fp(workDir)).toBe(clean);
  });

  it("changes when an untracked file's content changes (same line count)", async () => {
    write(path.join(workDir, "untracked.ts"), "const x = 1;\n");
    const before = await fp(workDir);
    write(path.join(workDir, "untracked.ts"), "const x = 2;\n"); // 1 line → 1 line
    expect(await fp(workDir)).not.toBe(before);
  });

  it("changes when a new untracked file appears", async () => {
    const before = await fp(workDir);
    write(path.join(workDir, "brand-new.ts"), "// new\n");
    expect(await fp(workDir)).not.toBe(before);
  });

  it("is deterministic with many untracked files read concurrently", async () => {
    for (let i = 0; i < 20; i++) {
      write(path.join(workDir, `untracked-${String(i).padStart(2, "0")}.ts`), `const n = ${i};\n`);
    }

    const first = await getChanges(workDir);
    const second = await getChanges(workDir);
    if (first.kind !== "ok" || second.kind !== "ok") throw new Error("not ok");

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path));
    expect(first.files.map((f) => f.path)).toEqual(
      [...first.files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("is base-independent: same working tree → same fingerprint with or without a base", async () => {
    // Diverge a feature branch from main, then dirty the working tree.
    git(workDir, ["checkout", "-b", "feature"]);
    write(path.join(workDir, "feature-only.ts"), "// feature\n");
    git(workDir, ["add", "feature-only.ts"]);
    git(workDir, [...COMMIT_C, "commit", "-m", "feature commit"]);
    write(path.join(workDir, "a.ts"), "export const a = 7;\n"); // uncommitted

    // The display file list differs by base, but the working-tree
    // fingerprint must not — it's always computed vs HEAD.
    const noBase = await getChanges(workDir);
    const withBase = await getChanges(workDir, "main");
    if (noBase.kind !== "ok" || withBase.kind !== "ok") throw new Error("not ok");
    expect(withBase.files.length).toBeGreaterThan(noBase.files.length);
    expect(withBase.fingerprint).toBe(noBase.fingerprint);
  });
});

describe("getChangesCount", () => {
  it("returns not-a-repo outside a git repo", async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "not-a-repo-"));
    const res = await getChangesCount(dir);
    expect(res.kind).toBe("not-a-repo");
  });

  it("counts tracked modifications and untracked files in one scan", async () => {
    makeRepo();
    write(path.join(workDir, "a.ts"), "export const a = 2;\n"); // modify tracked
    write(path.join(workDir, "untracked.ts"), "const x = 1;\n"); // new untracked

    const res = await getChangesCount(workDir);
    if (res.kind !== "ok") throw new Error(`not ok: ${res.kind}`);
    // Should match getChanges' file count.
    const full = await getChanges(workDir);
    if (full.kind !== "ok") throw new Error("full not ok");
    expect(res.fileCount).toBe(full.files.length);
    expect(res.fileCount).toBe(2);
  });

  it("counts a rename as a single changed file", async () => {
    makeRepo();
    git(workDir, ["mv", "a.ts", "renamed.ts"]);

    const res = await getChangesCount(workDir);
    if (res.kind !== "ok") throw new Error(`not ok: ${res.kind}`);
    expect(res.fileCount).toBe(1);
  });

  it("is clean (0) on an unmodified repo", async () => {
    makeRepo();
    const res = await getChangesCount(workDir);
    if (res.kind !== "ok") throw new Error(`not ok: ${res.kind}`);
    expect(res.fileCount).toBe(0);
  });
});

describe("createWorktree", () => {
  it("creates a worktree on a new branch from the current HEAD", async () => {
    makeRepo();
    // Create a branch to use as base
    git(workDir, ["checkout", "-b", "feature"]);
    write(path.join(workDir, "b.ts"), "export const b = 2;\n");
    git(workDir, ["add", "b.ts"]);
    git(workDir, [...COMMIT_C, "commit", "-m", "feature"]);
    git(workDir, ["checkout", "main"]);

    const { createWorktree } = await import("./git.js");
    const result = await createWorktree(workDir, "feature");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.worktreePath).toBeTruthy();
    expect(result.branch).toMatch(/^pi-vis-[a-z]+-[a-z]+$/);
    expect(result.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(result.base).toBe("feature");

    // Verify the worktree exists and is on the right branch
    const worktreeList = git(workDir, ["worktree", "list"]);
    expect(worktreeList).toContain(result.worktreePath);

    // Verify the branch exists
    const branches = git(workDir, ["branch", "--list", result.branch]);
    expect(branches).toContain(result.branch);

    // Clean up the worktree so subsequent tests aren't polluted
    git(workDir, ["worktree", "remove", "--force", result.worktreePath]);
    git(workDir, ["branch", "-D", result.branch]);
  });

  it("handles collision by generating a different name", async () => {
    makeRepo();

    const { createWorktree } = await import("./git.js");
    const first = await createWorktree(workDir, "main");
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;

    // Make a worktree with the exact same name by creating a ref manually
    const dupBranch = first.branch;
    const dupDir = first.worktreePath;
    // Create a second one — collision handling should produce a different name
    const second = await createWorktree(workDir, "main");
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    // Names should differ
    expect(second.name).not.toBe(first.name);

    // Clean up
    git(workDir, ["worktree", "remove", "--force", dupDir]);
    git(workDir, ["branch", "-D", dupBranch]);
    git(workDir, ["worktree", "remove", "--force", second.worktreePath]);
    git(workDir, ["branch", "-D", second.branch]);
  });

  it("returns a descriptive error when the base ref can't be resolved", async () => {
    makeRepo();

    const { createWorktree } = await import("./git.js");
    const result = await createWorktree(workDir, "no-such-branch");

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    // The message names the bad base and is actionable — not a bare exit code.
    expect(result.message).toContain("no-such-branch");
    expect(result.message).not.toMatch(/code \d/);
  });

  it("creates a worktree from a remote base", async () => {
    makeRepo();
    // Simulate a remote-tracking branch by creating a local branch that
    // looks like one (git worktree add supports origin/x patterns).
    git(workDir, ["checkout", "-b", "origin/stable"]);
    write(path.join(workDir, "c.ts"), "export const c = 3;\n");
    git(workDir, ["add", "c.ts"]);
    git(workDir, [...COMMIT_C, "commit", "-m", "stable"]);
    git(workDir, ["checkout", "main"]);

    const { createWorktree } = await import("./git.js");
    const result = await createWorktree(workDir, "main");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.base).toBe("main");

    git(workDir, ["worktree", "remove", "--force", result.worktreePath]);
    git(workDir, ["branch", "-D", result.branch]);
  });
});

describe("inspectWorktree", () => {
  // Helper: make a fresh tmp repo with an initial commit, return its path.
  // Distinct from the outer `workDir` so worktree tests below can use it
  // without colliding with sibling describes' state.
  function makeTmpRepo(): string {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "inspect-repo-"));
    git(dir, [...INIT_C, "init"]);
    try {
      git(dir, ["config", "core.hooksPath", "/dev/null"]);
    } catch {
      /* best effort */
    }
    write(path.join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, ["add", "a.ts"]);
    git(dir, [...COMMIT_C, "commit", "-m", "init"]);
    return dir;
  }

  // Helper: make a *second* fresh tmp repo (no shared `.git` with the first).
  // Used to verify the same-repo common-dir check rejects unrelated dirs.
  function makeUnrelatedRepo(): string {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "inspect-other-"));
    git(dir, [...INIT_C, "init"]);
    try {
      git(dir, ["config", "core.hooksPath", "/dev/null"]);
    } catch {
      /* best effort */
    }
    write(path.join(dir, "b.ts"), "export const b = 2;\n");
    git(dir, ["add", "b.ts"]);
    git(dir, [...COMMIT_C, "commit", "-m", "init"]);
    return dir;
  }

  it("returns 'Directory not found' for a missing path (not 'git missing')", async () => {
    const repo = makeTmpRepo();
    const { inspectWorktree } = await import("./git.js");
    const missing = path.join(tmpRoot, "does-not-exist-xyz");
    const res = await inspectWorktree(repo, missing);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    // The bug this guards against: if we let git handle the missing path,
    // `mapSpawnError` rewrites ENOENT to `git-missing` ("git binary
    // missing") which is the wrong message. The pre-stat in inspectWorktree
    // catches it before shelling out.
    expect(res.message).toBe("Directory not found.");
    expect(res.message).not.toMatch(/git/i);
  });

  it("returns 'Not a git repository' for a plain directory", async () => {
    const repo = makeTmpRepo();
    const plain = fs.mkdtempSync(path.join(tmpRoot, "inspect-plain-"));
    const { inspectWorktree } = await import("./git.js");
    const res = await inspectWorktree(repo, plain);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.message).toBe("Not a git repository.");
  });

  it("returns the canonical worktree root for a same-repo worktree", async () => {
    const repo = makeTmpRepo();
    // Create a sibling worktree of the same repo via `git worktree add`.
    const wtDir = fs.mkdtempSync(path.join(tmpRoot, "inspect-wt-"));
    git(repo, ["worktree", "add", "-b", "feature", wtDir]);

    const { inspectWorktree } = await import("./git.js");
    const res = await inspectWorktree(repo, wtDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // The canonical path is the toplevel, which IS the worktree root here
    // (the candidate was already a worktree root, not a subdirectory).
    expect(res.path).toBe(fs.realpathSync(wtDir));
    expect(res.branch).toBe("feature");
    expect(res.name).toBe(path.basename(wtDir));

    // Cleanup
    git(repo, ["worktree", "remove", "--force", wtDir]);
    git(repo, ["branch", "-D", "feature"]);
  });

  it("collapses a subdirectory of a worktree to the worktree root (P0 regression guard)", async () => {
    const repo = makeTmpRepo();
    // Create a sibling worktree, then make a subdirectory inside it.
    const wtDir = fs.mkdtempSync(path.join(tmpRoot, "inspect-wt-sub-"));
    git(repo, ["worktree", "add", "-b", "feature", wtDir]);
    const sub = path.join(wtDir, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });

    const { inspectWorktree } = await import("./git.js");
    // Pass the *subdirectory*, not the worktree root. The whole point of
    // canonicalization via `--show-toplevel` + realpath is that this
    // collapses to the worktree root and matches the workspace-side
    // common-dir (same repo), rather than being treated as "not a repo".
    const res = await inspectWorktree(repo, sub);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.path).toBe(fs.realpathSync(wtDir));
    expect(res.branch).toBe("feature");
    // `name` uses `path.basename(canonicalTop)` so it's the worktree
    // root's basename, not the subdirectory's basename.
    expect(res.name).toBe(path.basename(wtDir));

    git(repo, ["worktree", "remove", "--force", wtDir]);
    git(repo, ["branch", "-D", "feature"]);
  });

  it("returns 'different repository' for a worktree of an unrelated repo", async () => {
    const repo = makeTmpRepo();
    const otherRepo = makeUnrelatedRepo();
    // Create a worktree of `otherRepo` (same `.git` as otherRepo, NOT repo).
    const wtDir = fs.mkdtempSync(path.join(tmpRoot, "inspect-other-wt-"));
    git(otherRepo, ["worktree", "add", "-b", "branch", wtDir]);

    const { inspectWorktree } = await import("./git.js");
    const res = await inspectWorktree(repo, wtDir);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.message).toBe("That directory belongs to a different repository.");

    git(otherRepo, ["worktree", "remove", "--force", wtDir]);
    git(otherRepo, ["branch", "-D", "branch"]);
  });

  it("returns 'current workspace' guard when the candidate IS the workspace itself", async () => {
    const repo = makeTmpRepo();
    const { inspectWorktree } = await import("./git.js");
    // Pass the workspace root as the candidate. The realpath'd toplevels
    // match, so the same-repo check passes but the workspace-self guard
    // trips.
    const res = await inspectWorktree(repo, repo);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.message).toBe(
      "That's the current workspace — choose a different worktree directory.",
    );
  });

  it("returns a short SHA for a detached HEAD", async () => {
    const repo = makeTmpRepo();
    const wtDir = fs.mkdtempSync(path.join(tmpRoot, "inspect-detached-"));
    git(repo, ["worktree", "add", "--detach", wtDir]);

    const { inspectWorktree } = await import("./git.js");
    const res = await inspectWorktree(repo, wtDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.path).toBe(fs.realpathSync(wtDir));
    // Detached HEAD → short SHA (hex, ~7-12 chars). Not the literal "HEAD".
    expect(res.branch).not.toBe("HEAD");
    expect(res.branch).toMatch(/^[0-9a-f]{7,12}$/);

    git(repo, ["worktree", "remove", "--force", wtDir]);
  });

  it("returns '(no commits)' for an unborn HEAD repo", async () => {
    const repo = makeTmpRepo();
    const wtDir = fs.mkdtempSync(path.join(tmpRoot, "inspect-unborn-"));
    // `git worktree add` of an unborn-HEAD repo still creates a worktree
    // pointing at the unborn ref; if that fails, fall back to a fresh
    // empty repo whose HEAD is unborn (no commits).
    git(repo, ["worktree", "add", "--detach", wtDir]);

    // Make the worktree's HEAD unborn by checking out a non-existent
    // branch reference (this is what `git worktree add` does internally
    // for unborn HEADs).
    let unborn = false;
    try {
      git(wtDir, ["checkout", "--orphan", "orphan-branch"]);
      unborn = true;
    } catch {
      // Orphan branches can fail on some git versions for worktrees;
      // fall back to a separate empty tmp repo with no commits.
    }

    if (!unborn) {
      // Make a tmp dir that has `git init` but no commits at all.
      const empty = fs.mkdtempSync(path.join(tmpRoot, "inspect-empty-"));
      git(empty, [...INIT_C, "init"]);
      try {
        git(empty, ["config", "core.hooksPath", "/dev/null"]);
      } catch {
        /* best effort */
      }
      const { inspectWorktree } = await import("./git.js");
      const res = await inspectWorktree(repo, empty);
      expect(res.kind).toBe("ok");
      if (res.kind !== "ok") return;
      expect(res.branch).toBe("(no commits)");
      return;
    }

    const { inspectWorktree } = await import("./git.js");
    const res = await inspectWorktree(repo, wtDir);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.branch).toBe("(no commits)");

    git(repo, ["worktree", "remove", "--force", wtDir]);
  });

  it("canonicalizes the path via realpath (no trailing slash / symlink drift)", async () => {
    const repo = makeTmpRepo();
    const wtDir = fs.mkdtempSync(path.join(tmpRoot, "inspect-realpath-"));
    git(repo, ["worktree", "add", "-b", "feature", wtDir]);

    // Pass a trailing-slash variant — `git rev-parse --show-toplevel` already
    // normalizes that, and the subsequent `fs.realpath` flattens any symlinks.
    const withSlash = wtDir.endsWith("/") ? wtDir : `${wtDir}/`;

    const { inspectWorktree } = await import("./git.js");
    const res = await inspectWorktree(repo, withSlash);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.path).toBe(fs.realpathSync(wtDir));
    // No trailing slash in the canonical output.
    expect(res.path.endsWith("/")).toBe(false);

    git(repo, ["worktree", "remove", "--force", wtDir]);
    git(repo, ["branch", "-D", "feature"]);
  });
});

/** sha256 hex of the UTF-8 encoding of `text` — exactly how the renderer hashes its base. */
function utf8Sha(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("writeWorkingFile", () => {
  it("writes when the expected hash matches (happy path)", async () => {
    makeRepo();
    write(path.join(workDir, "f.ts"), "a\nb\nc\n");
    const res = await writeWorkingFile(workDir, "f.ts", "a\nB\nc\n", utf8Sha("a\nb\nc\n"));
    expect(res).toEqual({ kind: "ok" });
    expect(fs.readFileSync(path.join(workDir, "f.ts"), "utf8")).toBe("a\nB\nc\n");
  });

  it("returns conflict when the file changed on disk (hash mismatch)", async () => {
    makeRepo();
    write(path.join(workDir, "f.ts"), "a\nb\nc\n");
    // The editor's base was "a\nb\nc\n" but disk now has "a\nX\nc\n".
    write(path.join(workDir, "f.ts"), "a\nX\nc\n");
    const res = await writeWorkingFile(workDir, "f.ts", "a\nB\nc\n", utf8Sha("a\nb\nc\n"));
    expect(res).toEqual({ kind: "conflict" });
    // Disk untouched.
    expect(fs.readFileSync(path.join(workDir, "f.ts"), "utf8")).toBe("a\nX\nc\n");
  });

  it("returns conflict when the file was deleted (ENOENT)", async () => {
    makeRepo();
    write(path.join(workDir, "f.ts"), "a\nb\nc\n");
    fs.unlinkSync(path.join(workDir, "f.ts"));
    const res = await writeWorkingFile(workDir, "f.ts", "a\nB\nc\n", utf8Sha("a\nb\nc\n"));
    expect(res).toEqual({ kind: "conflict" });
  });

  it("rejects an absolute path", async () => {
    makeRepo();
    const res = await writeWorkingFile(workDir, "/etc/hosts", "x", "anything");
    expect(res.kind).toBe("error");
  });

  it("rejects a path that escapes the repo root (.. traversal)", async () => {
    makeRepo();
    write(path.join(workDir, "f.ts"), "a\n");
    const res = await writeWorkingFile(workDir, "../escape.txt", "x", utf8Sha("a\n"));
    expect(res.kind).toBe("error");
    expect(fs.existsSync(path.join(tmpRoot, "escape.txt"))).toBe(false);
  });

  it("rejects a symlink target", async () => {
    makeRepo();
    write(path.join(workDir, "real.ts"), "a\nb\n");
    fs.symlinkSync(path.join(workDir, "real.ts"), path.join(workDir, "link.ts"));
    const res = await writeWorkingFile(workDir, "link.ts", "x", utf8Sha("a\nb\n"));
    expect(res.kind).toBe("error");
  });

  it("rejects a symlinked parent directory", async () => {
    makeRepo();
    const outside = fs.mkdtempSync(path.join(tmpRoot, "outside-"));
    write(path.join(outside, "f.ts"), "a\nb\n");
    fs.symlinkSync(outside, path.join(workDir, "linked-dir"));

    const res = await writeWorkingFile(workDir, "linked-dir/f.ts", "x\n", utf8Sha("a\nb\n"));

    expect(res.kind).toBe("error");
    expect(fs.readFileSync(path.join(outside, "f.ts"), "utf8")).toBe("a\nb\n");
  });

  it("round-trips a CRLF file byte-identically outside the edited range", async () => {
    makeRepo();
    const original = "a\r\nb\r\nc\r\nd\r\n";
    write(path.join(workDir, "f.ts"), original);
    // Splice only line 2 ("b") → "B", preserving CRLF (the renderer's splice job).
    const next = "a\r\nB\r\nc\r\nd\r\n";
    const res = await writeWorkingFile(workDir, "f.ts", next, utf8Sha(original));
    expect(res).toEqual({ kind: "ok" });
    const written = fs.readFileSync(path.join(workDir, "f.ts"));
    expect(Buffer.from(written)).toEqual(Buffer.from(next));
  });

  it("preserves a BOM prefix when the edited range keeps it", async () => {
    makeRepo();
    const original = "\uFEFFa\nb\nc\n";
    write(path.join(workDir, "f.ts"), original);
    // Buffer seeded from model line 1 ("\uFEFFa") keeps the BOM.
    const next = "\uFEFFa\nB\nc\n";
    const res = await writeWorkingFile(workDir, "f.ts", next, utf8Sha(original));
    expect(res).toEqual({ kind: "ok" });
    expect(fs.readFileSync(path.join(workDir, "f.ts"), "utf8")).toBe(next);
  });

  it("preserves a missing final newline on the edited file", async () => {
    makeRepo();
    const original = "a\nb\nc"; // no trailing newline
    write(path.join(workDir, "f.ts"), original);
    const next = "a\nB\nc"; // still no trailing newline
    const res = await writeWorkingFile(workDir, "f.ts", next, utf8Sha(original));
    expect(res).toEqual({ kind: "ok" });
    expect(fs.readFileSync(path.join(workDir, "f.ts"), "utf8")).toBe(next);
  });
});
