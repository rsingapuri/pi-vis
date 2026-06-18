import type { SessionId } from "@shared/ids.js";
import type { SessionStatus, SessionSummary } from "@shared/ipc-contract.js";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { ModelInfo, SessionStats, SlashCommandInfo } from "@shared/pi-protocol/responses.js";
import type { ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import { detectTurnError } from "@shared/pi-protocol/turn-error.js";
import { create } from "zustand";
import type { PickerRequest } from "../lib/commands/execute.js";
import {
  type TranscriptState,
  addBashBlock,
  addCustomMessageBlock,
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
  /**
   * Unread turn-result marker for the sidebar status dot. Set to "done" or
   * "error" when a turn finishes (see applyEvent's agent_end handling). It
   * acts as a notification for background sessions: it persists until the
   * user views the session and moves on (setActiveSession clears the
   * previously-active session) or starts a new turn there (agent_start).
   */
  unreadStatus?: "done" | "error" | undefined;
  /** Transient: did the current agent attempt produce a provider/model error?
   *  Reset on agent_start and on a willRetry agent_end (each auto-retry attempt
   *  starts clean), set on an erroring assistant message_end, consumed at the
   *  final (non-retrying) agent_end to decide unreadStatus. */
  turnErrored: boolean;
  pendingDialogs: ExtensionUiRequest[];
  statusSegments: Map<string, string>; // statusKey → statusText
  widgets: Map<string, string[]>; // widgetKey → lines
  toasts: Array<{ id: string; message: string; type?: string | undefined; createdAt: number }>;
  stats?: SessionStats | undefined;
  availableModels: ModelInfo[];
  currentModel?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  sessionTitle?: string | undefined;
  sessionName?: string | undefined;
  commands: SlashCommandInfo[];
  editorInjection?: { text: string; nonce: number } | undefined;
  pendingPicker?: PickerRequest | undefined;
  /**
   * Recency key for sidebar ordering. Set when a session is *created fresh*
   * (no file yet) and bumped only when the user submits a prompt — NOT on
   * mere open/activate. Resumed sessions leave this undefined so the sidebar
   * falls back to the session file's mtime, keeping them in place when clicked.
   */
  lastActivityAt?: number | undefined;
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

  createSession: (
    sessionId: SessionId,
    workspacePath: string,
    sessionFile?: string,
    name?: string,
    title?: string,
    status?: SessionStatus,
  ) => void;
  openSessionTab: (
    workspacePath: string,
    sessionFile?: string,
    opts?: { focus?: boolean },
  ) => Promise<SessionId | null>;
  closeSessionTab: (sessionId: SessionId) => Promise<void>;
  removeSession: (sessionId: SessionId) => void;
  /** Archive a session: add its file path to archivedSessions in settings,
   *  close its live tab if one exists, and refresh the workspace list. */
  archiveSession: (
    sessionId: SessionId | undefined,
    filePath: string,
    workspacePath: string,
  ) => Promise<void>;
  setSessionFile: (sessionId: SessionId, sessionFile: string) => void;
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
  /** Re-point the session to a new file (overrides the only-if-unset guard). */
  adoptSessionFile: (
    sessionId: SessionId,
    sessionFile?: string,
    sessionName?: string,
  ) => Promise<void>;
  /** Refresh the discovered command list (extension/prompt/skill) from pi. */
  refreshCommands: (sessionId: SessionId) => Promise<void>;
  /** Drop a fresh nonce on editorInjection so the Composer re-picks it up. */
  injectEditorText: (sessionId: SessionId, text: string) => void;
  /** Open a built-in picker (model / fork / resume). Single slot. */
  openPicker: (sessionId: SessionId, picker: PickerRequest) => void;
  /** Drop any active picker. */
  closePicker: (sessionId: SessionId) => void;
  /** Append a custom_message block to the transcript (TUI parity for /session). */
  addCustomMessage: (sessionId: SessionId, content: string) => void;

  refreshWorkspaceSessions: (path: string) => Promise<void>;

  setActiveSession: (sessionId: SessionId | null) => void;
  setActiveWorkspace: (path: string | null) => void;
}

let toastCounter = 0;
let editorInjectionNonce = 0;

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

  createSession: (sessionId, workspacePath, sessionFile, name, title, status) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        sessionId,
        workspacePath,
        sessionFile,
        status: status ?? "cold",
        sessionTitle: title,
        sessionName: name,
        transcript: createTranscriptState(),
        isStreaming: false,
        unreadStatus: undefined,
        turnErrored: false,
        pendingDialogs: [],
        commands: [],
        statusSegments: new Map(),
        widgets: new Map(),
        toasts: [],
        availableModels: [],
        // Fresh sessions (no file yet) sort to the top; resumed sessions
        // leave this undefined and fall back to their file mtime.
        lastActivityAt: sessionFile ? undefined : Date.now(),
      });
      const workspaces = new Map(state.workspaces);
      const ws = workspaces.get(workspacePath);
      if (ws) {
        workspaces.set(workspacePath, {
          ...ws,
          activeSessions: [...ws.activeSessions, sessionId],
        });
      }
      return { sessions, workspaces };
    });
  },

  removeSession: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.delete(sessionId);
      const workspaces = new Map(state.workspaces);
      const ws = workspaces.get(s.workspacePath);
      if (ws) {
        workspaces.set(s.workspacePath, {
          ...ws,
          activeSessions: ws.activeSessions.filter((id) => id !== sessionId),
        });
      }
      return {
        sessions,
        workspaces,
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
      };
    });
  },

  setSessionFile: (sessionId, sessionFile) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      if (s.sessionFile) return {};
      sessions.set(sessionId, { ...s, sessionFile });
      return { sessions };
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
      let unreadStatus = s.unreadStatus;
      let turnErrored = s.turnErrored;
      // Pi (and its extensions) drive the session name; it gets reported as
      // a `session_info_changed` event. Pi rejects empty names server-side,
      // so `name` is always a non-empty string.
      const sessionName = event.type === "session_info_changed" ? event.name : s.sessionName;

      if (event.type === "agent_start") {
        isStreaming = true;
        // Starting a new turn acknowledges any prior unread dot — the user is
        // actively engaging with the session again.
        turnErrored = false;
        unreadStatus = undefined;
      }
      // Track provider/model failures within the turn so agent_end can decide
      // the dot color.
      if (event.type === "message_end" && event.message?.role === "assistant") {
        if (detectTurnError(event.message).isError) turnErrored = true;
      }
      if (event.type === "agent_end") {
        if (event.willRetry) {
          // Not a real turn end — pi will auto-retry. Stay "working" (the
          // agent is still going) and wipe the error flag so the next attempt
          // starts clean. The terminal dot is decided only by the final
          // (non-retrying) agent_end below, regardless of whether the retry
          // re-emits agent_start.
          turnErrored = false;
        } else {
          isStreaming = false;
          // A finished turn surfaces an unread "done"/"error" marker. For a
          // background session this is a notification that persists until the
          // user clicks in and then leaves (setActiveSession) or starts a new
          // turn (agent_start above).
          unreadStatus = turnErrored ? "error" : "done";
          turnErrored = false;
        }
      }

      const thinkingLevel = event.type === "thinking_level_changed" ? event.level : s.thinkingLevel;
      const transcript = applyPiEvent(s.transcript, event);
      sessions.set(sessionId, {
        ...s,
        transcript,
        isStreaming,
        unreadStatus,
        turnErrored,
        sessionName,
        thinkingLevel,
      });
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
      const transcript = addUserBlock(s.transcript, content, images, true);
      // Self-label a brand-new session from its first prompt so the tab and
      // header have a meaningful identity before pi or the user renames it.
      // Do not overwrite a name set by pi (session_info_changed → sessionName)
      // or a title set by an extension (setTitle → sessionTitle) or by the
      // resume preview path (createSession's `title` param).
      let sessionTitle = s.sessionTitle;
      if (!s.sessionName && !sessionTitle) {
        const firstLine = content.trim().split("\n", 1)[0] ?? "";
        const trimmed = firstLine.slice(0, 80);
        if (trimmed.length > 0) sessionTitle = trimmed;
      }
      // Submitting a prompt is the only thing that promotes a session in the
      // sidebar order — opening/activating it does not (see lastActivityAt).
      sessions.set(sessionId, { ...s, transcript, sessionTitle, lastActivityAt: Date.now() });
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
      const s = state.sessions.get(sessionId);
      if (!s) return {};

      // Handle fire-and-forget methods as side effects
      if (
        ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)
      ) {
        // Build the clone only when we actually need to mutate.
        const sessions = new Map(state.sessions);
        const sFinal = s;

        if (request.method === "notify") {
          const toastId = `toast-${++toastCounter}`;
          const notifyReq = request as { message: string; notifyType?: string };
          sessions.set(sessionId, {
            ...sFinal,
            toasts: [
              ...sFinal.toasts,
              {
                id: toastId,
                message: notifyReq.message,
                type: notifyReq.notifyType,
                createdAt: Date.now(),
              },
            ],
          });
        } else if (request.method === "setStatus") {
          // Pi sends `statusText: undefined` to clear a segment (the field is
          // omitted from the JSON wire). A present `statusText` (including the
          // empty string) replaces the entry. `Map.delete` on a non-existent
          // key is a no-op, so clearing a missing key is safe.
          const statusSegments = new Map(sFinal.statusSegments);
          const sr = request as { statusKey: string; statusText?: string };
          if (sr.statusText === undefined) {
            statusSegments.delete(sr.statusKey);
          } else {
            statusSegments.set(sr.statusKey, sr.statusText);
          }
          sessions.set(sessionId, { ...sFinal, statusSegments });
        } else if (request.method === "setWidget") {
          // Same clear-on-undefined contract as setStatus. The store keeps
          // `widgets` typed as `Map<string, string[]>` and guarantees no
          // undefined values, so the Composer's widget strip never has to
          // guard for them.
          const widgets = new Map(sFinal.widgets);
          const wr = request as { widgetKey: string; widgetLines?: string[] };
          if (wr.widgetLines === undefined) {
            widgets.delete(wr.widgetKey);
          } else {
            widgets.set(wr.widgetKey, wr.widgetLines);
          }
          sessions.set(sessionId, { ...sFinal, widgets });
        } else if (request.method === "setTitle") {
          const tr = request as { title: string };
          sessions.set(sessionId, { ...sFinal, sessionTitle: tr.title });
        } else if (request.method === "set_editor_text") {
          // Editor injection is consumed by the Composer via a useEffect on
          // editorInjection.nonce. The nonce is a monotonic counter so the
          // same Composer instance can re-inject the same text on demand.
          const er = request as { text: string };
          sessions.set(sessionId, {
            ...sFinal,
            editorInjection: { text: er.text, nonce: ++editorInjectionNonce },
          });
        }
        return { sessions };
      }

      // Dialog requests — queue them. Build the clone only when we mutate.
      const sessions = new Map(state.sessions);
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
        toasts: [...s.toasts, { id: toastId, message, type, createdAt: Date.now() }],
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

  /**
   * Re-point a session to a new file (used by the fileChanged flow after
   * /new, /fork, /clone, /switch_session). Overrides the only-if-unset
   * guard that setSessionFile enforces for normal harvests — pi has
   * confirmed the file is the new authoritative path.
   *
   * Steps:
   *   1. Update sessionFile (may be undefined for a lazy new_session).
   *   2. Clear the transcript (the new session is empty until loadHistory).
   *   3. Update sessionName if pi provided one.
   *
   * (Tab-persistence was removed: openTabs is no longer tracked in
   * settings, so there is no step 4. The session stays in memory for
   * this run; a relaunch will open a fresh session in the MRU
   * workspace.)
   */
  adoptSessionFile: async (sessionId, sessionFile, sessionName) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const next: SessionViewState = {
        ...s,
        sessionFile,
        transcript: createTranscriptState(),
        isStreaming: false,
        unreadStatus: undefined,
        turnErrored: false,
        ...(sessionName !== undefined ? { sessionName } : {}),
      };
      sessions.set(sessionId, next);
      return { sessions };
    });
  },

  /** Refresh the discovered command list (extension / prompt / skill). */
  refreshCommands: async (sessionId) => {
    if (typeof window === "undefined" || !window.pivis) return;
    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_commands" },
      });
      if (!res || !res.success) return;
      // Tolerant read: pi v0.79.1 returns { commands: RpcSlashCommand[] };
      // the contract's PiRpcResponse is a discriminated union, but we
      // only care about `data.commands` so a narrow cast is fine here.
      const data = (res as { data?: { commands?: unknown[] } }).data;
      const raw = data?.commands;
      if (!Array.isArray(raw)) return;
      const commands: SlashCommandInfo[] = raw
        .map((c) => {
          // Tolerant parse: SlashCommandInfoSchema is permissive and tolerates
          // both v0.79.1's nested sourceInfo shape and the docs' flat shape.
          const parsed = c as SlashCommandInfo | null;
          return parsed && typeof parsed.name === "string" ? parsed : null;
        })
        .filter((c): c is SlashCommandInfo => c !== null);
      set((state) => {
        const sessions = new Map(state.sessions);
        const s = sessions.get(sessionId);
        if (!s) return {};
        sessions.set(sessionId, { ...s, commands });
        return { sessions };
      });
    } catch {
      // best effort
    }
  },

  injectEditorText: (sessionId, text) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        editorInjection: { text, nonce: ++editorInjectionNonce },
      });
      return { sessions };
    });
  },

  openPicker: (sessionId, picker) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, pendingPicker: picker });
      return { sessions };
    });
  },

  closePicker: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, pendingPicker: undefined });
      return { sessions };
    });
  },

  addCustomMessage: (sessionId, content) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      const next: SessionViewState = {
        ...s,
        transcript: addCustomMessageBlock(s.transcript, content),
      };
      sessions.set(sessionId, next);
      return { sessions };
    });
  },

  openSessionTab: async (workspacePath, sessionFile, opts) => {
    if (typeof window === "undefined" || !window.pivis) return null;
    const focus = opts?.focus ?? true;
    try {
      // Renderer-side dedupe: a session already open with the same file is reused.
      // (Fast path; main's session.open is also idempotent so this is not load-bearing.)
      if (sessionFile) {
        for (const s of get().sessions.values()) {
          if (s.sessionFile === sessionFile) {
            if (focus) get().setActiveSession(s.sessionId);
            return s.sessionId;
          }
        }
      }
      // session.open is idempotent and non-throwing: it returns
      //   { outcome: "opened" | "existing", sessionId, name, preview, sessionStatus }
      // when the file exists, or { outcome: "missing" } for stale tab entries.
      // "existing" means the file is already open in the main registry — we
      // adopt the existing record instead of failing, so renderer reloads and
      // double-clicks on a stored row are both lossless.
      const res = await window.pivis.invoke("session.open", {
        workspacePath,
        sessionFile,
      });
      if (res.outcome === "missing") return null; // stale tab: skip; the cold-open call site decides whether to surface a new session
      const { sessionId, name, preview, sessionStatus } = res;

      // A concurrent openSessionTab for the same file may have already adopted
      // this id (double-click TOCTOU) — never recreate/reseed an existing record.
      if (get().sessions.has(sessionId)) {
        if (focus) get().setActiveSession(sessionId);
        return sessionId;
      }

      get().createSession(
        sessionId,
        workspacePath,
        sessionFile,
        name ?? undefined,
        preview ?? undefined,
        res.outcome === "existing" ? sessionStatus : "cold",
      );
      // loadHistory + seedHistory exactly as before. For adopted sessions pi
      // persists entries as it goes, so the file IS the transcript.
      if (sessionFile) {
        try {
          const history = await window.pivis.invoke("session.loadHistory", { sessionId });
          if (Array.isArray(history) && history.length > 0) {
            get().seedHistory(sessionId, history);
          }
        } catch {
          /* no history — fine */
        }
      }
      if (focus) get().setActiveSession(sessionId);
      return sessionId;
    } catch (err) {
      console.error("Failed to open session:", err);
      return null;
    }
  },

  closeSessionTab: async (sessionId) => {
    if (typeof window !== "undefined" && window.pivis) {
      await window.pivis.invoke("session.close", { sessionId }).catch(console.error);
    }
    get().removeSession(sessionId);
  },

  archiveSession: async (sessionId, filePath, workspacePath) => {
    // 1. Add file path to archivedSessions in settings
    try {
      const settings = await window.pivis.invoke("settings.get", undefined);
      const archived = settings.archivedSessions ?? [];
      if (archived.includes(filePath)) return;
      await window.pivis.invoke("settings.set", {
        archivedSessions: [...archived, filePath],
      });
    } catch (err) {
      console.error("Failed to archive session:", err);
      return;
    }

    // 2. If a live record exists, close its tab
    if (sessionId) {
      await get().closeSessionTab(sessionId);
    }

    // 3. Refresh the workspace list so the archived row disappears
    await get().refreshWorkspaceSessions(workspacePath);
  },

  setActiveSession: (sessionId) => {
    set((state) => {
      // Switching away from the previously-active session clears its unread
      // turn-result dot: the user has now "seen" it and moved on. Sessions
      // that were never activated (background notifications) are left alone
      // so their dot persists until the user actually visits them.
      const prev = state.activeSessionId;
      if (prev && prev !== sessionId) {
        const prevSession = state.sessions.get(prev);
        if (prevSession?.unreadStatus) {
          const sessions = new Map(state.sessions);
          sessions.set(prev, { ...prevSession, unreadStatus: undefined });
          return { sessions, activeSessionId: sessionId };
        }
      }
      return { activeSessionId: sessionId };
    });
    if (sessionId && typeof window !== "undefined" && window.pivis) {
      const s = get().sessions.get(sessionId);
      if (s && (s.status === "cold" || s.status === "exited" || s.status === "failed")) {
        // Activation triggers a session.activate; the main process emits
        // statusChanged("starting") which App.tsx applies. Re-invoking
        // activate before that lands is no-op'd by main's idempotency.
        window.pivis.invoke("session.activate", { sessionId }).catch((err) => {
          get().setSessionStatus(sessionId, "failed", String(err));
        });
      }
    }
  },

  setActiveWorkspace: (path) => {
    set({ activeWorkspacePath: path });
  },
}));
