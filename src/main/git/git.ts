// Main-process git module — IPC backend for the diff viewer.
//
// Design notes (matching the WP1 spec):
//   - Always spawn `git` via `execFile` with arg arrays; never a shell. The
//     args form is the only one that handles spaces/unicode in paths
//     portably across platforms.
//   - Use `-z` for every path-emitting command so paths with spaces / newlines
//     / unicode round-trip through NULs as a single token.
//   - All commands run with `cwd = repoRoot` (or the input root, when no
//     repo exists yet) and a 15s timeout. 64 MiB maxBuffer is generous for
//     lists, but file contents go through readFile (no buffering concern).
//   - Errors never throw across IPC. They become typed `GitChangesResult` /
//     `GitFileDiffResult` variants the renderer can pattern-match on.
//   - `ENOENT` on the git binary is special-cased to `git-missing` so the
//     renderer can show a specific empty state.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  GitBranchesResult,
  GitChangedFile,
  GitChangesResult,
  GitFileDiffResult,
  GitFileStatus,
  GitWorktreeResult,
} from "@shared/git.js";
import { getSubprocessEnv } from "../auth.js";

// ── Tunables (kept in one place so they're easy to find) ──────────────

/** Hard cap on the number of files we surface in a single diff. */
const MAX_FILES = 500;
/** Cap on the number of untracked files we count line insertions for. */
const UNTRACKED_COUNT_LIMIT = 200;
/** Above this many bytes, skip line counting and just mark the file. */
const UNTRACKED_SKIP_SIZE = 1024 * 1024; // 1 MiB
/** Above this many bytes, refuse to read the contents. */
const FILE_TOO_LARGE = 1024 * 1024; // 1 MiB
/** Number of leading bytes to sniff for a NUL when detecting binary. */
const BINARY_SNIFF_BYTES = 8192;
/** Process timeout for every git invocation. */
const GIT_TIMEOUT_MS = 15_000;
/** Buffer ceiling — list output is small; file contents are read via fs. */
const MAX_BUFFER = 64 * 1024 * 1024;
/** Git's well-known empty-tree object — used to diff a HEAD-less repo's
 *  working tree against "nothing" for the content fingerprint. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ── exec helpers ───────────────────────────────────────────────────────

/** Returns the text stdout of `git <args>` in `cwd`, or throws. */
function execGitText(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf8",
        env: env ?? process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          // execFile attaches a code for non-zero exits; pass it through.
          const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string };
          (e as { stderr?: string }).stderr = typeof stderr === "string" ? stderr : "";
          reject(e);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

/** Like execGitText but only resolves with the exit code (no stdout). */
function execGitQuiet(args: string[], cwd: string, env?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        encoding: "utf8",
        env: env ?? process.env,
      },
      (err) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string; status?: number };
          resolve(typeof e.code === "number" ? e.code : 1);
          return;
        }
        resolve(0);
      },
    );
  });
}

// ── Public: getChanges ─────────────────────────────────────────────────

/** Resolve a base ref: returns "HEAD" for the default, or `git merge-base <base> HEAD` for a selected branch.
 *  Falls back to `base` itself if merge-base fails (unrelated histories).
 */
async function resolveBaseRef(
  base: string | undefined | null,
  repoRoot: string,
  env: Record<string, string>,
): Promise<string> {
  if (!base || base === "HEAD") return "HEAD";
  try {
    const r = await execGitText(["merge-base", base, "HEAD"], repoRoot, env);
    const sha = r.stdout.trim();
    if (sha) return sha;
  } catch {
    // fall through to fallback
  }
  return base;
}

export async function getChanges(root: string, base?: string): Promise<GitChangesResult> {
  // Step 1: confirm the binary is present and `root` is inside a repo.
  const env = await getSubprocessEnv();
  let repoRoot: string;
  try {
    const r = await execGitText(["rev-parse", "--show-toplevel"], root, env);
    repoRoot = r.stdout.trim();
  } catch (err) {
    return mapSpawnError(err);
  }
  if (!repoRoot) return { kind: "not-a-repo" };

  // Step 2: has HEAD? Fresh repos have no commits.
  let hasHead = false;
  try {
    const code = await execGitQuiet(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot, env);
    hasHead = code === 0;
  } catch {
    hasHead = false;
  }

  // Build a destination-path → numstat tuple map. Renames have two
  // associated paths; we key by destination.
  type CountTuple = { insertions: number; deletions: number; binary: boolean };
  const counts = new Map<string, CountTuple>();
  const tracked: GitChangedFile[] = [];

  if (hasHead) {
    const baseRef = await resolveBaseRef(base, repoRoot, env);

    // Step 3a: statuses.
    let statusOut = "";
    try {
      const r = await execGitText(["diff", "--name-status", "-z", "-M", baseRef], repoRoot, env);
      statusOut = r.stdout;
    } catch (err) {
      return { kind: "error", message: errorMessage(err) };
    }
    const parsed = parseNameStatus(statusOut);
    tracked.push(...parsed);

    // Step 3b: numstat. Empty path before the NUL marks a two-path entry
    // (rename or copy); in that case the FIRST path is the old path and
    // the SECOND is the new path.
    let numstatOut = "";
    try {
      const r = await execGitText(["diff", "--numstat", "-z", "-M", baseRef], repoRoot, env);
      numstatOut = r.stdout;
    } catch (err) {
      // numstat on binary files can throw; we still have the statuses.
      numstatOut = "";
      console.warn("git diff --numstat failed:", err);
    }
    for (const e of parseNumstat(numstatOut)) {
      counts.set(e.path, { insertions: e.insertions, deletions: e.deletions, binary: e.binary });
    }
  } else {
    // Step 4: no HEAD → all known files are "added" relative to an empty
    // tree. We treat `git ls-files --cached` as the added set.
    let lsOut = "";
    try {
      const r = await execGitText(["ls-files", "--cached", "-z"], repoRoot, env);
      lsOut = r.stdout;
    } catch (err) {
      return { kind: "error", message: errorMessage(err) };
    }
    const files = splitNul(lsOut).filter((p) => p.length > 0);
    for (const p of files) {
      tracked.push({
        path: p,
        status: "A",
        untracked: false,
        insertions: 0,
        deletions: 0,
        binary: false,
      });
    }
  }

  // Working-tree content fingerprint. Always computed vs HEAD (never the
  // display `base`), so a no-base badge refresh and a base-scoped viewer
  // refresh produce identical, comparable fingerprints. Hashing the full
  // patch text — not just numstat — closes the line-count-collision case
  // (an edit that preserves insertions/deletions but changes content).
  // Untracked files never appear in `git diff`, so they're folded in
  // separately during the read loop below.
  const fpHash = createHash("sha1");
  {
    const fpRef = hasHead ? "HEAD" : EMPTY_TREE_SHA;
    try {
      const r = await execGitText(["diff", "-M", "--no-color", fpRef], repoRoot, env);
      fpHash.update(r.stdout);
    } catch (err) {
      // Non-fatal (e.g. a pathologically large diff exceeding maxBuffer):
      // fold the error in so the fingerprint is stable for an unchanged
      // failing state rather than silently masking real edits.
      fpHash.update(`__diff_error__:${errorMessage(err)}`);
    }
  }
  fpHash.update("\0untracked\0");

  // Step 5: untracked files.
  const untracked: GitChangedFile[] = [];
  let untrackedOut = "";
  try {
    const r = await execGitText(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      repoRoot,
      env,
    );
    untrackedOut = r.stdout;
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
  const untrackedPaths = splitNul(untrackedOut).filter((p) => p.length > 0);
  for (let i = 0; i < untrackedPaths.length; i++) {
    const p = untrackedPaths[i];
    if (p === undefined) continue;
    const counted = i < UNTRACKED_COUNT_LIMIT;
    let insertions = 0;
    let binary = false;
    // Per-file fingerprint descriptor. The path is always hashed (so a
    // new/removed untracked file moves the fingerprint); content is hashed
    // for files we read anyway, falling back to size for binary/large ones.
    // Files past UNTRACKED_COUNT_LIMIT contribute only their path (no stat,
    // matching the line-counter's cap) — a content-only edit to one of those
    // won't move the fingerprint, which the `fingerprint` doc notes.
    // Reuses the read the line-counter already does — no extra I/O.
    let fileFp = "uncounted";
    if (counted) {
      const filePath = path.join(repoRoot, p);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && stat.size <= UNTRACKED_SKIP_SIZE) {
          const fd = await fs.open(filePath, "r");
          try {
            const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
            const { bytesRead } = await fd.read(buf, 0, BINARY_SNIFF_BYTES, 0);
            if (hasNulByte(buf.subarray(0, bytesRead))) {
              binary = true;
              fileFp = `bin:${stat.size}`;
            } else {
              const full = await fs.readFile(filePath, "utf8");
              insertions = countLines(full);
              fileFp = full;
            }
          } finally {
            await fd.close();
          }
        } else {
          // Directory, non-file, or over the read cap — size is the only
          // cheap content proxy.
          fileFp = `skip:${stat.size}`;
        }
      } catch (err) {
        // Skip-on-error: a file may have been deleted between ls-files
        // and our read. Drop counts rather than fail the whole call.
        fileFp = "err";
        console.warn("untracked read failed:", p, err);
      }
    }
    fpHash.update(p);
    fpHash.update("\0");
    fpHash.update(fileFp);
    fpHash.update("\0");
    untracked.push({
      path: p,
      status: "A",
      untracked: true,
      insertions,
      deletions: 0,
      binary,
    });
  }

  // Stitch counts onto tracked entries by destination path.
  // Renames appear in numstat with destination as the second path
  // (and empty first path); the parser keys by destination, which is
  // `f.path` for renames too, so the lookup is identical.
  const trackedWithCounts: GitChangedFile[] = tracked.map((f) => {
    const c = counts.get(f.path);
    if (!c) return f;
    return {
      ...f,
      insertions: c.insertions,
      deletions: c.deletions,
      binary: c.binary,
    };
  });

  const all = [...trackedWithCounts, ...untracked];

  // Step 6: guard rails. Sort first so truncation is deterministic
  // alphabetically.
  all.sort((a, b) => a.path.localeCompare(b.path));
  const truncated = all.length > MAX_FILES;
  const capped = truncated ? all.slice(0, MAX_FILES) : all;

  return {
    kind: "ok",
    repoRoot,
    files: capped,
    truncated,
    fingerprint: fpHash.digest("hex"),
  };
}

// ── Public: getFileDiff ────────────────────────────────────────────────

export async function getFileDiff(
  root: string,
  file: { path: string; oldPath?: string; status: GitFileStatus; untracked: boolean },
  base?: string,
): Promise<GitFileDiffResult> {
  const env = await getSubprocessEnv();
  // Re-resolve the repo root so callers (incl. stale tabs) can pass an
  // arbitrary path. We re-do this rather than caching because git
  // status can change in a heartbeat.
  let repoRoot: string;
  try {
    const r = await execGitText(["rev-parse", "--show-toplevel"], root, env);
    repoRoot = r.stdout.trim();
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
  if (!repoRoot) return { kind: "error", message: "Not a git repository" };

  // hasHead?
  let hasHead = false;
  try {
    const code = await execGitQuiet(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot, env);
    hasHead = code === 0;
  } catch {
    hasHead = false;
  }

  // Resolve base ref for old-side reads.
  const baseRef = await resolveBaseRef(base, repoRoot, env);

  // Old side.
  let oldText = "";
  let oldMissingNewline = false;
  const wantOld = !file.untracked && file.status !== "A" && hasHead;
  if (wantOld) {
    const showPath = file.oldPath ?? file.path;
    try {
      const r = await execGitText(["show", `${baseRef}:${showPath}`], repoRoot, env);
      oldText = r.stdout;
      oldMissingNewline = oldText.length > 0 && !oldText.endsWith("\n");
    } catch (err) {
      // Race tolerance: file may have been renamed/removed. Drop the
      // old side, but still show a diff against an empty old.
      console.warn(`git show ${baseRef}:${showPath} failed:`, err);
      oldText = "";
    }
  }

  // New side.
  let newText = "";
  let newMissingNewline = false;
  if (file.status !== "D") {
    const filePath = path.join(repoRoot, file.path);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > FILE_TOO_LARGE) {
        return {
          kind: "ok",
          oldText,
          newText: "",
          binary: false,
          tooLarge: true,
          oldMissingNewline,
          newMissingNewline,
        };
      }
      newText = await fs.readFile(filePath, "utf8");
      newMissingNewline = newText.length > 0 && !newText.endsWith("\n");
    } catch (err) {
      // ENOENT (or any other error) → empty new side. The file may have
      // vanished between the list and the click.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`readFile ${filePath} failed:`, err);
      }
      newText = "";
    }
  }

  // Binary sniff on both sides. We operate on the *text* we already
  // loaded; if the file is binary and the OS read the bytes as utf8
  // with replacement characters, we still want to flag it.
  const oldBinary = file.status !== "A" && hasBinaryAtStart(oldText);
  const newBinary = file.status !== "D" && hasBinaryAtStart(newText);

  return {
    kind: "ok",
    oldText,
    newText,
    binary: oldBinary || newBinary,
    tooLarge: false,
    oldMissingNewline,
    newMissingNewline,
  };
}

// ── Parsers (NUL-delimited) ────────────────────────────────────────────

/**
 * Parse the output of `git diff --name-status -z -M`.
 * Grammar (per git docs):
 *   STATUS NUL path NUL                 (most cases)
 *   STATUS+SCORE NUL oldPath NUL newPath NUL   (R / C)
 */
function parseNameStatus(out: string): GitChangedFile[] {
  const tokens = splitNul(out);
  const out2: GitChangedFile[] = [];
  for (let i = 0; i < tokens.length; ) {
    const head = tokens[i];
    if (head === undefined || head === "") {
      i++;
      continue;
    }
    const statusChar = head[0];
    if (statusChar === "R" || statusChar === "C") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 3;
      if (!oldPath || !newPath) continue;
      out2.push({
        path: newPath,
        oldPath,
        status: statusChar === "C" ? "A" : "R",
        untracked: false,
        insertions: 0,
        deletions: 0,
        binary: false,
      });
      continue;
    }
    const path = tokens[i + 1];
    i += 2;
    if (!path) continue;
    out2.push({
      path,
      status: normalizeStatus(statusChar),
      untracked: false,
      insertions: 0,
      deletions: 0,
      binary: false,
    });
  }
  return out2;
}

/**
 * Parse the output of `git diff --numstat -z -M`.
 * Grammar:
 *   ins TAB del TAB path NUL                              (most cases)
 *   ins TAB del TAB NUL oldPath NUL newPath NUL           (R / C)
 * A `-` for ins or del means binary.
 */
function parseNumstat(
  out: string,
): Array<{ path: string; insertions: number; deletions: number; binary: boolean }> {
  const result: Array<{ path: string; insertions: number; deletions: number; binary: boolean }> =
    [];
  // We split on NUL first, then re-glue consecutive entries where
  // a record is `ins\tdel\t` (with empty path), which is the rename form.
  const tokens = splitNul(out);
  for (let i = 0; i < tokens.length; ) {
    const head = tokens[i];
    if (head === undefined || head === "") {
      i++;
      continue;
    }
    // head = "ins\tdel\t[path]" (trailing tab included in head because
    // we split on NUL, not on tab).
    const tab1 = head.indexOf("\t");
    if (tab1 < 0) {
      i++;
      continue;
    }
    const rest = head.slice(tab1 + 1);
    const tab2 = rest.indexOf("\t");
    if (tab2 < 0) {
      i++;
      continue;
    }
    const insStr = head.slice(0, tab1);
    const delStr = rest.slice(0, tab2);
    const headPath = rest.slice(tab2 + 1);
    if (headPath === "") {
      // Rename: tokens[i+1] = oldPath, tokens[i+2] = newPath.
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 3;
      if (!oldPath || !newPath) continue;
      const binary = insStr === "-" || delStr === "-";
      result.push({
        path: newPath,
        insertions: binary ? 0 : Number.parseInt(insStr, 10) || 0,
        deletions: binary ? 0 : Number.parseInt(delStr, 10) || 0,
        binary,
      });
      continue;
    }
    const binary = insStr === "-" || delStr === "-";
    result.push({
      path: headPath,
      insertions: binary ? 0 : Number.parseInt(insStr, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(delStr, 10) || 0,
      binary,
    });
    i++;
  }
  return result;
}

// ── Small helpers ──────────────────────────────────────────────────────

/** Split a NUL-delimited buffer into a string[]. Tolerates a trailing NUL. */
function splitNul(buf: string): string[] {
  // split('\0') always emits a trailing empty string; we drop it.
  const parts = buf.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function normalizeStatus(ch: string | undefined): GitFileStatus {
  if (ch === "M" || ch === "A" || ch === "D" || ch === "R") return ch;
  // T (type change) and U (unmerged) collapse to "M" for the viewer.
  return "M";
}

function hasNulByte(buf: Buffer): boolean {
  // Buffer.indexOf is O(n) and very fast; this is the canonical binary
  // sniff recipe (also what `git diff` does internally).
  return buf.indexOf(0) !== -1;
}

function hasBinaryAtStart(text: string): boolean {
  // We sniff the head of the *decoded* text. UTF-8 with replacement
  // chars (U+FFFD) is a strong signal that the source had NULs.
  if (text.length === 0) return false;
  const head = text.slice(0, BINARY_SNIFF_BYTES);
  return head.includes("\u0000") || head.includes("\uFFFD");
}

function countLines(text: string): number {
  // Counting by splitting is the right call: 1 MiB is nothing, and
  // it correctly counts a trailing newline as a non-line (the
  // TUI's `wc -l` does the same).
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

/**
 * List branches for a repository.
 */
export async function getBranches(root: string): Promise<GitBranchesResult> {
  try {
    const env = await getSubprocessEnv();
    const revParseRes = await execGitText(["rev-parse", "--show-toplevel"], root, env);
    const repoRoot = revParseRes.stdout.trim();
    if (!repoRoot) return { kind: "not-a-repo" };

    // Current branch.
    let current: string | null = null;
    try {
      const curRes = await execGitText(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, env);
      const cur = curRes.stdout.trim();
      if (cur && cur !== "HEAD") current = cur;
    } catch {
      // detached HEAD — current stays null
    }

    // Local branches.
    const localRes = await execGitText(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      repoRoot,
      env,
    );
    const locals = localRes.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((name) => ({
        name,
        remote: false,
        current: name === current,
      }));

    // Remote-tracking branches.
    const remoteRes = await execGitText(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
      repoRoot,
      env,
    );
    const remotes = remoteRes.stdout
      .trim()
      .split("\n")
      .filter((n) => n && n !== "origin/HEAD")
      .map((name) => ({
        name,
        remote: true,
        current: false,
      }));

    const branches = [...locals, ...remotes];
    return { kind: "ok", current, branches };
  } catch (err) {
    return mapSpawnErrorBranches(err);
  }
}

function mapSpawnErrorBranches(err: unknown): GitBranchesResult {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { kind: "git-missing" };
  const stderr = (err as { stderr?: string }).stderr ?? "";
  const msg = errorMessage(err);
  if (/not a git repository/i.test(stderr) || /not a git repository/i.test(msg)) {
    return { kind: "not-a-repo" };
  }
  return { kind: "error", message: errorMessage(err) };
}

// ── Public: createWorktree ────────────────────────────────────────────

/**
 * Create a disconnected git worktree on a fresh branch.
 * Returns the worktree path, branch name, friendly name, and base.
 * Collision-safe: if the branch ref or dir already exists, re-rolls
 * the name a few times before appending a suffix.
 */
export async function createWorktree(root: string, base: string): Promise<GitWorktreeResult> {
  try {
    const env = await getSubprocessEnv();
    // Resolve the repo root
    const r = await execGitText(["rev-parse", "--show-toplevel"], root, env);
    const repoRoot = r.stdout.trim();
    if (!repoRoot) return { kind: "error", message: "Not a git repository" };

    const repoName = path.basename(repoRoot);
    const parentDir = path.dirname(repoRoot);
    const worktreesRoot = path.join(parentDir, `${repoName}-worktrees`);
    await fs.mkdir(worktreesRoot, { recursive: true });

    // Import the name generator (lazy to avoid circular deps if any).
    const { generateWorktreeName } = await import("./worktree-names.js");

    // Try up to 5 names, then append -2, -3, etc.
    let name = generateWorktreeName();
    let attempts = 0;
    const MAX_ATTEMPTS = 5;

    const collision = async (n: string): Promise<boolean> => {
      const branchRef = `pivis/${n}`;
      // Check branch existence
      try {
        await execGitText(["rev-parse", "--verify", "--quiet", branchRef], repoRoot, env);
        return true; // branch exists
      } catch {
        // branch doesn't exist — good
      }
      // Check directory existence
      const dir = path.join(worktreesRoot, n);
      try {
        await fs.stat(dir);
        return true; // directory exists
      } catch {
        return false; // no collision
      }
    };

    while (await collision(name)) {
      attempts++;
      if (attempts < MAX_ATTEMPTS) {
        name = generateWorktreeName();
      } else {
        // Last-resort suffix
        const suffix = attempts - MAX_ATTEMPTS + 2;
        name = `${generateWorktreeName()}-${suffix}`;
      }
    }

    const branch = `pivis/${name}`;
    const worktreePath = path.join(worktreesRoot, name);

    // `git worktree add -b <branch> <path> <base>`
    const exitCode = await execGitQuiet(
      ["worktree", "add", "-b", branch, worktreePath, base],
      repoRoot,
      env,
    );

    if (exitCode !== 0) {
      return { kind: "error", message: `git worktree add failed with code ${exitCode}` };
    }

    return { kind: "ok", worktreePath, branch, name, base };
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}

function mapSpawnError(err: unknown): GitChangesResult {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { kind: "git-missing" };
  // "not a git repository" is the error we get from `rev-parse
  // --show-toplevel` outside a repo. We match by stderr content
  // (the only reliable cross-platform signal) and by the English
  // substring git emits.
  const stderr = (err as { stderr?: string }).stderr ?? "";
  const msg = errorMessage(err);
  if (/not a git repository/i.test(stderr) || /not a git repository/i.test(msg)) {
    return { kind: "not-a-repo" };
  }
  return { kind: "error", message: errorMessage(err) };
}
