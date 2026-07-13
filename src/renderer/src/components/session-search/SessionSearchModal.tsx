import type {
  SearchMatchRange,
  SearchTargetId,
  SessionSearchContextResult,
  SessionSearchResult,
} from "@shared/session-search.js";
import type React from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useSessionSearchStore } from "../../stores/session-search-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconChevronLeft, IconClose, IconSearch } from "../common/icons.js";
import "./SessionSearchModal.css";

export const SESSION_SEARCH_FOCUS_EVENT = "pivis:focus-session-search";

interface SessionSearchModalProps {
  /** Must delegate to the normal session-open orchestration. */
  onOpenResult?: (targetId: SearchTargetId) => Promise<undefined | boolean>;
}

function formatTime(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15)
    return "Saved history";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      timestamp,
    );
  } catch {
    return "Saved history";
  }
}

/** Ranges are source offsets, not regexes. Invalid ranges are discarded. */
export function HighlightedText({ text, ranges }: { text: string; ranges: SearchMatchRange[] }) {
  const valid = [...ranges]
    .filter((range) => range.start >= 0 && range.end <= text.length && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const range of valid) {
    if (range.start < cursor) continue;
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <mark key={`${range.start}-${range.end}`} className="session-search__match">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function isReadyContext(
  value: SessionSearchContextResult,
): value is Extract<SessionSearchContextResult, { outcome: "ready" | "relocated" }> {
  return value.outcome === "ready" || value.outcome === "relocated";
}

function ResultOption({
  result,
  selected,
  id,
  onPreview,
}: {
  result: SessionSearchResult;
  selected: boolean;
  id: string;
  onPreview: () => void;
}): React.ReactElement {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={`session-search__result${selected ? " session-search__result--selected" : ""}`}
      onClick={onPreview}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onPreview();
      }}
    >
      <FadeText className="session-search__result-name" title={result.sessionName}>
        {result.sessionName}
      </FadeText>
      <div className="session-search__snippet">
        <HighlightedText text={result.snippet} ranges={result.matchRanges} />
      </div>
      <div className="session-search__metadata">
        <span>{formatTime(result.timestamp)}</span>
        {result.worktreeName && <FadeText>{result.worktreeName}</FadeText>}
      </div>
    </div>
  );
}

function focusableChildren(element: HTMLElement): HTMLElement[] {
  return [
    ...element.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((candidate) => {
    if (candidate.hasAttribute("hidden")) return false;
    for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
      if (node.hasAttribute("hidden")) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (node === element) break;
    }
    return true;
  });
}

export function SessionSearchModal({
  onOpenResult,
}: SessionSearchModalProps): React.ReactElement | null {
  const state = useSessionSearchStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const previewBackRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const resultsPaneRef = useRef<HTMLElement>(null);
  const [resultScrollFades, setResultScrollFades] = useState({ top: false, bottom: false });
  const listboxId = useId();
  const selectedOptionId = state.selectedTargetId
    ? `session-search-result-${state.selectedTargetId}`
    : undefined;
  useEscapeClaim(state.open);

  const close = useCallback(() => {
    const returnFocus = useSessionSearchStore.getState().returnFocus;
    useSessionSearchStore.getState().closeSearch();
    requestAnimationFrame(() => returnFocus?.focus());
  }, []);

  useEffect(() => {
    if (!state.open) return;
    return window.pivis.on("sessionSearch.batch", (batch) => {
      useSessionSearchStore.getState().acceptBatch(batch);
    });
  }, [state.open]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      event.stopPropagation();
      const current = useSessionSearchStore.getState();
      if (current.open) {
        current.setNarrowPane("results");
        current.openSearch(current.workspacePath, current.returnFocus);
        return;
      }
      const workspacePath = useSessionsStore.getState().activeWorkspacePath;
      if (workspacePath) {
        current.openSearch(workspacePath, document.activeElement as HTMLElement | null);
      }
    };
    window.addEventListener("keydown", onShortcut, true);
    return () => window.removeEventListener("keydown", onShortcut, true);
  }, []);

  // focusNonce intentionally retriggers selection for Cmd/Ctrl+Shift+F while open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusNonce is an imperative focus signal
  useEffect(() => {
    if (!state.open || state.narrowPane === "context") return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [state.open, state.focusNonce, state.narrowPane]);

  useEffect(() => {
    if (!state.open || state.narrowPane !== "context") return;
    previewBackRef.current?.focus();
  }, [state.narrowPane, state.open]);

  useEffect(() => {
    if (!state.open || !state.selectedTargetId || state.narrowPane === "context") return;
    document
      .getElementById(`session-search-result-${state.selectedTargetId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [state.open, state.narrowPane, state.selectedTargetId]);

  const updateResultScrollFades = useCallback(() => {
    const pane = resultsPaneRef.current;
    if (!pane) return;
    const next = {
      top: pane.scrollTop > 1,
      bottom: pane.scrollHeight - pane.scrollTop - pane.clientHeight > 1,
    };
    setResultScrollFades((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  }, []);

  useLayoutEffect(() => {
    const pane = resultsPaneRef.current;
    if (!pane) return;
    const observer = new ResizeObserver(updateResultScrollFades);
    observer.observe(pane);
    const content = pane.querySelector(".session-search__results");
    if (content) observer.observe(content);
    updateResultScrollFades();
    return () => observer.disconnect();
  });

  useEffect(() => {
    if (!state.open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (state.narrowPane === "context") {
          state.setNarrowPane("results");
          requestAnimationFrame(() => inputRef.current?.focus());
        } else close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = focusableChildren(dialog);
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close, state]);

  const select = useCallback((targetId: SearchTargetId) => state.selectTarget(targetId), [state]);
  const preview = useCallback((targetId: SearchTargetId) => {
    const store = useSessionSearchStore.getState();
    store.selectTarget(targetId);
    store.setNarrowPane("context");
    void useSessionSearchStore.getState().loadContext(targetId);
  }, []);

  const selectedIndex = useMemo(
    () => state.results.findIndex((result) => result.targetId === state.selectedTargetId),
    [state.results, state.selectedTargetId],
  );
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!state.results.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const index = Math.max(0, Math.min(state.results.length - 1, selectedIndex + delta));
      const target = state.results[index];
      if (target) select(target.targetId);
    } else if (event.key === "Enter" && state.selectedTargetId) {
      event.preventDefault();
      preview(state.selectedTargetId);
    }
  };

  const openSelected = (): void => {
    if (onOpenResult) void state.openSelected(onOpenResult);
  };

  if (!state.open) return null;
  const hasQuery = Boolean(state.query.trim());
  const inPreview = state.narrowPane === "context";
  const context = state.context;
  const contextMatchesSelection =
    context.state === "idle" || context.targetId === state.selectedTargetId;
  const readyContext = context.state === "ready" && contextMatchesSelection ? context.value : null;
  const contextItems = readyContext && isReadyContext(readyContext) ? readyContext.items : [];
  const noWorkspace = !state.workspacePath;
  const workspaceName = state.workspacePath?.split("/").filter(Boolean).at(-1);
  const noResults = hasQuery && !state.loading && state.results.length === 0;
  const selectedResult = state.results.find((result) => result.targetId === state.selectedTargetId);
  const dialogName = workspaceName
    ? `Search sessions in ${workspaceName}`
    : "Search saved sessions";

  return (
    <div
      className="session-search-overlay"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        className={`session-search${!hasQuery ? " session-search--empty" : ""}${inPreview ? " session-search--preview" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={dialogName}
      >
        {!inPreview && (
          <div className="session-search__input-wrap">
            <IconSearch />
            <input
              ref={inputRef}
              type="search"
              role="combobox"
              aria-label="Search saved sessions"
              aria-autocomplete="list"
              aria-expanded={hasQuery && state.results.length > 0}
              aria-controls={hasQuery ? listboxId : undefined}
              aria-activedescendant={hasQuery ? selectedOptionId : undefined}
              value={state.query}
              placeholder="Search"
              disabled={noWorkspace}
              onChange={(event) => state.setQuery(event.currentTarget.value)}
              onCompositionStart={() => state.setComposing(true)}
              onCompositionEnd={(event) => {
                state.setComposing(false);
                state.setQuery(event.currentTarget.value);
              }}
              onKeyDown={onInputKeyDown}
            />
            {state.query && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Clear search"
                onClick={() => state.setQuery("")}
              >
                <IconClose />
              </button>
            )}
          </div>
        )}
        {hasQuery && !inPreview && (
          <section
            ref={resultsPaneRef}
            className={`session-search__results-pane${resultScrollFades.top ? " session-search__results-pane--fade-top" : ""}${resultScrollFades.bottom ? " session-search__results-pane--fade-bottom" : ""}`}
            aria-label="Search results"
            onScroll={updateResultScrollFades}
          >
            {state.error && (
              <div className="session-search__notice session-search__notice--error">
                {state.error}
              </div>
            )}
            {noResults && (
              <div className="session-search__empty">
                {state.done
                  ? "No saved-session matches."
                  : "No matches yet — older sessions are still being indexed."}
              </div>
            )}
            <div
              id={listboxId}
              role="listbox"
              aria-label="Session search results"
              className="session-search__results"
            >
              {state.results.map((result) => (
                <ResultOption
                  key={result.targetId}
                  id={`session-search-result-${result.targetId}`}
                  result={result}
                  selected={result.targetId === state.selectedTargetId}
                  onPreview={() => preview(result.targetId)}
                />
              ))}
            </div>
            {!state.done && state.results.length > 0 && (
              <button
                type="button"
                className="session-search__more"
                disabled={state.loading}
                onClick={() => void state.loadMore()}
              >
                {state.loading ? "Searching…" : "Load more sessions"}
              </button>
            )}
          </section>
        )}
        {inPreview && (
          <section className="session-search__context-pane" aria-label="Saved history context">
            <div className="session-search__context-header">
              <button
                ref={previewBackRef}
                type="button"
                className="icon-btn"
                onClick={() => state.setNarrowPane("results")}
                aria-label="Return to results"
              >
                <IconChevronLeft />
              </button>
              <FadeText className="session-search__preview-name">
                {selectedResult?.sessionName ?? "Saved session"}
              </FadeText>
              {onOpenResult && (
                <button
                  type="button"
                  className="session-search__open"
                  disabled={!state.selectedTargetId || state.openError === "Opening session…"}
                  onClick={openSelected}
                >
                  {state.openError === "Opening session…" ? "Opening…" : "Open session"}
                </button>
              )}
            </div>
            {state.openError && state.openError !== "Opening session…" && (
              <div className="session-search__notice session-search__notice--error">
                {state.openError}
              </div>
            )}
            {(context.state === "idle" || !contextMatchesSelection) && (
              <div className="session-search__empty">Loading saved history…</div>
            )}
            {context.state === "loading" && contextMatchesSelection && (
              <div className="session-search__empty">Loading saved history…</div>
            )}
            {context.state === "error" && contextMatchesSelection && (
              <div className="session-search__notice session-search__notice--error">
                {context.message}
              </div>
            )}
            {readyContext && !isReadyContext(readyContext) && (
              <div className="session-search__notice">{readyContext.message}</div>
            )}
            {readyContext && isReadyContext(readyContext) && (
              <div className="session-search__context-items">
                {readyContext.branchKind === "other-saved-branch" && (
                  <div className="session-search__notice">
                    Other saved branch. Opening the session uses its current saved path.
                  </div>
                )}
                {readyContext.ancestryIncomplete && (
                  <div className="session-search__notice">Some saved history is unavailable.</div>
                )}
                {readyContext.hasEarlier && state.contextBefore < 20 && state.selectedTargetId && (
                  <button
                    type="button"
                    className="session-search__context-more"
                    onClick={() =>
                      void state.loadContext(state.selectedTargetId ?? undefined, {
                        before: state.contextBefore + 8,
                        after: state.contextAfter,
                      })
                    }
                  >
                    Load earlier saved context
                  </button>
                )}
                {contextItems.map((item) => (
                  <article
                    key={`${item.entryId}-${item.contentPartKey}`}
                    className={`session-search__context-item session-search__context-item--${item.role}${item.target ? " session-search__context-item--target" : ""}`}
                  >
                    <div className="session-search__metadata">
                      {item.role.replaceAll("-", " ")} · {formatTime(item.timestamp)}
                    </div>
                    <div>
                      <HighlightedText text={item.text} ranges={item.matchRanges} />
                    </div>
                  </article>
                ))}
                {readyContext.hasLater && state.contextAfter < 20 && state.selectedTargetId && (
                  <button
                    type="button"
                    className="session-search__context-more"
                    onClick={() =>
                      void state.loadContext(state.selectedTargetId ?? undefined, {
                        before: state.contextBefore,
                        after: state.contextAfter + 8,
                      })
                    }
                  >
                    Load later saved context
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** Convenience entry point for workspace buttons that retain their own focus. */
export function openSessionSearch(workspacePath: string, returnFocus: HTMLElement | null): void {
  useSessionSearchStore.getState().openSearch(workspacePath, returnFocus);
}
