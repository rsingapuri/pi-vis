import type { GitChangedFile, GitChangesResult, GitFileDiffResult, GitFileStatus } from "./git.js";
import type { SessionId } from "./ids.js";
import type { PiRpcCommand } from "./pi-protocol/commands.js";
import type { PiEvent } from "./pi-protocol/events.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./pi-protocol/extension-ui.js";
import type { PiRpcResponse } from "./pi-protocol/responses.js";
import type { AppSettings } from "./settings.js";

export interface SessionSummary {
  filePath: string;
  id: string;
  name?: string | undefined;
  mtime: number;
  preview: string;
  messageCount: number;
  cwd: string;
}

export type SessionStatus = "cold" | "starting" | "ready" | "exited" | "failed";

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
  "workspace.recents": { req: undefined; res: string[] };
  "workspace.remove": { req: { workspacePath: string }; res: string[] };
  "workspace.listSessions": { req: { workspacePath: string }; res: SessionSummary[] };
  "session.open": {
    req: { workspacePath: string; sessionFile?: string | undefined };
    res:
      | {
          outcome: "opened" | "existing";
          sessionId: SessionId;
          name: string | null;
          preview: string | null;
          sessionStatus: SessionStatus;
        }
      | { outcome: "missing" };
  };
  "session.activate": { req: { sessionId: SessionId }; res: undefined };
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
  "settings.get": { req: undefined; res: AppSettings };
  "settings.set": { req: Partial<AppSettings>; res: AppSettings };
  "app.versions": { req: undefined; res: { app: string; electron: string; node: string } };
  // Git diff viewer (WP1). The requests take an explicit `root` (the
  // tree being diffed) — never a sessionId — so the renderer can swap
  // `workspacePath` for a worktree path later without touching every
  // call site. The optional `oldPath` is set on renames; status is the
  // single-letter git code; `untracked` is true for new untracked files.
  "git.changes": { req: { root: string }; res: GitChangesResult };
  "git.fileDiff": {
    req: {
      root: string;
      path: string;
      oldPath?: string;
      status: GitFileStatus;
      untracked: boolean;
    };
    res: GitFileDiffResult;
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
}

export type IpcInvokeChannel = keyof IpcInvokeContract;
export type IpcEventChannel = keyof IpcEventContract;
