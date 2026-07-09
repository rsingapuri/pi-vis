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

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import type {
  GitBranchesResult,
  GitChangedFile,
  GitChangesCountResult,
  GitChangesResult,
  GitFileDiffResult,
  GitFileStatus,
  GitWorktreeInspect,
  GitWorktreeResult,
  GitWriteFileResult,
} from "@shared/git.js";
import { getSubprocessEnv } from "../auth.js";
import { mapLimit } from "../util/concurrency.js";

// ── Tunables (kept in one place so they're easy to find) ──────────────

/** Hard cap on the number of files we surface in a single diff. */
const MAX_FILES = 500;
/** Cap on the number of untracked files we count line insertions for. */
const UNTRACKED_COUNT_LIMIT = 200;
/** Above this many bytes, skip line counting and just mark the file. */
const UNTRACKED_SKIP_SIZE = 1024 * 1024; // 1 MiB
/** Default cap on the working-tree file bytes the diff viewer will read.
 *  Overridable per-call (from the `diffMaxFileSizeMiB` setting); above the
 *  effective cap, getFileDiff returns a `tooLarge` marker. The renderer's
 *  per-side line cap (TOO_LARGE_LINE_TOTAL in diff-model.ts) is the other
 *  guard; keep the two roughly in step. */
const FILE_TOO_LARGE_DEFAULT = 5 * 1024 * 1024; // 5 MiB
/** Number of leading bytes to sniff for a NUL when detecting binary. */
const BINARY_SNIFF_BYTES = 8192;
/** Process timeout for every (fast) git invocation. */
const GIT_TIMEOUT_MS = 15_000;
/** Generous timeout for `git worktree add`, which performs a full
 *  working-tree checkout — on large repos this can take minutes, far past
 *  the 15s default that governs the cheap read-only commands. */
const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000; // 10 minutes
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

/** Outcome of {@link execGitCapture} — never throws, so callers can build a
 *  rich error message from stderr / the kill signal instead of just a code. */
interface GitExecResult {
  /** Exit code (0 on success). 1 is the catch-all when no numeric code is set
   *  (e.g. the process was killed by a signal). */
  code: number;
  stdout: string;
  stderr: string;
  /** The signal that killed the process, if any (e.g. "SIGTERM" on timeout). */
  signal: NodeJS.Signals | null;
  /** True when execFile aborted the process because it exceeded `timeoutMs`. */
  timedOut: boolean;
}

/**
 * Run `git <args>` capturing stdout, stderr, exit code, and kill signal
 * without ever rejecting. Unlike {@link execGitQuiet} (which collapses every
 * failure to a bare code and discards the reason), this preserves git's own
 * stderr so the UI can show *why* a command failed.
 *
 * `timeoutMs` defaults to the standard short budget but is overridable —
 * long-running plumbing like `git worktree add` (a full working-tree
 * checkout) needs a far larger budget on big repos, where the 15s default
 * would otherwise SIGTERM the checkout and surface as a meaningless "code 1".
 */
function execGitCapture(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitExecResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
        encoding: "utf8",
        env: env ?? process.env,
      },
      (err, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const errOut = typeof stderr === "string" ? stderr : "";
        if (err) {
          const e = err as NodeJS.ErrnoException & {
            code?: number | string;
            signal?: NodeJS.Signals | null;
            killed?: boolean;
          };
          const signal = e.signal ?? null;
          // execFile sets `killed` when it terminates the process for exceeding
          // the timeout; the signal is the configured killSignal (SIGTERM).
          const timedOut = e.killed === true;
          resolve({
            code: typeof e.code === "number" ? e.code : 1,
            stdout: out,
            stderr: errOut,
            signal,
            timedOut,
          });
          return;
        }
        resolve({ code: 0, stdout: out, stderr: errOut, signal: null, timedOut: false });
      },
    );
  });
}

function execGitDigest(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ ok: true; digest: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const hash = createHash("sha1");
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    const child = spawn("git", args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    const finish = (result: { ok: true; digest: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => hash.update(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > 8192 && stderrChunks.length > 1) {
        const removed = stderrChunks.shift();
        if (removed) stderrBytes -= removed.length;
      }
    });
    child.on("error", (err) => finish({ ok: false, error: errorMessage(err) }));
    child.on("close", (code, signal) => {
      if (code === 0) finish({ ok: true, digest: hash.digest("hex") });
      else {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        finish({
          ok: false,
          error: stderr || `git exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
        });
      }
    });
  });
}

interface UntrackedMeta {
  file: GitChangedFile;
  fingerprint: string;
}

async function readUntrackedMeta(
  repoRoot: string,
  p: string,
  counted: boolean,
): Promise<UntrackedMeta> {
  let insertions = 0;
  let binary = false;
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
            const content = await fs.readFile(filePath);
            insertions = countLines(content.toString("utf8"));
            fileFp = createHash("sha1").update(content).digest("hex");
          }
        } finally {
          await fd.close();
        }
      } else {
        fileFp = `skip:${stat.size}`;
      }
    } catch (err) {
      fileFp = "err";
      console.warn("untracked read failed:", p, err);
    }
  }
  return {
    fingerprint: fileFp,
    file: { path: p, status: "A", untracked: true, insertions, deletions: 0, binary },
  };
}

// ── Public: getChanges ─────────────────────────────────────────────────

/** Resolve the comparison base for GitHub-style branch diffs.
 *  The selected branch is treated as the merge target, so compare from the
 *  latest common ancestor (`git merge-base <base> HEAD`) rather than from the
 *  selected branch tip. Otherwise files deleted on the base branch after the
 *  local branch forked would appear as locally-added files.
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
  // This is the heavyweight path: it computes the file list, per-file line
  // counts, AND the working-tree fingerprint (a hash of the entire patch).
  // The header badge while the viewer is closed only needs a file count, so
  // it uses the much cheaper `getChangesCount` instead — this function is
  // reserved for the open viewer (and its staleness probe), which needs all
  // of it.
  //
  // Step 1: confirm the binary is present and `root` is inside a repo.
  // GIT_OPTIONAL_LOCKS=0 keeps these read-only commands from taking
  // index.lock to rewrite the index stat cache — it avoids contention now
  // that the diffs below run concurrently, and trims a small write.
  const env = { ...(await getSubprocessEnv()), GIT_OPTIONAL_LOCKS: "0" };
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

  // Working-tree content fingerprint. Always computed vs HEAD (never the
  // display `base`), so a no-base badge refresh and a base-scoped viewer
  // refresh produce identical, comparable fingerprints. Launched up front
  // so it runs concurrently with the status/numstat/untracked reads — it's
  // independent of all of them. (Untracked files never appear in `git
  // diff`, so they're folded into the hash separately, in the read loop.)
  const fpRef = hasHead ? "HEAD" : EMPTY_TREE_SHA;
  const fpDiffPromise = execGitDigest(["diff", "-M", "--no-color", fpRef], repoRoot, env);

  // Untracked listing is independent of the tracked-file work below — kick
  // it off now so it overlaps with merge-base resolution and the diffs.
  const untrackedListPromise = execGitText(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repoRoot,
    env,
  )
    .then((r) => ({ ok: true as const, out: r.stdout }))
    .catch((err) => ({ ok: false as const, err }));

  // Build a destination-path → numstat tuple map. Renames have two
  // associated paths; we key by destination.
  type CountTuple = { insertions: number; deletions: number; binary: boolean };
  const counts = new Map<string, CountTuple>();
  const tracked: GitChangedFile[] = [];

  if (hasHead) {
    const baseRef = await resolveBaseRef(base, repoRoot, env);

    // Step 3: name-status and numstat are independent reads → run them
    // concurrently. Each resolves to a sentinel (never rejects) so a
    // numstat failure on binary files doesn't sink the whole call.
    const [statusR, numstatOut] = await Promise.all([
      execGitText(["diff", "--name-status", "-z", "-M", baseRef], repoRoot, env)
        .then((r) => ({ ok: true as const, out: r.stdout }))
        .catch((err) => ({ ok: false as const, err })),
      execGitText(["diff", "--numstat", "-z", "-M", baseRef], repoRoot, env)
        .then((r) => r.stdout)
        .catch((err) => {
          // numstat on binary files can throw; we still have the statuses.
          console.warn("git diff --numstat failed:", err);
          return "";
        }),
    ]);
    if (!statusR.ok) return { kind: "error", message: errorMessage(statusR.err) };
    tracked.push(...parseNameStatus(statusR.out));

    // numstat: empty path before the NUL marks a two-path entry (rename or
    // copy); in that case the FIRST path is the old path and the SECOND is
    // the new path.
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

  // Fold the working-tree patch digest (launched concurrently above) into the
  // fingerprint. On failure, fold a stable sentinel preserving the old
  // "error participates in fingerprint" semantics without buffering stdout.
  const fpHash = createHash("sha1");
  const diffDigest = await fpDiffPromise;
  fpHash.update(diffDigest.ok ? diffDigest.digest : `__diff_error__:${diffDigest.error}`);
  fpHash.update("\0untracked\0");

  // Step 5: untracked files (listing launched concurrently above).
  const untrackedListed = await untrackedListPromise;
  if (!untrackedListed.ok) {
    return { kind: "error", message: errorMessage(untrackedListed.err) };
  }
  const untrackedPaths = splitNul(untrackedListed.out).filter((p) => p.length > 0);
  const untrackedMeta = await mapLimit(untrackedPaths, 8, (p, i) =>
    readUntrackedMeta(repoRoot, p, i < UNTRACKED_COUNT_LIMIT),
  );
  const untracked: GitChangedFile[] = [];
  for (let i = 0; i < untrackedPaths.length; i++) {
    const p = untrackedPaths[i];
    const meta = untrackedMeta[i];
    if (p === undefined || meta === undefined) continue;
    fpHash.update(p);
    fpHash.update("\0");
    fpHash.update(meta.fingerprint);
    fpHash.update("\0");
    untracked.push(meta.file);
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

// ── Public: getChangesCount ────────────────────────────────────────────
//
// The header badge (while the diff viewer is closed) only needs a count of
// changed files — not line counts, not a fingerprint, not file contents. On
// a huge working tree, `getChanges` runs four tree scans (name-status,
// numstat, the fingerprint patch, ls-files) plus up to 200 untracked file
// reads; this needs exactly one.
//
// `git status --porcelain=v2` reports tracked changes AND untracked files in
// a single working-tree walk, so we count its records and stop. Capped at
// MAX_FILES to match the (capped) count `getChanges` returns for the viewer.
export async function getChangesCount(root: string): Promise<GitChangesCountResult> {
  const env = { ...(await getSubprocessEnv()), GIT_OPTIONAL_LOCKS: "0" };
  let repoRoot: string;
  try {
    const r = await execGitText(["rev-parse", "--show-toplevel"], root, env);
    repoRoot = r.stdout.trim();
  } catch (err) {
    return mapSpawnError(err);
  }
  if (!repoRoot) return { kind: "not-a-repo" };

  let out: string;
  try {
    const r = await execGitText(
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      repoRoot,
      env,
    );
    out = r.stdout;
  } catch (err) {
    return mapSpawnError(err);
  }
  return { kind: "ok", fileCount: Math.min(countPorcelainV2(out), MAX_FILES) };
}

/**
 * Count changed-file records in `git status --porcelain=v2 -z` output.
 * Record types (first char of each NUL-delimited token):
 *   '1' ordinary change · 'u' unmerged · '?' untracked — each one path.
 *   '2' rename/copy — one path, but consumes an EXTRA token (the origPath).
 * (No '#' header lines without --branch; no '!' without --ignored.)
 */
function countPorcelainV2(out: string): number {
  const tokens = splitNul(out);
  let count = 0;
  for (let i = 0; i < tokens.length; ) {
    const head = tokens[i];
    if (head === undefined || head === "") {
      i++;
      continue;
    }
    const kind = head[0];
    if (kind === "2") {
      // Rename/copy: this record's path + a trailing origPath token.
      count++;
      i += 2;
    } else if (kind === "1" || kind === "u" || kind === "?") {
      count++;
      i++;
    } else {
      // Unknown/header — skip defensively.
      i++;
    }
  }
  return count;
}

// ── Public: getFileDiff ────────────────────────────────────────────────

export async function getFileDiff(
  root: string,
  file: { path: string; oldPath?: string; status: GitFileStatus; untracked: boolean },
  base?: string,
  maxFileSizeBytes: number = FILE_TOO_LARGE_DEFAULT,
): Promise<GitFileDiffResult> {
  // GIT_OPTIONAL_LOCKS=0: these are read-only commands; don't take
  // index.lock (avoids contention with concurrent git reads and a stray
  // index write).
  const env = { ...(await getSubprocessEnv()), GIT_OPTIONAL_LOCKS: "0" };
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

  // hasHead and the base ref both depend only on repoRoot → resolve them
  // concurrently. (resolveBaseRef is itself a merge-base spawn when a base
  // branch is selected.)
  const [hasHead, baseRef] = await Promise.all([
    execGitQuiet(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot, env)
      .then((code) => code === 0)
      .catch(() => false),
    resolveBaseRef(base, repoRoot, env),
  ]);

  // Old side: `git show <ref>:<path>`. Returns the text (+ trailing-newline
  // flag), tolerating a vanished/renamed file by falling back to empty.
  const wantOld = !file.untracked && file.status !== "A" && hasHead;
  const oldSidePromise: Promise<{ text: string; missingNewline: boolean }> = wantOld
    ? (() => {
        const showPath = file.oldPath ?? file.path;
        return execGitText(["show", `${baseRef}:${showPath}`], repoRoot, env)
          .then((r) => ({
            text: r.stdout,
            missingNewline: r.stdout.length > 0 && !r.stdout.endsWith("\n"),
          }))
          .catch((err) => {
            // Race tolerance: file may have been renamed/removed. Drop the
            // old side, but still show a diff against an empty old.
            console.warn(`git show ${baseRef}:${showPath} failed:`, err);
            return { text: "", missingNewline: false };
          });
      })()
    : Promise.resolve({ text: "", missingNewline: false });

  // New side: read the working-tree file. Resolves to a `tooLarge` marker
  // rather than reading when the file exceeds the cap. Runs concurrently
  // with the old-side `git show` above — they're independent.
  const newSidePromise: Promise<{ text: string; missingNewline: boolean; tooLarge: boolean }> =
    file.status !== "D"
      ? (async () => {
          const filePath = path.join(repoRoot, file.path);
          try {
            const stat = await fs.stat(filePath);
            if (stat.size > maxFileSizeBytes) {
              return { text: "", missingNewline: false, tooLarge: true };
            }
            const text = await fs.readFile(filePath, "utf8");
            return {
              text,
              missingNewline: text.length > 0 && !text.endsWith("\n"),
              tooLarge: false,
            };
          } catch (err) {
            // ENOENT (or any other error) → empty new side. The file may
            // have vanished between the list and the click.
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              console.warn(`readFile ${filePath} failed:`, err);
            }
            return { text: "", missingNewline: false, tooLarge: false };
          }
        })()
      : Promise.resolve({ text: "", missingNewline: false, tooLarge: false });

  const [oldSide, newSide] = await Promise.all([oldSidePromise, newSidePromise]);
  const oldText = oldSide.text;
  const oldMissingNewline = oldSide.missingNewline;

  if (newSide.tooLarge) {
    return {
      kind: "ok",
      oldText,
      newText: "",
      binary: false,
      tooLarge: true,
      oldMissingNewline,
      newMissingNewline: false,
    };
  }
  const newText = newSide.text;
  const newMissingNewline = newSide.missingNewline;

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

// ── Public: writeWorkingFile ────────────────────────────────────────────

/**
 * Compare-and-swap write of a working-tree file from the diff editor.
 *
 * The renderer sends `expectedHash` = sha256 of the UTF-8 bytes of the
 * `newText` its edit buffer was derived from. We re-read the file, hash the
 * decoded-string re-encoding the SAME way (Buffer.from(current, "utf8")), and
 * only write when the hashes agree — so a save can never clobber disk content
 * that changed underneath the editor.
 *
 *   - repo root via `rev-parse --show-toplevel` (mirrors getFileDiff).
 *   - absolute paths and paths escaping the repo root are rejected (`error`).
 *   - symlinks are rejected via `lstat` (`error`) — never followed.
 *   - a missing file (ENOENT) is a `conflict` (the base vanished).
 *   - a hash mismatch is a `conflict` (stale base).
 *   - on a match, a plain `fs.writeFile(abs, content, "utf8")` → `ok`.
 *
 * TOCTOU window between the read and the write is accepted (single-user
 * desktop; the working-tree fingerprint machinery catches concurrent losers
 * and the viewer re-baselines on the next refresh).
 */
async function lstatRepoPathWithoutSymlinks(
  repoRoot: string,
  rel: string,
): Promise<
  { kind: "ok"; stat: Stats } | { kind: "conflict" } | { kind: "error"; message: string }
> {
  let cur = repoRoot;
  let stat: Stats;
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length === 0) {
    try {
      stat = await fs.lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "conflict" };
      return { kind: "error", message: errorMessage(err) };
    }
    return { kind: "ok", stat };
  }

  for (const part of parts) {
    cur = path.join(cur, part);
    try {
      stat = await fs.lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "conflict" };
      return { kind: "error", message: errorMessage(err) };
    }
    if (stat.isSymbolicLink()) {
      return { kind: "error", message: "Refusing to write through a symlink." };
    }
  }

  return { kind: "ok", stat: stat! };
}

export async function writeWorkingFile(
  root: string,
  filePath: string,
  content: string,
  expectedHash: string,
): Promise<GitWriteFileResult> {
  // Reject absolute inputs up front: path.resolve(repoRoot, "/abs") would
  // otherwise collapse to the absolute path and escape the repo.
  if (path.isAbsolute(filePath)) {
    return { kind: "error", message: "Refusing to write an absolute path." };
  }
  const env = { ...(await getSubprocessEnv()), GIT_OPTIONAL_LOCKS: "0" };
  let repoRoot: string;
  try {
    const r = await execGitText(["rev-parse", "--show-toplevel"], root, env);
    repoRoot = r.stdout.trim();
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
  if (!repoRoot) return { kind: "error", message: "Not a git repository" };

  const abs = path.resolve(repoRoot, filePath);
  const rel = path.relative(repoRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { kind: "error", message: "Path escapes the repository root." };
  }

  // Reject symlinks anywhere in the path (lstat each component, never follow)
  // and anything not a regular file. Checking only the leaf is insufficient: a
  // symlinked parent directory would otherwise let the write escape repoRoot.
  const statRes = await lstatRepoPathWithoutSymlinks(repoRoot, rel);
  if (statRes.kind !== "ok") return statRes;
  const stat = statRes.stat;
  if (!stat.isFile()) {
    return { kind: "error", message: "Refusing to write a non-regular file." };
  }

  // Hash the current contents the same way the renderer hashed its base: the
  // UTF-8 encoding of the JS string.
  let current: string;
  try {
    current = await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "conflict" };
    return { kind: "error", message: errorMessage(err) };
  }
  const currentHash = createHash("sha256").update(Buffer.from(current, "utf8")).digest("hex");
  if (currentHash !== expectedHash) return { kind: "conflict" };

  try {
    await fs.writeFile(abs, content, "utf8");
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
  return { kind: "ok" };
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
 * Build a human-readable failure message for a non-zero `git worktree add`,
 * preferring git's own stderr and special-casing the timeout so a slow
 * checkout on a huge repo reads as a timeout rather than a mystery "code 1".
 */
function describeWorktreeAddFailure(add: GitExecResult, worktreePath: string): string {
  if (add.timedOut) {
    const minutes = Math.round(WORKTREE_ADD_TIMEOUT_MS / 60_000);
    return `Creating the worktree timed out after ${minutes} minutes. This can happen on very large repositories. The partial worktree at ${worktreePath} may need to be cleaned up before retrying.`;
  }
  const stderr = add.stderr.trim();
  if (stderr) {
    // git prefixes its messages with "fatal: " — keep it; it reads naturally.
    return stderr;
  }
  if (add.signal) {
    return `git worktree add was terminated by ${add.signal}.`;
  }
  return `git worktree add failed with code ${add.code}.`;
}

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

    // Pre-flight: confirm the base ref actually resolves before we commit to
    // creating directories and a branch. Without this, a stale/typo'd base
    // surfaces only as git's verbose "invalid reference" deep inside the
    // `worktree add` failure; this turns it into a crisp, actionable message.
    const baseCheck = await execGitCapture(
      ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
      repoRoot,
      env,
    );
    if (baseCheck.code !== 0) {
      return {
        kind: "error",
        message: `Base branch "${base}" could not be resolved — it may have been deleted or renamed. Pick a different base branch and try again.`,
      };
    }

    const repoName = path.basename(repoRoot);
    const parentDir = path.dirname(repoRoot);
    const worktreesRoot = path.join(parentDir, `${repoName}-worktrees`);
    try {
      await fs.mkdir(worktreesRoot, { recursive: true });
    } catch (err) {
      return {
        kind: "error",
        message: `Could not create the worktrees directory at ${worktreesRoot}: ${errorMessage(err)}`,
      };
    }

    // Import the name generator (lazy to avoid circular deps if any).
    const { generateWorktreeName } = await import("./worktree-names.js");

    // Try up to 5 names, then append -2, -3, etc.
    let name = generateWorktreeName();
    let attempts = 0;
    const MAX_ATTEMPTS = 5;

    const collision = async (n: string): Promise<boolean> => {
      const branchRef = `pi-vis-${n}`;
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

    const branch = `pi-vis-${name}`;
    const worktreePath = path.join(worktreesRoot, name);

    // `git worktree add -b <branch> <path> <base>`
    // Uses a generous timeout: this checks out the entire working tree, which
    // on a large repo can take minutes. Capture stderr so a failure surfaces
    // git's actual reason rather than a bare exit code.
    const add = await execGitCapture(
      ["worktree", "add", "-b", branch, worktreePath, base],
      repoRoot,
      env,
      WORKTREE_ADD_TIMEOUT_MS,
    );

    if (add.code !== 0) {
      return { kind: "error", message: describeWorktreeAddFailure(add, worktreePath) };
    }

    return { kind: "ok", worktreePath, branch, name, base };
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}

/**
 * Validate a user-supplied candidate directory for the attach-to-worktree
 * flow and return the canonical worktree identity (canonical toplevel +
 * branch + name).
 *
 * Validation strategy (the "same main repo" check):
 *
 *  1. Canonicalize the candidate to its worktree root first. Run
 *     `git rev-parse --show-toplevel` (cwd = the user's input) → collapses
 *     a pasted *subdirectory* of a worktree down to the worktree root, and
 *     the output is already absolute. Then `fs.realpath` it (macOS
 *     `/var`↔`/private/var`). **Every downstream use — the same-repo
 *     compare, the persisted `settings.worktrees` key, the respawn cwd, and
 *     the chip name — uses this canonical toplevel, never the raw input.**
 *     This is what makes `resolveWorktreeForFile` re-attach correctly on
 *     relaunch: pi writes the canonical cwd into the session header, and
 *     our persisted key must equal it byte-for-byte.
 *
 *  2. Same-repo proof via common dir. For any worktree, `git rev-parse
 *     --git-common-dir` resolves to the *shared* `.git` of the main repo;
 *     all linked worktrees of one repo share it. Compare
 *     `realpath(commonDir(candidate)) === realpath(commonDir(workspaceRoot))`.
 *     (`--git-common-dir` can return a relative path, so resolve it
 *     against the candidate's toplevel before realpath. No
 *     `--path-format=absolute` — it needs git ≥2.31 and is unnecessary
 *     here.)
 *
 * Order of checks (crisp messages, cheapest first):
 *
 *  - `fs.stat(input)` → missing/not-a-dir → "Directory not found." (Do
 *    **not** rely on git for this: `mapSpawnError` at the bottom of this
 *    file maps `ENOENT` to `git-missing`, which means *git binary*
 *    missing — wrong message.)
 *  - `--show-toplevel` fails → "Not a git repository."
 *  - common-dir mismatch → "That directory belongs to a different repository."
 *  - canonical toplevel === realpath'd workspace toplevel → "That's the
 *    current workspace — choose a different worktree directory."
 *    (Compare two *realpath'd* toplevels, not raw `workspaceRoot` vs
 *    realpath'd candidate.)
 *
 * Branch resolution (best effort, never fails the validation):
 *
 *  - `git rev-parse --abbrev-ref HEAD`; `HEAD` (detached) → `--short HEAD`;
 *    if that also fails (unborn HEAD, no commits) → fall back to the branch
 *    from `git symbolic-ref --short HEAD` or the literal `"(no commits)"`.
 *
 * Single source of truth: called by both the live-validate IPC
 * (`worktree.validate`) and the attach IPC (`session.attachWorktree`).
 * The attach IPC is the authoritative gate — it re-runs `inspectWorktree`
 * server-side and uses the returned canonical `path`, so a stale/edited
 * live result can never persist a bad path.
 */
export async function inspectWorktree(
  workspaceRoot: string,
  candidatePath: string,
): Promise<GitWorktreeInspect> {
  // Precheck: must exist AND be a directory. Do this BEFORE shelling out to
  // git — `mapSpawnError` below maps ENOENT to `git-missing`, which means
  // "git binary missing", not "directory missing". Doing the stat here keeps
  // the user-facing error message correct.
  let stat: Stats;
  try {
    stat = await fs.stat(candidatePath);
  } catch {
    return { kind: "error", message: "Directory not found." };
  }
  if (!stat.isDirectory()) {
    return { kind: "error", message: "Directory not found." };
  }

  const env = await getSubprocessEnv();

  // 1. Canonicalize the candidate down to its worktree root + same-repo check
  //    via `--git-common-dir`. Both happen in one git invocation per command
  //    so we don't pay four spawn costs on a large repo.
  let canonicalTop: string;
  let commonDirRel: string;
  try {
    const topRes = await execGitText(["rev-parse", "--show-toplevel"], candidatePath, env);
    canonicalTop = topRes.stdout.trim();
    if (!canonicalTop) return { kind: "error", message: "Not a git repository." };
  } catch {
    return { kind: "error", message: "Not a git repository." };
  }
  // `--git-common-dir` can return a relative path; resolve it against the
  // canonical toplevel, then realpath both sides for the byte-for-byte
  // compare that survives `/var`↔`/private/var` (macOS) and any symlinks
  // the user or `git worktree add` created in the candidate path.
  try {
    const commonRes = await execGitText(["rev-parse", "--git-common-dir"], candidatePath, env);
    const rel = commonRes.stdout.trim();
    if (!rel) return { kind: "error", message: "Not a git repository." };
    commonDirRel = path.isAbsolute(rel) ? rel : path.resolve(canonicalTop, rel);
  } catch {
    return { kind: "error", message: "Not a git repository." };
  }

  // Resolve the workspace side the same way (canonical + common-dir). Doing
  // it here (rather than caching the workspace's common-dir in a setting)
  // makes the check robust against the workspace itself having been moved
  // or moved-aside on disk — the user sees a real failure, not a stale hit.
  let workspaceTop: string;
  let workspaceCommon: string;
  try {
    const topRes = await execGitText(["rev-parse", "--show-toplevel"], workspaceRoot, env);
    workspaceTop = topRes.stdout.trim();
    if (!workspaceTop) return { kind: "error", message: "Not a git repository." };
  } catch {
    return { kind: "error", message: "Not a git repository." };
  }
  try {
    const commonRes = await execGitText(["rev-parse", "--git-common-dir"], workspaceRoot, env);
    const rel = commonRes.stdout.trim();
    if (!rel) return { kind: "error", message: "Not a git repository." };
    workspaceCommon = path.isAbsolute(rel) ? rel : path.resolve(workspaceTop, rel);
  } catch {
    return { kind: "error", message: "Not a git repository." };
  }

  let realCandidateCommon: string;
  let realWorkspaceCommon: string;
  let realCandidateTop: string;
  let realWorkspaceTop: string;
  try {
    realCandidateCommon = await fs.realpath(commonDirRel);
    realWorkspaceCommon = await fs.realpath(workspaceCommon);
    realCandidateTop = await fs.realpath(canonicalTop);
    realWorkspaceTop = await fs.realpath(workspaceTop);
  } catch {
    // The path resolved to something that doesn't exist on disk anymore
    // (e.g. user pasted a phantom worktree, or a parent was unmounted).
    // Treat as "not a git repository" — the same-repo check below is
    // meaningless without both sides.
    return { kind: "error", message: "Not a git repository." };
  }

  if (realCandidateCommon !== realWorkspaceCommon) {
    return {
      kind: "error",
      message: "That directory belongs to a different repository.",
    };
  }
  if (realCandidateTop === realWorkspaceTop) {
    return {
      kind: "error",
      message: "That's the current workspace — choose a different worktree directory.",
    };
  }

  // From here down, use the realpath'd toplevel (`realCandidateTop`) — the
  // exact string the self-compare above trusted — for the branch cwd, the
  // chip name, and the returned `path`. This is the value we persist as the
  // `settings.worktrees` key and respawn pi into, so it must match the cwd pi
  // records in its session header byte-for-byte for `resolveWorktreeForFile`
  // to re-attach on relaunch. (Git's `--show-toplevel` already resolves
  // symlinks, so `realCandidateTop === canonicalTop` in practice; this keeps
  // the one source of truth explicit rather than relying on that.)

  // 2. Branch label. Best-effort: a detached HEAD falls through to `--short
  //    HEAD` (a SHA prefix), and an unborn HEAD (no commits yet) ends at the
  //    `"(no commits)"` sentinel. None of these branches fail validation —
  //    attaching to an unborn-HEAD worktree is still a valid attach target.
  let branch = "(no commits)";
  try {
    const r = await execGitText(["rev-parse", "--abbrev-ref", "HEAD"], realCandidateTop, env);
    const trimmed = r.stdout.trim();
    if (trimmed && trimmed !== "HEAD") {
      branch = trimmed;
    } else {
      // Detached HEAD → short SHA.
      try {
        const sha = await execGitText(["rev-parse", "--short", "HEAD"], realCandidateTop, env);
        branch = sha.stdout.trim() || "(no commits)";
      } catch {
        // Fall back to symbolic-ref (e.g. unborn HEAD: HEAD points at refs/.../main but no commit yet).
        try {
          const sym = await execGitText(["symbolic-ref", "--short", "HEAD"], realCandidateTop, env);
          branch = sym.stdout.trim() || "(no commits)";
        } catch {
          branch = "(no commits)";
        }
      }
    }
  } catch {
    branch = "(no commits)";
  }

  // The friendly chip name = directory name. We use the canonical toplevel
  // (the worktree root) so a subdir-paste collapses to the same name a
  // freshly-created worktree would have, not the subdir's basename.
  const name = path.basename(realCandidateTop);

  return { kind: "ok", path: realCandidateTop, branch, name };
}

/** The error variants shared by getChanges / getChangesCount — a subset of
 *  both result unions, so either function can return this directly. */
type GitErrorResult =
  | { kind: "git-missing" }
  | { kind: "not-a-repo" }
  | { kind: "error"; message: string };

function mapSpawnError(err: unknown): GitErrorResult {
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
