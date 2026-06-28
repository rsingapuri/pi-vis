import type { ProviderAuthStatus } from "./auth.js";
import type {
  GitBranchesResult,
  GitChangedFile,
  GitChangesCountResult,
  GitChangesResult,
  GitFileDiffResult,
  GitFileStatus,
} from "./git.js";
import type { SessionId } from "./ids.js";
import type { PiRpcCommand } from "./pi-protocol/commands.js";
import type { PiEvent } from "./pi-protocol/events.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./pi-protocol/extension-ui.js";
import type { PanelEvent } from "./pi-protocol/panel-events.js";
import type { PiRpcResponse } from "./pi-protocol/responses.js";
import type { AppSettings } from "./settings.js";
import type { UpdateStatus } from "./updates.js";

export interface SessionSummary {
  filePath: string;
  id: string;
  name?: string | undefined;
  mtime: number;
  /** Epoch-ms of the most recent user-authored entry (prompt / `!bash`),
   *  read from the session file. Absent for sessions with no user messages,
   *  in which case callers fall back to `mtime`. Drives the persistent
   *  sidebar ordering — see `extractSessionMeta`. */
  lastActiveAt?: number | undefined;
  preview: string;
  messageCount: number;
  cwd: string;
}

export type SessionStatus = "cold" | "starting" | "ready" | "exited" | "failed";

/** A worktree a session runs in. Persisted in settings.worktrees keyed
 *  by `path` so worktree sessions survive app relaunch. */
export interface WorktreeIdentity {
  path: string;
  branch: string;
  name: string;
  base: string;
}

export interface TranscriptBlock {
  id: string;
  type: string;
  // actual block data carried as discriminated union in renderer; the
  // shared schema is intentionally permissive (validated in renderer
  // and history-loader before reading).
  data: unknown;
}

// Every invoke channel: request type → response type
export interface IpcInvokeContract {
  "pi.locate": { req: undefined; res: { path: string; version: string } | null };
  "workspace.pick": { req: undefined; res: string | null };
  "workspace.list": { req: undefined; res: string[] };
  "workspace.remove": { req: { workspacePath: string }; res: string[] };
  "workspace.listSessions": { req: { workspacePath: string }; res: SessionSummary[] };
  // Worktree identity attached to a session.open response when the
  // resumed session file belongs to a known worktree of the workspace.
  // Lets the renderer show the worktree chip and lets the main process
  // spawn pi inside the worktree cwd (not the parent workspace).
  "session.open": {
    req: { workspacePath: string; sessionFile?: string | undefined };
    res:
      | {
          outcome: "opened" | "existing";
          sessionId: SessionId;
          name: string | null;
          preview: string | null;
          sessionStatus: SessionStatus;
          worktree?: WorktreeIdentity | undefined;
        }
      | { outcome: "missing" };
  };
  "session.activate": { req: { sessionId: SessionId }; res: undefined };
  "session.reload": {
    req: { sessionId: SessionId };
    res: { success: true } | { success: false; error: string };
  };
  // /share: export the session to a secret GitHub gist (via `gh`) and
  // return the pi.dev share viewer URL. Implemented in main because it
  // shells out to `gh` and writes a temp file; the HTML content comes from
  // the host's export_html bridge command. Error strings match pi's TUI
  // messages verbatim for the gh-missing / gh-not-logged-in cases.
  "session.share": {
    req: { sessionId: SessionId };
    res: { ok: true; url: string; gistUrl: string } | { ok: false; error: string };
  };
  // /changelog: read pi's shipped CHANGELOG.md from the located pi
  // package dir and return the raw markdown. The renderer renders it as a
  // custom_message block (mirrors pi's in-TUI changelog rendering).
  "pi.changelog": {
    req: undefined;
    res: { ok: true; markdown: string } | { ok: false; error: string };
  };
  "session.createWorktree": {
    req: { sessionId: SessionId; base: string };
    res:
      | { ok: true; worktreePath: string; branch: string; name: string; base: string }
      | { ok: false; error: string };
  };
  // Attach an existing worktree on disk to a fresh session. Mirrors the
  // shape of `session.createWorktree` — the main process re-runs
  // `inspectWorktree` server-side so a stale/edited live-validate result
  // can never persist a bad path. `path` is the canonical toplevel the
  // main process resolved; the renderer uses it to seed
  // `applyWorktree` and the same plumbing (`setWorktreeAndRespawn`,
  // `settings.worktrees` persistence, `resolveWorktreeForFile`
  // re-attach) as the create flow. `base` equals `branch` here — there
  // is no "cut from" relationship for an attached worktree; the chip
  // tooltip uses `base === branch` as the "attached, not cut from
  // anything" sentinel.
  "session.attachWorktree": {
    req: { sessionId: SessionId; path: string };
    res:
      | { ok: true; worktreePath: string; branch: string; name: string; base: string }
      | { ok: false; error: string };
  };
  // Live-validate a pasted-or-picked path for the WorktreeBar's
  // "Existing" mode. The renderer calls this from a debounced text
  // input + the "Browse…" button; the result drives the status line.
  // The result is advisory only — the authoritative gate is the
  // `session.attachWorktree` IPC re-running `inspectWorktree`.
  "worktree.validate": {
    req: { workspacePath: string; path: string };
    res: { ok: true; branch: string; name: string } | { ok: false; error: string };
  };
  // Open the OS directory picker for attaching to an existing worktree.
  // Returns the chosen path or `null` if the user cancelled.
  "worktree.pickDirectory": { req: { workspacePath: string }; res: string | null };
  "session.close": { req: { sessionId: SessionId }; res: undefined };
  "session.loadHistory": { req: { sessionId: SessionId }; res: TranscriptBlock[] };
  "session.sendCommand": {
    req: { sessionId: SessionId; command: PiRpcCommand };
    res: PiRpcResponse;
  };
  "session.respondToUiRequest": {
    req: { sessionId: SessionId; response: ExtensionUiResponse };
    res: undefined;
  };
  /** Send keystroke input to an open custom panel (xterm.js overlay). */
  "session.panelInput": {
    req: { sessionId: SessionId; panelId: number; data: string };
    res: undefined;
  };
  /** Notify the host of a new xterm.js panel size (cols/rows), so the TUI
   *  layout matches the actual panel dimensions. */
  "session.panelResize": {
    req: { sessionId: SessionId; panelId: number; cols: number; rows: number };
    res: undefined;
  };
  /** Force-close an open custom panel (escape hatch for a panel whose
   *  extension never calls done()). Resolves the extension's custom() promise
   *  with undefined and tears the panel down on both sides. */
  "session.panelClose": {
    req: { sessionId: SessionId; panelId: number };
    res: undefined;
  };
  "settings.get": { req: undefined; res: AppSettings };
  "settings.set": { req: Partial<AppSettings>; res: AppSettings };
  "app.versions": { req: undefined; res: { app: string; electron: string; node: string } };
  // Clipboard write. Routed through the main process because the
  // renderer's `navigator.clipboard` API is unreliable in Electron
  // (it silently no-ops when the window isn't focused / under certain
  // security contexts), which left clicks that "copied" nothing.
  "clipboard.writeText": { req: { text: string }; res: { ok: true } };

  // Git diff viewer (WP1). The requests take an explicit `root` (the
  // tree being diffed) — never a sessionId — so the renderer can swap
  // `workspacePath` for a worktree path later without touching every
  // call site. The optional `oldPath` is set on renames; status is the
  // single-letter git code; `untracked` is true for new untracked files.
  "git.changes": { req: { root: string; base?: string }; res: GitChangesResult };
  // Lightweight changed-file count for the header badge while the viewer is
  // closed — one `git status` scan, no line counts / fingerprint / file reads.
  "git.changesCount": { req: { root: string }; res: GitChangesCountResult };
  "git.fileDiff": {
    req: {
      root: string;
      base?: string;
      path: string;
      oldPath?: string;
      status: GitFileStatus;
      untracked: boolean;
    };
    res: GitFileDiffResult;
  };
  "git.branches": { req: { root: string }; res: GitBranchesResult };

  // ── Auth ────────────────────────────────────────────────────────────
  "auth.status": { req: undefined; res: ProviderAuthStatus[] };
  "auth.saveApiKey": {
    req: { provider: string; key: string };
    res: { ok: true } | { ok: false; error: string };
  };
  "auth.remove": {
    req: { provider: string };
    res: { ok: true } | { ok: false; error: string };
  };

  // ── PTY ─────────────────────────────────────────────────────────────
  "pty.start": {
    req: { cwd?: string; autoLogin?: boolean; cols?: number; rows?: number };
    res: { ptyId: string };
  };
  "pty.write": { req: { ptyId: string; data: string }; res: undefined };
  "pty.resize": { req: { ptyId: string; cols: number; rows: number }; res: undefined };
  "pty.kill": { req: { ptyId: string }; res: undefined };

  // ── Updates ─────────────────────────────────────────────────────────
  "update.check": { req: undefined; res: UpdateStatus };
  "update.run": {
    req: { target: "all" | "pi" | { extension: string } };
    res: { runId: string };
  };
}

// Every event channel: payload type (main → renderer)
export interface IpcEventContract {
  "session.event": { sessionId: SessionId; event: PiEvent };
  "session.uiRequest": { sessionId: SessionId; request: ExtensionUiRequest };
  "session.statusChanged": {
    sessionId: SessionId;
    status: SessionStatus;
    error?: string | undefined;
    /** pi version when using SDK-host; undefined for --mode rpc */
    piVersion?: string | undefined;
  };
  // Emitted after new_session / switch_session / fork / clone when the
  // authoritative sessionFile + sessionName are known. The renderer adopts
  // the new file unconditionally (overriding any "only-if-unset" guard),
  // reseeds the transcript, and refreshes the workspace session list.
  "session.fileChanged": {
    sessionId: SessionId;
    sessionFile?: string | undefined;
    sessionName?: string | undefined;
  };

  // ── Auth ────────────────────────────────────────────────────────────
  "auth.changed": { providers: ProviderAuthStatus[] };

  // ── PTY ─────────────────────────────────────────────────────────────
  "pty.data": { ptyId: string; data: string };
  "pty.exit": { ptyId: string; exitCode: number };

  // ── Updates ─────────────────────────────────────────────────────────
  "update.available": UpdateStatus;
  "update.progress": { runId: string; chunk: string };
  "update.done": { runId: string; exitCode: number; status: UpdateStatus };

  // ── Panels (custom() rendering) ────────────────────────────────────
  "session.panelEvent": { sessionId: SessionId; event: PanelEvent };
}

export type IpcInvokeChannel = keyof IpcInvokeContract;
export type IpcEventChannel = keyof IpcEventContract;
