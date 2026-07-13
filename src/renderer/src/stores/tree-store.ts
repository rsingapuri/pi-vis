// tree-store — Zustand store that owns the conversation-tree viewer state.
//
// Mirrors diff-store's single-instance overlay conventions: every `set`
// produces a new Map/Set (never in-place mutation); only one overlay
// open at a time. Per the plan, the tree viewer is SDK-host-only — see
// the `phase: "unsupported"` path below for friendly degradation when the
// installed pi lacks session.sessionManager.getTree() / session.navigateTree().

import type { SessionId } from "@shared/ids.js";
import type { FlatTreeNode, GetTreeData, SessionTreeNode } from "@shared/pi-protocol/responses.js";
import type { AuthorityCursor, RuntimeIdentity } from "@shared/pi-protocol/runtime-state.js";
import { create } from "zustand";
import { buildNestedTree } from "../components/tree/tree-flatten.js";
import { dispatchSessionIntent, querySession } from "../lib/session-intent.js";
import { authoritySnapshotFor, isSessionWorking, useSessionsStore } from "./sessions-store.js";

interface TreeObservation {
  owner: RuntimeIdentity;
  cursor?: AuthorityCursor | undefined;
}

function currentObservation(sessionId: SessionId): TreeObservation | undefined {
  const session = useSessionsStore.getState().sessions.get(sessionId);
  const snapshot = authoritySnapshotFor(session);
  const semantic = session?.authorityProjection?.semantic;
  if (!snapshot || semantic?.state !== "following") return undefined;
  return { owner: snapshot.owner, cursor: semantic.cursor };
}

function observationIsCurrent(sessionId: SessionId, observation: TreeObservation): boolean {
  const current = currentObservation(sessionId);
  if (
    !current ||
    current.owner.hostInstanceId !== observation.owner.hostInstanceId ||
    current.owner.sessionEpoch !== observation.owner.sessionEpoch
  )
    return false;
  if (!observation.cursor) return true;
  const cursor = current.cursor;
  return (
    !!cursor &&
    cursor.hostInstanceId === observation.cursor.hostInstanceId &&
    cursor.sessionEpoch === observation.cursor.sessionEpoch &&
    cursor.transportSequence === observation.cursor.transportSequence &&
    cursor.snapshotSequence === observation.cursor.snapshotSequence
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
    const observation = currentObservation(sessionId);
    if (!observation) {
      useSessionsStore.getState().addToast(sessionId, "Session runtime is unavailable", "warning");
      return;
    }

    set({ navigating: true });
    try {
      const receipt = await dispatchSessionIntent(
        sessionId,
        {
          kind: "navigate",
          targetId,
          ...(get().summarizeOnSwitch ? { summarize: true } : {}),
        },
        observation,
      );
      if (!observationIsCurrent(sessionId, observation) || get().sessionId !== sessionId) return;
      if (receipt.status === "not_admitted" || receipt.status === "delivery_unknown") {
        useSessionsStore.getState().addToast(sessionId, "Failed to request branch switch", "error");
        set({ navigating: false });
        return;
      }
      // A receipt is admission only. Authority frames own the resulting
      // transcript, editor, stats, and navigation outcome.
      set({ navigating: false, open: false });
    } catch (err) {
      if (!observationIsCurrent(sessionId, observation) || get().sessionId !== sessionId) return;
      useSessionsStore
        .getState()
        .addToast(sessionId, err instanceof Error ? err.message : String(err), "error");
      set({ navigating: false });
    }
  },

  setLabel: async (targetId, label) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    const observation = currentObservation(sessionId);
    if (!observation) {
      useSessionsStore.getState().addToast(sessionId, "Session runtime is unavailable", "warning");
      return;
    }
    try {
      // Tree labels are an SDK-host command surface. The high-level intent
      // carries opaque slash text rather than exposing Pi command types here.
      const receipt = await dispatchSessionIntent(
        sessionId,
        {
          kind: "invokeCommand",
          text: label ? `/label ${targetId} ${label}` : `/label ${targetId}`,
          editorRevision: useSessionsStore.getState().sessions.get(sessionId)?.editorRevision ?? 0,
        },
        observation,
      );
      if (!observationIsCurrent(sessionId, observation) || get().sessionId !== sessionId) return;
      if (receipt.status === "not_admitted" || receipt.status === "delivery_unknown") {
        useSessionsStore.getState().addToast(sessionId, "Failed to set label", "error");
        return;
      }
      await get().refresh();
    } catch (err) {
      if (!observationIsCurrent(sessionId, observation) || get().sessionId !== sessionId) return;
      useSessionsStore
        .getState()
        .addToast(sessionId, err instanceof Error ? err.message : String(err), "error");
    }
  },

  refresh: async () => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    const observation = currentObservation(sessionId);
    if (!observation) {
      set({ phase: "error", errorMessage: "Session runtime is unavailable" });
      return;
    }
    let res: { success: boolean; error?: string; data?: GetTreeData };
    try {
      const result = await querySession(sessionId, { type: "get_tree" }, observation);
      if (
        result.owner.hostInstanceId !== observation.owner.hostInstanceId ||
        result.owner.sessionEpoch !== observation.owner.sessionEpoch ||
        !observationIsCurrent(sessionId, observation) ||
        get().sessionId !== sessionId
      )
        return;
      res = result.response as { success: boolean; error?: string; data?: GetTreeData };
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
