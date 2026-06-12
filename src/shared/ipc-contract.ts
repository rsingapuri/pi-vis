import type { SessionId } from "./ids.js";
import type { PiRpcCommand } from "./pi-protocol/commands.js";
import type { PiRpcResponse } from "./pi-protocol/responses.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./pi-protocol/extension-ui.js";
import type { PiEvent } from "./pi-protocol/events.js";
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
  // actual block data carried as discriminated union in renderer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

// Every invoke channel: request type → response type
export interface IpcInvokeContract {
  "pi.locate": { req: void; res: { path: string; version: string } | null };
  "workspace.pick": { req: void; res: string | null };
  "workspace.recents": { req: void; res: string[] };
  "workspace.listSessions": { req: { workspacePath: string }; res: SessionSummary[] };
  "session.open": {
    req: { workspacePath: string; sessionFile?: string | undefined };
    res: { sessionId: SessionId; name: string | null; preview: string | null };
  };
  "session.activate": { req: { sessionId: SessionId }; res: void };
  "session.close": { req: { sessionId: SessionId }; res: void };
  "session.loadHistory": { req: { sessionId: SessionId }; res: TranscriptBlock[] };
  "session.sendCommand": {
    req: { sessionId: SessionId; command: PiRpcCommand };
    res: PiRpcResponse;
  };
  "session.respondToUiRequest": {
    req: { sessionId: SessionId; response: ExtensionUiResponse };
    res: void;
  };
  "settings.get": { req: void; res: AppSettings };
  "settings.set": { req: Partial<AppSettings>; res: AppSettings };
  "app.versions": { req: void; res: { app: string; electron: string; node: string } };
}

// Every event channel: payload type (main → renderer)
export interface IpcEventContract {
  "session.event": { sessionId: SessionId; event: PiEvent };
  "session.uiRequest": { sessionId: SessionId; request: ExtensionUiRequest };
  "session.statusChanged": { sessionId: SessionId; status: SessionStatus; error?: string | undefined };
}

export type IpcInvokeChannel = keyof IpcInvokeContract;
export type IpcEventChannel = keyof IpcEventContract;
