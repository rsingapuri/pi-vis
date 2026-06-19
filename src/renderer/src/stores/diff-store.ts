// diff-store — zustand store that owns the viewer state.
//
// Conventions follow sessions-store: every `set` is wrapped to produce a
// new Map (never in-place mutation). The store is a single-instance
// viewer: only one modal can be open at a time, so a global shape is
// correct. The store never reads `workspacePath` for git purposes
// itself — the renderer derives the root in `openDiffForSession` and
// passes it explicitly. This is the single point of change when
// sessions become associated with a worktree.

import type {
  GitBranchesResult,
  GitChangedFile,
  GitChangesCountResult,
  GitChangesResult,
  GitFileDiffResult,
} from "@shared/git.js";
import type { GitBranch } from "@shared/git.js";
import type { SessionId } from "@shared/ids.js";
import type { ThemedToken } from "shiki";
import { create } from "zustand";
import type { AnyDiffModel, DiffModel, GapState } from "../lib/diff/diff-model.js";
import { buildDiffModel } from "../lib/diff/diff-model.js";
import { tokenizeLines } from "../lib/diff/highlight.js";
import { langForPath } from "../lib/diff/highlight.js";
import { gitRootForSession, useSessionsStore } from "./sessions-store.js";
import { useSettingsStore } from "./settings-store.js";

// ── Phases / state shape ──────────────────────────────────────────────

export type DiffPhase = "loading" | "ready" | "not-a-repo" | "git-missing" | "error";

export interface FileState {
  status: "idle" | "loading" | "ready" | "error";
  model?: AnyDiffModel;
  gapState?: GapState[];
  oldTokens?: ThemedToken[][] | null;
  newTokens?: ThemedToken[][] | null;
  oldText?: string;
  newText?: string;
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

  // base branch selection
  branches: GitBranch[];
  currentBranch: string | null;
  selectedBase: string | null; // null = HEAD
  includeRemoteBranches: boolean;

  // header badge (independent of the viewer being open)
  badge: DiffBadge | null;
  badgeKind: DiffPhase;

  // true when the working tree's content fingerprint has moved since the
  // last full viewer refresh — i.e. a tool call actually changed files (as
  // opposed to a read-only tool). Shown as a stale indicator by the refresh
  // button. Recomputed on every badge refresh; cleared by refresh().
  stale: boolean;
  // Working-tree fingerprint as of the last full viewer refresh (the diff
  // the user is currently looking at). null until the first refresh.
  baselineFingerprint: string | null;

  // mutators
  openViewer: (sessionId: SessionId, root: string) => void;
  closeViewer: () => void;
  refresh: () => Promise<void>;
  ensureFileLoaded: (path: string) => Promise<void>;
  expandGap: (path: string, gapIndex: number, dir: "up" | "down" | "all") => void;
  retokenize: () => void;
  toggleCollapsed: (path: string) => void;
  setViewMode: (mode: "unified" | "split") => void;
  setFilter: (text: string) => void;
  select: (path: string) => void;
  railWidth: number;
  setRailWidth: (w: number) => void;
  refreshBadge: (root: string) => Promise<void>;
  loadBranches: () => Promise<void>;
  setBase: (base: string | null) => void;
  setIncludeRemoteBranches: (v: boolean) => void;
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

/** Cheap signature for a changed file — used to detect actual changes across refreshes. */
function fileSig(f: GitChangedFile): string {
  return `${f.status}\0${f.insertions}\0${f.deletions}\0${f.binary ? 1 : 0}\0${f.oldPath ?? ""}`;
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
  // Single-flight: at most one badge scan runs at a time. On a huge repo a
  // scan can take seconds; without this guard, the every-tool-call refresh
  // would spawn overlapping scans that contend for disk and pile up. A
  // request arriving mid-scan just records the latest root; one trailing
  // scan runs when the in-flight one finishes.
  let badgeInFlight = false;
  let badgePendingRoot: string | null = null;

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
    railWidth: 280,
    fileState: new Map(),

    badge: null,
    badgeKind: "loading",
    stale: false,
    baselineFingerprint: null,

    // branch selection
    branches: [],
    currentBranch: null,
    selectedBase: null,
    includeRemoteBranches: false,

    // ── mutators ────────────────────────────────────────────────────

    openViewer: (sessionId, root) => {
      const viewMode = useSettingsStore.getState().settings.diffViewMode;
      const includeRemote = useSettingsStore.getState().settings.diffIncludeRemoteBranches;
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
        // Reset branch selection on open.
        selectedBase: null,
        includeRemoteBranches: includeRemote,
        stale: false,
        baselineFingerprint: null,
      });
      void get().refresh();
      void get().loadBranches();
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
      // Note: `stale` is intentionally NOT cleared here. It is cleared (and
      // the baseline fingerprint re-captured) only on success, in
      // handleChangesResult — so a refresh that errors out leaves the dot up,
      // since the displayed content is definitely out of date.
      // Show loading only on first load (when fileState is empty).
      const isFirst = get().fileState.size === 0;
      if (isFirst) {
        set({ phase: "loading", errorMessage: null });
      }
      let res: GitChangesResult;
      try {
        const base = get().selectedBase ?? undefined;
        res = await window.pivis.invoke("git.changes", {
          root,
          ...(base !== undefined ? { base } : {}),
        });
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
        const base = get().selectedBase ?? undefined;
        const params: {
          root: string;
          base?: string;
          path: string;
          oldPath?: string;
          status: import("@shared/git.js").GitFileStatus;
          untracked: boolean;
        } = {
          root: get().root ?? "",
          path: file.path,
          status: file.status,
          untracked: file.untracked,
        };
        if (file.oldPath) params.oldPath = file.oldPath;
        if (base !== undefined) params.base = base;
        res = await window.pivis.invoke("git.fileDiff", params);
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
        oldText: res.oldText,
        newText: res.newText,
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

    retokenize: () => {
      // Re-tokenize every ready file in place — used when the color
      // scheme / Shiki theme changes. Preserves model, gaps, and
      // collapse state; only nulls tokens and re-runs highlighter.
      const state = get().fileState;
      let changed = false;
      const next = new Map(state);
      for (const [path, fs] of state) {
        if (fs.status !== "ready") continue;
        const myGen = (fileGenerations.get(path) ?? 0) + 1;
        fileGenerations.set(path, myGen);
        next.set(path, { ...fs, oldTokens: null, newTokens: null });
        changed = true;
        if (fs.oldText !== undefined) scheduleTokenization(path, "old", fs.oldText, myGen);
        if (fs.newText !== undefined) scheduleTokenization(path, "new", fs.newText, myGen);
      }
      if (changed) set({ fileState: next });
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

    setRailWidth: (w) => {
      set({ railWidth: w });
    },

    refreshBadge: async (root) => {
      // Debounce coalesces a burst (e.g. multiple agent_end events) into one
      // scheduled scan; the single-flight runner then bounds concurrency.
      if (badgeDebounce !== null) clearTimeout(badgeDebounce);
      badgeDebounce = setTimeout(() => {
        badgeDebounce = null;
        runBadge(root);
      }, 500);
    },

    // ── Base branch selection ──────────────────────────────────────

    loadBranches: async () => {
      const root = get().root;
      if (!root) return;
      try {
        const res: GitBranchesResult = await window.pivis.invoke("git.branches", { root });
        if (res.kind === "ok") {
          set({
            branches: res.branches,
            currentBranch: res.current,
          });
        }
      } catch {
        // Silently ignore; branch dropdown just stays empty.
      }
    },

    setBase: (base) => {
      set({
        selectedBase: base,
        // Clear file state so diffs reload against the new base.
        fileState: new Map(),
      });
      void get().refresh();
    },

    setIncludeRemoteBranches: (v) => {
      set({ includeRemoteBranches: v });
      // Persist to settings.
      void useSettingsStore.getState().update({ diffIncludeRemoteBranches: v });
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

  // Single-flight wrapper around doBadgeRefresh: bounds badge scans to one at
  // a time and coalesces requests that arrive mid-scan into a single trailing
  // scan (using the latest root).
  function runBadge(root: string): void {
    if (badgeInFlight) {
      badgePendingRoot = root;
      return;
    }
    badgeInFlight = true;
    void doBadgeRefresh(root, ++badgeGeneration).finally(() => {
      badgeInFlight = false;
      if (badgePendingRoot !== null) {
        const next = badgePendingRoot;
        badgePendingRoot = null;
        runBadge(next);
      }
    });
  }

  async function doBadgeRefresh(root: string, myGen: number): Promise<void> {
    // When the viewer is CLOSED, the badge only needs a changed-file count —
    // use the lightweight one-scan query (no line counts, fingerprint, or
    // file reads). When OPEN, the refresh doubles as the staleness probe, so
    // we need the full changes (including the fingerprint).
    if (!get().open) {
      let res: GitChangesCountResult;
      try {
        res = await window.pivis.invoke("git.changesCount", { root });
      } catch {
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
      // insertions/deletions aren't rendered on the badge; the count is all
      // the closed-viewer path needs.
      set({
        badge: { root, fileCount: res.fileCount, insertions: 0, deletions: 0 },
        badgeKind: "ready",
      });
      return;
    }

    let res: GitChangesResult;
    try {
      res = await window.pivis.invoke("git.changes", { root });
    } catch {
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
    // The open viewer's per-tool-call refresh doubles as the staleness probe:
    // the dot lights iff the working tree's fingerprint has moved off the
    // baseline captured by the last full viewer refresh. The fingerprint is
    // base-independent, so this holds even for a branch-relative diff, and it
    // can also *clear* a false stale (a reverted edit returns to the baseline).
    const s = get();
    if (s.open) {
      const stale = s.baselineFingerprint !== null && res.fingerprint !== s.baselineFingerprint;
      if (s.stale !== stale) set({ stale });
    }
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

  // Build signatures for previous files to detect changes.
  const prevFiles = get().files;
  const prevFileState = get().fileState;
  const prevSigs = new Map<string, string>();
  for (const pf of prevFiles) {
    prevSigs.set(pf.path, fileSig(pf));
  }

  // Reconcile: reuse FileState for files whose signature is unchanged,
  // create idle for new/changed files.
  const fileState = new Map<string, FileState>();
  for (let i = 0; i < res.files.length; i++) {
    const f = res.files[i]!;
    const prev = prevFileState.get(f.path);
    const prevSig = prevSigs.get(f.path);
    const sig = fileSig(f);

    if (prev && prevSig === sig && prev.status !== "error") {
      // Signature unchanged — reuse the previous FileState verbatim.
      // This preserves parsed diff models, Shiki tokens, gaps, and
      // collapse state so the diff viewer doesn't flash/reload.
      fileState.set(f.path, prev);
    } else {
      // Changed or new file — start idle so ensureFileLoaded reloads.
      fileState.set(f.path, {
        status: "idle",
        collapsed: prev?.collapsed ?? i >= 50,
      });
    }
  }

  set({
    phase: "ready",
    errorMessage: null,
    repoRoot: res.repoRoot,
    files: res.files,
    truncated: res.truncated,
    fileState,
    selectedPath: isFirst && res.files.length > 0 ? res.files[0]!.path : get().selectedPath,
    // A full viewer refresh is the user seeing current state: re-baseline the
    // fingerprint and clear staleness. Subsequent badge refreshes compare
    // against this.
    baselineFingerprint: res.fingerprint,
    stale: false,
  });
}

// ── openDiffForSession ────────────────────────────────────────────────
// The single place that derives a root from a session. When sessions
// become associated with a worktree, this function changes; nothing
// else in the codebase reads `workspacePath` for git purposes.
export function openDiffForSession(sessionId: SessionId): void {
  const session = useSessionsStore.getState().sessions.get(sessionId);
  if (!session) return;
  const root = gitRootForSession(session);
  if (!root) return;
  useDiffStore.getState().openViewer(sessionId, root);
}
