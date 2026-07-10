// Git IPC types — worktree-aware. Requests take an explicit `root` (the
// path of the tree being diffed) so the renderer can swap `workspacePath`
// for a worktree path later without touching every call site. Session-id
// is never the input: a session is associated with a tree, not the other
// way around.

export type GitFileStatus = "M" | "A" | "D" | "R";

export interface GitChangedFile {
  /** Repo-root-relative path, posix separators (as git reports). */
  path: string;
  /** Set only when status is "R". */
  oldPath?: string;
  status: GitFileStatus;
  /** True for untracked files (rendered as "A" with a tooltip). */
  untracked: boolean;
  /** 0 when unknown (binary, large, uncounted). */
  insertions: number;
  deletions: number;
  binary: boolean;
}

export type GitChangesResult =
  | {
      kind: "ok";
      repoRoot: string;
      files: GitChangedFile[];
      /** Complete, deterministically ordered changed-file manifest used by
       *  worker-backed search. Unlike `files`, this is never capped; it carries
       *  descriptors only, never file contents. Optional for compatibility
       *  with older preview/test fixtures. */
      searchFiles?: GitChangedFile[] | undefined;
      /** True when the browsable file list was capped (see WP1b: 500-file limit). */
      truncated: boolean;
      /** Content hash of the working tree vs HEAD (base-independent), plus
       *  untracked file contents (the first 200 by name; beyond that, only
       *  a file's presence is hashed, not its contents). Lets the diff viewer
       *  tell a real edit from a read-only tool call without inspecting tool
       *  names. */
      fingerprint: string;
    }
  | { kind: "not-a-repo" }
  | { kind: "git-missing" }
  | { kind: "error"; message: string };

/** Lightweight result for the header badge: just the changed-file count
 *  (capped at the same limit as `GitChangesResult.files`). No line counts,
 *  no fingerprint — see `getChangesCount`. */
export type GitChangesCountResult =
  | { kind: "ok"; fileCount: number; truncated: boolean }
  | { kind: "not-a-repo" }
  | { kind: "git-missing" }
  | { kind: "error"; message: string };

export type GitFileDiffResult =
  | {
      kind: "ok";
      oldText: string;
      newText: string;
      binary: boolean;
      tooLarge: boolean;
      oldMissingNewline: boolean;
      newMissingNewline: boolean;
    }
  | { kind: "error"; message: string };

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
}

export type GitBranchesResult =
  | { kind: "ok"; current: string | null; branches: GitBranch[] }
  | { kind: "not-a-repo" }
  | { kind: "git-missing" }
  | { kind: "error"; message: string };

/** Compare-and-swap write of a working-tree file. The renderer sends the
 *  sha256 (UTF-8) of the `newText` it derived its edit buffer from; main
 *  re-reads the file, hashes the decoded-string re-encoding the same way, and
 *  only writes when the hashes match — so a save never overwrites disk content
 *  that moved underneath the editor. `conflict` surfaces a stale-base state;
 *  the renderer re-anchors and retries once. */
export type GitWriteFileResult =
  | { kind: "ok" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export interface GitWorktreeCreated {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Full branch name, e.g. "pi-vis-swift-otter". */
  branch: string;
  /** The friendly name portion, e.g. "swift-otter". */
  name: string;
  /** The base branch the worktree was cut from. */
  base: string;
}

export type GitWorktreeResult =
  | ({ kind: "ok" } & GitWorktreeCreated)
  | { kind: "error"; message: string };

/**
 * Result of inspecting a candidate directory for attach-to-worktree.
 *
 * `path` is the **canonical worktree toplevel** (not the raw input):
 * `git rev-parse --show-toplevel` collapses a pasted subdirectory down
 * to the worktree root, then `fs.realpath` resolves symlinks (macOS
 * `/var`↔`/private/var`). Every downstream use — the same-repo compare,
 * the persisted `settings.worktrees` key, the respawn cwd, and the
 * chip name — uses this canonical path, never the raw input. Skipping
 * the canonicalization breaks subdir inputs, the relaunch re-attach
 * (`resolveWorktreeForFile` matches `cwd` from the session file
 * header byte-for-byte against the persisted key), and the
 * workspace-self guard.
 */
export type GitWorktreeInspect =
  | {
      kind: "ok";
      path: string;
      /** Best-effort branch label. Falls back to a short SHA on detached
       *  HEAD, or `"(no commits)"` for an unborn HEAD. */
      branch: string;
      /** `path.basename(path)` — the directory name, used for the chip. */
      name: string;
    }
  | { kind: "error"; message: string };
