import type { SessionId } from "@shared/ids.js";
import type { SessionStatus, SessionSummary } from "@shared/ipc-contract.js";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { KnownPiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { PanelEvent } from "@shared/pi-protocol/panel-events.js";
import type { ModelInfo, SessionStats, SlashCommandInfo } from "@shared/pi-protocol/responses.js";
import { ModelInfoSchema } from "@shared/pi-protocol/responses.js";
import type { ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import { ThinkingLevelSchema } from "@shared/pi-protocol/thinking.js";
import { detectTurnError } from "@shared/pi-protocol/turn-error.js";
import { create } from "zustand";
import type { PickerRequest } from "../lib/commands/execute.js";
import { useSettingsStore } from "./settings-store.js";
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
  /** Wall-clock timestamp (ms) when the current turn started running —
   *  set on the *first* agent_start of a turn (when we weren't already
   *  streaming) and cleared only on a final (non-retrying) agent_end. Auto
   *  retries (agent_end with willRetry, and the agent_start pi re-emits for
   *  the retry attempt) deliberately do NOT reset this, so the working
   *  timer keeps counting across retries and stops only when the turn truly
   *  finishes. */
  runningSince?: number | undefined;
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
   * Pre-send worktree creation intent (drives the WorktreeBar).
   * These are only set for a brand-new session (no transcript yet)
   * and are cleared after the first send.
   */
  worktreeCreate?: boolean | undefined;
  /** The base branch the user selected in the WorktreeBar. */
  worktreeBase?: string | null | undefined;
  /** True while the worktree creation IPC is in flight. */
  worktreeCreating?: boolean | undefined;
  /**
   * Post-creation identity — set after a worktree is successfully
   * created and the pi process is re-spawned into it.
   */
  worktreePath?: string | undefined;
  /** Full branch name, e.g. "pi-vis-swift-otter". */
  worktreeBranch?: string | undefined;
  /** The friendly name, e.g. "swift-otter". */
  worktreeName?: string | undefined;
  /** The base branch the worktree was cut from (for the chip tooltip). */
  worktreeFromBase?: string | undefined;

  /** Inline custom panel from extension ctx.ui.custom() — rendered via xterm.js overlay. */
  panel?: { id: number; overlay: boolean; buffer: string[] } | undefined;
  /** pi version reported by the SDK-host on ready (undefined for pi --mode rpc).
   *  Surfaced in the SessionHeader tooltip. See P1-c. */
  piVersion?: string | undefined;
  /**
   * Recency key for sidebar ordering. Set when a session is *created fresh*
   * (no file yet) and bumped only when the user submits a prompt — NOT on
   * mere open/activate. Resumed sessions leave this undefined so the sidebar
   * falls back to the session file's mtime, keeping them in place when clicked.
   */
  lastActivityAt?: number | undefined;
  /** True for sessions resumed from a file on disk (had a `sessionFile` at
   *  open time). False for brand-new sessions. Gates the "remember last
   *  selected model/thinking level" preference: it applies only to new
   *  sessions; resumed sessions keep the model/thinking level they had when
   *  last active (restored by pi from the session file). */
  resumed: boolean;
  /**
   * True once the one-time model + thinking-level bootstrap has run for this
   * session (see `bootstrapModelState`). It seeds pi's authoritative
   * model/level into the store and — for brand-new sessions only — applies
   * the global last-used preference.
   *
   * This flag is the structural guard for invariant #2 ("a session's model /
   * thinking level NEVER changes unless the user changes it in THAT session").
   * It lives in the store, not in the `SessionHeader` component, precisely so
   * it survives the header's unmount/remount on every tab switch — a
   * component-local guard would reset and let a remount re-apply the global
   * preference, silently changing this session's model to whatever another
   * session last picked.
   */
  modelInitialized: boolean;
}

interface WorkspaceState {
  path: string;
  sessions: SessionSummary[];
  activeSessions: SessionId[];
}

/**
 * Whether the "Running for …" working indicator should be shown.
 *
 * `isStreaming` alone is not enough: an extension slash-command (e.g. /agents)
 * runs through `session.prompt`, so pi emits `agent_start` and reports the turn
 * active for the WHOLE time the command's handler is up — including while it's
 * blocked on a select dialog or a custom panel awaiting the user. During that
 * wait nothing is computing, so the indicator is misleading. Treat any open
 * extension UI (a pending dialog or an open panel) as "waiting on the user, not
 * working" and suppress it. This covers the whole category of interactive
 * extension commands, not just /agents.
 */
export function shouldShowWorkingIndicator(session: SessionViewState | undefined): boolean {
  if (!session?.isStreaming) return false;
  const extensionUiActive = session.pendingDialogs.length > 0 || session.panel != null;
  return !extensionUiActive;
}

interface SessionsStore {
  workspaces: Map<string, WorkspaceState>;
  sessions: Map<SessionId, SessionViewState>;
  activeSessionId: SessionId | null;
  activeWorkspacePath: string | null;
  /** Workspace paths whose session lists are expanded in the sidebar.
   * Multiple may be expanded at once; independent of activeWorkspacePath. */
  expandedWorkspaces: string[];
  /** Whether the session header is in compact mode (controls in sub-bar). */
  headerCompact: boolean;

  addWorkspace: (path: string) => void;
  removeWorkspace: (path: string) => void;
  setWorkspaceSessions: (path: string, sessions: SessionSummary[]) => void;
  /** Toggle a workspace's session-list expansion (chevron). Does not change
   *  the active workspace. */
  toggleWorkspaceExpanded: (path: string) => void;
  /** Idempotently expand a workspace (no-op if already expanded). Used by the
   *  boot/add flows where toggling would be wrong if it's already open. */
  expandWorkspace: (path: string) => void;
  /** Set the expanded set wholesale (e.g. when syncing from settings). */
  setExpandedWorkspaces: (paths: string[]) => void;
  /** Reorder workspaces: move `from` index to `to` index in workspaceOrder. */
  reorderWorkspaces: (from: number, to: number) => void;

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
  setSessionStatus: (
    sessionId: SessionId,
    status: SessionStatus,
    error?: string,
    piVersion?: string,
  ) => void;
  applyEvent: (sessionId: SessionId, event: PiEvent) => void;
  seedHistory: (sessionId: SessionId, history: TranscriptBlock[]) => void;
  addUserMessage: (sessionId: SessionId, content: string, images?: string[]) => void;
  addBashCommand: (sessionId: SessionId, command: string) => void;
  finishBashCommand: (sessionId: SessionId, output: string, exitCode?: number) => void;
  setStreaming: (sessionId: SessionId, isStreaming: boolean) => void;
  addUiRequest: (sessionId: SessionId, request: ExtensionUiRequest) => void;
  handlePanelEvent: (sessionId: SessionId, event: PanelEvent) => void;
  dismissUiRequest: (sessionId: SessionId, requestId: string) => void;
  addToast: (sessionId: SessionId, message: string, type?: string) => void;
  dismissToast: (sessionId: SessionId, toastId: string) => void;
  setHeaderCompact: (v: boolean) => void;

  // Worktree bar state (pre-send)
  setWorktreeCreate: (sessionId: SessionId, v: boolean) => void;
  setWorktreeBase: (sessionId: SessionId, base: string | null) => void;
  setWorktreeCreating: (sessionId: SessionId, v: boolean) => void;
  /** Apply post-creation identity after a successful worktree creation. */
  applyWorktree: (
    sessionId: SessionId,
    result: {
      worktreePath: string;
      branch: string;
      name: string;
      base: string;
    },
  ) => void;
  /** Clear pre-send worktree state — called after first send. */
  clearWorktreeIntent: (sessionId: SessionId) => void;
  setStats: (sessionId: SessionId, stats: SessionStats) => void;
  setAvailableModels: (sessionId: SessionId, models: ModelInfo[]) => void;
  setCurrentModel: (sessionId: SessionId, model: string) => void;
  setThinkingLevel: (sessionId: SessionId, level: ThinkingLevel) => void;
  /**
   * One-time, idempotent model/thinking-level bootstrap for a session. Seeds
   * the store with pi's authoritative model + level (from `get_available_models`
   * / `get_state`) and, for brand-new (non-resumed) sessions ONLY, applies the
   * global last-used preference. Guarded by `modelInitialized` so it runs at
   * most once per session no matter how many times the caller fires it (header
   * remounts, StrictMode double-invoke, concurrent callers). This is the sole
   * place the global preference is ever applied to a session — see the
   * model/thinking invariants on `modelInitialized`.
   */
  bootstrapModelState: (sessionId: SessionId) => Promise<void>;
  /**
   * Switch a session's model: optimistically update the store (so the dropdown
   * reflects the requested model immediately — the "queued change about to be
   * sent" half of invariant #1), send `set_model`, and **revert** to the prior
   * model if the command fails (so the dropdown never lingers on a model pi
   * didn't accept). The global last-used preference is persisted ONLY on
   * success. The single mutation path for the model dropdown / `/model`.
   */
  applyModelChange: (
    sessionId: SessionId,
    model: ModelInfo,
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Switch a session's thinking level: optimistic update, send
   * `set_thinking_level`, reconcile with pi's actually-applied level (a model
   * may clamp it), and **revert** on failure. Persists last-used only on
   * success. Returns `clampedTo` when pi applied a different level than asked.
   */
  applyThinkingLevel: (
    sessionId: SessionId,
    level: ThinkingLevel,
  ) => Promise<{ ok: boolean; error?: string; clampedTo?: ThinkingLevel }>;
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

/** Upper bound on a session's retained custom-panel replay buffer (chars).
 *  See the panel_data case in handlePanelEvent for the rationale. */
const PANEL_BUFFER_MAX_BYTES = 512 * 1024;

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  workspaces: new Map(),
  sessions: new Map(),
  activeSessionId: null,
  activeWorkspacePath: null,
  expandedWorkspaces: [],
  headerCompact: false,

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
        expandedWorkspaces: state.expandedWorkspaces.filter((p) => p !== path),
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

  toggleWorkspaceExpanded: (path) => {
    set((state) => ({
      expandedWorkspaces: state.expandedWorkspaces.includes(path)
        ? state.expandedWorkspaces.filter((p) => p !== path)
        : [...state.expandedWorkspaces, path],
    }));
  },

  expandWorkspace: (path) => {
    set((state) =>
      state.expandedWorkspaces.includes(path)
        ? {}
        : { expandedWorkspaces: [...state.expandedWorkspaces, path] },
    );
  },

  setExpandedWorkspaces: (paths) => set({ expandedWorkspaces: paths }),

  reorderWorkspaces: (from, to) => {
    set((state) => {
      const order = Array.from(state.workspaces.keys());
      if (from < 0 || from >= order.length || to < 0 || to >= order.length || from === to) {
        return {};
      }
      const [moved] = order.splice(from, 1);
      if (moved) order.splice(to, 0, moved);
      const workspaces = new Map<string, WorkspaceState>();
      for (const p of order) {
        const ws = state.workspaces.get(p);
        if (ws) workspaces.set(p, ws);
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
        // Worktree fields start unset
        worktreeCreate: undefined,
        worktreeBase: undefined,
        worktreeCreating: undefined,
        worktreePath: undefined,
        worktreeBranch: undefined,
        worktreeName: undefined,
        worktreeFromBase: undefined,
        // Fresh sessions (no file yet) sort to the top; resumed sessions
        // leave this undefined and fall back to their file mtime.
        lastActivityAt: sessionFile ? undefined : Date.now(),
        // Resumed sessions had a file at open time; new sessions did not.
        // Gates last-used model/thinking-level preference (new sessions only).
        resumed: !!sessionFile,
        // Bootstrap hasn't run yet — it fires once when the session goes live.
        modelInitialized: false,
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

  setSessionStatus: (sessionId, status, error, piVersion) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (s) {
        // Only store piVersion when explicitly provided (a non-host "ready"
        // or a status change without version info mustn't clobber a prior
        // value). See P1-c.
        sessions.set(sessionId, {
          ...s,
          status,
          error,
          ...(piVersion !== undefined ? { piVersion } : {}),
        });
      }
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
      let runningSince = s.runningSince;
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
        // Stamp the timer on a genuinely new turn. A retrying turn keeps
        // `isStreaming` true across its willRetry agent_end, so the retry's
        // agent_start finds `isStreaming` already true and skips this —
        // the timer keeps counting from the original start.
        if (!s.isStreaming) runningSince = Date.now();
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
          // re-emits agent_start. The working timer also keeps counting.
          turnErrored = false;
        } else {
          isStreaming = false;
          // The turn truly finished — stop the working timer.
          runningSince = undefined;
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
        runningSince,
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
      // Keep the working timer in lockstep with the optimistic streaming
      // flag the composer sets at send time (ahead of the real agent_start):
      // start it on the first send of a turn, stop it when streaming ends.
      // The applyEvent path does the authoritative bookkeeping for retries;
      // here we only stamp/clear when not already done so.
      const runningSince =
        isStreaming && s.runningSince == null
          ? Date.now()
          : !isStreaming
            ? undefined
            : s.runningSince;
      sessions.set(sessionId, { ...s, isStreaming, runningSince });
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

  handlePanelEvent: (sessionId, event) => {
    set((state) => {
      const s = state.sessions.get(sessionId);
      if (!s) return {};
      const sessions = new Map(state.sessions);

      switch (event.type) {
        case "panel_open":
          sessions.set(sessionId, {
            ...s,
            panel: { id: event.panelId, overlay: event.overlay, buffer: [] },
          });
          break;
        case "panel_data":
          if (s.panel?.id === event.panelId) {
            // The buffer is only a remount snapshot (CustomPanelHost replays it
            // into a fresh xterm). A TUI panel redraws continuously, so an
            // unbounded buffer is a steady leak. Keep a bounded tail: TUI
            // frames are full repaints with cursor-home/clear sequences, so the
            // most recent PANEL_BUFFER_MAX_BYTES reliably contains a complete
            // frame to re-seed from. Oldest chunks are dropped first.
            const buffer = [...s.panel.buffer, event.data];
            let total = 0;
            for (const chunk of buffer) total += chunk.length;
            while (buffer.length > 1 && total > PANEL_BUFFER_MAX_BYTES) {
              total -= (buffer.shift() as string).length;
            }
            sessions.set(sessionId, { ...s, panel: { ...s.panel, buffer } });
          }
          break;
        case "panel_close":
          if (s.panel?.id === event.panelId) {
            sessions.set(sessionId, { ...s, panel: undefined });
          }
          break;
        case "panel_clear_all":
          sessions.set(sessionId, { ...s, panel: undefined });
          break;
        case "host_fallback":
          // The host couldn't start (pi too old / SDK import failed) and we
          // fell back to pi --mode rpc. Panels are unavailable — surface as a
          // toast so the user knows to update pi, without blocking the session.
          sessions.set(sessionId, {
            ...s,
            toasts: [
              ...s.toasts,
              {
                id: `toast-${++toastCounter}`,
                message: event.reason,
                type: "warning",
                createdAt: Date.now(),
              },
            ],
          });
          break;
        case "session_warning":
          // Non-fatal warning (e.g. session file open elsewhere). Toast it.
          sessions.set(sessionId, {
            ...s,
            toasts: [
              ...s.toasts,
              {
                id: `toast-${++toastCounter}`,
                message: event.message,
                type: "warning",
                createdAt: Date.now(),
              },
            ],
          });
          break;
      }
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

  // ── Worktree actions ────────────────────────────────────────────

  setWorktreeCreate: (sessionId, v) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, worktreeCreate: v });
      return { sessions };
    });
  },

  setWorktreeBase: (sessionId, base) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, worktreeBase: base });
      return { sessions };
    });
  },

  setWorktreeCreating: (sessionId, v) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, worktreeCreating: v });
      return { sessions };
    });
  },

  applyWorktree: (sessionId, result) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        worktreePath: result.worktreePath,
        worktreeBranch: result.branch,
        worktreeName: result.name,
        worktreeFromBase: result.base,
      });
      return { sessions };
    });
  },

  clearWorktreeIntent: (sessionId) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, {
        ...s,
        worktreeCreate: undefined,
        worktreeBase: undefined,
        worktreeCreating: undefined,
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

  bootstrapModelState: async (sessionId) => {
    if (typeof window === "undefined" || !window.pivis) return;
    const existing = get().sessions.get(sessionId);
    // Run at most once per session. Bailing on `modelInitialized` here is what
    // structurally enforces invariant #2: a SessionHeader remount (every tab
    // switch) re-invokes this, but after the first run it is a no-op, so the
    // global last-used preference can NEVER be re-applied to an already-live
    // session and silently change its model.
    if (!existing || existing.modelInitialized) return;
    const resumed = existing.resumed;

    // Claim the bootstrap synchronously, BEFORE any await, so a concurrent
    // caller (StrictMode double-invoke, a racing remount) sees the flag set
    // and returns early instead of double-applying the preference.
    set((state) => {
      const sessions = new Map(state.sessions);
      const s = sessions.get(sessionId);
      if (!s) return {};
      sessions.set(sessionId, { ...s, modelInitialized: true });
      return { sessions };
    });

    // The global "last selected" preference applies ONLY to brand-new sessions.
    // Resumed sessions keep the model/level pi restored from the session file,
    // so they read no preference here.
    const settings = useSettingsStore.getState().settings;
    const lum = resumed ? null : settings.lastUsedModel;
    const ltl = resumed ? null : settings.lastUsedThinkingLevel;

    // 1. Available models + current model. All writes target THIS sessionId.
    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_available_models" },
      });
      const raw = res.data as { models?: unknown[]; currentModelId?: string } | undefined;
      const list = Array.isArray(raw?.models) ? raw.models : [];
      const models = list
        .map((m) => {
          const r = ModelInfoSchema.safeParse(m);
          return r.success ? r.data : null;
        })
        .filter((m): m is ModelInfo => m !== null);
      get().setAvailableModels(sessionId, models);

      const match = lum ? models.find((m) => m.id === lum.modelId) : undefined;
      if (match?.provider) {
        await window.pivis
          .invoke("session.sendCommand", {
            sessionId,
            command: { type: "set_model", provider: match.provider, modelId: match.id },
          })
          .then(() => get().setCurrentModel(sessionId, match.id))
          .catch(() => {});
      } else if (raw?.currentModelId) {
        get().setCurrentModel(sessionId, raw.currentModelId);
      } else {
        const active = models.find((m) => (m as Record<string, unknown>)["current"] === true);
        if (active) get().setCurrentModel(sessionId, active.id);
      }
    } catch {
      /* best effort — leave the dropdown showing whatever the store already has */
    }

    // 2. Thinking level + session name/file (get_state).
    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_state" },
      });
      const raw = res?.data as
        | {
            thinkingLevel?: unknown;
            model?: { id?: unknown };
            sessionName?: unknown;
            sessionFile?: unknown;
          }
        | undefined;
      if (!raw) return;
      if (typeof raw.thinkingLevel === "string") {
        const parsed = ThinkingLevelSchema.safeParse(raw.thinkingLevel);
        if (parsed.success) get().setThinkingLevel(sessionId, parsed.data);
      }
      if (ltl) {
        await window.pivis
          .invoke("session.sendCommand", {
            sessionId,
            command: { type: "set_thinking_level", level: ltl },
          })
          .then(() => get().setThinkingLevel(sessionId, ltl))
          .catch(() => {});
      }
      if (raw.model && typeof raw.model.id === "string") {
        get().setCurrentModel(sessionId, raw.model.id);
      }
      if (typeof raw.sessionName === "string" && raw.sessionName) {
        get().setSessionName(sessionId, raw.sessionName);
      }
      if (typeof raw.sessionFile === "string" && raw.sessionFile) {
        get().setSessionFile(sessionId, raw.sessionFile);
      }
    } catch {
      /* best effort */
    }
  },

  applyModelChange: async (sessionId, model) => {
    if (typeof window === "undefined" || !window.pivis) {
      return { ok: false, error: "Unavailable" };
    }
    const before = get().sessions.get(sessionId);
    if (!before) return { ok: false, error: "Unknown session" };
    const prevModel = before.currentModel;
    const provider = model.provider ?? model.id.split("/")[0] ?? "";

    // Optimistic: show the requested model right away (invariant #1's "queued
    // change about to be sent").
    get().setCurrentModel(sessionId, model.id);

    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "set_model", provider, modelId: model.id },
      });
      if (!res.success) throw new Error(res.error ?? "set_model failed");
    } catch (err) {
      // Revert so the dropdown reflects the model still actually in effect —
      // but only if our optimistic value is still the one showing. A newer
      // change (or a pi event) that landed in the meantime wins.
      set((state) => {
        const sessions = new Map(state.sessions);
        const s = sessions.get(sessionId);
        if (!s || s.currentModel !== model.id) return {};
        sessions.set(sessionId, { ...s, currentModel: prevModel });
        return { sessions };
      });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Persist the global last-used preference ONLY on success — a failed
    // switch must not leak into the next new session's default.
    void useSettingsStore.getState().update({ lastUsedModel: { provider, modelId: model.id } });
    return { ok: true };
  },

  applyThinkingLevel: async (sessionId, level) => {
    if (typeof window === "undefined" || !window.pivis) {
      return { ok: false, error: "Unavailable" };
    }
    const before = get().sessions.get(sessionId);
    if (!before) return { ok: false, error: "Unknown session" };
    const prevLevel = before.thinkingLevel;

    // Optimistic update.
    get().setThinkingLevel(sessionId, level);

    try {
      const res = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "set_thinking_level", level },
      });
      if (!res.success) throw new Error(res.error ?? "set_thinking_level failed");

      // Reconcile with the level pi actually applied (a model may clamp it).
      let clampedTo: ThinkingLevel | undefined;
      const stateRes = await window.pivis.invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_state" },
      });
      const raw = stateRes?.data as { thinkingLevel?: unknown } | undefined;
      if (raw && typeof raw.thinkingLevel === "string") {
        const confirmed = ThinkingLevelSchema.safeParse(raw.thinkingLevel);
        // Only adopt pi's value if our optimistic value is still in effect
        // (not superseded by a newer change).
        if (confirmed.success && get().sessions.get(sessionId)?.thinkingLevel === level) {
          get().setThinkingLevel(sessionId, confirmed.data);
          if (confirmed.data !== level) clampedTo = confirmed.data;
        }
      }

      void useSettingsStore.getState().update({ lastUsedThinkingLevel: level });
      return clampedTo ? { ok: true, clampedTo } : { ok: true };
    } catch (err) {
      set((state) => {
        const sessions = new Map(state.sessions);
        const s = sessions.get(sessionId);
        if (!s || s.thinkingLevel !== level) return {};
        sessions.set(sessionId, { ...s, thinkingLevel: prevLevel });
        return { sessions };
      });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
        runningSince: undefined,
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
      // Re-attach worktree identity for a resumed worktree session so the
      // chip renders and git operations target the worktree (not the parent
      // workspace). New sessions have no worktree and skip this.
      if (res.worktree) {
        get().applyWorktree(sessionId, {
          worktreePath: res.worktree.path,
          branch: res.worktree.branch,
          name: res.worktree.name,
          base: res.worktree.base,
        });
      }
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
      if (sessionId === null) {
        return { activeSessionId: null, activeWorkspacePath: null };
      }
      // Switching away from the previously-active session clears its unread
      // turn-result dot: the user has now "seen" it and moved on. Sessions
      // that were never activated (background notifications) are left alone
      // so their dot persists until the user actually visits them.
      const prev = state.activeSessionId;
      const next = state.sessions.get(sessionId);
      const nextWs = next?.workspacePath ?? null;
      if (prev && prev !== sessionId) {
        const prevSession = state.sessions.get(prev);
        if (prevSession?.unreadStatus) {
          const sessions = new Map(state.sessions);
          sessions.set(prev, { ...prevSession, unreadStatus: undefined });
          return {
            sessions,
            activeSessionId: sessionId,
            activeWorkspacePath: nextWs,
          };
        }
      }
      return { activeSessionId: sessionId, activeWorkspacePath: nextWs };
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
  setHeaderCompact: (v) => {
    set({ headerCompact: v });
  },
}));

/**
 * Derive the git root for a session — prefers the worktree path
 * over the workspace path. Callers that need the root for git
 * operations (diff viewer, changes badge) must use this.
 */
export function gitRootForSession(
  session: Pick<SessionViewState, "worktreePath" | "workspacePath"> | undefined,
): string | undefined {
  return session?.worktreePath ?? session?.workspacePath;
}
