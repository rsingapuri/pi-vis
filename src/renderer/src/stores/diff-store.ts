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
  GitCommitRange,
  GitFileDiffResult,
  GitHistoricalContext,
} from "@shared/git.js";
import type { GitBranch } from "@shared/git.js";
import type { SessionId } from "@shared/ids.js";
import type { ThemedToken } from "shiki";
import { create } from "zustand";
import { detectIndentUnit } from "../lib/diff/auto-indent.js";
import { buildDiffModelAsync } from "../lib/diff/diff-model-worker-client.js";
import type { AnyDiffModel, DiffModel, GapState } from "../lib/diff/diff-model.js";
import {
  buildDiffModel,
  carryGapState,
  splitAndNormalizeLines,
  visibleOldLineNos,
} from "../lib/diff/diff-model.js";
import { findUniqueBlock } from "../lib/diff/edit-anchor.js";
import type { EditBlockKind, EditRange } from "../lib/diff/edit-range.js";
import { tokenizeLines, tokenizeLinesSync } from "../lib/diff/highlight.js";
import { langForPath } from "../lib/diff/highlight.js";
import { clampDiffRenderCap } from "../lib/diff/render-limits.js";
import type { SearchMatch } from "../lib/diff/search.js";
import { spliceNewLines } from "../lib/diff/splice.js";
import { getLoadedHighlighter } from "../lib/shiki.js";
import { gitRootForSession, useSessionsStore } from "./sessions-store.js";
import { useSettingsStore } from "./settings-store.js";

// ── Phases / state shape ──────────────────────────────────────────────

export type DiffPhase = "loading" | "ready" | "not-a-repo" | "git-missing" | "error";
export type WorkingTreeScope = "base" | "uncommitted";

export interface FileState {
  status: "idle" | "loading" | "ready" | "error";
  model?: AnyDiffModel;
  gapState?: GapState[];
  oldTokens?: ThemedToken[][] | null;
  newTokens?: ThemedToken[][] | null;
  oldText?: string;
  newText?: string;
  collapsed: boolean;
  renderCap?: number | undefined;
  error?: string;
}

/** An in-progress inline edit of one file's new-side line range.
 *
 *  Buffers are NOT store state (the card's textareas are uncontrolled); the
 *  card passes the segment buffers to `saveEditSession` at save time. While a
 *  session exists for file F, F is FROZEN: `handleChangesResult`/`refresh`
 *  reuse F's FileState verbatim and keep F's GitChangedFile entry even if it
 *  drops out of `git.changes`; queued changes apply on close. */
export interface EditCursorPosition {
  /** Edit-block (textarea) index that should receive initial focus. */
  segmentIndex: number;
  /** Initial selection start within that segment's initial text. */
  offset: number;
  /** Initial selection end within that segment's initial text. Omitted for a collapsed cursor. */
  selectionEndOffset?: number | undefined;
}

export interface EditSession {
  path: string;
  /** Initial textarea selection derived from the highlighted text. */
  initialCursor: EditCursorPosition | null;
  /** Frozen model line indices of the selected slice. */
  startLineIdx: number;
  endLineIdx: number;
  /** New-side line range being replaced. */
  startNewNo: number;
  endNewNo: number;
  /** Ordered block sequence (edit segments + inert del/comment rows). */
  blocks: EditBlockKind[];
  /** FileState.newText captured at open — the CAS base. */
  baseNewText: string;
  /** Original new-side lines [startNewNo..endNewNo] (conflict re-anchor key). */
  originalLines: string[];
  indentUnit: string;
  phase: "editing" | "saving" | "conflict" | "error";
  errorMessage?: string | undefined;
  dirty: boolean;
  /** Set when the file changed/vanished on disk while frozen; flushed on close. */
  queuedRefresh: boolean;
}

export interface DiffBadge {
  root: string;
  fileCount: number;
  insertions: number;
  deletions: number;
  /** True when fileCount is a cap rather than the exact total. */
  truncated: boolean;
}

export interface DiffStore {
  // viewer
  open: boolean;
  sessionId: SessionId | null;
  root: string | null;
  phase: DiffPhase;
  errorMessage: string | null;
  repoRoot: string | null;
  /** Browsable file sections (capped by main for DOM/sidebar scalability). */
  files: GitChangedFile[];
  /** Complete descriptor-only manifest used by uncapped diff search. */
  searchFiles: GitChangedFile[];
  truncated: boolean;
  selectedPath: string | null;
  filter: string;
  viewMode: "unified" | "split";
  fileState: Map<string, FileState>;
  /** Bumped when local diff content/projection changes without replacing the
   *  changed-file manifest (gap reveal or inline save). Search uses this
   *  primitive instead of scanning FileState on tokenization/lazy-load updates. */
  searchRevision: number;

  /** At most one inline edit session is open at a time (one editor at a time).
   *  While non-null, that file is frozen against refreshes. */
  editSession: EditSession | null;
  /** Files with an open unsaved comment editor. Comparison changes are fenced
   *  so local component drafts cannot be unmounted silently. */
  commentEditorFiles: Set<string>;
  /** Bumped to ask the open edit card to run its cancel flow (confirm if
   *  dirty). Lets the viewer's Esc / backdrop / close route to the card's
   *  ConfirmDialog without the card needing to own those inputs. */
  editCancelNonce: number;

  // in-diff find: highlight + jump between every visible occurrence of a
  // string across all changed files. `activeMatch` is the currently-focused
  // occurrence (drives the "current" highlight + scroll-into-view); the full
  // ordered match list is derived in the host from files + fileState.
  search: {
    open: boolean;
    query: string;
    caseSensitive: boolean;
    activeMatch: SearchMatch | null;
  };

  // base branch selection
  branches: GitBranch[];
  currentBranch: string | null;
  selectedBase: string | null; // null = HEAD
  /** Which live comparison to use while commitRange is null. `base` compares
   * the selected base through the working tree; `uncommitted` compares HEAD
   * through the working tree and therefore excludes committed branch work. */
  workingTreeScope: WorkingTreeScope;
  /** Ephemeral inclusive historical commit band; null is a live working tree. */
  commitRange: GitCommitRange | null;
  /** Concrete object IDs issued with the current historical manifest. */
  historicalContext: GitHistoricalContext | null;
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

  // True while a full `git.changes` refresh is in flight. Drives the
  // refresh-button spinner independently of `phase` (which only flips to
  // "loading" on the first load, to avoid wiping the already-displayed
  // file list on every click). Enforced to stay true for at least one full
  // icon rotation so an instant refresh still gives visible feedback.
  refreshing: boolean;

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
  railVisible: boolean;
  toggleRail: () => void;
  refreshBadge: (root: string) => Promise<void>;
  loadBranches: () => Promise<void>;
  /** Atomically switch both comparison dimensions. A changed comparison has
   * exactly one invalidation and refresh. */
  setComparison: (comparison: {
    base: string | null;
    range: GitCommitRange | null;
    workingTreeScope?: WorkingTreeScope;
  }) => void;
  /** Compatibility wrappers for existing callers. */
  setBase: (base: string | null) => void;
  setCommitRange: (range: GitCommitRange | null) => void;
  showUncommittedChanges: () => void;
  setIncludeRemoteBranches: (v: boolean) => void;

  // in-diff find
  openSearch: () => void;
  closeSearch: () => void;
  setSearchQuery: (q: string) => void;
  toggleSearchCaseSensitive: () => void;
  setActiveMatch: (m: SearchMatch | null) => void;
  bumpRenderCap: (path: string, cap: number) => void;

  // ── Inline edit session ───────────────────────────────────────────
  /** Open an edit session for a resolved selection. No-op if one is already
   *  open. Requires the file to be `ready` with a `kind:"ok"` model + newText. */
  setCommentEditorOpen: (path: string, open: boolean) => void;
  openEditSession: (path: string, range: EditRange, cursor?: EditCursorPosition | null) => void;
  /** Mark the open session dirty (a buffer changed). */
  markEditDirty: () => void;
  /** Cancel/close the open session, flushing a queued refresh if any. */
  cancelEditSession: () => void;
  /** Save the open session: splice + CAS write + commit. `buffers` is the
   *  per-edit-segment buffer text, in block order (only edit blocks). */
  saveEditSession: (buffers: string[]) => Promise<void>;
  /** Ask the open edit card to cancel (confirm if dirty). */
  requestCancelEdit: () => void;
}

const EMPTY_SEARCH = {
  open: false,
  query: "",
  caseSensitive: false,
  activeMatch: null,
} as const;

const EXPAND_STEP = 20;

// Minimum time the refresh icon stays spinning, so even a sub-frame
// refresh shows at least one full rotation (matches the 0.8s
// `diff-spin` animation period).
const MIN_REFRESH_SPIN_MS = 800;

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

// Paths saved in the current tick: handleChangesResult reuses their FileState
// verbatim (WE are the change) and clears the mark, so a save neither reloads
// the file nor lights the stale dot (invariant 10). Module-level because the
// single-instance viewer's reconcile (handleChangesResult) is also
// module-level and must clear it.
const justSavedPaths = new Set<string>();

/** Cheap signature for a changed file — used to detect actual changes across refreshes. */
function fileSig(f: GitChangedFile): string {
  return `${f.status}\0${f.insertions}\0${f.deletions}\0${f.binary ? 1 : 0}\0${f.oldPath ?? ""}`;
}

// ── Store factory ─────────────────────────────────────────────────────

export const useDiffStore = create<DiffStore>((set, get) => {
  // Generation counter: every refresh bumps this; stale async
  // resolutions check the counter and ignore themselves.
  let generation = 0;
  // Invalidates all file loads even when a successor has not started one yet.
  let comparisonGeneration = 0;
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
  const selectedBaseBySession = new Map<SessionId, string | null>();

  return {
    // ── viewer state ────────────────────────────────────────────────
    open: false,
    sessionId: null,
    root: null,
    phase: "loading",
    errorMessage: null,
    repoRoot: null,
    files: [],
    searchFiles: [],
    truncated: false,
    selectedPath: null,
    filter: "",
    viewMode: "unified",
    railWidth: 280,
    railVisible: true,
    fileState: new Map(),
    searchRevision: 0,
    editSession: null,
    commentEditorFiles: new Set(),
    editCancelNonce: 0,

    badge: null,
    badgeKind: "loading",
    stale: false,
    baselineFingerprint: null,
    refreshing: false,

    search: { ...EMPTY_SEARCH },

    // branch selection
    branches: [],
    currentBranch: null,
    selectedBase: null,
    workingTreeScope: "base",
    commitRange: null,
    historicalContext: null,
    includeRemoteBranches: false,

    // ── mutators ────────────────────────────────────────────────────

    openViewer: (sessionId, root) => {
      generation++;
      comparisonGeneration++;
      for (const [path, token] of fileGenerations) fileGenerations.set(path, token + 1);
      const settings = useSettingsStore.getState().settings;
      const viewMode = settings.diffViewMode;
      const includeRemote = settings.diffIncludeRemoteBranches;
      set({
        open: true,
        sessionId,
        root,
        phase: "loading",
        errorMessage: null,
        repoRoot: null,
        files: [],
        searchFiles: [],
        truncated: false,
        selectedPath: null,
        filter: "",
        viewMode,
        // Restore the persisted rail layout (width + visibility) so the
        // viewer reopens the way the user left it.
        railWidth: settings.diffRailWidth,
        railVisible: settings.diffRailVisible,
        fileState: new Map(),
        searchRevision: 0,
        editSession: null,
        commentEditorFiles: new Set(),
        editCancelNonce: 0,
        // Restore the branch selected for this session during the current app run.
        selectedBase: selectedBaseBySession.get(sessionId) ?? null,
        workingTreeScope: "base",
        commitRange: null,
        historicalContext: null,
        includeRemoteBranches: includeRemote,
        stale: false,
        baselineFingerprint: null,
        refreshing: false,
        search: { ...EMPTY_SEARCH },
      });
      void get().refresh();
      void get().loadBranches();
    },

    closeViewer: () => {
      const root = get().root;
      generation++;
      comparisonGeneration++;
      for (const [path, token] of fileGenerations) fileGenerations.set(path, token + 1);
      set({
        open: false,
        sessionId: null,
        root: null,
        phase: "loading",
        errorMessage: null,
        repoRoot: null,
        files: [],
        searchFiles: [],
        truncated: false,
        selectedPath: null,
        filter: "",
        fileState: new Map(),
        searchRevision: 0,
        editSession: null,
        commentEditorFiles: new Set(),
        editCancelNonce: 0,
        refreshing: false,
        workingTreeScope: "base",
        commitRange: null,
        historicalContext: null,
        stale: false,
        baselineFingerprint: null,
        search: { ...EMPTY_SEARCH },
      });
      // Refresh the badge after close so the header count reflects current state.
      if (root !== null) void get().refreshBadge(root);
    },

    refresh: async () => {
      const root = get().root;
      if (root === null) return;
      const baseAtStart = get().selectedBase;
      const workingTreeScopeAtStart = get().workingTreeScope;
      const rangeAtStart = get().commitRange;
      const historicalContextAtStart = get().historicalContext;
      const myComparison = comparisonGeneration;
      const myGen = ++generation;
      // Note: `stale` is intentionally NOT cleared here. It is cleared (and
      // the baseline fingerprint re-captured) only on success, in
      // handleChangesResult — so a refresh that errors out leaves the dot up,
      // since the displayed content is definitely out of date.
      // Spin the refresh icon for the duration of the fetch. Unlike `phase`,
      // this does not wipe the already-displayed file list, so a refresh
      // click keeps the current content visible while indicating activity.
      // Held for at least one full icon rotation so an instant refresh still
      // gives visible feedback.
      set({ refreshing: true });
      const minSpin = new Promise<void>((resolve) => setTimeout(resolve, MIN_REFRESH_SPIN_MS));
      // Show loading only on first load (when fileState is empty).
      const isFirst = get().fileState.size === 0;
      if (isFirst) {
        set({ phase: "loading", errorMessage: null });
      }
      let res: GitChangesResult;
      try {
        const base =
          rangeAtStart !== null || workingTreeScopeAtStart === "base"
            ? (baseAtStart ?? undefined)
            : undefined;
        res = await window.pivis.invoke("git.changes", {
          root,
          ...(base !== undefined ? { base } : {}),
          ...(rangeAtStart !== null ? { range: rangeAtStart } : {}),
          ...(historicalContextAtStart !== null
            ? { historicalContext: historicalContextAtStart }
            : {}),
        });
      } catch (err) {
        if (isStale(generation, myGen)) return;
        set({
          phase: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          refreshing: false,
        });
        return;
      }
      if (isStale(generation, myGen) || comparisonGeneration !== myComparison) return;
      handleChangesResult(set, get, res, isFirst, rangeAtStart !== null && !rangeAtStart.includeUncommitted);
      // Keep the spinner going for at least one rotation even if the fetch
      // was near-instant. If a newer refresh has superseded this one, leave
      // `refreshing` alone — the newer call owns the flag.
      await minSpin;
      if (isStale(generation, myGen)) return;
      set({ refreshing: false });
    },

    ensureFileLoaded: async (path) => {
      // Freeze: while an edit session is open for this file, never reload it.
      if (get().editSession?.path === path) return;
      const file =
        get().searchFiles.find((candidate) => candidate.path === path) ??
        get().files.find((candidate) => candidate.path === path);
      const state = get().fileState.get(path);
      if (!file) return;
      if (state && state.status !== "idle") return;

      const myGen = (fileGenerations.get(path) ?? 0) + 1;
      const myComparison = comparisonGeneration;
      const rootAtStart = get().root;
      const baseAtStart = get().selectedBase;
      const workingTreeScopeAtStart = get().workingTreeScope;
      const rangeAtStart = get().commitRange;
      const historicalContextAtStart = get().historicalContext;
      fileGenerations.set(path, myGen);

      const next = new Map(get().fileState);
      next.set(path, {
        ...(state ?? { collapsed: false }),
        status: "loading",
      });
      set({ fileState: next });

      let res: GitFileDiffResult;
      try {
        const base =
          rangeAtStart !== null || workingTreeScopeAtStart === "base"
            ? (baseAtStart ?? undefined)
            : undefined;
        const params: {
          root: string;
          base?: string;
          path: string;
          oldPath?: string;
          status: import("@shared/git.js").GitFileStatus;
          untracked: boolean;
          binary: boolean;
          range?: GitCommitRange;
          historicalContext?: GitHistoricalContext;
        } = {
          root: rootAtStart ?? "",
          path: file.path,
          status: file.status,
          untracked: file.untracked,
          binary: file.binary,
        };
        if (file.oldPath) params.oldPath = file.oldPath;
        if (base !== undefined) params.base = base;
        if (rangeAtStart !== null) params.range = rangeAtStart;
        if (historicalContextAtStart !== null) {
          params.historicalContext = historicalContextAtStart;
        }
        res = await window.pivis.invoke("git.fileDiff", params);
      } catch (err) {
        if (myGen !== fileGenerations.get(path) || comparisonGeneration !== myComparison) return;
        const m2 = new Map(get().fileState);
        m2.set(path, {
          ...(state ?? { collapsed: false }),
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        set({ fileState: m2 });
        return;
      }
      if (myGen !== fileGenerations.get(path) || comparisonGeneration !== myComparison) return;
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
      // Honor main's `tooLarge` / `binary` flags directly instead of diffing
      // the text. Main caps the working-tree read at FILE_TOO_LARGE and
      // returns `tooLarge` with an EMPTY newText (but a populated oldText for
      // a modified file); feeding that empty new side into buildDiffModel
      // would render a modified file as a wholesale deletion ("removed
      // completely"), or — past the line cap — show a misleading "File too
      // large to diff". A `binary` file's text is replacement-char soup that's
      // pointless to diff. Both get a dedicated notice; skip tokenization too.
      if (res.tooLarge || res.binary) {
        const m2 = new Map(get().fileState);
        m2.set(path, {
          ...(state ?? { collapsed: false }),
          status: "ready",
          // Binary takes precedence: a binary diff has nothing legible to
          // render, and main never sets both flags at once (a too-large file
          // is returned with binary:false before the sniff runs).
          model: res.binary ? { kind: "binary" } : { kind: "too-large", oldSize: 0, newSize: 0 },
          gapState: [],
          oldTokens: null,
          newTokens: null,
          oldText: res.oldText,
          newText: res.newText,
        });
        set({ fileState: m2 });
        return;
      }
      const model = await buildDiffModelAsync(res.oldText, res.newText);
      if (myGen !== fileGenerations.get(path) || comparisonGeneration !== myComparison) return;
      const gapState: GapState[] =
        model.kind === "ok" ? model.gaps.map(() => ({ top: 0, bottom: 0 })) : [];
      // Tokenize in the SAME commit whenever the highlighter is warm (it is,
      // after app boot). A deferred plain→colored token swap rewrites every
      // row's text nodes, which visibly remaps any active text selection in
      // the file — the "shifting highlight" bug. One commit ⇒ one paint.
      const lang = langForPath(path);
      const warm = getLoadedHighlighter() !== null;
      const oldTokens = warm ? tokenizeLinesSync(res.oldText, lang) : null;
      const newTokens = warm ? tokenizeLinesSync(res.newText, lang) : null;
      const m3 = new Map(get().fileState);
      m3.set(path, {
        ...(state ?? { collapsed: false }),
        status: "ready",
        model,
        gapState,
        oldTokens,
        newTokens,
        oldText: res.oldText,
        newText: res.newText,
      });
      set({ fileState: m3 });

      // Cold-start fallback only: the highlighter wasn't ready yet, so
      // tokenize in macrotasks and swap in when done. (When warm, sync
      // tokenization already ran; a null there means unknown lang / over
      // caps, which the async path would also return null for.)
      if (!warm) {
        scheduleTokenization(path, "old", res.oldText, myGen);
        scheduleTokenization(path, "new", res.newText, myGen);
      }
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
      set({ fileState: m, searchRevision: get().searchRevision + 1 });
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

    toggleRail: () => {
      const next = !get().railVisible;
      set({ railVisible: next });
      void useSettingsStore.getState().update({ diffRailVisible: next });
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
      const requestSessionId = get().sessionId;
      if (!root || !requestSessionId) return;
      try {
        const res: GitBranchesResult = await window.pivis.invoke("git.branches", { root });
        if (get().root !== root || get().sessionId !== requestSessionId) return;
        if (res.kind === "ok") {
          const selectedBase = get().selectedBase;
          const selectedBaseValid =
            selectedBase === null || res.branches.some((branch) => branch.name === selectedBase);
          const sessionId = get().sessionId;
          set({
            branches: res.branches,
            currentBranch: res.current,
            ...(selectedBaseValid
              ? {}
              : {
                  selectedBase: null,
                  fileState: new Map(),
                }),
          });
          if (!selectedBaseValid) {
            if (sessionId) selectedBaseBySession.set(sessionId, null);
            // This is the same comparison invalidation as changing the base:
            // a range and every comparison-derived UI value belong to the
            // deleted base and must not survive the replacement refresh.
            generation++;
            comparisonGeneration++;
            for (const [path, token] of fileGenerations) fileGenerations.set(path, token + 1);
            set({
              branches: res.branches,
              currentBranch: res.current,
              selectedBase: null,
              workingTreeScope: "base",
              commitRange: null,
              historicalContext: null,
              files: [],
              searchFiles: [],
              truncated: false,
              selectedPath: null,
              fileState: new Map(),
              stale: false,
              baselineFingerprint: null,
              search: { ...get().search, activeMatch: null },
            });
            void get().refresh();
          }
        }
      } catch {
        // Silently ignore; branch dropdown just stays empty.
      }
    },

    setComparison: ({ base, range, workingTreeScope = "base" }) => {
      if (get().editSession || get().commentEditorFiles.size > 0) return;
      const current = get();
      if (
        current.selectedBase === base &&
        current.workingTreeScope === workingTreeScope &&
        current.commitRange?.start === range?.start &&
        current.commitRange?.end === range?.end &&
        current.commitRange?.includeUncommitted === range?.includeUncommitted
      ) {
        return;
      }
      const sessionId = current.sessionId;
      if (sessionId) selectedBaseBySession.set(sessionId, base);
      generation++;
      comparisonGeneration++;
      for (const [path, token] of fileGenerations) fileGenerations.set(path, token + 1);
      set({
        selectedBase: base,
        workingTreeScope,
        commitRange: range,
        historicalContext: null,
        files: [],
        searchFiles: [],
        truncated: false,
        selectedPath: null,
        fileState: new Map(),
        stale: false,
        baselineFingerprint: null,
        search: { ...current.search, activeMatch: null },
      });
      void get().refresh();
    },

    setBase: (base) => {
      get().setComparison({ base, range: null, workingTreeScope: "base" });
    },

    setCommitRange: (range) => {
      get().setComparison({ base: get().selectedBase, range, workingTreeScope: "base" });
    },

    showUncommittedChanges: () => {
      get().setComparison({
        base: get().selectedBase,
        range: null,
        workingTreeScope: "uncommitted",
      });
    },

    setIncludeRemoteBranches: (v) => {
      set({ includeRemoteBranches: v });
      // Persist to settings.
      void useSettingsStore.getState().update({ diffIncludeRemoteBranches: v });
    },

    // ── In-diff find ───────────────────────────────────────────────

    openSearch: () => {
      set({ search: { ...get().search, open: true } });
    },

    closeSearch: () => {
      // Keep the query so reopening restores it; just hide the bar and drop
      // the active occupation so no stray "current" highlight lingers.
      set({ search: { ...get().search, open: false, activeMatch: null } });
    },

    setSearchQuery: (q) => {
      // A new query invalidates the active match; the host re-seeds it to the
      // first hit once matches recompute.
      set({ search: { ...get().search, query: q, activeMatch: null } });
    },

    toggleSearchCaseSensitive: () => {
      const s = get().search;
      set({ search: { ...s, caseSensitive: !s.caseSensitive, activeMatch: null } });
    },

    setActiveMatch: (m) => {
      set({ search: { ...get().search, activeMatch: m } });
    },

    bumpRenderCap: (path, cap) => {
      const m = new Map(get().fileState);
      const cur = m.get(path);
      if (!cur) return;
      const nextCap = clampDiffRenderCap(cap);
      if ((cur.renderCap ?? 0) >= nextCap) return;
      m.set(path, { ...cur, renderCap: nextCap });
      set({ fileState: m });
    },

    // ── Inline edit session ─────────────────────────────────────────

    setCommentEditorOpen: (path, open) => {
      const next = new Set(get().commentEditorFiles);
      if (open) next.add(path);
      else next.delete(path);
      set({ commentEditorFiles: next });
    },

    openEditSession: (path, range, cursor = null) => {
      if (get().commitRange || get().editSession || get().commentEditorFiles.size > 0) return;
      const viewerSessionId = get().sessionId;
      if (
        viewerSessionId &&
        useSessionsStore.getState().sessions.get(viewerSessionId)?.worktreeCreating
      )
        return;
      const state = get().fileState.get(path);
      if (!state || state.status !== "ready" || !state.model || state.model.kind !== "ok") return;
      if (state.newText === undefined) return;
      const allLines = splitAndNormalizeLines(state.newText);
      const originalLines = allLines.slice(range.startNewNo - 1, range.endNewNo);
      set({
        editSession: {
          path,
          initialCursor: cursor,
          startLineIdx: range.startLineIdx,
          endLineIdx: range.endLineIdx,
          startNewNo: range.startNewNo,
          endNewNo: range.endNewNo,
          blocks: range.blocks,
          baseNewText: state.newText,
          originalLines,
          indentUnit: detectIndentUnit(state.newText),
          phase: "editing",
          dirty: false,
          queuedRefresh: false,
        },
        editCancelNonce: 0,
      });
    },

    markEditDirty: () => {
      const s = get().editSession;
      if (!s || s.dirty) return;
      set({ editSession: { ...s, dirty: true } });
    },

    cancelEditSession: () => {
      const s = get().editSession;
      if (!s) return;
      set({ editSession: null });
      if (s.queuedRefresh) void get().refresh();
    },

    requestCancelEdit: () => {
      const session = get().editSession;
      if (!session || session.phase === "saving") return;
      set({ editCancelNonce: get().editCancelNonce + 1 });
    },

    saveEditSession: async (buffers) => {
      await doSave(buffers);
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

  // ── Inline edit save orchestration ────────────────────────────────

  /** Splice + CAS write against `baseText`. Returns the spliced new text on
   *  ok so the caller can commit it. Never throws across IPC. */
  async function tryWrite(
    root: string,
    path: string,
    baseText: string,
    startNewNo: number,
    endNewNo: number,
    replacementLines: string[],
  ): Promise<
    { kind: "ok"; newText: string } | { kind: "conflict" } | { kind: "error"; message: string }
  > {
    const nextNewText = spliceNewLines(baseText, startNewNo, endNewNo, replacementLines);
    const expectedHash = await sha256Hex(baseText);
    try {
      const res = await window.pivis.invoke("git.writeWorkingFile", {
        root,
        path,
        content: nextNewText,
        expectedHash,
      });
      if (res.kind === "ok") return { kind: "ok", newText: nextNewText };
      if (res.kind === "conflict") return { kind: "conflict" };
      return { kind: "error", message: res.message };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Commit the save in ONE store update: rebuild model, tokenize, carry gaps,
   *  re-anchor comments FIRST (invariant 7), then set FileState + clear the
   *  session, then refresh() to re-baseline the fingerprint (no stale dot). */
  async function commitSave(
    session: EditSession,
    editRange: { startNewNo: number; endNewNo: number },
    replacementLines: string[],
    nextNewText: string,
  ): Promise<void> {
    const path = session.path;
    const state = get().fileState.get(path);
    if (!state) return;
    const sessionId = get().sessionId;
    const root = get().root;
    const newModel = buildDiffModel(state.oldText ?? "", nextNewText);
    const lang = langForPath(path);
    // Warm highlighter → effectively synchronous; no plain-text flash.
    const newTokens = await tokenizeLines(nextNewText, lang);
    const oldVisible =
      state.model && state.model.kind === "ok"
        ? visibleOldLineNos(
            state.model,
            state.gapState ?? state.model.gaps.map(() => ({ top: 0, bottom: 0 })),
          )
        : new Set<number>();
    const newGapState = newModel.kind === "ok" ? carryGapState(newModel, oldVisible) : [];
    const newLineCount = newModel.kind === "ok" ? newModel.newCount : 0;
    // Re-anchor comments BEFORE the new model becomes visible (invariant 7).
    if (sessionId && root) {
      useSessionsStore.getState().applyDiffEditReanchor(sessionId, path, {
        startNewNo: editRange.startNewNo,
        endNewNo: editRange.endNewNo,
        replacementLines,
        newLineCount,
      });
    }
    // Discard any in-flight tokenization for this file.
    fileGenerations.set(path, (fileGenerations.get(path) ?? 0) + 1);
    const m = new Map(get().fileState);
    const cur = m.get(path) ?? { collapsed: false };
    m.set(path, {
      ...cur,
      ...state,
      status: "ready",
      model: newModel,
      newText: nextNewText,
      newTokens,
      gapState: newGapState,
    });
    justSavedPaths.add(path);
    set({
      fileState: m,
      editSession: null,
      searchRevision: get().searchRevision + 1,
    });
    // Re-baseline the fingerprint so the stale dot stays dark (invariant 10).
    void get().refresh();
  }

  async function doSave(buffers: string[]): Promise<void> {
    const session = get().editSession;
    if (get().commitRange || !session || session.phase === "saving") return;
    const path = session.path;
    const root = get().root;
    const sessionId = get().sessionId;
    if (!root || !sessionId) return;
    const state = get().fileState.get(path);
    if (!state || state.model?.kind !== "ok") return;

    // replacementLines = concat of edit-block buffers (empty buffer → 0 lines).
    const replacementLines: string[] = [];
    let bi = 0;
    for (const block of session.blocks) {
      if (block.kind !== "edit") continue;
      const buf = buffers[bi++] ?? "";
      if (buf === "") continue;
      replacementLines.push(...buf.split("\n"));
    }

    set({ editSession: { ...session, phase: "saving", errorMessage: undefined } });

    const outcome = await tryWrite(
      root,
      path,
      session.baseNewText,
      session.startNewNo,
      session.endNewNo,
      replacementLines,
    );

    if (outcome.kind === "ok") {
      await commitSave(
        session,
        { startNewNo: session.startNewNo, endNewNo: session.endNewNo },
        replacementLines,
        outcome.newText,
      );
      return;
    }
    if (outcome.kind === "error") {
      const cur = get().editSession;
      if (cur) set({ editSession: { ...cur, phase: "error", errorMessage: outcome.message } });
      return;
    }

    // conflict → re-fetch fresh text, re-anchor the original range, retry ONCE.
    const file = get().files.find((f) => f.path === path);
    let freshNewText: string | null = null;
    if (file) {
      try {
        const base =
          get().workingTreeScope === "base" ? (get().selectedBase ?? undefined) : undefined;
        const params: {
          root: string;
          path: string;
          status: import("@shared/git.js").GitFileStatus;
          untracked: boolean;
          binary: boolean;
          oldPath?: string;
          base?: string;
        } = {
          root,
          path: file.path,
          status: file.status,
          untracked: file.untracked,
          binary: file.binary,
        };
        if (file.oldPath) params.oldPath = file.oldPath;
        if (base !== undefined) params.base = base;
        const res = await window.pivis.invoke("git.fileDiff", params);
        if (res.kind === "ok") freshNewText = res.newText;
      } catch {
        freshNewText = null;
      }
    }
    const cur = get().editSession;
    if (!cur) return;
    if (freshNewText === null) {
      set({ editSession: { ...cur, phase: "conflict" } });
      return;
    }
    const loc = findUniqueBlock(freshNewText, session.originalLines);
    if (!loc) {
      set({ editSession: { ...cur, phase: "conflict" } });
      return;
    }
    const freshNext = spliceNewLines(freshNewText, loc.startLine, loc.endLine, replacementLines);
    const freshHash = await sha256Hex(freshNewText);
    let retry: import("@shared/git.js").GitWriteFileResult;
    try {
      retry = await window.pivis.invoke("git.writeWorkingFile", {
        root,
        path,
        content: freshNext,
        expectedHash: freshHash,
      });
    } catch (err) {
      retry = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    const cur2 = get().editSession;
    if (!cur2) return;
    if (retry.kind === "ok") {
      await commitSave(
        session,
        { startNewNo: loc.startLine, endNewNo: loc.endLine },
        replacementLines,
        freshNext,
      );
      return;
    }
    set({
      editSession: {
        ...cur2,
        phase: retry.kind === "conflict" ? "conflict" : "error",
        ...(retry.kind === "error" ? { errorMessage: retry.message } : {}),
      },
    });
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
        badge: {
          root,
          fileCount: res.fileCount,
          insertions: 0,
          deletions: 0,
          truncated: res.truncated,
        },
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
        truncated: res.truncated,
      },
      badgeKind: "ready",
    });
    // The open viewer's per-tool-call refresh doubles as the staleness probe:
    // the dot lights iff the working tree's fingerprint has moved off the
    // baseline captured by the last full viewer refresh. The fingerprint is
    // base-independent, so this holds even for a branch-relative diff, and it
    // can also *clear* a false stale (a reverted edit returns to the baseline).
    const s = get();
    if (s.open && s.commitRange === null) {
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
  historical: boolean,
): void {
  if (res.kind === "not-a-repo" || res.kind === "git-missing") {
    set({
      phase: res.kind,
      errorMessage: null,
      files: [],
      searchFiles: [],
      repoRoot: null,
      truncated: false,
    });
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

  // Freeze + just-saved handling:
  //  - While an edit session is open for file F, F's FileState is reused
  //    verbatim regardless of signature, F's GitChangedFile is kept even if it
  //    drops out of `git.changes`, and `queuedRefresh` is set when F's sig
  //    changed/vanished (flushed on close).
  //  - A path saved in this tick is the change WE just made: reuse its
  //    FileState verbatim (no reload, no stale dot) and clear the mark.
  const frozenPath = get().editSession?.path ?? null;
  const frozenPrevFile = frozenPath ? prevFiles.find((f) => f.path === frozenPath) : undefined;
  let queuedRefresh = false;

  // Reconcile: reuse FileState for files whose signature is unchanged,
  // create idle for new/changed files.
  const fileState = new Map<string, FileState>();
  for (let i = 0; i < res.files.length; i++) {
    const f = res.files[i]!;
    const prev = prevFileState.get(f.path);
    const prevSig = prevSigs.get(f.path);
    const sig = fileSig(f);

    if (f.path === frozenPath && prev) {
      // Frozen: reuse verbatim; flag a queued refresh if the sig moved.
      fileState.set(f.path, prev);
      if (prevSig !== sig) queuedRefresh = true;
    } else if (justSavedPaths.has(f.path) && prev) {
      // Just-saved (we are the change): reuse verbatim.
      fileState.set(f.path, prev);
    } else if (prev && prevSig === sig && prev.status !== "error") {
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
  justSavedPaths.clear();

  // Frozen file vanished from results → keep its previous GitChangedFile AND
  // FileState so the section/card stays mounted (it applies queued changes on
  // close). Without the FileState copy, FileSections falls back to an idle state
  // and ensureFileLoaded immediately returns because the file is frozen, leaving
  // the editor replaced by a permanent Loading… notice.
  let filesOut = res.files;
  let searchFilesOut = res.searchFiles ?? res.files;
  if (frozenPath && frozenPrevFile && !res.files.some((f) => f.path === frozenPath)) {
    filesOut = [...res.files, frozenPrevFile];
    if (!searchFilesOut.some((f) => f.path === frozenPath)) {
      searchFilesOut = [...searchFilesOut, frozenPrevFile].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
    }
    const prevFrozenState = prevFileState.get(frozenPath);
    if (prevFrozenState) fileState.set(frozenPath, prevFrozenState);
    queuedRefresh = true;
  }

  // Carry the queuedRefresh flag onto the open edit session (if any).
  const session = get().editSession;
  if (session && queuedRefresh && !session.queuedRefresh) {
    set({ editSession: { ...session, queuedRefresh: true } });
  }

  set({
    phase: "ready",
    errorMessage: null,
    repoRoot: res.repoRoot,
    files: filesOut,
    searchFiles: searchFilesOut,
    truncated: res.truncated,
    fileState,
    selectedPath: isFirst && res.files.length > 0 ? res.files[0]!.path : get().selectedPath,
    // A full viewer refresh is the user seeing current state: re-baseline the
    // fingerprint and clear staleness. Subsequent badge refreshes compare
    // against this.
    baselineFingerprint: historical ? null : res.fingerprint,
    historicalContext: historical ? (res.historicalContext ?? null) : null,
    stale: false,
  });
}

// ── openDiffForSession ────────────────────────────────────────────────
// The single place that derives a root from a session. When sessions
// become associated with a worktree, this function changes; nothing
// else in the codebase reads `workspacePath` for git purposes.
export function openDiffForSession(sessionId: SessionId): void {
  const session = useSessionsStore.getState().sessions.get(sessionId);
  if (!session || session.worktreeCreating) return;
  const root = gitRootForSession(session);
  if (!root) return;
  useDiffStore.getState().openViewer(sessionId, root);
}

/** sha256 hex of the UTF-8 encoding of `text` — symmetric with main's
 *  `createHash("sha256").update(Buffer.from(current, "utf8"))`, so the CAS
 *  hash the renderer derives from `newText` matches the hash main derives from
 *  the disk file's decoded string. */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  let hex = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
