// diff-store — zustand store that owns the viewer state.
//
// Conventions follow sessions-store: every `set` is wrapped to produce a
// new Map (never in-place mutation). The store is a single-instance
// viewer: only one modal can be open at a time, so a global shape is
// correct. The store never reads `workspacePath` for git purposes
// itself — the renderer derives the root in `openDiffForSession` and
// passes it explicitly. This is the single point of change when
// sessions become associated with a worktree.

import type { GitChangedFile, GitChangesResult, GitFileDiffResult } from "@shared/git.js";
import type { SessionId } from "@shared/ids.js";
import type { ThemedToken } from "shiki";
import { create } from "zustand";
import type { AnyDiffModel, DiffModel, GapState } from "../lib/diff/diff-model.js";
import { buildDiffModel } from "../lib/diff/diff-model.js";
import { tokenizeLines } from "../lib/diff/highlight.js";
import { langForPath } from "../lib/diff/highlight.js";
import { useSessionsStore } from "./sessions-store.js";
import { useSettingsStore } from "./settings-store.js";

// ── Phases / state shape ──────────────────────────────────────────────

export type DiffPhase = "loading" | "ready" | "not-a-repo" | "git-missing" | "error";

export interface FileState {
  status: "idle" | "loading" | "ready" | "error";
  model?: AnyDiffModel;
  gapState?: GapState[];
  oldTokens?: ThemedToken[][] | null;
  newTokens?: ThemedToken[][] | null;
  collapsed: boolean;
  error?: string;
}

export interface DiffBadge {
  root: string;
  fileCount: number;
  insertions: number;
  deletions: number;
}

export interface DiffStore {
  // viewer
  open: boolean;
  sessionId: SessionId | null;
  root: string | null;
  phase: DiffPhase;
  errorMessage: string | null;
  repoRoot: string | null;
  files: GitChangedFile[];
  truncated: boolean;
  selectedPath: string | null;
  filter: string;
  viewMode: "unified" | "split";
  fileState: Map<string, FileState>;

  // header badge (independent of the viewer being open)
  badge: DiffBadge | null;
  badgeKind: DiffPhase;

  // mutators
  openViewer: (sessionId: SessionId, root: string) => void;
  closeViewer: () => void;
  refresh: () => Promise<void>;
  ensureFileLoaded: (path: string) => Promise<void>;
  expandGap: (path: string, gapIndex: number, dir: "up" | "down" | "all") => void;
  toggleCollapsed: (path: string) => void;
  setViewMode: (mode: "unified" | "split") => void;
  setFilter: (text: string) => void;
  select: (path: string) => void;
  refreshBadge: (root: string) => Promise<void>;
  clearBadge: () => void;
}

const EXPAND_STEP = 20;

// ── Helpers ───────────────────────────────────────────────────────────

/** Sum insertions and deletions for the badge (tracked counts come from numstat; untracked from line counting in main). */
function totals(files: GitChangedFile[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const f of files) {
    insertions += f.insertions;
    deletions += f.deletions;
  }
  return { insertions, deletions };
}

function isStale(generation: number, my: number): boolean {
  return generation !== my;
}

// ── Store factory ─────────────────────────────────────────────────────

export const useDiffStore = create<DiffStore>((set, get) => {
  // Generation counter: every refresh bumps this; stale async
  // resolutions check the counter and ignore themselves.
  let generation = 0;
  // Per-file load tokens for the same protection (a previous load's
  // tokenization landing after a refresh must not overwrite fresh state).
  const fileGenerations = new Map<string, number>();
  // Debounced badge refresh — coalesce multiple rapid calls into one.
  let badgeDebounce: ReturnType<typeof setTimeout> | null = null;
  let badgeGeneration = 0;

  return {
    // ── viewer state ────────────────────────────────────────────────
    open: false,
    sessionId: null,
    root: null,
    phase: "loading",
    errorMessage: null,
    repoRoot: null,
    files: [],
    truncated: false,
    selectedPath: null,
    filter: "",
    viewMode: "unified",
    fileState: new Map(),

    badge: null,
    badgeKind: "loading",

    // ── mutators ────────────────────────────────────────────────────

    openViewer: (sessionId, root) => {
      const viewMode = useSettingsStore.getState().settings.diffViewMode;
      set({
        open: true,
        sessionId,
        root,
        phase: "loading",
        errorMessage: null,
        repoRoot: null,
        files: [],
        truncated: false,
        selectedPath: null,
        filter: "",
        viewMode,
        fileState: new Map(),
      });
      void get().refresh();
    },

    closeViewer: () => {
      const root = get().root;
      set({
        open: false,
        sessionId: null,
        root: null,
        phase: "loading",
        errorMessage: null,
        repoRoot: null,
        files: [],
        truncated: false,
        selectedPath: null,
        filter: "",
        fileState: new Map(),
      });
      // Refresh the badge after close so the header count reflects current state.
      if (root !== null) void get().refreshBadge(root);
    },

    refresh: async () => {
      const root = get().root;
      if (root === null) return;
      const myGen = ++generation;
      // Show loading only on first load (when fileState is empty).
      const isFirst = get().fileState.size === 0;
      if (isFirst) {
        set({ phase: "loading", errorMessage: null });
      }
      let res: GitChangesResult;
      try {
        res = await window.pivis.invoke("git.changes", { root });
      } catch (err) {
        if (isStale(generation, myGen)) return;
        set({
          phase: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (isStale(generation, myGen)) return;
      handleChangesResult(set, get, res, isFirst);
    },

    ensureFileLoaded: async (path) => {
      const file = get().files.find((f) => f.path === path);
      const state = get().fileState.get(path);
      if (!file) return;
      if (state && state.status !== "idle") return;

      const myGen = (fileGenerations.get(path) ?? 0) + 1;
      fileGenerations.set(path, myGen);

      const next = new Map(get().fileState);
      next.set(path, {
        ...(state ?? { collapsed: false }),
        status: "loading",
      });
      set({ fileState: next });

      let res: GitFileDiffResult;
      try {
        res = await window.pivis.invoke("git.fileDiff", {
          root: get().root ?? "",
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          status: file.status,
          untracked: file.untracked,
        });
      } catch (err) {
        if (myGen !== fileGenerations.get(path)) return;
        const m2 = new Map(get().fileState);
        m2.set(path, {
          ...(state ?? { collapsed: false }),
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        set({ fileState: m2 });
        return;
      }
      if (myGen !== fileGenerations.get(path)) return;
      if (res.kind !== "ok") {
        const m2 = new Map(get().fileState);
        m2.set(path, {
          ...(state ?? { collapsed: false }),
          status: "error",
          error: res.message,
        });
        set({ fileState: m2 });
        return;
      }
      const model = buildDiffModel(res.oldText, res.newText);
      const gapState: GapState[] =
        model.kind === "ok" ? model.gaps.map(() => ({ top: 0, bottom: 0 })) : [];
      const m3 = new Map(get().fileState);
      m3.set(path, {
        ...(state ?? { collapsed: false }),
        status: "ready",
        model,
        gapState,
        oldTokens: null,
        newTokens: null,
      });
      set({ fileState: m3 });

      // Tokenize in macrotasks so we don't block the main thread.
      scheduleTokenization(path, "old", res.oldText, myGen);
      scheduleTokenization(path, "new", res.newText, myGen);
    },

    expandGap: (path, gapIndex, dir) => {
      const state = get().fileState.get(path);
      if (!state || !state.gapState || !state.model || state.model.kind !== "ok") return;
      const gap = state.model.gaps[gapIndex];
      const gapSt = state.gapState[gapIndex];
      if (!gap || !gapSt) return;
      const nextGapState = state.gapState.map((g, i) => {
        if (i !== gapIndex) return g;
        if (dir === "all") return { top: gap.size, bottom: gap.size };
        if (dir === "up") return { ...g, bottom: Math.min(gap.size, g.bottom + EXPAND_STEP) };
        return { ...g, top: Math.min(gap.size, g.top + EXPAND_STEP) };
      });
      const m = new Map(get().fileState);
      m.set(path, { ...state, gapState: nextGapState });
      set({ fileState: m });
    },

    toggleCollapsed: (path) => {
      const state = get().fileState.get(path);
      if (!state) return;
      const m = new Map(get().fileState);
      m.set(path, { ...state, collapsed: !state.collapsed });
      set({ fileState: m });
      // Expanding triggers a load if the file is still idle.
      if (state.collapsed) {
        void get().ensureFileLoaded(path);
      }
    },

    setViewMode: (mode) => {
      set({ viewMode: mode });
      void useSettingsStore.getState().update({ diffViewMode: mode });
    },

    setFilter: (text) => {
      set({ filter: text });
    },

    select: (path) => {
      set({ selectedPath: path });
    },

    refreshBadge: async (root) => {
      // Debounce: rapid calls (e.g. multiple agent_end events) collapse
      // to a single IPC roundtrip.
      if (badgeDebounce !== null) clearTimeout(badgeDebounce);
      badgeDebounce = setTimeout(() => {
        badgeDebounce = null;
        void doBadgeRefresh(root, ++badgeGeneration);
      }, 500);
    },

    clearBadge: () => {
      if (badgeDebounce !== null) {
        clearTimeout(badgeDebounce);
        badgeDebounce = null;
      }
      set({ badge: null, badgeKind: "loading" });
    },
  };

  // ── internal helpers (closed over) ────────────────────────────────

  function scheduleTokenization(
    path: string,
    side: "old" | "new",
    text: string,
    myGen: number,
  ): void {
    // We always know the extension via the path; import lazily so
    // the highlighter boot doesn't block store init.
    setTimeout(async () => {
      if (myGen !== fileGenerations.get(path)) return;
      const lang = langForPath(path);
      const tokens = await tokenizeLines(text, lang);
      if (myGen !== fileGenerations.get(path)) return;
      const m = new Map(get().fileState);
      const cur = m.get(path);
      if (!cur || cur.status !== "ready") return;
      m.set(path, {
        ...cur,
        [side === "old" ? "oldTokens" : "newTokens"]: tokens,
      });
      set({ fileState: m });
    }, 0);
  }

  async function doBadgeRefresh(root: string, myGen: number): Promise<void> {
    let res: GitChangesResult;
    try {
      res = await window.pivis.invoke("git.changes", { root });
    } catch (err) {
      if (myGen !== badgeGeneration) return;
      set({ badge: null, badgeKind: "error" });
      return;
    }
    if (myGen !== badgeGeneration) return;
    if (res.kind === "not-a-repo" || res.kind === "git-missing") {
      set({ badge: null, badgeKind: res.kind });
      return;
    }
    if (res.kind === "error") {
      set({ badge: null, badgeKind: "error" });
      return;
    }
    const t = totals(res.files);
    set({
      badge: {
        root,
        fileCount: res.files.length,
        insertions: t.insertions,
        deletions: t.deletions,
      },
      badgeKind: "ready",
    });
  }
});

function handleChangesResult(
  set: (partial: Partial<DiffStore>) => void,
  get: () => DiffStore,
  res: GitChangesResult,
  isFirst: boolean,
): void {
  if (res.kind === "not-a-repo" || res.kind === "git-missing") {
    set({ phase: res.kind, errorMessage: null, files: [], repoRoot: null, truncated: false });
    return;
  }
  if (res.kind === "error") {
    set({ phase: "error", errorMessage: res.message });
    return;
  }
  // Auto-collapse: files beyond the first 50 start collapsed.
  const fileState = new Map<string, FileState>();
  for (let i = 0; i < res.files.length; i++) {
    const f = res.files[i]!;
    fileState.set(f.path, { status: "idle", collapsed: i >= 50 });
  }
  set({
    phase: "ready",
    errorMessage: null,
    repoRoot: res.repoRoot,
    files: res.files,
    truncated: res.truncated,
    fileState,
    selectedPath: isFirst && res.files.length > 0 ? res.files[0]!.path : get().selectedPath,
  });
}

// ── openDiffForSession ────────────────────────────────────────────────
// The single place that derives a root from a session. When sessions
// become associated with a worktree, this function changes; nothing
// else in the codebase reads `workspacePath` for git purposes.
export function openDiffForSession(sessionId: SessionId): void {
  const session = useSessionsStore.getState().sessions.get(sessionId);
  if (!session) return;
  const root = session.workspacePath;
  useDiffStore.getState().openViewer(sessionId, root);
}
