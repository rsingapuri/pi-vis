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
import { useSettingsStore } from "../../stores/settings-store.js";
import { BaseBranchDropdown } from "./BaseBranchDropdown.js";
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
  const railWidth = useDiffStore((s) => s.railWidth);
  const setRailWidth = useDiffStore((s) => s.setRailWidth);
  const selectedPath = useDiffStore((s) => s.selectedPath);
  const ensureFileLoaded = useDiffStore((s) => s.ensureFileLoaded);
  const refresh = useDiffStore((s) => s.refresh);

  // Branch selection lives in BaseBranchDropdown, which subscribes to the
  // store directly — the host only needs to mount it.

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
  // A full refresh runs on agent_end (turn boundary) and window focus; each
  // re-baselines the working-tree fingerprint and clears staleness. Mid-turn
  // tool calls don't force a disruptive refresh — instead the header's
  // per-tool-call badge refresh recomputes the fingerprint and lights the
  // stale dot (see diff-store doBadgeRefresh).
  const stale = useDiffStore((s) => s.stale);
  useEffect(() => {
    if (!visible) return;
    const unsubEvent = window.pivis.on("session.event", ({ sessionId: sid, event }) => {
      if (sid !== sessionId) return;
      if (event.type === "agent_end") {
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

  // ── Re-tokenize open diff when the color scheme changes ───────────
  // CSS variables don't reach Shiki's baked-in hex tokens, so a scheme
  // switch needs re-tokenization. retokenize() re-runs the highlighter
  // on every ready file in place — no git re-fetch, no flash.
  const colorScheme = useSettingsStore((s) => s.settings.colorScheme);
  const retokenize = useDiffStore((s) => s.retokenize);
  // biome-ignore lint/correctness/useExhaustiveDependencies: we intentionally only re-run on colorScheme; visible is checked inside, retokenize is stable
  useEffect(() => {
    if (!visible) return;
    retokenize();
  }, [colorScheme, visible, retokenize]);

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
      // Defer to the picker when it owns the screen. Extension dialogs
      // no longer block the UI — they live in the Composer slot — so
      // j/k navigation, Escape, etc. should still work in the diff
      // viewer while a question is pending.
      if (document.querySelector(".picker-overlay")) return;
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
          files={files}
          viewMode={viewMode}
          narrow={narrow}
          stale={stale}
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
              railWidth={railWidth}
              setRailWidth={setRailWidth}
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
  files,
  viewMode,
  narrow,
  stale,
  onClose,
  onRefresh,
  onSetViewMode,
}: {
  phase: import("../../stores/diff-store.js").DiffPhase;
  files: GitChangedFile[];
  viewMode: "unified" | "split";
  narrow: boolean;
  stale: boolean;
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
  return (
    <div className="diff-viewer__header">
      <span className="diff-viewer__title">Changes</span>
      <BaseBranchDropdown />
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
        className={`diff-viewer__icon-btn${phase === "loading" ? " diff-viewer__icon-btn--spinning" : ""}`}
        onClick={onRefresh}
        title="Refresh"
        aria-label="Refresh"
      >
        <RefreshIcon />
      </button>
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
    current.insertions += file.insertions;
    current.deletions += file.deletions;
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
      <polyline points="5 3 9 7 5 11" />
    </svg>
  );
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
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        const w = Math.max(160, Math.min(560, ev.clientX - left));
        setRailWidth(w);
      };

      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // Persist width on release.
        const finalWidth = railWidth;
        import("../../stores/settings-store.js").then((mod) =>
          mod.useSettingsStore.getState().update({ diffRailWidth: finalWidth }),
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
      <div className="diff-rail__list" ref={listRef} role="listbox">
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
                  className="diff-tree__row diff-tree__row--dir"
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
                  <span className="diff-tree__dir-label diff-tree__label--truncate-tail">
                    {row.label}
                  </span>
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
                className={`diff-tree__row diff-tree__row--file${isActive ? " diff-tree__row--active" : ""}`}
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
                    <span className="diff-tree__file-stem">{ext || row.label}</span>
                  ) : (
                    <>
                      <span className="diff-tree__file-stem">{stem}</span>
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
      </div>
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
      <path d="M14 8a6 6 0 1 1-6-6c1.7 0 3.3.7 4.5 1.8L14 6" />
      <path d="M14 2v4h-4" />
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
