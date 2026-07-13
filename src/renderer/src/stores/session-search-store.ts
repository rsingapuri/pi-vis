import type {
  SearchId,
  SearchTargetId,
  SessionSearchBatch,
  SessionSearchContextResult,
  SessionSearchCoverage,
  SessionSearchResult,
} from "@shared/session-search.js";
import { create } from "zustand";
import { RENDERER_GENERATION } from "../lib/renderer-generation.js";

const SEARCH_DEBOUNCE_MS = 120;

export type SessionSearchContextState =
  | { state: "idle" }
  | { state: "loading"; targetId: SearchTargetId }
  | { state: "ready"; targetId: SearchTargetId; value: SessionSearchContextResult }
  | { state: "error"; targetId: SearchTargetId; message: string };

export interface SessionSearchStore {
  open: boolean;
  workspacePath: string | null;
  returnFocus: HTMLElement | null;
  query: string;
  composing: boolean;
  /** Bumped on every query and close; fences all async work for this modal. */
  queryGeneration: number;
  clientQueryId: string | null;
  searchId: SearchId | null;
  results: SessionSearchResult[];
  selectedTargetId: SearchTargetId | null;
  context: SessionSearchContextState;
  contextBefore: number;
  contextAfter: number;
  coverage: SessionSearchCoverage | null;
  count: { value: number; exact: boolean } | null;
  done: boolean;
  loading: boolean;
  error: string | null;
  openError: string | null;
  narrowPane: "results" | "context";
  /** Lets a repeated global shortcut re-focus and select the input. */
  focusNonce: number;
  lastSequence: number;
  indexRevision: number;

  openSearch: (workspacePath: string | null, returnFocus?: HTMLElement | null) => void;
  closeSearch: () => void;
  setQuery: (query: string) => void;
  setComposing: (composing: boolean) => void;
  startSearchNow: () => Promise<void>;
  acceptBatch: (batch: SessionSearchBatch) => void;
  selectTarget: (targetId: SearchTargetId | null) => void;
  loadContext: (
    targetId?: SearchTargetId,
    window?: { before: number; after: number },
  ) => Promise<void>;
  expandSession: (targetId: SearchTargetId) => Promise<void>;
  loadMore: () => Promise<void>;
  rebuild: () => Promise<void>;
  setNarrowPane: (pane: "results" | "context") => void;
  openSelected: (
    openResult: (targetId: SearchTargetId) => Promise<undefined | boolean>,
  ) => Promise<boolean>;
}

let debounce: ReturnType<typeof setTimeout> | null = null;
let clientCounter = 0;

function emptySearchState(): Pick<
  SessionSearchStore,
  | "query"
  | "composing"
  | "clientQueryId"
  | "searchId"
  | "results"
  | "selectedTargetId"
  | "context"
  | "contextBefore"
  | "contextAfter"
  | "coverage"
  | "count"
  | "done"
  | "loading"
  | "error"
  | "openError"
  | "narrowPane"
  | "lastSequence"
  | "indexRevision"
> {
  return {
    query: "",
    composing: false,
    clientQueryId: null,
    searchId: null,
    results: [],
    selectedTargetId: null,
    context: { state: "idle" },
    contextBefore: 4,
    contextAfter: 4,
    coverage: null,
    count: null,
    done: false,
    loading: false,
    error: null,
    openError: null,
    narrowPane: "results",
    lastSequence: -1,
    indexRevision: 0,
  };
}

function cancelSearch(searchId: SearchId | null): void {
  if (!searchId) return;
  void window.pivis
    .invoke("sessionSearch.cancel", { rendererGeneration: RENDERER_GENERATION, searchId })
    .catch(() => {});
}

function schedule(get: () => SessionSearchStore): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void get().startSearchNow();
  }, SEARCH_DEBOUNCE_MS);
}

export const useSessionSearchStore = create<SessionSearchStore>((set, get) => ({
  open: false,
  workspacePath: null,
  returnFocus: null,
  queryGeneration: 0,
  focusNonce: 0,
  ...emptySearchState(),

  openSearch: (workspacePath, returnFocus = null) => {
    const current = get();
    if (current.open && current.workspacePath === workspacePath) {
      set({
        returnFocus: returnFocus ?? current.returnFocus,
        focusNonce: current.focusNonce + 1,
      });
      return;
    }
    if (current.open) cancelSearch(current.searchId);
    set({
      open: true,
      workspacePath,
      returnFocus,
      queryGeneration: current.queryGeneration + 1,
      focusNonce: current.focusNonce + 1,
      ...emptySearchState(),
    });
  },

  closeSearch: () => {
    const current = get();
    if (debounce !== null) {
      clearTimeout(debounce);
      debounce = null;
    }
    cancelSearch(current.searchId);
    set({
      open: false,
      workspacePath: null,
      returnFocus: null,
      queryGeneration: current.queryGeneration + 1,
      ...emptySearchState(),
    });
  },

  setQuery: (query) => {
    const current = get();
    if (!current.open) return;
    if (debounce !== null) {
      clearTimeout(debounce);
      debounce = null;
    }
    // A replacement query invalidates both results and context immediately;
    // the outgoing query is cancelled before its successor can be started.
    cancelSearch(current.searchId);
    const nextGeneration = current.queryGeneration + 1;
    set({
      query,
      queryGeneration: nextGeneration,
      clientQueryId: null,
      searchId: null,
      results: [],
      selectedTargetId: null,
      context: { state: "idle" },
      coverage: null,
      count: null,
      done: false,
      loading: query.trim().length > 0 && !current.composing,
      error: null,
      openError: null,
      narrowPane: "results",
      lastSequence: -1,
    });
    if (query.trim() && !current.composing) schedule(get);
  },

  setComposing: (composing) => {
    const current = get();
    if (current.composing === composing) return;
    set({ composing });
    if (composing) {
      if (debounce !== null) {
        clearTimeout(debounce);
        debounce = null;
      }
      return;
    }
    if (get().query.trim()) schedule(get);
  },

  startSearchNow: async () => {
    const current = get();
    if (!current.open || current.composing || !current.workspacePath || !current.query.trim())
      return;
    const generation = current.queryGeneration;
    const clientQueryId = `renderer-${RENDERER_GENERATION}-${++clientCounter}`;
    // Cancel just before dispatch too: this covers a pending debounce whose
    // predecessor became active after `setQuery` ran.
    cancelSearch(current.searchId);
    set({
      clientQueryId,
      searchId: null,
      results: [],
      selectedTargetId: null,
      context: { state: "idle" },
      coverage: null,
      count: null,
      done: false,
      loading: true,
      error: null,
      lastSequence: -1,
    });
    try {
      const response = await window.pivis.invoke("sessionSearch.start", {
        rendererGeneration: RENDERER_GENERATION,
        clientQueryId,
        workspacePath: current.workspacePath,
        query: current.query,
        pageSize: 50,
      });
      const latest = get();
      if (
        !latest.open ||
        latest.queryGeneration !== generation ||
        latest.clientQueryId !== clientQueryId
      ) {
        if (response.accepted) cancelSearch(response.searchId);
        return;
      }
      set({ searchId: response.searchId });
    } catch (error) {
      const latest = get();
      if (
        latest.open &&
        latest.queryGeneration === generation &&
        latest.clientQueryId === clientQueryId
      ) {
        set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  },

  acceptBatch: (batch) => {
    const current = get();
    if (
      !current.open ||
      batch.rendererGeneration !== RENDERER_GENERATION ||
      batch.clientQueryId !== current.clientQueryId ||
      batch.searchId !== current.searchId ||
      batch.sequence <= current.lastSequence
    ) {
      return;
    }
    const results =
      batch.disposition === "replace" ? [...batch.results] : [...current.results, ...batch.results];
    const selectedTargetId =
      current.selectedTargetId &&
      results.some((result) => result.targetId === current.selectedTargetId)
        ? current.selectedTargetId
        : (results[0]?.targetId ?? null);
    const selectionChanged = selectedTargetId !== current.selectedTargetId;
    set({
      results,
      selectedTargetId,
      ...(selectionChanged
        ? { context: { state: "idle" } as const, contextBefore: 4, contextAfter: 4 }
        : {}),
      coverage: { ...batch.coverage },
      count: { ...batch.count },
      done: batch.done,
      // `done` means cursor/catalog exhaustion, not request-in-flight. This
      // batch completed the current page request even when more pages remain.
      loading: false,
      error: batch.error ?? null,
      lastSequence: batch.sequence,
      indexRevision: batch.indexRevision,
    });
  },

  selectTarget: (targetId) => {
    const current = get();
    if (targetId !== null && !current.results.some((result) => result.targetId === targetId))
      return;
    set({
      selectedTargetId: targetId,
      context: targetId === current.selectedTargetId ? current.context : { state: "idle" },
      ...(targetId === current.selectedTargetId ? {} : { contextBefore: 4, contextAfter: 4 }),
      openError: null,
    });
  },

  loadContext: async (requestedTargetId, requestedWindow) => {
    const current = get();
    const targetId = requestedTargetId ?? current.selectedTargetId;
    if (!current.open || !targetId || !current.searchId) return;
    if (!current.results.some((candidate) => candidate.targetId === targetId)) return;
    const queryGeneration = current.queryGeneration;
    const searchId = current.searchId;
    const before = Math.min(20, Math.max(0, requestedWindow?.before ?? current.contextBefore));
    const after = Math.min(20, Math.max(0, requestedWindow?.after ?? current.contextAfter));
    set({
      context: { state: "loading", targetId },
      contextBefore: before,
      contextAfter: after,
      openError: null,
    });
    try {
      const value = await window.pivis.invoke("sessionSearch.context", {
        rendererGeneration: RENDERER_GENERATION,
        searchId,
        targetId,
        indexRevision: current.indexRevision,
        before,
        after,
      });
      const latest = get();
      if (
        !latest.open ||
        latest.queryGeneration !== queryGeneration ||
        latest.searchId !== searchId ||
        latest.selectedTargetId !== targetId
      ) {
        return;
      }
      set({ context: { state: "ready", targetId, value } });
    } catch (error) {
      const latest = get();
      if (
        latest.open &&
        latest.queryGeneration === queryGeneration &&
        latest.searchId === searchId &&
        latest.selectedTargetId === targetId
      ) {
        set({
          context: {
            state: "error",
            targetId,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  },

  expandSession: async (targetId) => {
    const current = get();
    if (!current.open || !current.searchId) return;
    if (!current.results.some((result) => result.targetId === targetId)) return;
    try {
      const response = await window.pivis.invoke("sessionSearch.expand", {
        rendererGeneration: RENDERER_GENERATION,
        searchId: current.searchId,
        targetId,
      });
      if (!response.accepted && get().searchId === current.searchId) {
        set({ error: "These additional matches are no longer available." });
      }
    } catch (error) {
      if (get().searchId === current.searchId) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  },

  loadMore: async () => {
    const current = get();
    if (!current.open || !current.searchId || current.loading || current.done) return;
    set({ loading: true });
    try {
      const response = await window.pivis.invoke("sessionSearch.more", {
        rendererGeneration: RENDERER_GENERATION,
        searchId: current.searchId,
      });
      if (!response.accepted && get().searchId === current.searchId) set({ loading: false });
    } catch (error) {
      if (get().searchId === current.searchId) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },

  rebuild: async () => {
    const current = get();
    const workspacePath = current.workspacePath;
    const queryGeneration = current.queryGeneration;
    if (!current.open || !workspacePath) return;
    set({ loading: true, error: null });
    try {
      const status = await window.pivis.invoke("sessionSearch.rebuild", {
        rendererGeneration: RENDERER_GENERATION,
        workspacePath,
      });
      const latest = get();
      if (
        !latest.open ||
        latest.queryGeneration !== queryGeneration ||
        latest.workspacePath !== workspacePath
      ) {
        return;
      }
      if (status.state === "failed" || status.state === "unavailable") {
        set({ loading: false, error: status.message ?? "Session search is unavailable." });
      }
    } catch (error) {
      const latest = get();
      if (
        latest.open &&
        latest.queryGeneration === queryGeneration &&
        latest.workspacePath === workspacePath
      ) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },

  setNarrowPane: (narrowPane) => set({ narrowPane }),

  openSelected: async (openResult) => {
    const current = get();
    const targetId = current.selectedTargetId;
    const queryGeneration = current.queryGeneration;
    const workspacePath = current.workspacePath;
    if (!current.open || !workspacePath || !targetId || current.openError === "Opening session…")
      return false;
    set({ openError: "Opening session…" });
    const isCurrentOpen = (): boolean => {
      const latest = get();
      return (
        latest.open &&
        latest.queryGeneration === queryGeneration &&
        latest.workspacePath === workspacePath &&
        latest.selectedTargetId === targetId &&
        latest.results.some((result) => result.targetId === targetId)
      );
    };
    try {
      const result = await openResult(targetId);
      if (!isCurrentOpen()) return false;
      if (result === false) {
        set({ openError: "Could not open this session." });
        return false;
      }
      // Only the same modal instance and still-selected capability may close.
      get().closeSearch();
      return true;
    } catch (error) {
      if (isCurrentOpen()) {
        set({ openError: error instanceof Error ? error.message : "Could not open this session." });
      }
      return false;
    }
  },
}));

export const SESSION_SEARCH_DEBOUNCE_MS = SEARCH_DEBOUNCE_MS;
