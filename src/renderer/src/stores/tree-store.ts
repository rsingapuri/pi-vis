// tree-store — Zustand store that owns the conversation-tree viewer state.
//
// Mirrors diff-store's single-instance overlay conventions: every `set`
// produces a new Map/Set (never in-place mutation); only one overlay
// open at a time. Per the plan, the tree viewer is SDK-host-only — see
// the `phase: "unsupported"` path below for friendly degradation when the
// installed pi lacks session.sessionManager.getTree() / session.navigateTree().

import type { SessionId } from "@shared/ids.js";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import type {
  FlatTreeNode,
  GetTreeData,
  NavigateTreeData,
  SessionTreeEntry,
  SessionTreeNode,
} from "@shared/pi-protocol/responses.js";
import type { SessionStats } from "@shared/pi-protocol/responses.js";
import { create } from "zustand";
import { buildNestedTree } from "../components/tree/tree-flatten.js";
import { invokeSessionCommand } from "../lib/session-command.js";
import { isSessionWorking, useSessionsStore } from "./sessions-store.js";

function currentRuntime(sessionId: SessionId) {
  const session = useSessionsStore.getState().sessions.get(sessionId);
  return session?.hostInstanceId && session.availability === "available"
    ? { hostInstanceId: session.hostInstanceId, sessionEpoch: session.sessionEpoch }
    : undefined;
}

function runtimeIsCurrent(
  sessionId: SessionId,
  runtime: { hostInstanceId: string; sessionEpoch: number },
): boolean {
  const current = currentRuntime(sessionId);
  return (
    current?.hostInstanceId === runtime.hostInstanceId &&
    current.sessionEpoch === runtime.sessionEpoch
  );
}

// ── Phases / state shape ──────────────────────────────────────────────

export type TreePhase = "loading" | "ready" | "error" | "unsupported";

export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

interface TreeStore {
  // viewer
  open: boolean;
  sessionId: SessionId | null;
  phase: TreePhase;
  errorMessage: string | null;
  // Nested form (reconstituted from the FLAT wire format via buildNestedTree).
  // The wire shape is FlatTreeNode[] to dodge the contextBridge's 1000-level
  // nesting limit; this nested copy lives only in the renderer's main world.
  nodes: SessionTreeNode[];
  leafId: string | null;
  filterMode: TreeFilterMode;
  search: string;
  selectedId: string | null;
  summarizeOnSwitch: boolean;
  foldedIds: Set<string>;
  navigating: boolean;

  // Actions ────────────────────────────────────────────────────────────

  openTreeForSession: (sessionId: SessionId) => Promise<void>;
  closeViewer: () => void;
  setFilterMode: (mode: TreeFilterMode) => void;
  setSearch: (q: string) => void;
  setSelected: (id: string) => void;
  toggleFold: (id: string) => void;
  setSummarizeOnSwitch: (v: boolean) => void;
  navigateTo: (targetId: string) => Promise<void>;
  setLabel: (targetId: string, label: string | undefined) => Promise<void>;
  refresh: () => Promise<void>;
}

// Friendly message shown when the tree viewer cannot run because the runtime
// lacks session.sessionManager.getTree/navigateTree. Never surface pi's raw
// "Unknown command: get_tree" — that reads as an internal bug, not a runtime
// feature gate (review S2).
const UNSUPPORTED_MESSAGE = "Tree view requires the SDK host — update pi or reload the session.";

// Mid-turn guard copy. Mirrors executeReload's wording (execute.ts:562).
// pi's navigateTree has no internal streaming guard and overwrites agent
// state, so navigating mid-stream corrupts the active turn (review B1).
const STREAMING_GUARD_MESSAGE =
  "Wait for the current response to finish before switching branches.";

export const useTreeStore = create<TreeStore>((set, get) => ({
  open: false,
  sessionId: null,
  phase: "loading",
  errorMessage: null,
  nodes: [],
  leafId: null,
  filterMode: "default",
  search: "",
  selectedId: null,
  summarizeOnSwitch: false,
  foldedIds: new Set<string>(),
  navigating: false,

  openTreeForSession: async (sessionId) => {
    set({
      open: true,
      sessionId,
      phase: "loading",
      errorMessage: null,
      nodes: [],
      leafId: null,
      // reset viewer-local UI state so the overlay opens fresh each time.
      filterMode: "default",
      search: "",
      selectedId: null,
      foldedIds: new Set<string>(),
      navigating: false,
    });
    await get().refresh();
  },

  closeViewer: () => {
    set({
      open: false,
      navigating: false,
    });
  },

  setFilterMode: (mode) => {
    set({ filterMode: mode });
  },

  setSearch: (q) => {
    set({ search: q });
  },

  setSelected: (id) => {
    set({ selectedId: id });
  },

  toggleFold: (id) => {
    const next = new Set(get().foldedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    set({ foldedIds: next });
  },

  setSummarizeOnSwitch: (v) => {
    set({ summarizeOnSwitch: v });
  },

  navigateTo: async (targetId) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;

    // Mid-turn guard. Mirror executeReload: bail with a toast before
    // sending the command so pi's in-memory agent state can't be
    // clobbered mid-stream (review B1).
    const sessions = useSessionsStore.getState().sessions;
    const session = sessions.get(sessionId);
    if (isSessionWorking(session)) {
      useSessionsStore.getState().addToast(sessionId, STREAMING_GUARD_MESSAGE, "warning");
      return;
    }
    const runtime = currentRuntime(sessionId);
    if (!runtime) {
      useSessionsStore.getState().addToast(sessionId, "Session runtime is unavailable", "warning");
      return;
    }

    set({ navigating: true });
    try {
      const res = (await invokeSessionCommand(
        sessionId,
        {
          type: "navigate_tree",
          targetId,
          summarize: get().summarizeOnSwitch || undefined,
        },
        runtime,
        { sourceText: `Navigate conversation tree to ${targetId}` },
      )) as { success: boolean; error?: string; data?: NavigateTreeData };
      if (!runtimeIsCurrent(sessionId, runtime)) return;

      if (!res.success) {
        // Defensive — the navigate command failing mid-flight should
        // leave the viewer in place so the user can retry.
        useSessionsStore
          .getState()
          .addToast(sessionId, res.error ?? "Failed to switch branches", "error");
        set({ navigating: false });
        return;
      }

      const data = res.data;
      if (data?.cancelled) {
        useSessionsStore.getState().addToast(sessionId, "Branch switch cancelled", "info");
        set({ navigating: false });
        return;
      }
      if (data?.aborted) {
        useSessionsStore.getState().addToast(sessionId, "Branch switch aborted", "info");
        set({ navigating: false });
        return;
      }

      // Success path: rebuild transcript from the returned branch (host's
      // in-memory getBranch() result — see plan §3), prefill the composer
      // when navigateTree returned editorText, refresh stats, then close
      // the overlay. We deliberately do NOT reconcile model/thinking
      // level — navigateTree mutates only agent.state.messages (review
      // S4).
      const branch: SessionTreeEntry[] = data?.branch ?? [];
      const transcript = (await window.pivis.invoke("session.transcriptForEntries", {
        sessionId,
        entries: branch,
      })) as TranscriptBlock[];
      if (!runtimeIsCurrent(sessionId, runtime)) return;
      useSessionsStore.getState().seedHistory(sessionId, transcript);

      if (data?.editorText !== undefined) {
        useSessionsStore.getState().injectEditorText(sessionId, data.editorText);
      }

      // Refresh token stats. navigateTree doesn't change model/thinking
      // level (only agent.state.messages), so those need no reconcile;
      // token stats DO track the branch (review S4, corrected).
      try {
        const statsRes = (await invokeSessionCommand(
          sessionId,
          { type: "get_session_stats" },
          runtime,
        )) as { success: boolean; data?: SessionStats };
        if (statsRes.success && statsRes.data && runtimeIsCurrent(sessionId, runtime)) {
          useSessionsStore.getState().setStats(sessionId, statsRes.data);
        }
      } catch {
        // Stats refresh is best-effort — don't block the navigation.
      }

      if (!runtimeIsCurrent(sessionId, runtime)) return;
      useSessionsStore.getState().addToast(sessionId, "Switched to selected branch", "success");
      set({ navigating: false, open: false });
    } catch (err) {
      // Transient (host restarting, IPC hiccup). Toast the real error but
      // KEEP the overlay open so the user can retry — closing on a transient
      // would lose their place in the tree. The viewer auto-recovers on the
      // next session-ready transition.
      useSessionsStore
        .getState()
        .addToast(sessionId, err instanceof Error ? err.message : String(err), "error");
      set({ navigating: false });
    }
  },

  setLabel: async (targetId, label) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    try {
      const runtime = currentRuntime(sessionId);
      if (!runtime) throw new Error("Session runtime is unavailable");
      const res = (await invokeSessionCommand(
        sessionId,
        { type: "set_label", targetId, label },
        runtime,
      )) as { success: boolean; error?: string };
      if (!runtimeIsCurrent(sessionId, runtime)) return;
      if (!res.success) {
        useSessionsStore
          .getState()
          .addToast(sessionId, res.error ?? "Failed to set label", "error");
        return;
      }
      // Refresh — cheap; appendLabelChange already updated the in-memory
      // labelsById map, so getTree() now reflects the new label on the
      // target node (review N2).
      await get().refresh();
    } catch (err) {
      useSessionsStore
        .getState()
        .addToast(sessionId, err instanceof Error ? err.message : String(err), "error");
    }
  },

  refresh: async () => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    let res: { success: boolean; error?: string; data?: GetTreeData };
    try {
      const runtime = currentRuntime(sessionId);
      if (!runtime) throw new Error("Session runtime is unavailable");
      res = (await invokeSessionCommand(sessionId, { type: "get_tree" }, runtime)) as {
        success: boolean;
        error?: string;
        data?: GetTreeData;
      };
      if (!runtimeIsCurrent(sessionId, runtime)) return;
    } catch (err) {
      // A thrown command is never a capability gap. Capability gaps return a
      // resolved unsupported response. A throw here is transient — the host
      // may be restarting, activation may still be in progress, or IPC may
      // have failed. Show the real error in the retryable "error" phase; the
      // overlay recovers when the session is ready again and `/tree` retries
      // refresh.
      set({
        phase: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!res.success) {
      // A resolved failure is a capability gap. The host reports supported
      // runtimes with `data.unsupported`; thrown failures are handled above.
      set({
        phase: "unsupported",
        errorMessage: UNSUPPORTED_MESSAGE,
        nodes: [],
        leafId: null,
      });
      return;
    }
    const data = res.data;
    if (data?.unsupported) {
      // Host is up but the installed pi lacks the tree surface — a genuine
      // capability gap, surfaced as a structured flag by the bridge.
      set({
        phase: "unsupported",
        errorMessage: UNSUPPORTED_MESSAGE,
        nodes: [],
        leafId: null,
      });
      return;
    }
    const flat: FlatTreeNode[] = data?.nodes ?? [];
    // A session may currently be navigated to an empty root branch while still
    // having messages elsewhere in the DAG. Keep that knowledge on the session
    // so sidebar / first-send affordances don't mistake it for a new blank tab.
    // Ignore settings-only bootstrap entries; they should not promote a truly
    // empty session.
    const hasConversationHistory = flat.some(
      (node) => node.entry.type === "message" || node.entry.type === "branch_summary",
    );
    useSessionsStore.getState().setTreeHistoryPresent(sessionId, hasConversationHistory);
    set({
      phase: "ready",
      errorMessage: null,
      // Re-nest the flat wire list in the renderer's own world (no
      // contextBridge depth limit here). See FlatTreeNode / buildNestedTree.
      nodes: buildNestedTree(flat),
      leafId: data?.leafId ?? null,
      // Default selection to the active leaf on first load.
      selectedId: data?.leafId ?? get().selectedId,
    });
  },
}));

// Helpers used by the host component for free, so the renderer can avoid
// pulling the tree-walking logic out of the store.
export function isTreeUnsupported(phase: TreePhase): boolean {
  return phase === "unsupported";
}
