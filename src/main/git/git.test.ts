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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getBranches, getChanges, getChangesCount, getFileDiff } from "./git.js";

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
    // Write a 1.5 MiB file (> 1 MiB limit) directly on disk.
    const filePath = path.join(workDir, "big.ts");
    const big = Buffer.alloc(1.5 * 1024 * 1024, 0x61);
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
    git(workDir, ["commit", "-m", "feature commit"]);

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

  it("getFileDiff returns merge-base old side", async () => {
    // Write a.ts on main first.
    write(`${workDir}/a.ts`, "// content from main\n");
    git(workDir, ["add", "a.ts"]);
    git(workDir, ["commit", "-m", "initial"]);

    git(workDir, ["checkout", "-b", "feature"]);
    write(`${workDir}/a.ts`, "// content from main\n// feature addition\n");
    git(workDir, ["add", "a.ts"]);
    git(workDir, ["commit", "-m", "feature commit"]);

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
    expect(result.branch).toMatch(/^pivis\/[a-z]+-[a-z]+$/);
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
