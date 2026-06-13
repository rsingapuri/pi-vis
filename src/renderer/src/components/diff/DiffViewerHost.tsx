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
import { useDiffStore } from "../../stores/diff-store.js";
import { DiffFileSection } from "./DiffFileSection.js";
import "./DiffViewer.css";

interface DiffViewerHostProps {
  sessionId: SessionId;
}

const SPLIT_MIN_WIDTH = 880; // px — below this, split view is disabled
const SCROLL_SPY_SUPPRESS_MS = 400;
const EAGER_LOAD_FIRST = 5;

export function DiffViewerHost({ sessionId }: DiffViewerHostProps): React.ReactElement | null {
  const open = useDiffStore((s) => s.open);
  const storeSessionId = useDiffStore((s) => s.sessionId);
  const closeViewer = useDiffStore((s) => s.closeViewer);
  const phase = useDiffStore((s) => s.phase);
  const repoRoot = useDiffStore((s) => s.repoRoot);
  const files = useDiffStore((s) => s.files);
  const truncated = useDiffStore((s) => s.truncated);
  const errorMessage = useDiffStore((s) => s.errorMessage);
  const fileState = useDiffStore((s) => s.fileState);
  const root = useDiffStore((s) => s.root);
  const filter = useDiffStore((s) => s.filter);
  const setFilter = useDiffStore((s) => s.setFilter);
  const viewMode = useDiffStore((s) => s.viewMode);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const select = useDiffStore((s) => s.select);
  const selectedPath = useDiffStore((s) => s.selectedPath);
  const ensureFileLoaded = useDiffStore((s) => s.ensureFileLoaded);
  const refresh = useDiffStore((s) => s.refresh);

  // Only render when the viewer is open *for this session*. A session
  // switch while open closes the viewer.
  const visible = open && storeSessionId === sessionId;

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
  useEffect(() => {
    if (!visible) return;
    const unsubEvent = window.pivis.on("session.event", ({ sessionId: sid, event }) => {
      if (sid === sessionId && event.type === "agent_end") {
        void refresh();
      }
    });
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      unsubEvent();
      window.removeEventListener("focus", onFocus);
    };
  }, [visible, sessionId, refresh]);

  // ── ResizeObserver → split-view auto-fallback ─────────────────────
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);

  // ── Scroll-spy: highlight rail row for the section at scrollTop ──
  const sectionRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const suppressSpyUntilRef = useRef<number>(0);

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
      // Defer to dialogs / pickers when they own the screen.
      if (document.querySelector(".ext-dialog-overlay, .picker-overlay")) return;
      const target = e.target as HTMLElement | null;
      const isInFilter = target?.classList.contains("diff-rail__search-input") ?? false;
      if (e.key === "Escape") {
        if (isInFilter && filter) {
          // Clear filter and consume.
          setFilter("");
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        closeViewer();
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
  }, [visible, closeViewer, files, selectedPath, filter, setFilter, jumpTo]);

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
        // Backdrop click closes (target === overlay, not a child).
        if (e.target === e.currentTarget) closeViewer();
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
          repoRoot={repoRoot}
          root={root}
          files={files}
          viewMode={viewMode}
          narrow={narrow}
          onClose={closeViewer}
          onRefresh={() => void refresh()}
          onSetViewMode={setViewMode}
        />
        {truncated && <div className="diff-viewer__truncated">Showing first 500 changed files</div>}
        <div className="diff-viewer__body">
          {phase === "ready" && (
            <Rail
              files={files}
              filter={filter}
              setFilter={setFilter}
              selectedPath={selectedPath}
              onSelect={jumpTo}
            />
          )}
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
            {phase === "ready" && files.length === 0 && <CleanState />}
            {phase === "ready" && files.length > 0 && (
              <FileSections
                files={files}
                fileState={fileState}
                viewMode={viewMode}
                narrow={narrow}
                registerSection={registerSection}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Header ────────────────────────────────────────────────────────────

function ViewerHeader({
  phase,
  repoRoot,
  root,
  files,
  viewMode,
  narrow,
  onClose,
  onRefresh,
  onSetViewMode,
}: {
  phase: import("../../stores/diff-store.js").DiffPhase;
  repoRoot: string | null;
  root: string | null;
  files: GitChangedFile[];
  viewMode: "unified" | "split";
  narrow: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSetViewMode: (m: "unified" | "split") => void;
}): React.ReactElement {
  // Use the real repoRoot if we have it; otherwise show the input root.
  const chip = repoRoot ?? root ?? "";
  const totals = useMemo(() => {
    let ins = 0;
    let del = 0;
    for (const f of files) {
      ins += f.insertions;
      del += f.deletions;
    }
    return { ins, del, count: files.length };
  }, [files]);
  return (
    <div className="diff-viewer__header">
      <span className="diff-viewer__title">Changes</span>
      <span className="diff-viewer__root-chip" title={chip}>
        {chip || "(no path)"}
      </span>
      <span className="diff-viewer__summary">
        <span>
          {totals.count.toLocaleString()} {totals.count === 1 ? "file" : "files"}
        </span>
        {totals.ins > 0 && (
          <span className="diff-viewer__summary-add">+{totals.ins.toLocaleString()}</span>
        )}
        {totals.del > 0 && (
          <span className="diff-viewer__summary-del">−{totals.del.toLocaleString()}</span>
        )}
      </span>
      <span className="diff-viewer__spacer" />
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
        className={`diff-viewer__icon-btn${phase === "loading" ? " diff-viewer__icon-btn--spinning" : ""}`}
        onClick={onRefresh}
        title="Refresh"
        aria-label="Refresh"
      >
        <RefreshIcon />
      </button>
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
  );
}

// ── Rail ──────────────────────────────────────────────────────────────

function Rail({
  files,
  filter,
  setFilter,
  selectedPath,
  onSelect,
}: {
  files: GitChangedFile[];
  filter: string;
  setFilter: (s: string) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}): React.ReactElement {
  // Filter applies to the rail only; the content keeps all files.
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, filter]);

  // Keep the active rail row visible: scroll it into view when the
  // selection changes (via spy or click).
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedPath) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-path="${cssEscape(selectedPath)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedPath]);

  return (
    <aside className="diff-rail" aria-label="Changed files">
      <div className="diff-rail__search">
        <input
          className="diff-rail__search-input"
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter files"
        />
      </div>
      <div className="diff-rail__list" ref={listRef} role="listbox">
        {filtered.length === 0 ? (
          <div className="diff-rail__empty">No matching files</div>
        ) : (
          filtered.map((f) => (
            <button
              type="button"
              key={f.path}
              data-path={f.path}
              className={`diff-rail__item${f.path === selectedPath ? " diff-rail__item--active" : ""}`}
              onClick={() => onSelect(f.path)}
              role="option"
              aria-selected={f.path === selectedPath}
              title={f.path}
            >
              <span
                className={`diff-status-badge diff-status-badge--${f.status}`}
                title={f.untracked ? "Untracked file" : f.status}
              >
                {f.status}
              </span>
              <RailPath
                path={f.path}
                {...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {})}
                status={f.status}
              />
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
          ))
        )}
      </div>
    </aside>
  );
}

function RailPath({
  path,
  oldPath,
  status,
}: {
  path: string;
  oldPath?: string;
  status: GitChangedFile["status"];
}): React.ReactElement {
  if (status === "R" && oldPath) {
    return (
      <span className="diff-rail__item-path">
        <span className="diff-rail__item-dirname">{oldPath}</span>
        <span className="diff-rail__item-arrow"> → </span>
        <span className="diff-rail__item-basename">{basename(path)}</span>
      </span>
    );
  }
  const slash = path.lastIndexOf("/");
  if (slash === -1) {
    return <span className="diff-rail__item-basename">{path}</span>;
  }
  return (
    <span className="diff-rail__item-path">
      <span className="diff-rail__item-dirname">{path.slice(0, slash + 1)}</span>
      <span className="diff-rail__item-basename">{path.slice(slash + 1)}</span>
    </span>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

// ── File sections container ─────────────────────────────────────────

function FileSections({
  files,
  fileState,
  viewMode,
  narrow,
  registerSection,
}: {
  files: GitChangedFile[];
  fileState: Map<string, import("../../stores/diff-store.js").FileState>;
  viewMode: "unified" | "split";
  narrow: boolean;
  registerSection: (path: string, el: HTMLElement | null) => void;
}): React.ReactElement {
  return (
    <>
      {files.map((f) => {
        const st = fileState.get(f.path) ?? { status: "idle", collapsed: false };
        return (
          <DiffFileSection
            key={f.path}
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

function CleanState(): React.ReactElement {
  return (
    <div className="diff-empty">
      <span className="diff-empty__check" aria-hidden>
        ✓
      </span>
      <span>Working tree clean</span>
      <span className="diff-empty__sub">No changes since HEAD</span>
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
      <path d="M14 8a6 6 0 1 1-1.76-4.24" />
      <polyline points="14 3 14 7 10 7" />
    </svg>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="2" y1="2" x2="10" y2="10" />
      <line x1="10" y1="2" x2="2" y2="10" />
    </svg>
  );
}

// ── Small helpers ────────────────────────────────────────────────────

/** Escape a string for use inside an attribute selector. */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
