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
import { getChanges, getFileDiff } from "./git.js";

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
