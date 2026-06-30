/**
 * TreeViewerHost — modal-style overlay for the conversation-tree navigator.
 *
 * Shares DiffViewerHost's modal semantics exactly (same `.app`-child overlay,
 * dimensions, scrim, elevation, open animation, backdrop-click-to-close, focus
 * save/restore, session-switch guard, ESC claim). The list itself is a port of
 * pi's TUI tree-selector: a FLAT list, keyboard-driven filters (no button bar),
 * and branch-only indentation (a linear conversation is flat). See
 * `tree-flatten.ts` for the flattening + filter parity.
 */
import type { SessionId } from "@shared/ids.js";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { cssEscape } from "../../lib/format.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { type TreeFilterMode, isTreeUnsupported, useTreeStore } from "../../stores/tree-store.js";
import { type VisibleRow, flattenVisible } from "./tree-flatten.js";
import "../common/viewer-header.css";
import "./TreeViewer.css";

// Filter modes + the single-letter key (with ⌃/⌘) that toggles each, mirroring
// pi's TUI (`filters ctrl+d/t/u/l/a`). Pressing the active filter's key returns
// to "default", same as pi.
const FILTER_MODES: ReadonlyArray<{ id: TreeFilterMode; label: string; key: string }> = [
  { id: "default", label: "Default", key: "d" },
  { id: "no-tools", label: "No tools", key: "t" },
  { id: "user-only", label: "User only", key: "u" },
  { id: "labeled-only", label: "Labeled", key: "l" },
  { id: "all", label: "All", key: "a" },
];

const FILTER_LABEL: Record<TreeFilterMode, string> = {
  default: "Default",
  "no-tools": "No tools",
  "user-only": "User only",
  "labeled-only": "Labeled",
  all: "All",
};

interface TreeViewerHostProps {
  sessionId: SessionId;
}

export function TreeViewerHost({ sessionId }: TreeViewerHostProps): React.ReactElement | null {
  const open = useTreeStore((s) => s.open);
  const storeSessionId = useTreeStore((s) => s.sessionId);
  const closeViewer = useTreeStore((s) => s.closeViewer);
  const phase = useTreeStore((s) => s.phase);
  const errorMessage = useTreeStore((s) => s.errorMessage);
  const refresh = useTreeStore((s) => s.refresh);
  const nodes = useTreeStore((s) => s.nodes);
  const leafId = useTreeStore((s) => s.leafId);
  const filterMode = useTreeStore((s) => s.filterMode);
  const setFilterMode = useTreeStore((s) => s.setFilterMode);
  const search = useTreeStore((s) => s.search);
  const setSearch = useTreeStore((s) => s.setSearch);
  const selectedId = useTreeStore((s) => s.selectedId);
  const setSelected = useTreeStore((s) => s.setSelected);
  const foldedIds = useTreeStore((s) => s.foldedIds);
  const toggleFold = useTreeStore((s) => s.toggleFold);
  const summarizeOnSwitch = useTreeStore((s) => s.summarizeOnSwitch);
  const setSummarizeOnSwitch = useTreeStore((s) => s.setSummarizeOnSwitch);
  const navigateTo = useTreeStore((s) => s.navigateTo);
  const navigating = useTreeStore((s) => s.navigating);

  const visible = open && storeSessionId === sessionId;

  // Claim ESC while open so a background streaming session isn't aborted
  // (ESC closes the viewer) — identical to DiffViewerHost.
  useEscapeClaim(visible);

  // Session switch: close the overlay when the active session changes
  // (mirrors DiffViewerHost). The `lastSessionRef.current = null` reset
  // while NOT visible is load-bearing: without it, opening /tree in a
  // different session than the last one it was opened in sees the stale
  // ref and immediately closes the just-opened overlay — so the first
  // /tree after a session switch "did nothing" and only the second worked.
  const lastSessionRef = useRef<SessionId | null>(null);
  useEffect(() => {
    if (!visible) {
      lastSessionRef.current = null;
      return;
    }
    if (lastSessionRef.current !== null && lastSessionRef.current !== sessionId) {
      closeViewer();
    }
    lastSessionRef.current = sessionId;
  }, [visible, sessionId, closeViewer]);

  // Focus save/restore (mirrors DiffViewerHost).
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setTimeout(() => panelRef.current?.focus(), 10);
    return () => {
      const prev = previousFocusRef.current;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [visible]);

  // ── Auto-recover after /reload / reactivation ──
  // The tree store's phase is sticky: once a transient failure lands it in
  // "error" (or a pre-upgrade "unsupported"), nothing in the store re-runs
  // refresh on its own. `/reload` restarts the host — which comes back fully
  // capable — but the viewer stayed stuck, so the user saw the unsupported /
  // error message persist through /reload. Watch the session's status and, on
  // the starting→ready transition, re-fetch if the viewer is open and not
  // already showing a good tree. This also catches the original transient:
  // if the first /tree raced a host restart, the next ready re-fetches.
  const sessionStatus = useSessionsStore((s) => s.sessions.get(sessionId)?.status);
  const prevStatusRef = useRef<string | undefined>(sessionStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = sessionStatus;
    if (!visible) return;
    if (
      prev === "starting" &&
      sessionStatus === "ready" &&
      phase !== "ready" &&
      phase !== "loading"
    ) {
      void refresh();
    }
  }, [sessionStatus, visible, phase, refresh]);

  // ── Visible rows: flatten the tree honoring folded + filter + search ──
  const visibleRows = useMemo(() => {
    return flattenVisible(nodes, {
      foldedIds,
      filterMode,
      search,
      leafId,
    });
  }, [nodes, foldedIds, filterMode, search, leafId]);

  // Auto-select the first visible row if selection becomes invalid.
  useEffect(() => {
    if (!visible) return;
    if (selectedId && visibleRows.some((r) => r.entry.id === selectedId)) return;
    const first = visibleRows[0];
    if (first) useTreeStore.getState().setSelected(first.entry.id);
  }, [visible, visibleRows, selectedId]);

  // Keyboard navigation: ↑/↓/←/→/Enter/Esc.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state-action references are stable from Zustand; listeners read current values at call time.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      // Defer to picker when it owns the screen.
      if (document.querySelector(".picker-overlay")) return;
      const target = e.target as HTMLElement | null;
      const isInSearch = target?.classList.contains("tree-viewer__search-input") ?? false;

      // Filter shortcuts (⌃/⌘ + d/t/u/l/a), mirroring pi's TUI. Work from any
      // focus (incl. the search box). Pressing the active filter's key returns
      // to default.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const match = FILTER_MODES.find((m) => m.key === e.key.toLowerCase());
        if (match) {
          e.preventDefault();
          setFilterMode(filterMode === match.id ? "default" : match.id);
          return;
        }
      }

      if (isInSearch) {
        // Esc inside the search input first clears, second closes.
        if (e.key === "Escape") {
          if (search) {
            e.preventDefault();
            setSearch("");
          } else {
            e.preventDefault();
            closeViewer();
          }
          return;
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        closeViewer();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(+1, visibleRows, selectedId, setSelected);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1, visibleRows, selectedId, setSelected);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const id = selectedId;
        if (!id) return;
        if (foldedIds.has(id)) toggleFold(id);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const id = selectedId;
        if (!id) return;
        if (!foldedIds.has(id)) toggleFold(id);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const id = selectedId;
        if (id && !navigating) void navigateTo(id);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    visible,
    visibleRows,
    selectedId,
    foldedIds,
    toggleFold,
    navigateTo,
    closeViewer,
    navigating,
    search,
    setSearch,
    filterMode,
    setFilterMode,
  ]);

  const [labelEditing, setLabelEditing] = useState<{ id: string; text: string } | null>(null);

  if (!visible) return null;

  return (
    <div
      className="tree-overlay"
      data-testid="tree-overlay"
      onMouseDown={(e) => {
        // Backdrop click closes (target === overlay, not a child) — same as
        // DiffViewerHost.
        if (e.target === e.currentTarget) closeViewer();
      }}
    >
      <div
        className="tree-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="Conversation tree"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="tree-viewer__header viewer-header">
          <div className="viewer-header__left">
            <span className="tree-viewer__title">Conversation Tree</span>
            {filterMode !== "default" && phase === "ready" && (
              <span className="tree-viewer__filter-tag">{FILTER_LABEL[filterMode]}</span>
            )}
            <span className="tree-viewer__summary">
              {phase === "ready"
                ? `${visibleRows.length} ${visibleRows.length === 1 ? "entry" : "entries"}`
                : phase === "loading"
                  ? "Loading…"
                  : phase === "unsupported"
                    ? "Unavailable"
                    : ""}
            </span>
          </div>
          <div className="viewer-header__right">
            <label
              className={`tree-viewer__toggle${summarizeOnSwitch ? " tree-viewer__toggle--on" : ""}`}
              title="Synthesize a summary of the branch you leave when switching"
            >
              <input
                type="checkbox"
                checked={summarizeOnSwitch}
                onChange={(e) => setSummarizeOnSwitch(e.target.checked)}
              />
              Summarize on switch
            </label>
            <div className="tree-viewer__search">
              <input
                className="tree-viewer__search-input"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search tree"
              />
            </div>
            <button
              type="button"
              className="tree-viewer__icon-btn"
              onClick={closeViewer}
              title="Close (Esc)"
              aria-label="Close tree viewer"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="tree-viewer__hint" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Move
          </span>
          <span>
            <kbd>←</kbd>
            <kbd>→</kbd> Fold
          </span>
          <span>
            <kbd>↵</kbd> Switch
          </span>
          <span>
            <kbd>⌘D</kbd>
            <kbd>T</kbd>
            <kbd>U</kbd>
            <kbd>L</kbd>
            <kbd>A</kbd> Filter
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>

        <div className="tree-viewer__body">
          {phase === "loading" && (
            <div className="tree-viewer__empty">
              <span>Loading tree…</span>
            </div>
          )}
          {phase === "unsupported" && <UnsupportedState message={errorMessage} />}
          {phase === "error" && <ErrorState message={errorMessage} />}
          {phase === "ready" && visibleRows.length === 0 && <EmptyState />}
          {phase === "ready" && visibleRows.length > 0 && (
            <TreeList
              rows={visibleRows}
              selectedId={selectedId}
              navigating={navigating}
              onSelect={setSelected}
              onToggleFold={toggleFold}
              onNavigate={(id) => void navigateTo(id)}
              onEditLabel={(id, currentLabel) => setLabelEditing({ id, text: currentLabel ?? "" })}
            />
          )}
        </div>

        {labelEditing && (
          <LabelEditor
            targetId={labelEditing.id}
            initialText={labelEditing.text}
            onClose={() => setLabelEditing(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────

function TreeList({
  rows,
  selectedId,
  navigating,
  onSelect,
  onToggleFold,
  onNavigate,
  onEditLabel,
}: {
  rows: VisibleRow[];
  selectedId: string | null;
  navigating: boolean;
  onSelect: (id: string) => void;
  onToggleFold: (id: string) => void;
  onNavigate: (id: string) => void;
  onEditLabel: (id: string, currentLabel: string | undefined) => void;
}): React.ReactElement {
  return (
    <div className="tree-viewer__tree" role="listbox" aria-label="Conversation tree">
      {rows.map((row) => (
        <TreeRow
          key={row.entry.id}
          row={row}
          selected={selectedId === row.entry.id}
          navigating={navigating}
          onSelect={() => onSelect(row.entry.id)}
          onToggleFold={() => onToggleFold(row.entry.id)}
          onNavigate={() => onNavigate(row.entry.id)}
          onEditLabel={() => onEditLabel(row.entry.id, row.label)}
        />
      ))}
    </div>
  );
}

function TreeRow({
  row,
  selected,
  navigating,
  onSelect,
  onToggleFold,
  onNavigate,
  onEditLabel,
}: {
  row: VisibleRow;
  selected: boolean;
  navigating: boolean;
  onSelect: () => void;
  onToggleFold: () => void;
  onNavigate: () => void;
  onEditLabel: () => void;
}): React.ReactElement {
  return (
    <div
      className={[
        "tree-viewer__row",
        selected ? "tree-viewer__row--selected" : "",
        row.isLeaf ? "tree-viewer__row--leaf" : "",
      ].join(" ")}
      role="option"
      aria-selected={selected}
      data-entry-id={row.entry.id}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!navigating) onNavigate();
        }
      }}
      onDoubleClick={() => {
        if (!navigating) onNavigate();
      }}
      // Branch-only indent: each level is one gutter step. Linear chains are 0.
      style={{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }}
    >
      {/* Fold chevron (only for entries that actually have children). */}
      {row.foldable ? (
        <button
          type="button"
          className={`tree-viewer__chevron${row.folded ? "" : " tree-viewer__chevron--open"}`}
          aria-label={row.folded ? "Expand" : "Collapse"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFold();
          }}
        >
          <ChevronRightIcon />
        </button>
      ) : (
        <span className="tree-viewer__chevron-spacer" aria-hidden />
      )}
      {/* Active-path bullet (pi's `•`). */}
      <span
        className={`tree-viewer__bullet${row.onActivePath ? " tree-viewer__bullet--active" : ""}`}
        aria-hidden
      >
        {row.onActivePath ? "•" : ""}
      </span>
      <span className={`tree-viewer__row-text tree-viewer__row-text--${row.kind}`} title={row.text}>
        {row.text}
      </span>
      {row.label && (
        <button
          type="button"
          className="tree-viewer__label-chip"
          onClick={(e) => {
            e.stopPropagation();
            onEditLabel();
          }}
          title="Click to edit label"
        >
          {row.label}
        </button>
      )}
      {!row.label && row.kind === "user" && (
        <button
          type="button"
          className="tree-viewer__label-add"
          onClick={(e) => {
            e.stopPropagation();
            onEditLabel();
          }}
          title="Add label"
          aria-label="Add label"
        >
          <LabelIcon />
        </button>
      )}
      {row.isLeaf && <span className="tree-viewer__current-pill">current</span>}
    </div>
  );
}

function UnsupportedState({ message }: { message: string | null }): React.ReactElement {
  return (
    <div className="tree-viewer__empty">
      <span>Tree view unavailable</span>
      <span className="tree-viewer__empty-sub">
        {message ?? "Tree view requires the SDK host — update pi or reload the session."}
      </span>
      <RetryButton />
    </div>
  );
}

function ErrorState({ message }: { message: string | null }): React.ReactElement {
  return (
    <div className="tree-viewer__empty">
      <span>Couldn't load tree</span>
      <span className="tree-viewer__empty-sub">{message ?? "Unknown error"}</span>
      <RetryButton />
    </div>
  );
}

function RetryButton(): React.ReactElement {
  const refresh = useTreeStore((s) => s.refresh);
  return (
    <button type="button" className="tree-viewer__retry" onClick={() => void refresh()}>
      Retry
    </button>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="tree-viewer__empty">
      <span>No matching entries</span>
      <span className="tree-viewer__empty-sub">Try a different filter or clear the search.</span>
    </div>
  );
}

function LabelEditor({
  targetId,
  initialText,
  onClose,
}: {
  targetId: string;
  initialText: string;
  onClose: () => void;
}): React.ReactElement {
  const [text, setText] = useState(initialText);
  const setLabel = useTreeStore((s) => s.setLabel);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = useCallback(async () => {
    const trimmed = text.trim();
    await setLabel(targetId, trimmed === "" ? undefined : trimmed);
    onClose();
  }, [targetId, text, setLabel, onClose]);

  return (
    <div className="tree-viewer__label-edit" role="dialog" aria-label="Edit label">
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") onClose();
        }}
        placeholder="Label (empty clears)"
        aria-label="Label"
      />
      <div className="tree-viewer__label-edit-actions">
        <button type="button" className="tree-viewer__label-edit-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="tree-viewer__label-edit-btn tree-viewer__label-edit-btn--primary"
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function moveSelection(
  delta: number,
  rows: VisibleRow[],
  selectedId: string | null,
  setSelected: (id: string) => void,
): void {
  if (rows.length === 0) return;
  const idx = selectedId ? rows.findIndex((r) => r.entry.id === selectedId) : -1;
  let next = idx + delta;
  if (next < 0) next = 0;
  if (next > rows.length - 1) next = rows.length - 1;
  const target = rows[next];
  if (target) {
    setSelected(target.entry.id);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-entry-id="${cssEscape(target.entry.id)}"]`,
      );
      el?.scrollIntoView({ block: "nearest", behavior: "auto" });
    });
  }
}

// ── Icons ───────────────────────────────────────────────────────────

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function ChevronRightIcon(): React.ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 2l4 4-4 4" />
    </svg>
  );
}

function LabelIcon(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3h4l4 4-4 4-4-4z" />
      <circle cx="4.5" cy="4.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

// Silence unused-import noise for symbols reserved for future polish.
void isTreeUnsupported;
void useSessionsStore;
