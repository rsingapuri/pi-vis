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
      /** True when the file list was capped (see WP1b: 500-file limit). */
      truncated: boolean;
    }
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
