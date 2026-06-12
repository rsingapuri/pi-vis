import type { SessionId } from "@shared/ids.js";
import type { SessionStatus, SessionSummary } from "@shared/ipc-contract.js";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { ModelInfo, SessionStats } from "@shared/pi-protocol/responses.js";
import type { ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import { create } from "zustand";
import {
  type TranscriptState,
  addBashBlock,
  addUserBlock,
  applyPiEvent,
  createTranscriptState,
  finishBashBlock,
  seedFromHistory,
} from "./transcript.js";

export interface SessionViewState {
  sessionId: SessionId;
  workspacePath: string;
  sessionFile?: string | undefined;
  status: SessionStatus;
  error?: string | undefined;
  transcript: TranscriptState;
  isStreaming: boolean;
  pendingDialogs: ExtensionUiRequest[];
  statusSegments: Map<string, string>; // statusKey → statusText
  widgets: Map<string, string[]>; // widgetKey → lines
  toasts: Array<{ id: string; message: string; type?: string | undefined }>;
  stats?: SessionStats | undefined;
  availableModels: ModelInfo[];
  currentModel?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  sessionTitle?: string | undefined;
  sessionName?: string | undefined;
}

interface WorkspaceState {
  path: string;
  sessions: SessionSummary[];
  activeSessions: SessionId[];
}

interface SessionsStore {
  workspaces: Map<string, WorkspaceState>;
  sessions: Map<SessionId, SessionViewState>;
  activeSessionId: SessionId | null;
  activeWorkspacePath: string | null;

  addWorkspace: (path: string) => void;
  removeWorkspace: (path: string) => void;
  setWorkspaceSessions: (path: string, sessions: SessionSummary[]) => void;

  createSession: (sessionId: SessionId, workspacePath: string, sessionFile?: string) => void;
  setSessionStatus: (sessionId: SessionId, status: SessionStatus, error?: string) => void;
  applyEvent: (sessionId: SessionId, event: PiEvent) => void;
  seedHistory: (sessionId: SessionId, history: TranscriptBlock[]) => void;
  addUserMessage: (sessionId: SessionId, content: string, images?: string[]) => void;
  addBashCommand: (sessionId: SessionId, command: string) => void;
  finishBashCommand: (sessionId: SessionId, output: string, exitCode?: number) => void;
  setStreaming: (sessionId: SessionId, isStreaming: boolean) => void;
  addUiRequest: (sessionId: SessionId, request: ExtensionUiRequest) => void;
  dismissUiRequest: (sessionId: SessionId, requestId: string) => void;
  addToast: (sessionId: SessionId, message: string, type?: string) => void;
  dismissToast: (sessionId: SessionId, toastId: string) => void;
  setStats: (sessionId: SessionId, stats: SessionStats) => void;
  setAvailableModels: (sessionId: SessionId, models: ModelInfo[]) => void;
  setCurrentModel: (sessionId: SessionId, model: string) => void;
  setThinkingLevel: (sessionId: SessionId, level: ThinkingLevel) => void;
  setSessionName: (sessionId: SessionId, name: string) => void;

  refreshWorkspaceSessions: (path: string) => Promise<void>;

  setActiveSession: (sessionId: SessionId | null) => void;
  setActiveWorkspace: (path: string | null) => void;
}

let toastCounter = 0;

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  workspaces: new Map(),
  sessions: new Map(),
  activeSessionId: null,
  activeWorkspacePath: null,

  addWorkspace: (path) => {
    set((state) => {
      const workspaces = new Map(state.workspaces);
      if (!workspaces.has(path)) {
        workspaces.set(path, { path, sessions: [], activeSessions: [] });
      }
      return { workspaces };
    });
  },

  removeWorkspace: (path) => {
    set((state) => {
      const workspaces = new Map(state.workspaces);
      workspaces.delete(path);
      return {
        workspaces,
        activeWorkspacePath: state.activeWorkspacePath === path ? null : state.activeWorkspacePath,
      };
    });
  },

  setWorkspaceSessions: (path, sessions) => {
    set((state) => {
      const workspaces = new Map(state.workspaces);
      const ws = workspaces.get(path);
      if (ws) {
        workspaces.set(path, { ...ws, sessions });
      }
      return { workspaces };
    });
  },

  createSession: (sessionId, workspacePath, sessionFile) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        sessionId,
        workspacePath,
        sessionFile,
        status: "starting",
        transcript: createTranscriptState(),
        isStreaming: false,
        pendingDialogs: [],
        statusSegments: new Map(),
        widgets: new Map(),
        toasts: [],
        availableModels: [],
      });
      const workspaces = new Map(state.workspaces);
      const ws = workspaces.get(workspacePath);
      if (ws) {
        workspaces.set(workspacePath, {
          ...ws,
          activeSessions: [...ws.activeSessions, sessionId],
        });
      }
      return { sessions, workspaces, activeSessionId: sessionId };
    });
  },

  setSessionStatus: (sessionId, status, error) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (s) sessions.set(sessionId, { ...s, status, error });
      return { sessions };
    });
  },

  applyEvent: (sessionId, rawEvent) => {
    // Only apply known events to the transcript
    if ("__unknown" in rawEvent) {
      return;
    }
    const event = rawEvent as KnownPiEvent;

    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};

      let isStreaming = s.isStreaming;
      const statusSegments = new Map(s.statusSegments);
      const widgets = new Map(s.widgets);
      const sessionTitle = s.sessionTitle;
      // Pi (and its extensions) drive the session name; it gets reported as
      // a `session_info_changed` event. Pi rejects empty names server-side,
      // so `name` is always a non-empty string.
      const sessionName = event.type === "session_info_changed" ? event.name : s.sessionName;

      if (event.type === "agent_start") isStreaming = true;
      if (event.type === "agent_end") isStreaming = false;

      const thinkingLevel = event.type === "thinking_level_changed" ? event.level : s.thinkingLevel;
      const transcript = applyPiEvent(s.transcript, event);
      sessions.set(sessionId, {
        ...s,
        transcript,
        isStreaming,
        statusSegments,
        widgets,
        sessionTitle,
        sessionName,
        thinkingLevel,
      });
      return { sessions };
    });
  },

  applyUiSideEffect: (sessionId: SessionId, method: string, args: Record<string, unknown>) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};

      if (method === "setStatus") {
        const statusSegments = new Map(s.statusSegments);
        statusSegments.set(args["statusKey"] as string, args["statusText"] as string);
        sessions.set(sessionId, { ...s, statusSegments });
      } else if (method === "setWidget") {
        const widgets = new Map(s.widgets);
        widgets.set(args["widgetKey"] as string, args["widgetLines"] as string[]);
        sessions.set(sessionId, { ...s, widgets });
      } else if (method === "setTitle") {
        sessions.set(sessionId, { ...s, sessionTitle: args["title"] as string });
      }
      return { sessions };
    });
  },

  seedHistory: (sessionId, history) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const transcript = seedFromHistory(s.transcript, history);
      sessions.set(sessionId, { ...s, transcript });
      return { sessions };
    });
  },

  addUserMessage: (sessionId, content, images) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const transcript = addUserBlock(s.transcript, content, images);
      sessions.set(sessionId, { ...s, transcript });
      return { sessions };
    });
  },

  addBashCommand: (sessionId, command) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const transcript = addBashBlock(s.transcript, command);
      sessions.set(sessionId, { ...s, transcript });
      return { sessions };
    });
  },

  finishBashCommand: (sessionId, output, exitCode) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const transcript = finishBashBlock(s.transcript, output, exitCode);
      sessions.set(sessionId, { ...s, transcript });
      return { sessions };
    });
  },

  setStreaming: (sessionId, isStreaming) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, isStreaming });
      return { sessions };
    });
  },

  addUiRequest: (sessionId, request) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};

      // Handle fire-and-forget methods as side effects
      if (
        ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)
      ) {
        const sessionsFinal = new Map(state.sessions);
        const sFinal = sessionsFinal.get(sessionId);
        if (!sFinal) return {};

        if (request.method === "notify") {
          const toastId = `toast-${++toastCounter}`;
          const notifyReq = request as { message: string; notifyType?: string };
          sessionsFinal.set(sessionId, {
            ...sFinal,
            toasts: [
              ...sFinal.toasts,
              { id: toastId, message: notifyReq.message, type: notifyReq.notifyType },
            ],
          });
        } else if (request.method === "setStatus") {
          const statusSegments = new Map(sFinal.statusSegments);
          const sr = request as { statusKey: string; statusText: string };
          statusSegments.set(sr.statusKey, sr.statusText);
          sessionsFinal.set(sessionId, { ...sFinal, statusSegments });
        } else if (request.method === "setWidget") {
          const widgets = new Map(sFinal.widgets);
          const wr = request as { widgetKey: string; widgetLines: string[] };
          widgets.set(wr.widgetKey, wr.widgetLines);
          sessionsFinal.set(sessionId, { ...sFinal, widgets });
        } else if (request.method === "setTitle") {
          const tr = request as { title: string };
          sessionsFinal.set(sessionId, { ...sFinal, sessionTitle: tr.title });
        }
        return { sessions: sessionsFinal };
      }

      // Dialog requests — queue them
      sessions.set(sessionId, { ...s, pendingDialogs: [...s.pendingDialogs, request] });
      return { sessions };
    });
  },

  dismissUiRequest: (sessionId, requestId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        pendingDialogs: s.pendingDialogs.filter((d) => d.id !== requestId),
      });
      return { sessions };
    });
  },

  addToast: (sessionId, message, type) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const toastId = `toast-${++toastCounter}`;
      sessions.set(sessionId, {
        ...s,
        toasts: [...s.toasts, { id: toastId, message, type }],
      });
      return { sessions };
    });
  },

  dismissToast: (sessionId, toastId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        toasts: s.toasts.filter((t) => t.id !== toastId),
      });
      return { sessions };
    });
  },

  setStats: (sessionId, stats) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, stats });
      return { sessions };
    });
  },

  setAvailableModels: (sessionId, models) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, availableModels: models });
      return { sessions };
    });
  },

  setCurrentModel: (sessionId, model) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, currentModel: model });
      return { sessions };
    });
  },

  setThinkingLevel: (sessionId, level) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, thinkingLevel: level });
      return { sessions };
    });
  },

  setSessionName: (sessionId, name) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, sessionName: name });
      return { sessions };
    });
  },

  refreshWorkspaceSessions: async (path) => {
    if (typeof window === "undefined" || !window.pivis) return;
    try {
      const sessions = await window.pivis.invoke("workspace.listSessions", { workspacePath: path });
      get().setWorkspaceSessions(path, sessions);
    } catch (err) {
      console.error("Failed to refresh workspace sessions:", err);
    }
  },

  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  setActiveWorkspace: (path) => {
    set({ activeWorkspacePath: path });
  },
}));
