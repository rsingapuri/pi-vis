// DiffViewerHost — the modal-style diff viewer overlay.
//
// Owns the lifecycle: focus, keyboard, scroll-spy, IntersectionObserver
// for lazy file loading, and the auto-refresh on agent_end. Renders
// either the file list, the per-file sections, or one of the empty
// states (loading / clean / not-a-repo / git-missing / error).

import type { GitChangedFile } from "@shared/git.js";
import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDiffSearch } from "../../hooks/useDiffSearch.js";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { transcriptPublicationIncludes } from "../../lib/transcript-publication.js";
import { useDiffStore } from "../../stores/diff-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { FadeText } from "../common/FadeText.js";
import { ScrollFadeFrame } from "../common/ScrollFadeFrame.js";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClose,
} from "../common/icons.js";
import { BaseBranchDropdown } from "./BaseBranchDropdown.js";
import { CommitRangePicker } from "./CommitRangePicker.js";
import { DiffEditBubble } from "./DiffEditBubble.js";
import { DiffFileSection } from "./DiffFileSection.js";
import "../common/viewer-header.css";
import "./DiffViewer.css";

interface DiffViewerHostProps {
  sessionId: SessionId;
}

const SPLIT_MIN_WIDTH = 880; // px — below this, split view is disabled
const SCROLL_SPY_SUPPRESS_MS = 400;
const EAGER_LOAD_FIRST = 5;

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".diff-comment-editor")) return true;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(target.type);
}

export function DiffViewerHost({ sessionId }: DiffViewerHostProps): React.ReactElement | null {
  // Claim ESC while the diff viewer is open so a background streaming
  // session isn't aborted (ESC closes the viewer).
  const open = useDiffStore((s) => s.open);
  useEscapeClaim(open);
  const storeSessionId = useDiffStore((s) => s.sessionId);
  const closeViewer = useDiffStore((s) => s.closeViewer);
  const editSession = useDiffStore((s) => s.editSession);
  const requestCancelEdit = useDiffStore((s) => s.requestCancelEdit);
  const phase = useDiffStore((s) => s.phase);
  const files = useDiffStore((s) => s.files);
  const searchFiles = useDiffStore((s) => s.searchFiles);
  const truncated = useDiffStore((s) => s.truncated);
  const errorMessage = useDiffStore((s) => s.errorMessage);
  const fileState = useDiffStore((s) => s.fileState);
  const searchRevision = useDiffStore((s) => s.searchRevision);
  const root = useDiffStore((s) => s.root);
  const filter = useDiffStore((s) => s.filter);
  const setFilter = useDiffStore((s) => s.setFilter);
  const viewMode = useDiffStore((s) => s.viewMode);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const selectedBase = useDiffStore((s) => s.selectedBase);
  const workingTreeScope = useDiffStore((s) => s.workingTreeScope);
  const commitRange = useDiffStore((s) => s.commitRange);
  const historicalContext = useDiffStore((s) => s.historicalContext);
  const historical = commitRange !== null;
  const [narrow, setNarrow] = useState(false);
  const select = useDiffStore((s) => s.select);
  const railWidth = useDiffStore((s) => s.railWidth);
  const setRailWidth = useDiffStore((s) => s.setRailWidth);
  const railVisible = useDiffStore((s) => s.railVisible);
  const toggleRail = useDiffStore((s) => s.toggleRail);
  const selectedPath = useDiffStore((s) => s.selectedPath);
  const ensureFileLoaded = useDiffStore((s) => s.ensureFileLoaded);
  const refresh = useDiffStore((s) => s.refresh);
  const toggleCollapsed = useDiffStore((s) => s.toggleCollapsed);
  const commentsForSession = useSessionsStore((s) => s.diffComments.get(sessionId));
  const markDiffCommentsStaleForMissingFiles = useSessionsStore(
    (s) => s.markDiffCommentsStaleForMissingFiles,
  );

  // ── In-diff find ─────────────────────────────────────────────────
  const searchOpen = useDiffStore((s) => s.search.open);
  const searchQuery = useDiffStore((s) => s.search.query);
  const searchCaseSensitive = useDiffStore((s) => s.search.caseSensitive);
  const activeMatch = useDiffStore((s) => s.search.activeMatch);
  const openSearch = useDiffStore((s) => s.openSearch);
  const closeSearch = useDiffStore((s) => s.closeSearch);
  const setSearchQuery = useDiffStore((s) => s.setSearchQuery);
  const toggleSearchCaseSensitive = useDiffStore((s) => s.toggleSearchCaseSensitive);
  const setActiveMatch = useDiffStore((s) => s.setActiveMatch);

  // Only render when the viewer is open *for this session*. A session switch
  // while open closes the viewer and hard-cancels its worker search.
  const visible = open && storeSessionId === sessionId;
  const effectiveSearchViewMode = viewMode === "split" && !narrow ? "split" : "unified";

  // Gap reveals and inline saves change local search scope/content without
  // replacing the manifest. This primitive revision tracks only those events,
  // so lazy loads, collapse state, and tokenization cannot restart search.
  const searchProjectionKey = String(searchRevision);

  const searchIndex = useDiffSearch({
    enabled: visible && phase === "ready" && searchOpen,
    query: searchQuery,
    caseSensitive: searchCaseSensitive,
    viewMode: effectiveSearchViewMode,
    root,
    base: commitRange !== null || workingTreeScope === "base" ? selectedBase : null,
    range: commitRange,
    historicalContext,
    files: searchFiles,
    projectionKey: searchProjectionKey,
  });
  const activeIndex = searchIndex.indexOfMatch(activeMatch);

  const goToMatch = useCallback(
    (delta: number) => {
      if (searchIndex.count === 0) return;
      const cur = searchIndex.indexOfMatch(activeMatch);
      let next = cur + delta;
      // Partial results never wrap: doing so would falsely imply the current
      // index is complete and can make navigation jump backwards as files land.
      if (next < 0) {
        if (searchIndex.searching) return;
        next = searchIndex.count - 1;
      }
      if (next >= searchIndex.count) {
        if (searchIndex.searching) return;
        next = 0;
      }
      const target = searchIndex.getMatchAt(next);
      if (target) setActiveMatch(target);
    },
    [searchIndex, activeMatch, setActiveMatch],
  );

  // Branch selection lives in BaseBranchDropdown, which subscribes to the
  // store directly — the host only needs to mount it.

  const closeOrCancelEdit = useCallback(() => {
    if (editSession) {
      requestCancelEdit();
      return;
    }
    closeViewer();
  }, [closeViewer, editSession, requestCancelEdit]);

  // ── Session-switch guard ──────────────────────────────────────────
  const lastSessionRef = useRef<SessionId | null>(null);
  useEffect(() => {
    if (!visible) {
      lastSessionRef.current = null;
      return;
    }
    if (lastSessionRef.current !== null && lastSessionRef.current !== sessionId) {
      // Active session changed while we were open. Close.
      closeViewer();
    }
    lastSessionRef.current = sessionId;
  }, [visible, sessionId, closeViewer]);

  // ── Focus + restore ───────────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    previousFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    setTimeout(() => panelRef.current?.focus(), 10);
    return () => {
      const prev = previousFocusRef.current;
      if (prev && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [visible]);

  // ── Auto-refresh on agent_end + window focus ──────────────────────
  // A full refresh runs on agent_end (turn boundary) and window focus; each
  // re-baselines the working-tree fingerprint and clears staleness. Mid-turn
  // tool calls don't force a disruptive refresh — the header's badge scan
  // recomputes the fingerprint and lights the stale dot instead. Runtime
  // hosts publish those events on the sequenced transcript plane; the legacy
  // event listener is retained only for compatibility.
  const stale = useDiffStore((s) => s.stale);
  const refreshing = useDiffStore((s) => s.refreshing);
  useEffect(() => {
    if (!visible || historical) return;
    const unsubEvent = window.pivis.on("session.events", ({ sessionId: sid, events }) => {
      if (sid === sessionId && events.some((event) => event.type === "agent_end")) {
        void refresh();
      }
    });
    const unsubPublication = window.pivis.on("session.publication", (publication) => {
      if (
        publication.sessionId === sessionId &&
        transcriptPublicationIncludes(publication, ["agent_end"])
      ) {
        void refresh();
      }
    });
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      unsubEvent();
      unsubPublication();
      window.removeEventListener("focus", onFocus);
    };
  }, [visible, historical, sessionId, refresh]);

  // ── Keep pending diff-comment anchors checked against current files ─
  // Files with comments are loaded eagerly after refresh so RowsView can
  // reconcile moved/changed line anchors even if the user does not scroll to
  // that file. Comments for files that no longer appear in the diff are marked
  // stale immediately so the prompt metadata never presents them as current.
  useEffect(() => {
    if (
      !visible ||
      historical ||
      phase !== "ready" ||
      !commentsForSession ||
      commentsForSession.size === 0
    ) {
      return;
    }
    const currentPaths = new Set(files.map((f) => f.path));
    markDiffCommentsStaleForMissingFiles(sessionId, currentPaths);
    const commentedPaths = new Set(Array.from(commentsForSession.values(), (c) => c.filePath));
    for (const path of commentedPaths) {
      if (currentPaths.has(path)) void ensureFileLoaded(path);
    }
  }, [
    visible,
    phase,
    files,
    commentsForSession,
    sessionId,
    ensureFileLoaded,
    markDiffCommentsStaleForMissingFiles,
    historical,
  ]);

  // ── Re-tokenize open diff when the color scheme changes ───────────
  // CSS variables don't reach Shiki's baked-in hex tokens, so a scheme
  // switch needs re-tokenization. retokenize() re-runs the highlighter
  // on every ready file in place — no git re-fetch, no flash.
  const activeColorScheme = useSettingsStore((s) => s.activeColorScheme);
  const retokenize = useDiffStore((s) => s.retokenize);
  // biome-ignore lint/correctness/useExhaustiveDependencies: we intentionally only re-run on activeColorScheme; visible is checked inside, retokenize is stable
  useEffect(() => {
    if (!visible) return;
    retokenize();
  }, [activeColorScheme, visible, retokenize]);

  // ── ResizeObserver → split-view auto-fallback ─────────────────────
  const contentRef = useRef<HTMLDivElement | null>(null);

  // ── Scroll-spy: highlight rail row for the section at scrollTop ──
  const sectionRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const suppressSpyUntilRef = useRef<number>(0);

  // ── Find: seed/sync the active logical match ─────────────────────
  // Results arrive progressively from the worker. Preserve a selected match by
  // identity as earlier files complete, but refresh its projection row when the
  // view mode or revealed-gap scope changes.
  useEffect(() => {
    if (!searchOpen || searchQuery === "" || activeMatch !== null) return;
    const first = searchIndex.getMatchAt(0);
    if (first) setActiveMatch(first);
  }, [searchOpen, searchQuery, activeMatch, searchIndex, setActiveMatch]);

  useEffect(() => {
    if (!searchOpen || searchQuery === "" || activeMatch === null) return;
    const index = searchIndex.indexOfMatch(activeMatch);
    if (index < 0) {
      if (!searchIndex.searching) setActiveMatch(null);
      return;
    }
    const current = searchIndex.getMatchAt(index);
    if (
      current &&
      (current.rowIndex !== activeMatch.rowIndex ||
        current.side !== activeMatch.side ||
        current.start !== activeMatch.start ||
        current.end !== activeMatch.end)
    ) {
      setActiveMatch(current);
    }
  }, [searchOpen, searchQuery, activeMatch, searchIndex, setActiveMatch]);

  // ── Find: reveal + scroll the active match into view ─────────────
  // Re-runs on fileState changes so that after the target file loads/expands
  // (and its "current" mark renders) we can find and scroll to it.
  const scrolledIdRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fileState` is a deliberate re-trigger — it isn't read directly (we use getState()), but its identity change after the target file loads/expands is what lets us find and scroll to the now-rendered mark.
  useEffect(() => {
    if (!visible) return;
    if (!activeMatch) {
      scrolledIdRef.current = null;
      return;
    }
    select(activeMatch.path);
    const st = useDiffStore.getState().fileState.get(activeMatch.path);
    if (st?.collapsed) toggleCollapsed(activeMatch.path);
    // Search discovery is uncapped. Never grow the normal browsing prefix to
    // reach a result; DiffFileSection mounts a small targeted row island.
    void ensureFileLoaded(activeMatch.path);
    const scrollKey = `${activeMatch.id}\0${activeMatch.rowIndex}\0${activeMatch.side}\0${effectiveSearchViewMode}`;
    if (scrolledIdRef.current === scrollKey) return;
    suppressSpyUntilRef.current = performance.now() + SCROLL_SPY_SUPPRESS_MS;
    const el = contentRef.current?.querySelector<HTMLElement>(".diff-search-mark--current");
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "auto" });
      scrolledIdRef.current = scrollKey;
    }
  }, [
    visible,
    activeMatch,
    effectiveSearchViewMode,
    fileState,
    select,
    toggleCollapsed,
    ensureFileLoaded,
  ]);

  const jumpTo = useCallback(
    (path: string) => {
      select(path);
      // Expand collapsed file and suppress scroll-spy for
      // 400ms so the click doesn't fight the spy.
      const st = useDiffStore.getState().fileState.get(path);
      if (st?.collapsed) {
        useDiffStore.getState().toggleCollapsed(path);
      }
      suppressSpyUntilRef.current = performance.now() + SCROLL_SPY_SUPPRESS_MS;
      const el = sectionRefs.current.get(path);
      el?.scrollIntoView({ block: "start", behavior: "auto" });
      void ensureFileLoaded(path);
    },
    [select, ensureFileLoaded],
  );

  useLayoutEffect(() => {
    if (!visible) return;
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setNarrow(w < SPLIT_MIN_WIDTH);
    });
    ro.observe(el);
    // Seed with the current width synchronously.
    setNarrow(el.getBoundingClientRect().width < SPLIT_MIN_WIDTH);
    return () => ro.disconnect();
  }, [visible]);

  // ── Window keydown while open ────────────────────────────────────
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      // Defer to the picker when it owns the screen. Extension dialogs
      // no longer block the UI — they live in the Composer slot — so
      // j/k navigation, Escape, etc. should still work in the diff
      // viewer while a question is pending.
      if (document.querySelector(".picker-overlay")) return;
      // These popup controls are nested inside the viewer, so their own
      // Escape handlers run after this window capture listener. Defer before
      // the viewer can consume Escape and close itself.
      if (document.querySelector(".branch-dropdown__dropdown, .commit-range-picker__popup")) return;
      const target = e.target as HTMLElement | null;
      const isInFilter = target?.classList.contains("diff-rail__search-input") ?? false;
      const isInSearch = target?.classList.contains("diff-search__input") ?? false;
      const isInsideViewer = target?.closest(".diff-viewer") != null;
      const isGeneralTextEntry =
        isInsideViewer && isTextEntryTarget(target) && !isInFilter && !isInSearch;
      if (isGeneralTextEntry) return;

      // Cmd/Ctrl+F — open the find bar and focus it (overriding browser find).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openSearch();
        requestAnimationFrame(() => {
          const input = panelRef.current?.querySelector<HTMLInputElement>(".diff-search__input");
          input?.focus();
          input?.select();
        });
        return;
      }

      // Backslash toggles the file-list sidebar (only when not typing in an
      // input, so it can still be entered into the filter / find fields).
      if (
        (e.key === "\\" || e.key === "|") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isInFilter &&
        !isInSearch
      ) {
        e.preventDefault();
        useDiffStore.getState().toggleRail();
        return;
      }

      if (e.key === "Escape") {
        // While an edit session is open, Escape routes to the card's cancel
        // (confirm if dirty) instead of closing the viewer. (The card's own
        // textarea Escape stopPropagation already handles in-editor Esc; this
        // covers Escape while focus is elsewhere.)
        if (useDiffStore.getState().editSession) {
          e.preventDefault();
          useDiffStore.getState().requestCancelEdit();
          return;
        }
        // A visible edit bubble owns this Escape: dismiss it (its own capture
        // listener hides it) without closing the viewer. Fallback for when
        // listener registration order lets this handler run first.
        if (document.querySelector(".diff-edit-bubble")) {
          e.preventDefault();
          return;
        }
        if (isInFilter && filter) {
          // Clear filter and consume.
          setFilter("");
          e.stopPropagation();
          return;
        }
        if (searchOpen) {
          // First Escape closes the find bar, not the whole viewer.
          e.preventDefault();
          closeSearch();
          panelRef.current?.focus();
          return;
        }
        e.preventDefault();
        closeViewer();
        return;
      }

      // In the find bar: Enter / arrows step between matches.
      if (isInSearch) {
        if (e.key === "Enter") {
          e.preventDefault();
          goToMatch(e.shiftKey ? -1 : 1);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          goToMatch(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          goToMatch(-1);
          return;
        }
        return;
      }

      if (isInFilter) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1, files, selectedPath, filter, jumpTo);
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1, files, selectedPath, filter, jumpTo);
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    visible,
    closeViewer,
    files,
    selectedPath,
    filter,
    setFilter,
    jumpTo,
    searchOpen,
    openSearch,
    closeSearch,
    goToMatch,
  ]);

  // ── Lazy loading: IntersectionObserver + first N eager ───────────
  useEffect(() => {
    if (!visible) return;
    if (phase !== "ready") return;
    // Eager load first N files.
    for (let i = 0; i < Math.min(EAGER_LOAD_FIRST, files.length); i++) {
      const f = files[i]!;
      if (useDiffStore.getState().fileState.get(f.path)?.status === "idle") {
        void ensureFileLoaded(f.path);
      }
    }
    const content = contentRef.current;
    if (!content) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const path = (entry.target as HTMLElement).getAttribute("data-path");
            if (path) void ensureFileLoaded(path);
          }
        }
      },
      { root: content, rootMargin: "1200px 0px" },
    );
    const sections = content.querySelectorAll<HTMLElement>(".diff-file[data-path]");
    for (const s of sections) io.observe(s);
    return () => io.disconnect();
  }, [visible, phase, files, ensureFileLoaded]);

  // ── Scroll-spy: highlight rail row for the section at scrollTop ──
  // (declared above so window-keydown can use jumpTo)
  useLayoutEffect(() => {
    if (!visible) return;
    const content = contentRef.current;
    if (!content) return;
    let raf: number | null = null;
    const onScroll = (): void => {
      if (performance.now() < suppressSpyUntilRef.current) return;
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const top = content.scrollTop + 8;
        let bestPath: string | null = null;
        let bestTop = Number.NEGATIVE_INFINITY;
        for (const [path, el] of sectionRefs.current) {
          if (!el) continue;
          const et = el.offsetTop;
          if (et <= top && et > bestTop) {
            bestTop = et;
            bestPath = path;
          }
        }
        if (bestPath && bestPath !== selectedPath) {
          select(bestPath);
        }
      });
    };
    content.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      content.removeEventListener("scroll", onScroll);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [visible, selectedPath, select]);

  const registerSection = useCallback((path: string, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(path, el);
    else sectionRefs.current.delete(path);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="diff-overlay"
      onMouseDown={(e) => {
        // While an edit session is open, a backdrop click routes to the card's
        // cancel (confirm if dirty) instead of closing the viewer.
        if (e.target === e.currentTarget) {
          if (useDiffStore.getState().editSession) {
            useDiffStore.getState().requestCancelEdit();
          } else {
            closeViewer();
          }
        }
      }}
    >
      <div
        className="diff-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="Git changes"
        tabIndex={-1}
        ref={panelRef}
      >
        <ViewerHeader
          phase={phase}
          files={files}
          viewMode={viewMode}
          narrow={narrow}
          stale={stale}
          refreshing={refreshing}
          truncated={truncated}
          searchOpen={searchOpen}
          railVisible={railVisible}
          onToggleRail={toggleRail}
          onToggleSearch={() => {
            if (searchOpen) {
              closeSearch();
            } else {
              openSearch();
              requestAnimationFrame(() => {
                panelRef.current?.querySelector<HTMLInputElement>(".diff-search__input")?.focus();
              });
            }
          }}
          onClose={closeOrCancelEdit}
          onRefresh={() => void refresh()}
          onSetViewMode={setViewMode}
        />
        {truncated && (
          <div className="diff-viewer__truncated">Showing first &gt;499 changed files</div>
        )}
        <div className="diff-viewer__body">
          {phase === "ready" && searchOpen && (
            <DiffSearchBar
              query={searchQuery}
              caseSensitive={searchCaseSensitive}
              count={searchIndex.count}
              activeIndex={activeIndex}
              searching={searchIndex.searching}
              completedFiles={searchIndex.completedFiles}
              totalFiles={searchIndex.totalFiles}
              failedFiles={searchIndex.failedFiles}
              skippedFiles={searchIndex.skippedFiles}
              onQueryChange={setSearchQuery}
              onToggleCase={toggleSearchCaseSensitive}
              onPrev={() => goToMatch(-1)}
              onNext={() => goToMatch(1)}
              onClose={() => {
                closeSearch();
                panelRef.current?.focus();
              }}
            />
          )}
          {phase === "ready" && railVisible && (
            <Rail
              files={files}
              filter={filter}
              setFilter={setFilter}
              selectedPath={selectedPath}
              onSelect={jumpTo}
              railWidth={railWidth}
              setRailWidth={setRailWidth}
            />
          )}
          <div className="diff-content-shell">
            <div
              ref={contentRef}
              className={`diff-content${phase !== "ready" ? " diff-content--empty" : ""}`}
            >
              {phase === "loading" && (
                <div className="diff-empty">
                  <span>Loading changes…</span>
                </div>
              )}
              {phase === "not-a-repo" && <NotARepoState root={root} />}
              {phase === "git-missing" && (
                <div className="diff-empty">git executable not found on PATH</div>
              )}
              {phase === "error" && (
                <ErrorState message={errorMessage} onRetry={() => void refresh()} />
              )}
              {phase === "ready" && files.length === 0 && (
                <CleanState historical={historical} workingTreeScope={workingTreeScope} />
              )}
              {phase === "ready" && files.length > 0 && (
                <FileSections
                  sessionId={sessionId}
                  files={files}
                  searchFiles={searchFiles}
                  activeSearchPath={activeMatch?.path ?? null}
                  fileState={fileState}
                  viewMode={viewMode}
                  narrow={narrow}
                  registerSection={registerSection}
                />
              )}
              {!historical && <DiffEditBubble />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Header ────────────────────────────────────────────────────────────

function ViewerHeader({
  phase,
  files,
  viewMode,
  narrow,
  stale,
  refreshing,
  truncated,
  searchOpen,
  railVisible,
  onToggleRail,
  onToggleSearch,
  onClose,
  onRefresh,
  onSetViewMode,
}: {
  phase: import("../../stores/diff-store.js").DiffPhase;
  files: GitChangedFile[];
  viewMode: "unified" | "split";
  narrow: boolean;
  stale: boolean;
  refreshing: boolean;
  truncated: boolean;
  searchOpen: boolean;
  railVisible: boolean;
  onToggleRail: () => void;
  onToggleSearch: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onSetViewMode: (m: "unified" | "split") => void;
}): React.ReactElement {
  const totals = useMemo(() => {
    let ins = 0;
    let del = 0;
    for (const f of files) {
      ins += f.insertions;
      del += f.deletions;
    }
    return { ins, del, count: files.length };
  }, [files]);
  const refreshSpinning = phase === "loading" || refreshing;
  return (
    <div className="diff-viewer__header viewer-header">
      <div className="viewer-header__left">
        <button
          type="button"
          className={`diff-viewer__icon-btn${railVisible ? " diff-viewer__icon-btn--on" : ""}`}
          onClick={onToggleRail}
          title={`${railVisible ? "Hide" : "Show"} file list (\\)`}
          aria-label={railVisible ? "Hide file list" : "Show file list"}
          aria-pressed={railVisible}
        >
          <SidebarIcon active={railVisible} />
        </button>
        <span className="diff-viewer__title">Changes</span>
        <BaseBranchDropdown />
        <CommitRangePicker />
        <span className="diff-viewer__summary">
          <span>
            {truncated ? `>${(totals.count - 1).toLocaleString()}` : totals.count.toLocaleString()}{" "}
            {totals.count === 1 ? "file" : "files"}
          </span>
          {totals.ins > 0 && (
            <span className="diff-viewer__summary-add">+{totals.ins.toLocaleString()}</span>
          )}
          {totals.del > 0 && (
            <span className="diff-viewer__summary-del">−{totals.del.toLocaleString()}</span>
          )}
        </span>
      </div>
      <div className="viewer-header__right">
        {stale ? (
          <span
            className="diff-viewer__stale-dot"
            role="img"
            aria-label="Changes may be pending refresh"
            title="Changes may be pending refresh"
          />
        ) : null}
        <button
          type="button"
          className={`diff-viewer__icon-btn${refreshSpinning ? " diff-viewer__icon-btn--spinning" : ""}`}
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh"
          aria-busy={refreshSpinning}
        >
          <RefreshIcon />
        </button>
        {phase === "ready" && files.length > 0 && (
          <button
            type="button"
            className={`diff-viewer__icon-btn${searchOpen ? " diff-viewer__icon-btn--on" : ""}`}
            onClick={onToggleSearch}
            title="Find in diff (⌘F)"
            aria-label="Find in diff"
            aria-pressed={searchOpen}
          >
            <SearchIcon />
          </button>
        )}
        <div className="diff-viewer__seg" role="group" aria-label="Diff view mode">
          <button
            type="button"
            className={`diff-viewer__seg-btn${viewMode === "unified" ? " diff-viewer__seg-btn--active" : ""}`}
            onClick={() => onSetViewMode("unified")}
          >
            Unified
          </button>
          <button
            type="button"
            className={`diff-viewer__seg-btn${viewMode === "split" ? " diff-viewer__seg-btn--active" : ""}`}
            onClick={() => onSetViewMode("split")}
            disabled={narrow}
            title={narrow ? "Window too narrow for split view" : undefined}
          >
            Split
          </button>
        </div>
        <button
          type="button"
          className="diff-viewer__icon-btn"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close diff viewer"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

// ── Find bar ──────────────────────────────────────────────────────────

// A floating find widget (top-right of the diff content), modeled on the
// editor "find" affordance: live count, prev/next, case toggle. Highlighting
// of the hits themselves is done by the row renderer (see DiffFileSection);
// this only owns the controls and the query.
function DiffSearchBar({
  query,
  caseSensitive,
  count,
  activeIndex,
  searching,
  completedFiles,
  totalFiles,
  failedFiles,
  skippedFiles,
  onQueryChange,
  onToggleCase,
  onPrev,
  onNext,
  onClose,
}: {
  query: string;
  caseSensitive: boolean;
  count: number;
  activeIndex: number;
  searching: boolean;
  completedFiles: number;
  totalFiles: number;
  failedFiles: number;
  skippedFiles: number;
  onQueryChange: (q: string) => void;
  onToggleCase: () => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus on mount (covers opening via the header button).
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const hasQuery = query.length > 0;
  const noMatches = hasQuery && count === 0 && !searching;
  const hasMatches = count > 0;
  const unavailableFiles = failedFiles + skippedFiles;
  const issueLabel = unavailableFiles > 0 ? ` · ${unavailableFiles} unavailable` : "";
  const countLabel = !hasQuery
    ? ""
    : searching
      ? `${count > 0 ? `${count}+ results` : "Searching…"} · ${completedFiles}/${totalFiles} files`
      : hasMatches
        ? `${activeIndex >= 0 ? activeIndex + 1 : "–"} of ${count}${issueLabel}`
        : `No results${issueLabel}`;

  return (
    <div className="diff-search" role="search">
      <span className="diff-search__icon" aria-hidden>
        <SearchIcon />
      </span>
      <input
        ref={inputRef}
        className="diff-search__input"
        type="text"
        placeholder="Find in diff…"
        value={query}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => onQueryChange(e.target.value)}
        aria-label="Find in diff"
      />
      <span
        className={`diff-search__count${noMatches ? " diff-search__count--empty" : ""}`}
        aria-live="polite"
        title={
          unavailableFiles > 0
            ? `${skippedFiles} binary or too-large; ${failedFiles} failed to search`
            : undefined
        }
      >
        {countLabel}
      </span>
      <div className="diff-search__divider" aria-hidden />
      <button
        type="button"
        className="diff-search__btn"
        onClick={onToggleCase}
        title="Match case"
        aria-label="Match case"
        aria-pressed={caseSensitive}
        data-on={caseSensitive ? "" : undefined}
      >
        <CaseIcon />
      </button>
      <button
        type="button"
        className="diff-search__btn"
        onClick={onPrev}
        disabled={!hasMatches}
        title="Previous match (⇧⏎)"
        aria-label="Previous match"
      >
        <ChevronUpIcon />
      </button>
      <button
        type="button"
        className="diff-search__btn"
        onClick={onNext}
        disabled={!hasMatches}
        title="Next match (⏎)"
        aria-label="Next match"
      >
        <ChevronDownIcon />
      </button>
      <button
        type="button"
        className="diff-search__btn diff-search__btn--close"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close find"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

// ── Rail ──────────────────────────────────────────────────────────────

// ── Tree types ───────────────────────────────────────────────────────

interface DirNode {
  kind: "dir";
  name: string;
  fullPath: string;
  children: (DirNode | FileNode)[];
  insertions: number;
  deletions: number;
}

interface FileNode {
  kind: "file";
  name: string;
  fullPath: string;
  file: GitChangedFile;
  insertions: number;
  deletions: number;
}

type TreeNode = DirNode | FileNode;

interface TreeRow {
  kind: "dir" | "file";
  depth: number;
  label: string;
  dirPath?: string;
  file?: GitChangedFile;
  insertions: number;
  deletions: number;
}

// ── Tree building ────────────────────────────────────────────────────

function buildTree(files: GitChangedFile[]): DirNode {
  const root: DirNode = {
    kind: "dir",
    name: "",
    fullPath: "",
    children: [],
    insertions: 0,
    deletions: 0,
  };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      let child = current.children.find((c): c is DirNode => c.kind === "dir" && c.name === part);
      if (!child) {
        child = {
          kind: "dir",
          name: part,
          fullPath: parts.slice(0, i + 1).join("/"),
          children: [],
          insertions: 0,
          deletions: 0,
        };
        current.children.push(child);
      }
      child.insertions += file.insertions;
      child.deletions += file.deletions;
      current = child;
    }
    current.children.push({
      kind: "file",
      name: parts[parts.length - 1]!,
      fullPath: file.path,
      file,
      insertions: file.insertions,
      deletions: file.deletions,
    });
    // NOTE: do NOT add the file's counts to `current` here. The loop above
    // already accumulates the file's counts into EVERY ancestor directory
    // (including the immediate parent, which is the last dir the loop
    // descends into). Adding again here double-counts the immediate parent
    // — e.g. a dir directly containing a +10 file showed +20. The root's own
    // totals are never displayed (only `root.children` are flattened), so
    // top-level files need no separate accumulation either.
  }

  return root;
}

/**
 * Collapse a single-child directory chain into one label and return
 * the deepest dir node in the chain.
 * E.g. "src/renderer/components" where each intermediate dir has
 * only one dir child becomes one row labeled "src/renderer/components".
 */
function compressDirChain(node: DirNode): { label: string; skip: number; target: DirNode } {
  let current: DirNode = node;
  const parts: string[] = [current.name];
  while (current.children.length === 1 && current.children[0]!.kind === "dir") {
    current = current.children[0] as DirNode;
    parts.push(current.name);
  }
  return { label: parts.join("/"), skip: parts.length - 1, target: current };
}

/**
 * Flatten the tree into an ordered list of visible rows, applying
 * chain compression and honoring collapsed-dir state.
 */
function flattenTree(
  node: TreeNode,
  depth: number,
  collapsedSet: Set<string>,
  filterActive: boolean,
  rows: TreeRow[],
): void {
  if (node.kind === "dir") {
    const { label, skip, target } = compressDirChain(node);
    const collapsed = !filterActive && collapsedSet.has(target.fullPath);
    rows.push({
      kind: "dir",
      depth,
      label,
      dirPath: target.fullPath,
      insertions: node.insertions,
      deletions: node.deletions,
    });
    if (!collapsed) {
      for (const child of target.children) {
        flattenTree(child, depth + 1, collapsedSet, filterActive, rows);
      }
    }
  } else {
    rows.push({
      kind: "file",
      depth,
      label: node.name,
      file: node.file,
      insertions: node.insertions,
      deletions: node.deletions,
    });
  }
}

/**
 * Small SVG chevron arrow for dir collapse/expand.
 * Rotated 90° when expanded via CSS transform.
 */
function ChevronIcon(): React.ReactElement {
  return <IconChevronRight size="12px" />;
}

/**
 * Split a filename into stem + extension for smart truncation.
 */
function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Collect all ancestor dir paths for a given file path.
 */
function ancestorDirs(filePath: string): string[] {
  const parts = filePath.split("/");
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

/**
 * Return the set of matching file paths plus their ancestor dirs when
 * a filter is active.
 */
function filterMatchingPaths(files: GitChangedFile[], query: string): Set<string> {
  const matching = new Set<string>();
  if (!query) return matching;
  const q = query.toLowerCase();
  for (const f of files) {
    if (f.path.toLowerCase().includes(q)) {
      matching.add(f.path);
      for (const d of ancestorDirs(f.path)) {
        matching.add(d);
      }
    }
  }
  return matching;
}

// ── Rail (GitHub-style file tree) ───────────────────────────────────

function Rail({
  files,
  filter,
  setFilter,
  selectedPath,
  onSelect,
  railWidth,
  setRailWidth,
}: {
  files: GitChangedFile[];
  filter: string;
  setFilter: (s: string) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  railWidth: number;
  setRailWidth: (w: number) => void;
}): React.ReactElement {
  const filterActive = filter.trim().length > 0;
  const matchingPaths = useMemo(() => filterMatchingPaths(files, filter.trim()), [files, filter]);

  // Build tree from files.
  const root = useMemo(() => buildTree(files), [files]);

  // Collapsed directory state (keyed by full dir path).
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());

  const toggleCollapsed = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  // Auto-expand ancestors of the selected file so it's never hidden.
  useEffect(() => {
    if (!selectedPath || filterActive) return;
    const ancestors = ancestorDirs(selectedPath);
    setCollapsedDirs((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const d of ancestors) {
        if (next.has(d)) {
          next.delete(d);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedPath, filterActive]);

  // Flatten tree into visible rows.
  const rows = useMemo(() => {
    const result: TreeRow[] = [];
    if (filterActive) {
      // When filtering, force-expand everything and only show matching
      // files plus their ancestor directories.
      const tempCollapsed = new Set<string>();
      for (const child of root.children) flattenTree(child, 0, tempCollapsed, true, result);
      return result.filter((r) => r.kind === "dir" || (r.file && matchingPaths.has(r.file.path)));
    }
    for (const child of root.children) flattenTree(child, 0, collapsedDirs, false, result);
    return result;
  }, [root, collapsedDirs, filterActive, matchingPaths]);

  // Scroll active row into view.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedPath) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-path="${cssEscape(selectedPath)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedPath]);

  // ── Rail drag-resize (mirrors Sidebar pattern) ────────
  const railRef = useRef<HTMLElement | null>(null);
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const rail = railRef.current;
      if (!rail) return;
      const left = rail.getBoundingClientRect().left;
      let latestWidth = railWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        const w = Math.max(160, Math.min(560, ev.clientX - left));
        latestWidth = w;
        setRailWidth(w);
      };

      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // Persist width on release. Use the drag closure's latest value;
        // `railWidth` is the render value from drag start and may be stale.
        import("../../stores/settings-store.js").then((mod) =>
          mod.useSettingsStore.getState().update({ diffRailWidth: latestWidth }),
        );
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setRailWidth, railWidth],
  );

  return (
    <aside
      className="diff-rail"
      aria-label="Changed files"
      ref={railRef}
      style={{ width: railWidth }}
    >
      <div className="diff-rail__search">
        <input
          className="diff-rail__search-input"
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter files"
        />
      </div>
      <ScrollFadeFrame
        frameClassName="diff-rail__list-frame"
        scrollerRef={listRef}
        className="diff-rail__list"
        role="listbox"
        fill
      >
        {rows.length === 0 ? (
          <div className="diff-rail__empty">
            {filterActive ? "No matching files" : "No changed files"}
          </div>
        ) : (
          rows.map((row) => {
            if (row.kind === "dir") {
              const collapsed = !filterActive && collapsedDirs.has(row.dirPath!);
              return (
                <button
                  type="button"
                  key={`dir:${row.dirPath}`}
                  className="diff-tree__row diff-tree__row--dir fade-scope"
                  title={row.dirPath}
                  onClick={() => {
                    if (!filterActive && row.dirPath) {
                      toggleCollapsed(row.dirPath);
                    }
                  }}
                  tabIndex={-1}
                  aria-expanded={!collapsed}
                >
                  {Array.from({ length: row.depth }, (_, i) => {
                    // biome-ignore lint/suspicious/noArrayIndexKey: static indent cells
                    return <span key={i} className="diff-tree__indent-cell" />;
                  })}
                  <span
                    className={`diff-tree__chevron${collapsed ? "" : " diff-tree__chevron--open"}`}
                    aria-hidden
                  >
                    <ChevronIcon />
                  </span>
                  <FadeText head className="diff-tree__dir-label">
                    {row.label}
                  </FadeText>
                  {(row.insertions > 0 || row.deletions > 0) && (
                    <span className="diff-tree__dir-counts">
                      {row.insertions > 0 && (
                        <span className="diff-rail__item-counts-add">+{row.insertions}</span>
                      )}
                      {row.deletions > 0 && (
                        <span className="diff-rail__item-counts-del">−{row.deletions}</span>
                      )}
                    </span>
                  )}
                </button>
              );
            }

            // File row
            const f = row.file!;
            const isActive = f.path === selectedPath;
            const { stem, ext } = splitExt(row.label);
            return (
              <button
                type="button"
                key={f.path}
                data-path={f.path}
                className={`diff-tree__row diff-tree__row--file fade-scope${isActive ? " diff-tree__row--active" : ""}`}
                onClick={() => onSelect(f.path)}
                role="option"
                aria-selected={isActive}
                title={f.status === "R" && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                {Array.from({ length: row.depth }, (_, i) => {
                  // biome-ignore lint/suspicious/noArrayIndexKey: static indent cells
                  return <span key={i} className="diff-tree__indent-cell" />;
                })}
                <span
                  className={`diff-status-badge diff-status-badge--${f.status}`}
                  title={f.untracked ? "Untracked file" : f.status}
                >
                  {f.status}
                </span>
                <span className="diff-tree__file-label">
                  {stem === "" ? (
                    <FadeText className="diff-tree__file-stem">{ext || row.label}</FadeText>
                  ) : (
                    <>
                      <FadeText className="diff-tree__file-stem">{stem}</FadeText>
                      <span className="diff-tree__file-ext">{ext}</span>
                    </>
                  )}
                </span>
                <span className="diff-rail__item-counts">
                  {f.binary ? (
                    <span className="diff-rail__item-counts-bin">BIN</span>
                  ) : (
                    <>
                      {f.insertions > 0 && (
                        <span className="diff-rail__item-counts-add">+{f.insertions}</span>
                      )}
                      {f.deletions > 0 && (
                        <span className="diff-rail__item-counts-del">−{f.deletions}</span>
                      )}
                    </>
                  )}
                </span>
              </button>
            );
          })
        )}
      </ScrollFadeFrame>
      <div className="diff-rail__draghandle" onMouseDown={handleResizeStart} />
    </aside>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

// ── File sections container ─────────────────────────────────────────

function FileSections({
  sessionId,
  files,
  searchFiles,
  activeSearchPath,
  fileState,
  viewMode,
  narrow,
  registerSection,
}: {
  sessionId: SessionId;
  files: GitChangedFile[];
  searchFiles: GitChangedFile[];
  activeSearchPath: string | null;
  fileState: Map<string, import("../../stores/diff-store.js").FileState>;
  viewMode: "unified" | "split";
  narrow: boolean;
  registerSection: (path: string, el: HTMLElement | null) => void;
}): React.ReactElement {
  // The normal section list stays capped, but search covers the complete
  // manifest. Mount exactly one extra section when navigation targets a file
  // beyond the browsing cap.
  const activeSearchFile =
    activeSearchPath !== null && !files.some((file) => file.path === activeSearchPath)
      ? searchFiles.find((file) => file.path === activeSearchPath)
      : undefined;
  const renderedFiles = activeSearchFile ? [...files, activeSearchFile] : files;
  return (
    <>
      {renderedFiles.map((f) => {
        const st = fileState.get(f.path) ?? { status: "idle", collapsed: false };
        return (
          <DiffFileSection
            key={f.path}
            sessionId={sessionId}
            file={f}
            state={st}
            viewMode={viewMode}
            narrowWindow={narrow}
            active={false}
            sectionRef={(el) => registerSection(f.path, el)}
          />
        );
      })}
    </>
  );
}

// ── Empty / error states ─────────────────────────────────────────────

function CleanState({
  historical = false,
  workingTreeScope = "base",
}: {
  historical?: boolean;
  workingTreeScope?: "base" | "uncommitted";
}): React.ReactElement {
  return (
    <div className="diff-empty">
      <span className="diff-empty__check" aria-hidden>
        <IconCheck />
      </span>
      <span>
        {historical
          ? "No changes in selected range"
          : workingTreeScope === "uncommitted"
            ? "No uncommitted changes"
            : "Working tree clean"}
      </span>
      {!historical && <span className="diff-empty__sub">No changes since HEAD</span>}
    </div>
  );
}

function NotARepoState({ root }: { root: string | null }): React.ReactElement {
  return (
    <div className="diff-empty">
      <span>Not a git repository</span>
      {root && <span className="diff-empty__path">{root}</span>}
      <span className="diff-empty__sub">Initialize a repository to track changes.</span>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <div className="diff-empty">
      <span>Couldn't read changes</span>
      {message && <span className="diff-empty__path">{message}</span>}
      <button type="button" className="diff-empty__retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

// ── Keyboard nav ─────────────────────────────────────────────────────

function moveSelection(
  delta: number,
  files: GitChangedFile[],
  selected: string | null,
  filter: string,
  jumpTo: (p: string) => void,
): void {
  const q = filter.trim().toLowerCase();
  const list = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  if (list.length === 0) return;
  const idx = selected ? list.findIndex((f) => f.path === selected) : -1;
  let next = idx + delta;
  if (next < 0) next = 0;
  if (next > list.length - 1) next = list.length - 1;
  const target = list[next];
  if (target) jumpTo(target.path);
}

// ── Icons (inline SVGs; no library) ─────────────────────────────────

function SidebarIcon({ active }: { active: boolean }): React.ReactElement {
  // A two-pane sidebar glyph. When active (rail visible) the left pane is
  // emphasized; when hidden, the glyph is hollow so the button reads as
  // "collapsed / click to show".
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6" y1="3" x2="6" y2="13" />
      {active ? (
        <rect x="2.5" y="3.5" width="3" height="9" rx="0.5" fill="currentColor" stroke="none" />
      ) : null}
    </svg>
  );
}

function RefreshIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 8a6 6 0 1 1-6-6c1.7 0 3.3.7 4.5 1.8L14 6" />
      <path d="M14 2v4h-4" />
    </svg>
  );
}

function SearchIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.5" y1="10.5" x2="14" y2="14" />
    </svg>
  );
}

function CaseIcon(): React.ReactElement {
  // A compact "Aa" glyph; the active state is conveyed by the button styling.
  return (
    <svg width="16" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
      <text
        x="9"
        y="11"
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        fontFamily="var(--font-display)"
      >
        Aa
      </text>
    </svg>
  );
}

function ChevronUpIcon(): React.ReactElement {
  return <IconChevronUp size="12px" />;
}

function ChevronDownIcon(): React.ReactElement {
  return <IconChevronDown size="12px" />;
}

function CloseIcon(): React.ReactElement {
  return <IconClose size="12px" />;
}

// ── Small helpers ────────────────────────────────────────────────────

/** Escape a string for use inside an attribute selector. */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
