// @vitest-environment jsdom
import type { SearchId, SearchTargetId, SessionSearchBatch } from "@shared/session-search.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RENDERER_GENERATION } from "../lib/renderer-generation.js";
import { SESSION_SEARCH_DEBOUNCE_MS, useSessionSearchStore } from "./session-search-store.js";

const SEARCH_ID = "search-identifier-0001" as SearchId;
const TARGET_A = "target-identifier-0001" as SearchTargetId;
const TARGET_B = "target-identifier-0002" as SearchTargetId;

const invoke = vi.fn();

function result(targetId: SearchTargetId) {
  return {
    targetId,
    sessionName: `Session ${targetId.slice(-1)}`,
    role: "user" as const,
    timestamp: null,
    snippet: "matching source text",
    matchRanges: [{ start: 0, end: 8 }],
    branchKind: "latest-persisted-path" as const,
    sourceRevision: "revision",
    additionalMatches: 0,
  };
}

function batch(
  clientQueryId: string,
  overrides: Partial<SessionSearchBatch> = {},
): SessionSearchBatch {
  return {
    rendererGeneration: RENDERER_GENERATION,
    clientQueryId,
    searchId: SEARCH_ID,
    sequence: 0,
    indexRevision: 4,
    disposition: "replace",
    results: [result(TARGET_A)],
    count: { value: 1, exact: true },
    coverage: { indexedSources: 1, totalSources: 1, skippedSources: 0 },
    done: true,
    ...overrides,
  };
}

describe("session search store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sessionSearch.start")
        return Promise.resolve({ accepted: true, searchId: SEARCH_ID });
      if (channel === "sessionSearch.context")
        return Promise.resolve({ outcome: "unavailable", message: "gone" });
      if (channel === "sessionSearch.expand") return Promise.resolve({ accepted: true });
      return Promise.resolve(undefined);
    });
    Object.defineProperty(window, "pivis", {
      configurable: true,
      value: { invoke, on: vi.fn(() => vi.fn()), getPathForFile: vi.fn() },
    });
    useSessionSearchStore.getState().closeSearch();
  });

  afterEach(() => vi.useRealTimers());

  it("debounces input and cancels the predecessor before starting", async () => {
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    store.setQuery("first");
    store.setQuery("second");
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS - 1);
    expect(invoke).not.toHaveBeenCalledWith("sessionSearch.start", expect.anything());
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledWith(
      "sessionSearch.start",
      expect.objectContaining({ query: "second" }),
    );
  });

  it("suppresses IME dispatch and fences late batches", async () => {
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    store.setComposing(true);
    store.setQuery("日本語");
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS * 2);
    expect(invoke).not.toHaveBeenCalledWith("sessionSearch.start", expect.anything());
    store.setComposing(false);
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
    const client = useSessionSearchStore.getState().clientQueryId!;
    await Promise.resolve();
    store.acceptBatch(batch("old-client"));
    expect(useSessionSearchStore.getState().results).toEqual([]);
    store.acceptBatch(batch(client));
    expect(useSessionSearchStore.getState().results).toHaveLength(1);
  });

  it("enables and appends pagination when the first page is not exhausted", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "sessionSearch.start")
        return Promise.resolve({ accepted: true, searchId: SEARCH_ID });
      if (channel === "sessionSearch.more") return Promise.resolve({ accepted: true });
      return Promise.resolve(undefined);
    });
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    store.setQuery("many matches");
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
    const client = useSessionSearchStore.getState().clientQueryId!;
    store.acceptBatch(
      batch(client, {
        done: false,
        count: { value: 60, exact: true },
        results: [result(TARGET_A)],
      }),
    );
    expect(useSessionSearchStore.getState().loading).toBe(false);

    const more = store.loadMore();
    expect(invoke).toHaveBeenCalledWith("sessionSearch.more", {
      rendererGeneration: RENDERER_GENERATION,
      searchId: SEARCH_ID,
    });
    await more;
    expect(useSessionSearchStore.getState().loading).toBe(true);
    store.acceptBatch(
      batch(client, {
        sequence: 1,
        disposition: "append",
        results: [result(TARGET_B)],
        done: true,
      }),
    );
    expect(useSessionSearchStore.getState().results.map((item) => item.targetId)).toEqual([
      TARGET_A,
      TARGET_B,
    ]);
    expect(useSessionSearchStore.getState().loading).toBe(false);
  });

  it("preserves a selected target across progressive reordering and fences context", async () => {
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    store.setQuery("match");
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
    const client = useSessionSearchStore.getState().clientQueryId!;
    store.acceptBatch(batch(client, { results: [result(TARGET_A), result(TARGET_B)] }));
    store.selectTarget(TARGET_B);
    store.acceptBatch(
      batch(client, { sequence: 1, results: [result(TARGET_B), result(TARGET_A)] }),
    );
    expect(useSessionSearchStore.getState().selectedTargetId).toBe(TARGET_B);

    let resolveContext!: (value: { outcome: "unavailable"; message: string }) => void;
    invoke.mockImplementation((channel: string) =>
      channel === "sessionSearch.context"
        ? new Promise((resolve) => {
            resolveContext = resolve;
          })
        : Promise.resolve(undefined),
    );
    const loading = store.loadContext(TARGET_B);
    store.setQuery("replacement");
    resolveContext({ outcome: "unavailable", message: "late" });
    await loading;
    expect(useSessionSearchStore.getState().context).toEqual({ state: "idle" });
  });

  it("clears stale context immediately when replacement removes the selection", async () => {
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    store.setQuery("match");
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
    const client = useSessionSearchStore.getState().clientQueryId!;
    store.acceptBatch(batch(client, { results: [result(TARGET_A), result(TARGET_B)] }));
    store.selectTarget(TARGET_B);
    await store.loadContext(TARGET_B);
    expect(useSessionSearchStore.getState().context).toMatchObject({
      state: "ready",
      targetId: TARGET_B,
    });

    store.acceptBatch(batch(client, { sequence: 1, results: [result(TARGET_A)] }));

    expect(useSessionSearchStore.getState()).toMatchObject({
      selectedTargetId: TARGET_A,
      context: { state: "idle" },
      contextBefore: 4,
      contextAfter: 4,
    });
  });

  it("expands through an owned opaque target and retains the modal on open failure", async () => {
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    store.setQuery("match");
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
    const client = useSessionSearchStore.getState().clientQueryId!;
    store.acceptBatch(batch(client));

    await store.expandSession(TARGET_A);
    expect(invoke).toHaveBeenCalledWith("sessionSearch.expand", {
      rendererGeneration: RENDERER_GENERATION,
      searchId: SEARCH_ID,
      targetId: TARGET_A,
    });

    await expect(store.openSelected(async () => false)).resolves.toBe(false);
    expect(useSessionSearchStore.getState().open).toBe(true);
    expect(useSessionSearchStore.getState().openError).toBe("Could not open this session.");
  });

  it("does not request context merely because a batch selects its first result", async () => {
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    store.setQuery("match");
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
    const client = useSessionSearchStore.getState().clientQueryId!;
    store.acceptBatch(batch(client));
    expect(useSessionSearchStore.getState().selectedTargetId).toBe(TARGET_A);
    expect(invoke).not.toHaveBeenCalledWith("sessionSearch.context", expect.anything());
  });

  it("drops a rebuild failure after its modal generation closes", async () => {
    let resolveRebuild!: (value: { state: "failed"; message: string }) => void;
    invoke.mockImplementation((channel: string) => {
      if (channel === "sessionSearch.rebuild") {
        return new Promise((resolve) => {
          resolveRebuild = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    const rebuilding = store.rebuild();
    store.closeSearch();
    resolveRebuild({ state: "failed", message: "stale failure" });
    await rebuilding;
    expect(useSessionSearchStore.getState()).toMatchObject({ open: false, error: null });
  });

  it("does not let a stale open callback close a newly selected target", async () => {
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace");
    store.setQuery("match");
    await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
    const client = useSessionSearchStore.getState().clientQueryId!;
    store.acceptBatch(batch(client, { results: [result(TARGET_A), result(TARGET_B)] }));
    let resolveOpen!: (value: undefined) => void;
    const opening = store.openSelected(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    store.selectTarget(TARGET_B);
    resolveOpen(undefined);
    await expect(opening).resolves.toBe(false);
    expect(useSessionSearchStore.getState()).toMatchObject({
      open: true,
      selectedTargetId: TARGET_B,
      openError: null,
    });
  });

  it("clears query, results, context, and focus reference on close", () => {
    const node = document.createElement("button");
    const store = useSessionSearchStore.getState();
    store.openSearch("/workspace", node);
    store.setQuery("private query");
    store.closeSearch();
    const state = useSessionSearchStore.getState();
    expect(state.open).toBe(false);
    expect(state.query).toBe("");
    expect(state.results).toEqual([]);
    expect(state.context).toEqual({ state: "idle" });
    expect(state.returnFocus).toBeNull();
  });
});
