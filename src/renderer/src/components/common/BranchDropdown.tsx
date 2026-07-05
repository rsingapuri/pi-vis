// Presentational branch dropdown — reusable across the diff viewer and
// the worktree bar. Props drive all behaviour; no store dependency.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useVirtualList } from "../../hooks/useVirtualList.js";
import { FadeText } from "./FadeText.js";
import { IconCheck, IconChevronDown } from "./icons.js";
import "./BranchDropdown.css";

interface Branch {
  name: string;
  current: boolean;
  remote: boolean;
}

interface BranchDropdownProps {
  branches: Branch[];
  currentBranch: string | null;
  value: string | null;
  onChange: (base: string | null) => void;
  includeRemoteBranches: boolean;
  onToggleRemote: () => void;
  /** Optional leading item (the diff viewer's "HEAD" item). */
  leadingItem?: { label: string } | undefined;
  disabled?: boolean;
  triggerLabel?: string;
  /**
   * Which side of the trigger the panel opens on.
   * "bottom" (default) is correct for controls near the top of the window
   * (e.g. the diff viewer's base-branch picker). "top" is for controls near
   * the bottom (e.g. the WorktreeBar above the composer) so the panel isn't
   * clipped by the viewport edge.
   */
  placement?: "bottom" | "top";
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="branch-dropdown__match">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function BranchDropdown({
  branches,
  currentBranch,
  value,
  onChange,
  includeRemoteBranches,
  onToggleRemote,
  leadingItem,
  disabled = false,
  triggerLabel,
  placement = "bottom",
}: BranchDropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  // Claim ESC while the dropdown is open so a background streaming session
  // isn't aborted (the dropdown's own Escape handler closes it). Reused in
  // multiple places (worktree bar, diff viewer); ref-counting makes this
  // safe across concurrent instances.
  useEscapeClaim(open);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return branches.filter((b) => {
      if (!q) return true;
      return b.name.toLowerCase().includes(q);
    });
  }, [branches, search]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      highlightSourceRef.current = "programmatic";
      setHighlightedIndex(0);
      return;
    }
    setSearch("");
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
    setTimeout(() => searchInputRef.current?.focus(), 10);
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on search value
  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [search]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [open]);

  type Item = { type: "leadingItem"; label: string } | { type: "branch"; branch: Branch };

  const listItems = useMemo<Item[]>(() => {
    // The leading item (e.g. the diff viewer's "HEAD") is opt-in. The worktree
    // picker omits it — its base is always a concrete branch, never null. It
    // respects the search filter like any branch row, so a non-matching query
    // can actually reach the "No branches found" empty state.
    const items: Item[] = [];
    if (
      leadingItem &&
      (!search || leadingItem.label.toLowerCase().includes(search.toLowerCase()))
    ) {
      items.push({ type: "leadingItem" as const, label: leadingItem.label });
    }
    for (const b of filtered) {
      if (!includeRemoteBranches && b.remote) continue;
      items.push({ type: "branch" as const, branch: b });
    }
    return items;
  }, [filtered, includeRemoteBranches, leadingItem, search]);

  // The "Include remote branches" checkbox is a pinned footer BELOW the
  // scrolling list (always visible, never scrolled away). It still takes part
  // in keyboard navigation as the last index.
  const checkboxIndex = listItems.length;
  const totalItems = listItems.length + 1;
  const virtualList = useVirtualList<HTMLDivElement>({
    count: listItems.length,
    rowHeight: 34,
    minOverscan: 32,
    overscanScreens: 2,
  });

  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex((i) => Math.min(i, totalItems - 1));
  }, [totalItems]);

  useEffect(() => {
    if (!open || highlightedIndex === checkboxIndex) return;
    // Mouse hover should only move the visual highlight. Auto-scrolling on
    // hover feels jumpy (especially for rows near the bottom of the popup),
    // so only keyboard/programmatic highlight changes scroll the list.
    if (highlightSourceRef.current === "pointer") return;
    virtualList.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, open, checkboxIndex, virtualList.ensureIndexVisible]);

  const handleSelect = useCallback(
    (base: string | null) => {
      setOpen(false);
      onChange(base);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          if (search) {
            setSearch("");
          } else {
            setOpen(false);
          }
          e.preventDefault();
          e.stopPropagation();
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          highlightSourceRef.current = "keyboard";
          setHighlightedIndex((i) => (i < totalItems - 1 ? i + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          highlightSourceRef.current = "keyboard";
          setHighlightedIndex((i) => (i > 0 ? i - 1 : totalItems - 1));
          break;
        case "Home":
          e.preventDefault();
          e.stopPropagation();
          highlightSourceRef.current = "keyboard";
          setHighlightedIndex(0);
          break;
        case "End":
          e.preventDefault();
          e.stopPropagation();
          highlightSourceRef.current = "keyboard";
          setHighlightedIndex(totalItems - 1);
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          {
            if (highlightedIndex === checkboxIndex) {
              onToggleRemote();
              break;
            }
            const item = listItems[highlightedIndex];
            if (!item) break;
            if (item.type === "leadingItem") {
              handleSelect(null);
            } else {
              handleSelect(item.branch.name);
            }
          }
          break;
      }
    },
    [search, listItems, totalItems, checkboxIndex, highlightedIndex, handleSelect, onToggleRemote],
  );

  const label = triggerLabel ?? value ?? currentBranch ?? "branch";

  return (
    <div className="branch-dropdown__picker" ref={dropdownRef}>
      <button
        type="button"
        className="branch-dropdown__trigger fade-scope"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
      >
        <FadeText>{label}</FadeText>
        <IconChevronDown className="branch-dropdown__caret" />
      </button>
      {open && (
        <div
          className={`branch-dropdown__dropdown${placement === "top" ? " branch-dropdown__dropdown--top" : ""}`}
        >
          <div className="branch-dropdown__search">
            <input
              ref={searchInputRef}
              className="branch-dropdown__search-input"
              placeholder="Search branches…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              role="combobox"
              aria-expanded={open}
              aria-controls="branch-dropdown-listbox"
              aria-autocomplete="list"
            />
          </div>
          {listItems.length === 0 ? (
            <div className="branch-dropdown__empty">No branches found</div>
          ) : (
            <div
              ref={virtualList.containerRef}
              onScroll={virtualList.onScroll}
              className="branch-dropdown__list branch-dropdown__list--virtual"
              role="listbox"
              id="branch-dropdown-listbox"
            >
              <div
                className="branch-dropdown__virtual-spacer"
                style={{ height: virtualList.totalHeight }}
              >
                <div
                  className="branch-dropdown__virtual-window"
                  style={{ transform: `translateY(${virtualList.offsetY}px)` }}
                >
                  {virtualList.rows.map(({ index: idx }) => {
                    const item = listItems[idx];
                    if (!item) return null;
                    if (item.type === "leadingItem") {
                      const active = idx === highlightedIndex;
                      return (
                        <button
                          key="__leading__"
                          type="button"
                          role="option"
                          aria-selected={value === null}
                          className={`branch-dropdown__item fade-scope${active ? " branch-dropdown__item--highlighted" : ""}${value === null ? " branch-dropdown__item--active" : ""}`}
                          onClick={() => handleSelect(null)}
                          onMouseEnter={() => {
                            highlightSourceRef.current = "pointer";
                            setHighlightedIndex(idx);
                          }}
                        >
                          <span className="branch-dropdown__item-label" title={item.label}>
                            {search ? highlightMatch(item.label, search) : item.label}
                          </span>
                          {value === null && (
                            <span className="branch-dropdown__check" aria-hidden>
                              <IconCheck />
                            </span>
                          )}
                        </button>
                      );
                    }
                    const b = item.branch;
                    const active = idx === highlightedIndex;
                    const selected = value === b.name;
                    return (
                      <button
                        key={b.name}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`branch-dropdown__item fade-scope${active ? " branch-dropdown__item--highlighted" : ""}${selected ? " branch-dropdown__item--active" : ""}`}
                        onClick={() => handleSelect(b.name)}
                        onMouseEnter={() => {
                          highlightSourceRef.current = "pointer";
                          setHighlightedIndex(idx);
                        }}
                      >
                        <span className="branch-dropdown__item-label" title={b.name}>
                          {search ? highlightMatch(b.name, search) : b.name}
                        </span>
                        {b.current && <span className="branch-dropdown__current">current</span>}
                        {selected && (
                          <span className="branch-dropdown__check" aria-hidden>
                            <IconCheck />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {/* Pinned footer — always visible regardless of list scroll. */}
          <div
            role="option"
            aria-selected={false}
            className={`branch-dropdown__checkbox-row${highlightedIndex === checkboxIndex ? " branch-dropdown__item--highlighted" : ""}`}
            onClick={(e) => {
              if (e.target instanceof Element && e.target.closest("label")) return;
              onToggleRemote();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggleRemote();
              }
            }}
            onMouseEnter={() => {
              highlightSourceRef.current = "pointer";
              setHighlightedIndex(checkboxIndex);
            }}
          >
            <label className="branch-dropdown__checkbox-label">
              <input
                type="checkbox"
                checked={includeRemoteBranches}
                onChange={onToggleRemote}
                onClick={(e) => {
                  // A label click synthesizes an input click; keep that event
                  // from also bubbling into the clickable row.
                  e.stopPropagation();
                }}
              />
              <span>Include remote branches</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
