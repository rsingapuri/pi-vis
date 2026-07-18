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
import {
  promises as fs,
  type BigIntStats,
  type Stats,
  createReadStream,
  constants as fsConstants,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  GitBranchesResult,
  GitChangedFile,
  GitChangesCountResult,
  GitChangesResult,
  GitCommitMetadata,
  GitCommitRange,
  GitCommitsResult,
  GitFileDiffResult,
  GitFileStatus,
  GitHistoricalContext,
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
/** Large configured historical blobs are streamed and may legitimately need
 *  longer than the ordinary metadata-command budget. */
const GIT_BLOB_TIMEOUT_MS = 2 * 60_000;
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

interface LimitedNulOutput {
  stdout: string;
  truncated: boolean;
}

/** Stream a NUL-delimited Git listing and stop once one record beyond the UI
 * bound is complete. This bounds main-process memory and IPC payloads even for
 * ranges touching millions of paths. */
function execGitNulLimited<T>(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  parse: (stdout: string) => T[],
  limit: number,
): Promise<LimitedNulOutput> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let deliberatelyStopped = false;
    let timedOut = false;
    let settled = false;
    const child = spawn("git", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, GIT_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      const text = Buffer.concat(stdout, stdoutBytes).toString("utf8");
      resolve({ stdout: text, truncated: parse(text).length > limit });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (deliberatelyStopped) return;
      stdout.push(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BUFFER) {
        child.kill("SIGTERM");
        finish(new Error("Git path listing exceeded its safe output limit."));
        return;
      }
      const text = Buffer.concat(stdout, stdoutBytes).toString("utf8");
      if (parse(text).length > limit) {
        deliberatelyStopped = true;
        child.stdout.pause();
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > 8192 && stderr.length > 1) {
        const removed = stderr.shift();
        if (removed) stderrBytes -= removed.length;
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (deliberatelyStopped) {
        finish();
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      finish(
        new Error(
          detail ||
            (timedOut
              ? "Git path listing timed out."
              : `git exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`),
        ),
      );
    });
  });
}

function readGitBlobText(
  object: string,
  cwd: string,
  env: Record<string, string>,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const child = spawn("git", ["cat-file", "blob", object], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, GIT_BLOB_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
      } catch (error) {
        reject(error);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill("SIGTERM");
        finish(new Error("Historical blob exceeded the configured file-size limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > 8192 && stderr.length > 1) {
        const removed = stderr.shift();
        if (removed) stderrBytes -= removed.length;
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      finish(
        new Error(
          detail ||
            (timedOut
              ? "Historical blob read timed out."
              : `git cat-file exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`),
        ),
      );
    });
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

interface CommitContext {
  repoRoot: string;
  env: Record<string, string>;
  head: string;
  mergeBase: string;
  commits: GitCommitMetadata[];
  truncated: boolean;
}

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** Successful range validation is immutable and shared by the manifest plus
 * lazy per-file loads. Without this small bounded cache, each visible file
 * would repeat the merge-base and 500-commit history walk. */
const rangeValidationCache = new Map<string, Promise<ValidatedRange | GitErrorResult>>();
const worktreeCreationTails = new Map<string, Promise<void>>();

async function acquireWorktreeCreationLock(repoRoot: string): Promise<() => void> {
  const key = await fs.realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const previous = worktreeCreationTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  worktreeCreationTails.set(key, tail);
  await previous.catch(() => {});
  return () => {
    releaseGate();
    if (worktreeCreationTails.get(key) === tail) worktreeCreationTails.delete(key);
  };
}

/** Strictly resolve a concrete base and its first-parent candidate path. */
async function getCommitContext(
  root: string,
  base: string,
): Promise<CommitContext | GitErrorResult> {
  const env = { ...(await getSubprocessEnv()), GIT_OPTIONAL_LOCKS: "0" };
  let repoRoot: string;
  try {
    repoRoot = (await execGitText(["rev-parse", "--show-toplevel"], root, env)).stdout.trim();
  } catch (err) {
    return mapSpawnError(err);
  }
  if (!repoRoot) return { kind: "not-a-repo" };
  if (!base || base === "HEAD")
    return { kind: "error", message: "A concrete non-HEAD base branch is required." };

  let head: string;
  try {
    head = (
      await execGitText(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot, env)
    ).stdout.trim();
  } catch {
    return { kind: "error", message: "Repository has no HEAD commit." };
  }
  let baseSha: string;
  try {
    baseSha = (
      await execGitText(["rev-parse", "--verify", `${base}^{commit}`], repoRoot, env)
    ).stdout.trim();
  } catch {
    return { kind: "error", message: `Base branch "${base}" could not be resolved.` };
  }
  let mergeBase: string;
  try {
    mergeBase = (await execGitText(["merge-base", baseSha, head], repoRoot, env)).stdout.trim();
  } catch {
    return { kind: "error", message: `Base branch "${base}" has unrelated history.` };
  }
  if (!mergeBase) return { kind: "error", message: `Base branch "${base}" has unrelated history.` };

  // `--first-parent mergeBase..HEAD` alone can walk past a merge base that is
  // reachable only through a later merge parent. Prove the boundary itself is
  // on HEAD's first-parent chain before offering a contiguous range.
  try {
    const distanceText = (
      await execGitText(
        ["rev-list", "--first-parent", "--count", `${mergeBase}..${head}`],
        repoRoot,
        env,
      )
    ).stdout.trim();
    const distance = Number.parseInt(distanceText, 10);
    if (!Number.isSafeInteger(distance) || distance < 0) throw new Error("invalid distance");
    const boundary = (
      await execGitText(["rev-parse", "--verify", `${head}~${distance}^{commit}`], repoRoot, env)
    ).stdout.trim();
    if (boundary !== mergeBase) {
      return {
        kind: "error",
        message: `Base branch "${base}" does not meet HEAD on its first-parent history.`,
      };
    }
  } catch (error) {
    if (error instanceof Error && error.message === "invalid distance") {
      return { kind: "error", message: "Could not resolve the first-parent commit path." };
    }
    return {
      kind: "error",
      message: `Base branch "${base}" does not meet HEAD on its first-parent history.`,
    };
  }

  let out: string;
  try {
    out = (
      await execGitText(
        [
          "log",
          "--first-parent",
          "-n",
          String(MAX_FILES + 1),
          "-z",
          "--format=%H%x00%h%x00%s%x00%an%x00%at",
          `${mergeBase}..${head}`,
        ],
        repoRoot,
        env,
      )
    ).stdout;
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
  // `git log -z` terminates each record with NUL while the format inserts
  // four additional NUL-delimited fields. Keep empty subjects intact (Git
  // permits `--allow-empty-message`); filtering empty tokens would shift every
  // later record out of alignment.
  const fields = splitNul(out);
  const newest: GitCommitMetadata[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const [sha, shortSha, subject, authorName, authoredAt] = fields.slice(i, i + 5);
    if (
      !sha ||
      !shortSha ||
      subject === undefined ||
      authorName === undefined ||
      authoredAt === undefined
    )
      continue;
    newest.push({
      sha,
      shortSha,
      subject,
      authorName,
      authoredAt: Number.parseInt(authoredAt, 10) * 1000,
    });
  }
  const truncated = newest.length > MAX_FILES;
  return {
    repoRoot,
    env,
    head,
    mergeBase,
    commits: (truncated ? newest.slice(0, MAX_FILES) : newest).reverse(),
    truncated,
  };
}

/** List the newest 500 first-parent commits after the strict merge-base. */
export async function getCommits(root: string, base: string): Promise<GitCommitsResult> {
  const context = await getCommitContext(root, base);
  if ("kind" in context) return context;
  return {
    kind: "ok",
    head: context.head,
    mergeBase: context.mergeBase,
    commits: context.commits,
    truncated: context.truncated,
  };
}

interface ValidatedRange {
  parent: string;
  end: string;
  context: CommitContext;
}

async function validateRangeUncached(
  root: string,
  base: string,
  range: GitCommitRange,
): Promise<ValidatedRange | GitErrorResult> {
  const context = await getCommitContext(root, base);
  if ("kind" in context) return context;
  const startIndex = context.commits.findIndex((commit) => commit.sha === range.start);
  const endIndex = context.commits.findIndex((commit) => commit.sha === range.end);
  if (startIndex < 0 || endIndex < 0) {
    return {
      kind: "error",
      message: "Commit range is stale or outside the current first-parent history.",
    };
  }
  if (startIndex > endIndex)
    return { kind: "error", message: "Commit range endpoints are reversed." };
  let canonicalStart: string;
  let canonicalEnd: string;
  let parent: string;
  try {
    [canonicalStart, canonicalEnd, parent] = await Promise.all([
      execGitText(
        ["rev-parse", "--verify", `${range.start}^{commit}`],
        context.repoRoot,
        context.env,
      ).then((r) => r.stdout.trim()),
      execGitText(
        ["rev-parse", "--verify", `${range.end}^{commit}`],
        context.repoRoot,
        context.env,
      ).then((r) => r.stdout.trim()),
      execGitText(["rev-parse", "--verify", `${range.start}^`], context.repoRoot, context.env).then(
        (r) => r.stdout.trim(),
      ),
    ]);
  } catch {
    return { kind: "error", message: "Commit range endpoints are no longer valid." };
  }
  if (canonicalStart !== range.start || canonicalEnd !== range.end) {
    return { kind: "error", message: "Commit range endpoints must be canonical object IDs." };
  }
  return { parent, end: canonicalEnd, context };
}

async function validateRange(
  root: string,
  base: string | undefined,
  range: GitCommitRange | undefined,
): Promise<ValidatedRange | GitErrorResult> {
  if (!range) return { kind: "error", message: "A commit range is required." };
  if (!base || base === "HEAD")
    return {
      kind: "error",
      message: "A concrete non-HEAD base branch is required for a commit range.",
    };
  if (!FULL_OBJECT_ID.test(range.start) || !FULL_OBJECT_ID.test(range.end)) {
    return { kind: "error", message: "Commit range endpoints must be full immutable object IDs." };
  }

  const key = `${path.resolve(root)}\0${base}\0${range.start}\0${range.end}`;
  const cached = rangeValidationCache.get(key);
  if (cached) return cached;

  // Deduplicate only concurrent validation. A later fresh manifest request
  // must re-read mutable base/HEAD topology; immutable open-viewer reads carry
  // their concrete historicalContext and bypass this path entirely.
  const pending = validateRangeUncached(root, base, range);
  rangeValidationCache.set(key, pending);
  try {
    return await pending;
  } finally {
    if (rangeValidationCache.get(key) === pending) rangeValidationCache.delete(key);
  }
}

async function resolveHistoricalReadContext(
  root: string,
  base: string | undefined,
  range: GitCommitRange,
  immutable: GitHistoricalContext | undefined,
): Promise<
  { parent: string; end: string; repoRoot: string; env: Record<string, string> } | GitErrorResult
> {
  if (!immutable) {
    const validated = await validateRange(root, base, range);
    if ("kind" in validated) return validated;
    return {
      parent: validated.parent,
      end: validated.end,
      repoRoot: validated.context.repoRoot,
      env: validated.context.env,
    };
  }
  if (!base || base === "HEAD") {
    return {
      kind: "error",
      message: "A concrete non-HEAD base branch is required for a commit range.",
    };
  }
  if (
    !FULL_OBJECT_ID.test(range.start) ||
    !FULL_OBJECT_ID.test(range.end) ||
    !FULL_OBJECT_ID.test(immutable.parent) ||
    !FULL_OBJECT_ID.test(immutable.end) ||
    immutable.end !== range.end
  ) {
    return { kind: "error", message: "Historical diff context is invalid." };
  }
  const env = { ...(await getSubprocessEnv()), GIT_OPTIONAL_LOCKS: "0" };
  try {
    const repoRoot = (await execGitText(["rev-parse", "--show-toplevel"], root, env)).stdout.trim();
    const [parent, end] = await Promise.all([
      execGitText(["rev-parse", "--verify", `${range.start}^`], repoRoot, env).then((result) =>
        result.stdout.trim(),
      ),
      execGitText(["rev-parse", "--verify", `${range.end}^{commit}`], repoRoot, env).then(
        (result) => result.stdout.trim(),
      ),
    ]);
    if (parent !== immutable.parent || end !== immutable.end) {
      return { kind: "error", message: "Historical diff context no longer matches its range." };
    }
    return { parent, end, repoRoot, env };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

async function getHistoricalChanges(
  root: string,
  base: string | undefined,
  range: GitCommitRange,
  immutable: GitHistoricalContext | undefined,
): Promise<GitChangesResult> {
  const validated = await resolveHistoricalReadContext(root, base, range, immutable);
  if ("kind" in validated) return validated;
  const { repoRoot, env } = validated;
  const attrCapability = await execGitCapture(
    ["check-attr", `--source=${validated.end}`, "--all", "--", ".gitattributes"],
    repoRoot,
    env,
  );
  if (attrCapability.code !== 0) {
    return {
      kind: "error",
      message:
        "Historical commit ranges require Git 2.42 or newer so attributes can be read from the selected commit.",
    };
  }
  const diffArgs = `${validated.parent}..${validated.end}`;
  // Git normally consults attributes from the current checkout even for a
  // tree-to-tree diff. Pin them to the immutable range endpoint so a later
  // `.gitattributes` edit at HEAD cannot change historical binary semantics.
  const historicalEnv = { ...env, GIT_ATTR_SOURCE: validated.end };
  const [statusR, numstatR] = await Promise.all([
    execGitNulLimited(
      ["diff", "--name-status", "-z", "-M", diffArgs],
      repoRoot,
      historicalEnv,
      parseNameStatus,
      MAX_FILES,
    ),
    execGitNulLimited(
      ["diff", "--numstat", "-z", "-M", diffArgs],
      repoRoot,
      historicalEnv,
      parseNumstat,
      MAX_FILES,
    ),
  ]);
  const counts = new Map(
    parseNumstat(numstatR.stdout)
      .slice(0, MAX_FILES)
      .map((entry) => [entry.path, entry]),
  );
  const files = parseNameStatus(statusR.stdout)
    .slice(0, MAX_FILES)
    .map((file) => {
      const count = counts.get(file.path);
      return count
        ? {
            ...file,
            insertions: count.insertions,
            deletions: count.deletions,
            binary: count.binary,
          }
        : file;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const truncated = statusR.truncated;
  return {
    kind: "ok",
    repoRoot,
    files,
    searchFiles: files,
    historicalContext: { parent: validated.parent, end: validated.end },
    truncated,
    fingerprint: createHash("sha1").update(`${validated.parent}\0${validated.end}`).digest("hex"),
  };
}

export async function getChanges(
  root: string,
  base?: string,
  range?: GitCommitRange,
  historicalContext?: GitHistoricalContext,
): Promise<GitChangesResult> {
  if (range) {
    try {
      if (range.includeUncommitted) {
        // The pseudo uncommitted endpoint extends the selected first-parent
        // band from start^ through the live checkout, so it remains editable.
        const validated = await validateRange(root, base, range);
        if ("kind" in validated) return validated;
        return await getChanges(root, validated.parent);
      }
      return await getHistoricalChanges(root, base, range, historicalContext);
    } catch (err) {
      return { kind: "error", message: errorMessage(err) };
    }
  }
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
    // Search is logically independent from the 500-section browsing cap. The
    // complete manifest is descriptors-only; file contents remain lazy and
    // bounded by the search controller's concurrency.
    searchFiles: all,
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
  const count = countPorcelainV2(out);
  return { kind: "ok", fileCount: Math.min(count, MAX_FILES), truncated: count > MAX_FILES };
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

async function getHistoricalFileDiff(
  root: string,
  file: {
    path: string;
    oldPath?: string;
    status: GitFileStatus;
    untracked: boolean;
    binary?: boolean;
  },
  base: string | undefined,
  maxFileSizeBytes: number,
  range: GitCommitRange,
  immutable: GitHistoricalContext | undefined,
): Promise<GitFileDiffResult> {
  const validated = await resolveHistoricalReadContext(root, base, range, immutable);
  if ("kind" in validated)
    return {
      kind: "error",
      message: validated.kind === "error" ? validated.message : validated.kind,
    };
  const { repoRoot, env } = validated;
  type BlobSide = { text: string; missingNewline: boolean; tooLarge: boolean } | { error: string };
  const readBlob = async (ref: string, blobPath: string, present: boolean): Promise<BlobSide> => {
    if (!present) return { text: "", missingNewline: false, tooLarge: false };
    const object = `${ref}:${blobPath}`;
    try {
      const size = Number.parseInt(
        (await execGitText(["cat-file", "-s", object], repoRoot, env)).stdout.trim(),
        10,
      );
      if (Number.isFinite(size) && size > maxFileSizeBytes)
        return { text: "", missingNewline: false, tooLarge: true };
      const text = await readGitBlobText(object, repoRoot, env, maxFileSizeBytes);
      return { text, missingNewline: text.length > 0 && !text.endsWith("\n"), tooLarge: false };
    } catch (error) {
      return {
        error: `Could not read historical file ${blobPath} at ${ref.slice(0, 8)}: ${errorMessage(error)}`,
      };
    }
  };
  const [oldSide, newSide] = await Promise.all([
    readBlob(validated.parent, file.oldPath ?? file.path, !file.untracked && file.status !== "A"),
    readBlob(validated.end, file.path, file.status !== "D"),
  ]);
  if ("error" in oldSide) return { kind: "error", message: oldSide.error };
  if ("error" in newSide) return { kind: "error", message: newSide.error };
  if (oldSide.tooLarge || newSide.tooLarge) {
    return {
      kind: "ok",
      oldText: oldSide.text,
      newText: newSide.text,
      binary: false,
      tooLarge: true,
      oldMissingNewline: oldSide.missingNewline,
      newMissingNewline: newSide.missingNewline,
    };
  }
  return {
    kind: "ok",
    oldText: oldSide.text,
    newText: newSide.text,
    // `numstat` is authoritative and includes `.gitattributes` decisions;
    // preserve it even when an attribute-classified blob contains no NUL.
    binary:
      file.binary === true ||
      (file.status !== "A" && hasBinaryAtStart(oldSide.text)) ||
      (file.status !== "D" && hasBinaryAtStart(newSide.text)),
    tooLarge: false,
    oldMissingNewline: oldSide.missingNewline,
    newMissingNewline: newSide.missingNewline,
  };
}

export async function getFileDiff(
  root: string,
  file: {
    path: string;
    oldPath?: string;
    status: GitFileStatus;
    untracked: boolean;
    binary?: boolean;
  },
  base?: string,
  maxFileSizeBytes: number = FILE_TOO_LARGE_DEFAULT,
  range?: GitCommitRange,
  historicalContext?: GitHistoricalContext,
): Promise<GitFileDiffResult> {
  if (range) {
    if (range.includeUncommitted) {
      const validated = await validateRange(root, base, range);
      if ("kind" in validated) {
        return {
          kind: "error",
          message:
            validated.kind === "error" ? validated.message : "Unable to validate commit range.",
        };
      }
      return getFileDiff(root, file, validated.parent, maxFileSizeBytes);
    }
    return getHistoricalFileDiff(root, file, base, maxFileSizeBytes, range, historicalContext);
  }
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
 *
 * `sourceRoot` controls where the base ref is resolved while `root` remains
 * the owning workspace used for placement and worktree administration. Active
 * sessions use this to branch from the exact HEAD of their current checkout
 * without exposing an arbitrary base picker in the renderer.
 */
export async function createWorktree(
  root: string,
  base: string,
  sourceRoot: string = root,
  onPathReserved?: (worktreePath: string) => void,
): Promise<GitWorktreeResult> {
  try {
    const env = await getSubprocessEnv();
    // Resolve the repo root
    const r = await execGitText(["rev-parse", "--show-toplevel"], root, env);
    const repoRoot = r.stdout.trim();
    if (!repoRoot) return { kind: "error", message: "Not a git repository" };
    const releaseCreationLock = await acquireWorktreeCreationLock(repoRoot);
    try {
      // Pre-flight: confirm the base ref actually resolves before we commit to
      // creating directories and a branch. Without this, a stale/typo'd base
      // surfaces only as git's verbose "invalid reference" deep inside the
      // `worktree add` failure; this turns it into a crisp, actionable message.
      const baseCheck = await execGitCapture(
        ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
        sourceRoot,
        env,
      );
      const resolvedBase = baseCheck.stdout.trim();
      if (baseCheck.code !== 0 || !resolvedBase) {
        return {
          kind: "error",
          message: `Base branch "${base}" could not be resolved — it may have been deleted or renamed. Pick a different base branch and try again.`,
        };
      }
      const targetHasBase = await execGitCapture(
        ["cat-file", "-e", `${resolvedBase}^{commit}`],
        repoRoot,
        env,
      );
      if (targetHasBase.code !== 0) {
        return {
          kind: "error",
          message: "The current checkout belongs to a different repository.",
        };
      }
      let baseLabel = base;
      if (base === "HEAD") {
        const current = await execGitCapture(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          sourceRoot,
          env,
        );
        const label = current.stdout.trim();
        baseLabel =
          current.code === 0 && label && label !== "HEAD" ? label : resolvedBase.slice(0, 8);
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
      onPathReserved?.(worktreePath);

      // Create the checkout detached first so a failed/timeout checkout cannot
      // strand the generated branch. Once the full worktree exists, attaching a
      // new branch at the same commit only updates HEAD and is cheap.
      const add = await execGitCapture(
        ["worktree", "add", "--detach", worktreePath, resolvedBase],
        repoRoot,
        env,
        WORKTREE_ADD_TIMEOUT_MS,
      );

      if (add.code !== 0) {
        const cleanup = await cleanupFailedWorktreeAdd(repoRoot, worktreePath, resolvedBase, env);
        const message = describeWorktreeAddFailure(add, worktreePath);
        return {
          kind: "error",
          message:
            cleanup.kind === "ok" ? message : `${message} Cleanup also failed: ${cleanup.message}`,
        };
      }

      const attachBranch = await execGitCapture(
        ["checkout", "-b", branch],
        worktreePath,
        env,
        WORKTREE_ADD_TIMEOUT_MS,
      );
      if (attachBranch.code !== 0) {
        const currentBranch = await execGitCapture(
          ["symbolic-ref", "--short", "HEAD"],
          worktreePath,
          env,
        );
        const branchOwned = currentBranch.code === 0 && currentBranch.stdout.trim() === branch;
        const cleanup = await cleanupOwnedWorktreeArtifacts(
          repoRoot,
          worktreePath,
          branchOwned ? branch : undefined,
          env,
        );
        const message = describeWorktreeAddFailure(attachBranch, worktreePath);
        return {
          kind: "error",
          message:
            cleanup.kind === "ok" ? message : `${message} Cleanup also failed: ${cleanup.message}`,
        };
      }

      return { kind: "ok", worktreePath, branch, name, base: baseLabel };
    } finally {
      releaseCreationLock();
    }
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}

export type CopyCheckoutChangesResult =
  | { kind: "ok"; changed: boolean }
  | { kind: "error"; message: string };

export interface CheckoutIdentity {
  head: string;
  baseLabel: string;
}

export type ReadCheckoutIdentityResult =
  | { kind: "ok"; identity: CheckoutIdentity }
  | { kind: "error"; message: string };

/** Read only the immutable commit + presentation label of a checkout.
 *
 * This is the clean-worktree counterpart to `captureCheckoutChanges`: when a
 * user explicitly declines to copy local contents, we still pin the exact
 * source commit and reject a branch/HEAD change at the detach boundary without
 * reading or staging any uncommitted payload. */
export async function readCheckoutIdentity(
  requestedRoot: string,
): Promise<ReadCheckoutIdentityResult> {
  const env = await getSubprocessEnv();
  try {
    const rootResult = await execGitCapture(["rev-parse", "--show-toplevel"], requestedRoot, env);
    const sourceRoot = rootResult.stdout.trim();
    if (rootResult.code !== 0 || !sourceRoot) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Reading repository root", rootResult),
      };
    }
    const [headResult, branchResult] = await Promise.all([
      execGitCapture(["rev-parse", "--verify", "HEAD^{commit}"], sourceRoot, env),
      execGitCapture(["rev-parse", "--abbrev-ref", "HEAD"], sourceRoot, env),
    ]);
    const failed =
      headResult.code !== 0 ? headResult : branchResult.code !== 0 ? branchResult : null;
    const head = headResult.stdout.trim();
    if (failed || !head) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Reading checkout identity", failed ?? headResult),
      };
    }
    const branch = branchResult.stdout.trim();
    return {
      kind: "ok",
      identity: {
        head,
        baseLabel: branch && branch !== "HEAD" ? branch : head.slice(0, 8),
      },
    };
  } catch (error) {
    return { kind: "error", message: `Could not read checkout identity: ${errorMessage(error)}` };
  }
}

export async function checkoutStillMatchesIdentity(
  sourceRoot: string,
  identity: CheckoutIdentity,
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
  const current = await readCheckoutIdentity(sourceRoot);
  if (current.kind === "error") return current;
  if (
    current.identity.head !== identity.head ||
    current.identity.baseLabel !== identity.baseLabel
  ) {
    return {
      kind: "error",
      message: "The current checkout changed while the worktree was being created. Try again.",
    };
  }
  return { kind: "ok" };
}

export interface CheckoutChangesSnapshot {
  head: string;
  baseLabel: string;
  changed: boolean;
  tempDir: string;
  stagedPatch: string;
  unstagedPatch: string;
  untrackedPaths: string[];
  intentToAddPaths: string[];
  directoryModes: Array<{ path: string; mode: number }>;
  digest: string;
}

export type CaptureCheckoutChangesResult =
  | { kind: "ok"; snapshot: CheckoutChangesSnapshot }
  | { kind: "error"; message: string };

function describeCheckoutCopyFailure(step: string, result: GitExecResult): string {
  return (
    result.stderr.trim() ||
    (result.timedOut
      ? `${step} timed out.`
      : `${step} failed${result.signal ? ` (${result.signal})` : ` with code ${result.code}`}.`)
  );
}

function resolveSnapshotPath(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}

async function copySnapshotPath(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), target);
  } else if (stat.isDirectory()) {
    await fs.cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  } else if (stat.isFile()) {
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
    await fs.chmod(target, stat.mode);
  } else {
    throw new Error("unsupported file type");
  }
}

async function captureDirectoryModes(
  sourceRoot: string,
  relativePaths: string[],
): Promise<Array<{ path: string; mode: number }>> {
  const parents = new Set<string>();
  for (const relativePath of relativePaths) {
    let parent = path.dirname(relativePath);
    while (parent !== "." && parent !== path.dirname(parent)) {
      parents.add(parent);
      parent = path.dirname(parent);
    }
  }
  const result: Array<{ path: string; mode: number }> = [];
  for (const relativePath of [...parents].sort()) {
    const absolutePath = resolveSnapshotPath(sourceRoot, relativePath);
    if (!absolutePath) throw new Error("Git returned an invalid local directory path.");
    const stat = await fs.lstat(absolutePath);
    if (!stat.isDirectory()) throw new Error("An untracked parent path is not a directory.");
    result.push({ path: relativePath, mode: stat.mode & 0o7777 });
  }
  return result;
}

async function snapshotPathsEqual(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.lstat(left), fs.lstat(right)]);
  if ((leftStat.mode & 0o7777) !== (rightStat.mode & 0o7777)) return false;
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    if (!leftStat.isSymbolicLink() || !rightStat.isSymbolicLink()) return false;
    const [leftTarget, rightTarget] = await Promise.all([fs.readlink(left), fs.readlink(right)]);
    return leftTarget === rightTarget;
  }
  if (leftStat.isDirectory() || rightStat.isDirectory()) {
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
    const [leftEntries, rightEntries] = await Promise.all([fs.readdir(left), fs.readdir(right)]);
    leftEntries.sort();
    rightEntries.sort();
    if (
      leftEntries.length !== rightEntries.length ||
      leftEntries.some((entry, index) => entry !== rightEntries[index])
    )
      return false;
    for (const entry of leftEntries) {
      if (!(await snapshotPathsEqual(path.join(left, entry), path.join(right, entry))))
        return false;
    }
    return true;
  }
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  const hashFile = async (filePath: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
  };
  const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
  return leftHash === rightHash;
}

async function snapshotMetadataDigest(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (absolutePath: string, logicalPath: string): Promise<void> => {
    let stat: BigIntStats;
    try {
      stat = await fs.lstat(absolutePath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update(`${logicalPath}\0missing\0`);
        return;
      }
      throw error;
    }
    hash.update(`${logicalPath}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${await fs.readlink(absolutePath)}\0`);
    } else if (stat.isDirectory()) {
      const entries = await fs.readdir(absolutePath);
      entries.sort();
      for (const entry of entries) {
        await visit(path.join(absolutePath, entry), `${logicalPath}/${entry}`);
      }
    }
  };
  const unique = [...new Set(paths)].sort();
  for (const absolutePath of unique) await visit(absolutePath, absolutePath);
  return hash.digest("hex");
}

async function checkoutSourceMetadata(
  sourceRoot: string,
  env: Record<string, string>,
  payloadPaths: string[],
): Promise<
  { trackedPaths: string; indexEntries: string; digest: string } | { error: GitExecResult }
> {
  const [tracked, indexEntries] = await Promise.all([
    execGitCapture(["diff", "--name-only", "-z"], sourceRoot, env),
    execGitCapture(["ls-files", "--stage", "-z"], sourceRoot, env),
  ]);
  if (tracked.code !== 0) return { error: tracked };
  if (indexEntries.code !== 0) return { error: indexEntries };
  const relativePaths = [...tracked.stdout.split("\0").filter(Boolean), ...payloadPaths];
  const absolutePaths: string[] = [];
  for (const relativePath of relativePaths) {
    const resolved = resolveSnapshotPath(sourceRoot, relativePath);
    if (!resolved) {
      return {
        error: {
          code: 1,
          stdout: "",
          stderr: "Git returned an invalid local file path.",
          signal: null,
          timedOut: false,
        },
      };
    }
    absolutePaths.push(resolved);
  }
  return {
    trackedPaths: tracked.stdout,
    indexEntries: indexEntries.stdout,
    digest: await snapshotMetadataDigest(absolutePaths),
  };
}

async function digestSnapshotTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      hash.update(`${relativePath}\0${stat.mode & 0o7777}\0`);
      if (stat.isSymbolicLink()) {
        hash.update(`link\0${await fs.readlink(absolutePath)}\0`);
      } else if (stat.isDirectory()) {
        hash.update("dir\0");
        await visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        hash.update(`file\0${stat.size}\0`);
        for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
        hash.update("\0");
      } else {
        throw new Error(`Unsupported captured file type: ${relativePath}`);
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

/** Capture an immutable, source-preserving snapshot before worktree checkout. */
export async function captureCheckoutChanges(
  requestedRoot: string,
): Promise<CaptureCheckoutChangesResult> {
  const env = await getSubprocessEnv();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-vis-worktree-changes-"));
  const stagedPatch = path.join(tempDir, "staged.patch");
  const unstagedPatch = path.join(tempDir, "unstaged.patch");
  let verificationDir: string | undefined;
  let retained = false;
  try {
    const rootResult = await execGitCapture(["rev-parse", "--show-toplevel"], requestedRoot, env);
    const repositoryRoot = rootResult.stdout.trim();
    if (rootResult.code !== 0 || !repositoryRoot) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Reading repository root", rootResult),
      };
    }
    // Git path output is not consistently cwd-relative across commands. Capture
    // the complete checkout from one canonical repository-root coordinate system.
    const sourceRoot = repositoryRoot;
    const headResult = await execGitCapture(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      sourceRoot,
      env,
    );
    const head = headResult.stdout.trim();
    if (headResult.code !== 0 || !head) {
      return { kind: "error", message: describeCheckoutCopyFailure("Reading HEAD", headResult) };
    }
    const current = await execGitCapture(["rev-parse", "--abbrev-ref", "HEAD"], sourceRoot, env);
    const currentLabel = current.stdout.trim();
    const baseLabel =
      current.code === 0 && currentLabel && currentLabel !== "HEAD"
        ? currentLabel
        : head.slice(0, 8);

    const status = await execGitCapture(
      ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=none"],
      sourceRoot,
      env,
    );
    if (status.code !== 0) {
      return { kind: "error", message: describeCheckoutCopyFailure("Reading status", status) };
    }
    const dirtySubmodule = status.stdout
      .split("\0")
      .filter(Boolean)
      .some((record) => {
        if (!record.startsWith("1 ") && !record.startsWith("2 ") && !record.startsWith("u ")) {
          return false;
        }
        return record.split(" ")[2]?.startsWith("S") === true;
      });
    if (dirtySubmodule) {
      return {
        kind: "error",
        message: "Commit or clean submodule changes before creating a worktree.",
      };
    }

    const patchArgs = ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"];
    const staged = await execGitCapture(
      [...patchArgs, `--output=${stagedPatch}`, "--cached", head, "--"],
      sourceRoot,
      env,
      WORKTREE_ADD_TIMEOUT_MS,
    );
    if (staged.code !== 0) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Reading staged changes", staged),
      };
    }
    const unstaged = await execGitCapture(
      [...patchArgs, `--output=${unstagedPatch}`, "--"],
      sourceRoot,
      env,
      WORKTREE_ADD_TIMEOUT_MS,
    );
    if (unstaged.code !== 0) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Reading unstaged changes", unstaged),
      };
    }

    const [untracked, intentToAdd, stagedStat, unstagedStat] = await Promise.all([
      execGitCapture(["ls-files", "--others", "--exclude-standard", "-z"], sourceRoot, env),
      execGitCapture(["diff", "--name-only", "--diff-filter=A", "-z"], sourceRoot, env),
      fs.stat(stagedPatch),
      fs.stat(unstagedPatch),
    ]);
    if (untracked.code !== 0) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Reading untracked files", untracked),
      };
    }
    if (intentToAdd.code !== 0) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Reading intent-to-add files", intentToAdd),
      };
    }

    const untrackedPaths = untracked.stdout.split("\0").filter(Boolean);
    const intentToAddPaths = intentToAdd.stdout.split("\0").filter(Boolean);
    await Promise.all([
      fs.mkdir(path.join(tempDir, "untracked"), { recursive: true }),
      fs.mkdir(path.join(tempDir, "intent"), { recursive: true }),
    ]);
    for (const [kind, paths] of [
      ["untracked", untrackedPaths],
      ["intent", intentToAddPaths],
    ] as const) {
      for (const relativePath of paths) {
        const source = resolveSnapshotPath(sourceRoot, relativePath);
        const target = resolveSnapshotPath(path.join(tempDir, kind), relativePath);
        if (!source || !target) {
          return { kind: "error", message: "Git returned an invalid local file path." };
        }
        await copySnapshotPath(source, target);
      }
    }
    const directoryModes = await captureDirectoryModes(sourceRoot, [
      ...untrackedPaths,
      ...intentToAddPaths,
    ]);
    for (const kind of ["untracked", "intent"] as const) {
      for (const directory of directoryModes) {
        const capturedDirectory = resolveSnapshotPath(path.join(tempDir, kind), directory.path);
        if (!capturedDirectory) {
          return { kind: "error", message: "The captured directory path is invalid." };
        }
        try {
          await fs.chmod(capturedDirectory, directory.mode);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }

    // Re-read every captured input after payload copying. This makes a capture
    // self-consistent: a file or index mutation while an earlier path was being
    // copied cannot produce a mixed snapshot that later validates by accident.
    const sourceMetadataBefore = await checkoutSourceMetadata(sourceRoot, env, [
      ...untrackedPaths,
      ...intentToAddPaths,
      ...directoryModes.map((directory) => directory.path),
    ]);
    if ("error" in sourceMetadataBefore) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Reading source metadata", sourceMetadataBefore.error),
      };
    }
    // Hash the retained tree before the second source observation. The final
    // payload comparison below hashes source bytes directly against this tree,
    // avoiding a long temp-only hashing interval after the last source read.
    const digest = await digestSnapshotTree(tempDir);
    verificationDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-vis-worktree-verify-"));
    const verificationStagedPatch = path.join(verificationDir, "staged.patch");
    const verificationUnstagedPatch = path.join(verificationDir, "unstaged.patch");
    const verificationStaged = await execGitCapture(
      [...patchArgs, `--output=${verificationStagedPatch}`, "--cached", head, "--"],
      sourceRoot,
      env,
      WORKTREE_ADD_TIMEOUT_MS,
    );
    const verificationUnstaged = await execGitCapture(
      [...patchArgs, `--output=${verificationUnstagedPatch}`, "--"],
      sourceRoot,
      env,
      WORKTREE_ADD_TIMEOUT_MS,
    );
    const [verificationUntracked, verificationIntent] = await Promise.all([
      execGitCapture(["ls-files", "--others", "--exclude-standard", "-z"], sourceRoot, env),
      execGitCapture(["diff", "--name-only", "--diff-filter=A", "-z"], sourceRoot, env),
    ]);
    const verificationFailed = [
      verificationStaged,
      verificationUnstaged,
      verificationUntracked,
      verificationIntent,
    ].find((result) => result.code !== 0);
    if (verificationFailed) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Verifying local changes", verificationFailed),
      };
    }
    if (
      verificationUntracked.stdout !== untracked.stdout ||
      verificationIntent.stdout !== intentToAdd.stdout ||
      !(await snapshotPathsEqual(verificationStagedPatch, stagedPatch)) ||
      !(await snapshotPathsEqual(verificationUnstagedPatch, unstagedPatch))
    ) {
      return {
        kind: "error",
        message: "The checkout changed while local changes were being captured. Try again.",
      };
    }
    for (const [kind, paths] of [
      ["untracked", untrackedPaths],
      ["intent", intentToAddPaths],
    ] as const) {
      for (const relativePath of paths) {
        const source = resolveSnapshotPath(sourceRoot, relativePath);
        const captured = resolveSnapshotPath(path.join(tempDir, kind), relativePath);
        if (!source || !captured) {
          return { kind: "error", message: "Git returned an invalid local file path." };
        }
        if (!(await snapshotPathsEqual(source, captured))) {
          return {
            kind: "error",
            message: "The checkout changed while local changes were being captured. Try again.",
          };
        }
      }
    }
    // Finish with cheap source metadata/ref observations; no temporary payload
    // is re-read after this point.
    const [finalUntracked, finalIntent, finalStatus, finalHead, finalBranch] = await Promise.all([
      execGitCapture(["ls-files", "--others", "--exclude-standard", "-z"], sourceRoot, env),
      execGitCapture(["diff", "--name-only", "--diff-filter=A", "-z"], sourceRoot, env),
      execGitCapture(
        ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=none"],
        sourceRoot,
        env,
      ),
      execGitCapture(["rev-parse", "--verify", "HEAD^{commit}"], sourceRoot, env),
      execGitCapture(["rev-parse", "--abbrev-ref", "HEAD"], sourceRoot, env),
    ]);
    const finalFailed = [finalUntracked, finalIntent, finalStatus, finalHead, finalBranch].find(
      (result) => result.code !== 0,
    );
    if (finalFailed) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure("Verifying local changes", finalFailed),
      };
    }
    const finalLabel = finalBranch.stdout.trim();
    const finalBaseLabel = finalLabel && finalLabel !== "HEAD" ? finalLabel : head.slice(0, 8);
    if (
      finalHead.stdout.trim() !== head ||
      finalBaseLabel !== baseLabel ||
      finalStatus.stdout !== status.stdout ||
      finalUntracked.stdout !== untracked.stdout ||
      finalIntent.stdout !== intentToAdd.stdout
    ) {
      return {
        kind: "error",
        message: "The checkout changed while local changes were being captured. Try again.",
      };
    }
    const sourceMetadataAfter = await checkoutSourceMetadata(sourceRoot, env, [
      ...untrackedPaths,
      ...intentToAddPaths,
      ...directoryModes.map((directory) => directory.path),
    ]);
    if ("error" in sourceMetadataAfter) {
      return {
        kind: "error",
        message: describeCheckoutCopyFailure(
          "Verifying source metadata",
          sourceMetadataAfter.error,
        ),
      };
    }
    if (
      sourceMetadataAfter.trackedPaths !== sourceMetadataBefore.trackedPaths ||
      sourceMetadataAfter.indexEntries !== sourceMetadataBefore.indexEntries ||
      sourceMetadataAfter.digest !== sourceMetadataBefore.digest
    ) {
      return {
        kind: "error",
        message: "The checkout changed while local changes were being captured. Try again.",
      };
    }
    retained = true;
    return {
      kind: "ok",
      snapshot: {
        head,
        baseLabel,
        changed:
          stagedStat.size > 0 ||
          unstagedStat.size > 0 ||
          untrackedPaths.length > 0 ||
          intentToAddPaths.length > 0,
        tempDir,
        stagedPatch,
        unstagedPatch,
        untrackedPaths,
        intentToAddPaths,
        directoryModes,
        digest,
      },
    };
  } catch (err) {
    return { kind: "error", message: `Could not capture local changes: ${errorMessage(err)}` };
  } finally {
    if (verificationDir) {
      await fs.rm(verificationDir, { recursive: true, force: true }).catch(() => {});
    }
    // Ownership of a successful snapshot passes to the caller.
    if (!retained) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function disposeCheckoutChangesSnapshot(
  snapshot: CheckoutChangesSnapshot,
): Promise<void> {
  await fs.rm(snapshot.tempDir, { recursive: true, force: true }).catch(() => {});
}

export async function checkoutStillMatchesSnapshot(
  sourceRoot: string,
  snapshot: CheckoutChangesSnapshot,
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
  const current = await captureCheckoutChanges(sourceRoot);
  if (current.kind === "error") return current;
  try {
    if (
      current.snapshot.head !== snapshot.head ||
      current.snapshot.baseLabel !== snapshot.baseLabel ||
      current.snapshot.digest !== snapshot.digest
    ) {
      return {
        kind: "error",
        message: "The current checkout changed while the worktree was being created. Try again.",
      };
    }
    return { kind: "ok" };
  } finally {
    await disposeCheckoutChangesSnapshot(current.snapshot);
  }
}

/** Apply a captured checkout snapshot to a clean worktree at the same HEAD. */
export async function applyCheckoutChanges(
  snapshot: CheckoutChangesSnapshot,
  targetRoot: string,
): Promise<CopyCheckoutChangesResult> {
  const env = await getSubprocessEnv();
  try {
    const targetHead = await execGitCapture(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      targetRoot,
      env,
    );
    if (targetHead.code !== 0 || targetHead.stdout.trim() !== snapshot.head) {
      return { kind: "error", message: "The new worktree no longer matches the captured HEAD." };
    }
    const stagedStat = await fs.stat(snapshot.stagedPatch);
    if (stagedStat.size > 0) {
      const applied = await execGitCapture(
        ["apply", "--binary", "--index", "--whitespace=nowarn", snapshot.stagedPatch],
        targetRoot,
        env,
        WORKTREE_ADD_TIMEOUT_MS,
      );
      if (applied.code !== 0) {
        return {
          kind: "error",
          message: describeCheckoutCopyFailure("Copying staged changes", applied),
        };
      }
    }
    const unstagedStat = await fs.stat(snapshot.unstagedPatch);
    if (unstagedStat.size > 0) {
      const applied = await execGitCapture(
        ["apply", "--binary", "--whitespace=nowarn", snapshot.unstagedPatch],
        targetRoot,
        env,
        WORKTREE_ADD_TIMEOUT_MS,
      );
      if (applied.code !== 0) {
        return {
          kind: "error",
          message: describeCheckoutCopyFailure("Copying unstaged changes", applied),
        };
      }
    }

    for (const relativePath of snapshot.untrackedPaths) {
      const source = resolveSnapshotPath(path.join(snapshot.tempDir, "untracked"), relativePath);
      const target = resolveSnapshotPath(targetRoot, relativePath);
      if (!source || !target) {
        return { kind: "error", message: "The captured untracked path is invalid." };
      }
      await copySnapshotPath(source, target);
    }
    for (const relativePath of snapshot.intentToAddPaths) {
      const source = resolveSnapshotPath(path.join(snapshot.tempDir, "intent"), relativePath);
      const target = resolveSnapshotPath(targetRoot, relativePath);
      if (!source || !target) {
        return { kind: "error", message: "The captured intent-to-add path is invalid." };
      }
      try {
        await fs.lstat(target);
      } catch {
        await copySnapshotPath(source, target);
      }
    }
    // mkdir uses the process umask; restore source permissions only after all
    // payloads are in place so restrictive parents do not interrupt copying.
    for (const directory of snapshot.directoryModes) {
      const target = resolveSnapshotPath(targetRoot, directory.path);
      if (!target) return { kind: "error", message: "The captured directory path is invalid." };
      await fs.chmod(target, directory.mode);
    }
    for (let index = 0; index < snapshot.intentToAddPaths.length; index += 100) {
      const batch = snapshot.intentToAddPaths.slice(index, index + 100);
      const added = await execGitCapture(["add", "-N", "--", ...batch], targetRoot, env);
      if (added.code !== 0) {
        return {
          kind: "error",
          message: describeCheckoutCopyFailure("Restoring intent-to-add files", added),
        };
      }
    }
    return { kind: "ok", changed: snapshot.changed };
  } catch (err) {
    return { kind: "error", message: `Could not copy local changes: ${errorMessage(err)}` };
  }
}

/** Convenience helper for tests and already-created matching worktrees. */
export async function copyCheckoutChanges(
  sourceRoot: string,
  targetRoot: string,
): Promise<CopyCheckoutChangesResult> {
  const captured = await captureCheckoutChanges(sourceRoot);
  if (captured.kind === "error") return captured;
  try {
    return await applyCheckoutChanges(captured.snapshot, targetRoot);
  } finally {
    await disposeCheckoutChangesSnapshot(captured.snapshot);
  }
}

async function cleanupFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  expectedHead: string,
  env: Record<string, string>,
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
  const listing = await execGitCapture(["worktree", "list", "--porcelain"], repoRoot, env);
  if (listing.code !== 0) {
    return {
      kind: "error",
      message: listing.stderr.trim() || "Could not verify failed worktree ownership.",
    };
  }
  const ownedRegistration = listing.stdout.split(/\n\n+/).some((block) => {
    const fields = block.split("\n");
    return fields.includes(`worktree ${worktreePath}`) && fields.includes(`HEAD ${expectedHead}`);
  });
  if (ownedRegistration) {
    return cleanupOwnedWorktreeArtifacts(repoRoot, worktreePath, undefined, env);
  }
  const pathExists = await fs
    .stat(worktreePath)
    .then(() => true)
    .catch(() => false);
  return pathExists
    ? {
        kind: "error",
        message:
          "A path appeared at the destination, but this operation could not prove ownership; it was left untouched.",
      }
    : { kind: "ok" };
}

async function cleanupOwnedWorktreeArtifacts(
  repoRoot: string,
  worktreePath: string,
  branch: string | undefined,
  env: Record<string, string>,
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
  const failures: string[] = [];
  const removed = await execGitCapture(
    ["worktree", "remove", "--force", worktreePath],
    repoRoot,
    env,
    WORKTREE_ADD_TIMEOUT_MS,
  );
  if (removed.code !== 0) {
    // A checkout can fail before Git finishes registering it. The path was
    // collision-checked immediately before creation and is therefore owned by
    // this attempt; remove it directly, then prune any partial registration.
    await fs.rm(worktreePath, { recursive: true, force: true }).catch((error) => {
      failures.push(`remove directory: ${errorMessage(error)}`);
    });
    const pruned = await execGitCapture(["worktree", "prune", "--expire", "now"], repoRoot, env);
    if (pruned.code !== 0) {
      failures.push(pruned.stderr.trim() || `git worktree prune failed with code ${pruned.code}`);
    }
  }
  if (branch) {
    const deleted = await execGitCapture(["branch", "-D", branch], repoRoot, env);
    if (deleted.code !== 0) {
      failures.push(deleted.stderr.trim() || `git branch -D failed with code ${deleted.code}`);
    }
  }
  return failures.length > 0 ? { kind: "error", message: failures.join("; ") } : { kind: "ok" };
}

/**
 * Roll back a worktree freshly created by {@link createWorktree} when session
 * eligibility changes before runtime detachment begins. This must never be
 * used after the replacement host starts: extension startup could already
 * have written user data into that checkout.
 */
export async function cleanupCreatedWorktree(
  root: string,
  worktreePath: string,
  branch: string,
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
  try {
    const env = await getSubprocessEnv();
    const repoRoot = (await execGitText(["rev-parse", "--show-toplevel"], root, env)).stdout.trim();
    if (!repoRoot) return { kind: "error", message: "Not a git repository" };
    return await cleanupOwnedWorktreeArtifacts(repoRoot, worktreePath, branch, env);
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
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
 *     against the command's cwd before realpath. No
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
 *  - canonical toplevel === the session's realpath'd current checkout →
 *    "That's already the current checkout." The primary workspace remains a
 *    valid destination when the session currently runs in a linked worktree.
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
  currentCheckoutRoot: string = workspaceRoot,
  allowCurrentCheckout = false,
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
  // `--git-common-dir` can return a relative path; resolve it against each
  // command's cwd, then realpath both sides for the byte-for-byte
  // compare that survives `/var`↔`/private/var` (macOS) and any symlinks
  // the user or `git worktree add` created in the candidate path.
  try {
    const commonRes = await execGitText(["rev-parse", "--git-common-dir"], candidatePath, env);
    const rel = commonRes.stdout.trim();
    if (!rel) return { kind: "error", message: "Not a git repository." };
    commonDirRel = path.isAbsolute(rel) ? rel : path.resolve(candidatePath, rel);
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
    workspaceCommon = path.isAbsolute(rel) ? rel : path.resolve(workspaceRoot, rel);
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
  if (!allowCurrentCheckout) {
    let realCurrentTop: string;
    try {
      const currentTop = (
        await execGitText(["rev-parse", "--show-toplevel"], currentCheckoutRoot, env)
      ).stdout.trim();
      realCurrentTop = await fs.realpath(currentTop);
    } catch {
      return { kind: "error", message: "The session's current checkout is unavailable." };
    }
    if (realCandidateTop === realCurrentTop) {
      return { kind: "error", message: "That's already the current checkout." };
    }
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

  return { kind: "ok", path: realCandidateTop, workspaceTop: realWorkspaceTop, branch, name };
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
