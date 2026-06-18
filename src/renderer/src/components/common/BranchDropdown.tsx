// Presentational branch dropdown — reusable across the diff viewer and
// the worktree bar. Props drive all behaviour; no store dependency.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

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
      setHighlightedIndex(0);
      return;
    }
    setSearch("");
    setHighlightedIndex(0);
    setTimeout(() => searchInputRef.current?.focus(), 10);
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on search value
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, open]);

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

  type Item =
    | { type: "leadingItem"; label: string }
    | { type: "branch"; branch: Branch }
    | { type: "checkbox" };

  const allItems = useMemo<Item[]>(() => {
    // The leading item (e.g. the diff viewer's "HEAD") is opt-in. The worktree
    // picker omits it — its base is always a concrete branch, never null.
    const items: Item[] = leadingItem
      ? [{ type: "leadingItem" as const, label: leadingItem.label }]
      : [];
    for (const b of filtered) {
      if (!includeRemoteBranches && b.remote) continue;
      items.push({ type: "branch" as const, branch: b });
    }
    items.push({ type: "checkbox" as const });
    return items;
  }, [filtered, includeRemoteBranches, leadingItem]);

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
          setHighlightedIndex((i) => (i < allItems.length - 1 ? i + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setHighlightedIndex((i) => (i > 0 ? i - 1 : allItems.length - 1));
          break;
        case "Home":
          e.preventDefault();
          e.stopPropagation();
          setHighlightedIndex(0);
          break;
        case "End":
          e.preventDefault();
          e.stopPropagation();
          setHighlightedIndex(allItems.length - 1);
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          {
            const item = allItems[highlightedIndex];
            if (!item) break;
            if (item.type === "leadingItem") {
              handleSelect(null);
            } else if (item.type === "branch") {
              handleSelect(item.branch.name);
            } else if (item.type === "checkbox") {
              onToggleRemote();
            }
          }
          break;
      }
    },
    [search, allItems, highlightedIndex, handleSelect, onToggleRemote],
  );

  const label = triggerLabel ?? value ?? currentBranch ?? "branch";

  return (
    <div className="branch-dropdown__picker" ref={dropdownRef}>
      <button
        type="button"
        className="branch-dropdown__trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
      >
        {label} ▾
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
          {allItems.length === 0 ? (
            <div className="branch-dropdown__empty">No branches found</div>
          ) : (
            <div role="listbox" id="branch-dropdown-listbox">
              {allItems.map((item, idx) => {
                if (item.type === "leadingItem") {
                  const active = idx === highlightedIndex;
                  return (
                    <button
                      key="__leading__"
                      type="button"
                      ref={(el) => {
                        if (el) itemRefs.current.set(idx, el);
                        else itemRefs.current.delete(idx);
                      }}
                      role="option"
                      aria-selected={value === null}
                      className={`branch-dropdown__item${active ? " branch-dropdown__item--highlighted" : ""}${value === null ? " branch-dropdown__item--active" : ""}`}
                      onClick={() => handleSelect(null)}
                      onMouseEnter={() => setHighlightedIndex(idx)}
                    >
                      <span className="branch-dropdown__item-label">
                        {search ? highlightMatch(item.label, search) : item.label}
                      </span>
                      {value === null && <span className="branch-dropdown__check">✓</span>}
                    </button>
                  );
                }
                if (item.type === "checkbox") {
                  const active = idx === highlightedIndex;
                  return (
                    <div
                      key="__checkbox__"
                      role="option"
                      aria-selected={false}
                      className={`branch-dropdown__checkbox-row${active ? " branch-dropdown__item--highlighted" : ""}`}
                      onClick={onToggleRemote}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onToggleRemote();
                        }
                      }}
                      onMouseEnter={() => setHighlightedIndex(idx)}
                    >
                      <label className="branch-dropdown__checkbox-label">
                        <input
                          type="checkbox"
                          checked={includeRemoteBranches}
                          onChange={onToggleRemote}
                        />
                        <span>Include remote branches</span>
                      </label>
                    </div>
                  );
                }
                // branch item
                const b = item.branch;
                const active = idx === highlightedIndex;
                const selected = value === b.name;
                return (
                  <button
                    key={b.name}
                    type="button"
                    ref={(el) => {
                      if (el) itemRefs.current.set(idx, el);
                      else itemRefs.current.delete(idx);
                    }}
                    role="option"
                    aria-selected={selected}
                    className={`branch-dropdown__item${active ? " branch-dropdown__item--highlighted" : ""}${selected ? " branch-dropdown__item--active" : ""}`}
                    onClick={() => handleSelect(b.name)}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                  >
                    <span className="branch-dropdown__item-label">
                      {search ? highlightMatch(b.name, search) : b.name}
                    </span>
                    {b.current && <span className="branch-dropdown__current">current</span>}
                    {selected && <span className="branch-dropdown__check">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
