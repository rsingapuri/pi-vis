import type { AppUpdateStatus } from "./app-updates.js";
import type { ProviderAuthStatus } from "./auth.js";
import type {
  GitBranchesResult,
  GitChangedFile,
  GitChangesCountResult,
  GitChangesResult,
  GitFileDiffResult,
  GitFileStatus,
  GitWriteFileResult,
} from "./git.js";
import type { SessionId } from "./ids.js";
import type { PiRpcCommand } from "./pi-protocol/commands.js";
import type { PiEvent } from "./pi-protocol/events.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./pi-protocol/extension-ui.js";
import type { PanelEvent } from "./pi-protocol/panel-events.js";
import type {
  CommandSettlement,
  EscapeResult,
  ReloadRequest,
  ReloadSettlement,
  RuntimeRecord,
  RuntimeStateUpdate,
  SessionSubmission,
  SubmissionResult,
} from "./pi-protocol/runtime-state.js";
import type { AppSettings } from "./settings.js";
import type { Theme } from "./theme/index.js";
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

export interface HistoryPage {
  blocks: TranscriptBlock[];
  startIndex: number;
  total: number;
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
  "session.activate": {
    req: { sessionId: SessionId; activationVisitId?: string | undefined };
    res: undefined;
  };
  /** Release only a host whose cold→live activation belonged to this untouched visit. */
  "session.releaseActivationVisit": {
    req: { sessionId: SessionId; activationVisitId: string };
    res: { released: boolean };
  };
  /** Cancel an in-flight release when the user returns before it settles. */
  "session.cancelActivationVisitRelease": {
    req: { sessionId: SessionId; activationVisitId: string };
    res: { cancelled: boolean };
  };
  "session.reload": {
    req: { sessionId: SessionId; request: ReloadRequest };
    res: ReloadSettlement;
  };
  // /share: export the session to a secret GitHub gist (via `gh`) and
  // return the pi.dev share viewer URL. Implemented in main because it
  // shells out to `gh` and writes a temp file; the HTML content comes from
  // the host's export_html bridge command. Error strings match pi's TUI
  // messages verbatim for the gh-missing / gh-not-logged-in cases.
  "session.share": {
    req: {
      sessionId: SessionId;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
      exportIntentId: string;
    };
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
  "session.loadHistory": {
    req: {
      sessionId: SessionId;
      expectedSessionFile: string;
      historyGeneration: number;
      expectedHostInstanceId: string | null;
      expectedSessionEpoch: number | null;
      limit?: number | undefined;
      before?: number | undefined;
    };
    res:
      | { status: "loaded"; historyGeneration: number; page: HistoryPage }
      | { status: "stale"; historyGeneration: number };
  };
  // Replay a branch (an ordered array of SessionTreeEntry) from the host's
  // in-memory state into the same TranscriptBlock[] shape the renderer
  // already consumes via session.loadHistory. The renderer calls this after
  // /tree's navigate_tree returns, with the returned `branch` array, to
  // rebuild the transcript for the new active leaf without re-reading the
  // session file (which may be stale for freshly-appended entries).
  "session.transcriptForEntries": {
    req: { sessionId: SessionId; entries: import("./pi-protocol/responses.js").SessionTreeEntry[] };
    res: TranscriptBlock[];
  };
  "session.sendCommand": {
    req: {
      sessionId: SessionId;
      command: PiRpcCommand;
      requestId: string;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
      /** Required for effectful and replacement commands. */
      intentId?: string;
      uiSurface?: "composer" | "unified";
      /** Exact editor text that originated this command, for ambiguity review. */
      sourceText?: string;
      editorRevision?: number;
    };
    res: CommandSettlement;
  };
  /** The only text/image submission path. Pi chooses idle prompt vs queued delivery. */
  "session.submit": {
    req: { sessionId: SessionId; submission: SessionSubmission };
    res: SubmissionResult;
  };
  /** Every unclaimed bare Escape is acknowledged by the live host. */
  "session.acknowledgeRestoration": {
    req: { sessionId: SessionId; restorationId: string };
    res: { acknowledged: boolean };
  };
  "session.escape": {
    req: {
      sessionId: SessionId;
      requestId: string;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
    };
    res: EscapeResult;
  };
  /** Request a full snapshot after attach/focus/reload or a detected transport gap. */
  "session.runtimeResync": { req: { sessionId: SessionId }; res: RuntimeStateUpdate };
  /** Renderer lifecycle handshake. Loss increments generation and cancels blocking host UI. */
  "session.rendererAttach": {
    req: { sessionId: SessionId; rendererGeneration: number };
    res: RuntimeStateUpdate;
  };
  "session.editorPatch": {
    req: {
      sessionId: SessionId;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
      baseRevision: number;
      revision: number;
      text: string;
      attachments: unknown[];
    };
    res: {
      accepted: boolean;
      revision: number;
      text: string;
      attachments: unknown[];
      conflictText?: string;
      conflictAttachments?: unknown[];
    };
  };
  "session.respondToUiRequest": {
    req: {
      sessionId: SessionId;
      rendererGeneration: number;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
      operationId: string;
      response: ExtensionUiResponse;
    };
    res: { acknowledged: boolean };
  };
  /** Send keystroke input to an open custom panel (xterm.js overlay). */
  "session.panelInput": {
    req: {
      sessionId: SessionId;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
      panelId: number;
      sequence: number;
      data: string;
    };
    res: { acknowledgedThrough: number; gap?: { expected: number; received: number } };
  };
  /** Notify the host of a new xterm.js panel size (cols/rows), so the TUI
   *  layout matches the actual panel dimensions. `force` asks the host to
   *  discard its diff-render state and repaint a complete frame; UnifiedTuiHost
   *  uses it on xterm remount after session/view switches. */
  "session.panelResize": {
    req: {
      sessionId: SessionId;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
      panelId: number;
      cols: number;
      rows: number;
      force?: boolean;
    };
    res: undefined;
  };
  /** Force-close an open custom panel (escape hatch for a panel whose
   *  extension never calls done()). Resolves the extension's custom() promise
   *  with undefined and tears the panel down on both sides. */
  "session.panelClose": {
    req: {
      sessionId: SessionId;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
      panelId: number;
      operationId: string;
    };
    res: { acknowledged: boolean };
  };
  /** Two-phase close: checkpoint first, then confirm the current mutation token. */
  "session.prepareClose": {
    req: { sessionId: SessionId; force?: boolean };
    res: { reviewToken: string; checkpoint: unknown };
  };
  "session.cancelClose": {
    req: { sessionId: SessionId; reviewToken: string };
    res: { cancelled: boolean };
  };
  "session.confirmClose": {
    req: { sessionId: SessionId; reviewToken: string };
    res: { closed: boolean; reason?: string };
  };
  /** Respond to a unified-TUI editor submit (host→renderer round-trip).
   *  The host's `editor.onSubmit` sends the text to the renderer, which runs
   *  the shared submit pipeline (`submitFromText`). `ok:false` + `bailed:true`
   *  means a pre-send guard rejected the submit (e.g. no model) — the host
   *  restores the editor text. */
  "session.claimUnifiedSubmit": {
    req: {
      sessionId: SessionId;
      id: string;
      rendererGeneration: number;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
    };
    res: { claimed: false } | { claimed: true; claimId: string; expiresAt: number };
  };
  "session.unifiedSubmitResponse": {
    req: {
      sessionId: SessionId;
      id: string;
      rendererGeneration: number;
      claimId: string;
      expectedHostInstanceId: string;
      expectedSessionEpoch: number;
      ok: boolean;
      bailed?: boolean;
      error?: string;
    };
    res: { ok: boolean };
  };
  "settings.get": { req: undefined; res: AppSettings };
  "settings.set": { req: Partial<AppSettings>; res: AppSettings };
  // User-droppable themes loaded from <userData>/themes/*.json (validated
  // against ThemeSchema). Bundled themes are compiled into the renderer; this
  // returns only the user layer, which the renderer merges on top.
  "themes.listUser": { req: undefined; res: Theme[] };
  "themes.userDir": { req: undefined; res: string };
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
  // Compare-and-swap write of a working-tree file from the diff editor. The
  // renderer derives `expectedHash` (sha256 of UTF-8) from the `newText` its
  // edit buffer was built on; main refuses to write when the file on disk no
  // longer matches that base (returns `conflict`). `content` is the spliced
  // new file text. See `writeWorkingFile` in src/main/git/git.ts.
  "git.writeWorkingFile": {
    req: { root: string; path: string; content: string; expectedHash: string };
    res: GitWriteFileResult;
  };

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
  "appUpdate.status": { req: undefined; res: AppUpdateStatus };
  "appUpdate.check": { req: undefined; res: AppUpdateStatus };
  "appUpdate.install": { req: undefined; res: AppUpdateStatus };
}

// Every event channel: payload type (main → renderer)
export interface IpcEventContract {
  "session.events": { sessionId: SessionId; events: PiEvent[] };
  /** Atomic direct-getter runtime state; Unavailable is neither running nor idle. */
  "session.runtimeState": { sessionId: SessionId; state: RuntimeStateUpdate };
  /** One renderer-visible commit for a lifecycle epoch transition. */
  "session.transitionBatch": {
    sessionId: SessionId;
    records: RuntimeRecord[];
    state: RuntimeStateUpdate;
  };
  "session.submissionDisposition": { sessionId: SessionId; result: SubmissionResult };
  "session.queueRestoration": {
    sessionId: SessionId;
    restorationId: string;
    steering: string[];
    followUp: string[];
    originalAttachments: Array<{ intentId: string; images: unknown[] }>;
    commandDescription?: string;
    requiresReview: true;
  };
  "session.uiAcknowledged": { sessionId: SessionId; operationId: string };
  "session.uiRequest": { sessionId: SessionId; request: ExtensionUiRequest };
  "session.statusChanged": {
    sessionId: SessionId;
    status: SessionStatus;
    error?: string | undefined;
    /** pi version reported by the active SDK host. */
    piVersion?: string | undefined;
  };
  // Emitted after new_session / switch_session / fork / clone when the
  // authoritative sessionFile + sessionName are known. The renderer adopts
  // the new file unconditionally (overriding any "only-if-unset" guard),
  // reseeds the transcript, and refreshes the workspace session list.
  "session.fileChanged": {
    sessionId: SessionId;
    hostInstanceId: string;
    sessionEpoch: number;
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
  "appUpdate.status": AppUpdateStatus;

  // ── Window ─────────────────────────────────────────────────────────
  /** Window entered/left macOS fullscreen. In fullscreen the native
   *  traffic-light buttons disappear, so the renderer can drop the 80px
   *  left clearance the title bar reserves for them and reclaim that
   *  space. Fired on `enter-full-screen` / `leave-full-screen`. */
  "window.fullscreenChange": { fullscreen: boolean };

  // ── Panels (custom() rendering) ────────────────────────────────────
  "session.panelEvent": { sessionId: SessionId; event: PanelEvent };
  /** The unified-TUI editor submitted a prompt (host→renderer). The renderer
   *  runs the shared submit pipeline and replies via
   *  `session.unifiedSubmitResponse` (correlated by `id`). */
  "session.unifiedSubmitRequest": {
    sessionId: SessionId;
    id: string;
    text: string;
    editorRevision: number;
    submissionIntentId: string;
    hostInstanceId: string;
    sessionEpoch: number;
  };
}

export type IpcInvokeChannel = keyof IpcInvokeContract;
export type IpcEventChannel = keyof IpcEventContract;
