import type { GitCommitMetadata, GitCommitRange, GitCommitsResult } from "@shared/git.js";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useVirtualList } from "../../hooks/useVirtualList.js";
import { useDiffStore } from "../../stores/diff-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconChevronDown } from "../common/icons.js";
import "./CommitRangePicker.css";

function rangeCount(commits: GitCommitMetadata[], range: GitCommitRange): number {
  const start = commits.findIndex((commit) => commit.sha === range.start);
  const end = commits.findIndex((commit) => commit.sha === range.end);
  return start >= 0 && end >= 0 ? Math.abs(end - start) + 1 : 1;
}

/**
 * A compact, base-relative range chooser. It deliberately has no draft: every
 * selection is committed as it is made, while the first selected commit stays
 * open as the anchor for one optional inclusive second endpoint.
 */
export function CommitRangePicker(): React.ReactElement | null {
  const root = useDiffStore((s) => s.root);
  const base = useDiffStore((s) => s.selectedBase);
  const range = useDiffStore((s) => s.commitRange);
  const editing = useDiffStore((s) => s.editSession !== null || s.commentEditorFiles.size > 0);
  const setCommitRange = useDiffStore((s) => s.setCommitRange);
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<GitCommitMetadata[]>([]); // oldest → newest
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [listScrollFades, setListScrollFades] = useState({ top: false, bottom: false });
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEscapeClaim(open);

  const key = root && base ? `${root}\0${base}` : null;
  const available = key !== null && loadedKey === key && commits.length > 0;

  const close = useCallback((): void => {
    setOpen(false);
    setFirst(null);
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  // Fetch before the control is rendered. HEAD is intentionally not a
  // candidate base, and an empty/error result leaves no dead-end popup.
  useEffect(() => {
    setOpen(false);
    setFirst(null);
    setHighlightedIndex(0);
    setCommits([]);
    setLoadedKey(null);
    if (!key || !root || !base) return;
    let cancelled = false;
    void window.pivis
      .invoke("git.commits", { root, base })
      .then((result: GitCommitsResult) => {
        if (cancelled) return;
        if (result.kind === "ok") {
          setCommits(result.commits);
          setLoadedKey(key);
        }
      })
      .catch(() => {
        // No candidates means no control; errors should not open a dead end.
      });
    return () => {
      cancelled = true;
    };
  }, [key, root, base]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => popupRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) close();
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [open, close]);

  const list = [...commits].reverse(); // newest first
  const virtual = useVirtualList<HTMLDivElement>({
    count: list.length,
    rowHeight: 44,
    minOverscan: 16,
  });
  const count = range === null ? 0 : rangeCount(commits, range);
  const label = range === null ? "Working tree" : count === 1 ? "1 commit" : `${count} commits`;
  const selectedIndices = range
    ? [
        commits.findIndex((commit) => commit.sha === range.start),
        commits.findIndex((commit) => commit.sha === range.end),
      ]
    : [-1, -1];
  const startIndex = selectedIndices[0] ?? -1;
  const endIndex = selectedIndices[1] ?? -1;

  useEffect(() => {
    if (open) virtual.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, open, virtual.ensureIndexVisible]);

  const updateListScrollFades = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) return;
    const next = {
      top: listElement.scrollTop > 1,
      bottom: listElement.scrollHeight - listElement.scrollTop - listElement.clientHeight > 1,
    };
    setListScrollFades((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  }, []);

  useLayoutEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;
    const observer = new ResizeObserver(updateListScrollFades);
    observer.observe(listElement);
    const content = listElement.querySelector(".commit-range-picker__spacer");
    if (content) observer.observe(content);
    updateListScrollFades();
    return () => observer.disconnect();
  });

  const setListElement = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element;
      virtual.containerRef(element);
    },
    [virtual.containerRef],
  );

  const chooseCommit = (sha: string): void => {
    if (first === null) {
      // The initial click is a complete one-commit comparison, and becomes the
      // in-popup anchor only if the user chooses another endpoint.
      setCommitRange({ start: sha, end: sha });
      setFirst(sha);
      return;
    }
    const start = commits.findIndex((commit) => commit.sha === first);
    const end = commits.findIndex((commit) => commit.sha === sha);
    if (start < 0 || end < 0) return;
    setCommitRange({
      start: commits[Math.min(start, end)]!.sha,
      end: commits[Math.max(start, end)]!.sha,
    });
    close();
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    let next = highlightedIndex;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(list.length - 1, highlightedIndex + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, highlightedIndex - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = Math.max(0, list.length - 1);
        break;
      case "PageDown":
        next = Math.min(list.length - 1, highlightedIndex + 5);
        break;
      case "PageUp":
        next = Math.max(0, highlightedIndex - 5);
        break;
      case "Enter":
      case " ": {
        const commit = list[highlightedIndex];
        if (commit) chooseCommit(commit.sha);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setHighlightedIndex(next);
  };

  if (!available) return null;

  return (
    <div className="commit-range-picker" ref={pickerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="commit-range-picker__trigger fade-scope"
        disabled={editing}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Choose commit range"
        title={editing ? "Finish editing before changing the comparison" : "Choose commit range"}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <FadeText>{label}</FadeText>
        <IconChevronDown className="commit-range-picker__caret" />
      </button>
      {open && (
        <div
          ref={popupRef}
          className="commit-range-picker__popup"
          role="dialog"
          aria-label="Commit range"
        >
          <button
            data-autofocus
            type="button"
            className={`commit-range-picker__working${range === null ? " commit-range-picker__working--selected" : ""}`}
            aria-pressed={range === null}
            onClick={() => {
              setCommitRange(null);
              close();
            }}
          >
            Working tree
          </button>
          <div
            ref={setListElement}
            onScroll={(event) => {
              virtual.onScroll(event);
              updateListScrollFades();
            }}
            className={`commit-range-picker__list${listScrollFades.top ? " commit-range-picker__list--fade-top" : ""}${listScrollFades.bottom ? " commit-range-picker__list--fade-bottom" : ""}`}
            role="listbox"
            aria-label="Commits, newest first"
            tabIndex={0}
            aria-activedescendant={
              list[highlightedIndex] ? `commit-${list[highlightedIndex]!.sha}` : undefined
            }
            onKeyDown={handleListKeyDown}
          >
            <div className="commit-range-picker__spacer" style={{ height: virtual.totalHeight }}>
              <div
                className="commit-range-picker__window"
                style={{ transform: `translateY(${virtual.offsetY}px)` }}
              >
                {virtual.rows.map(({ index }) => {
                  const commit = list[index]!;
                  const original = commits.length - 1 - index;
                  const inBand =
                    startIndex >= 0 &&
                    endIndex >= 0 &&
                    original >= Math.min(startIndex, endIndex) &&
                    original <= Math.max(startIndex, endIndex);
                  const endpoint =
                    startIndex === endIndex && original === startIndex
                      ? "Only"
                      : original === startIndex
                        ? "Start"
                        : original === endIndex
                          ? "End"
                          : "";
                  return (
                    <button
                      key={commit.sha}
                      id={`commit-${commit.sha}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={inBand}
                      className={`commit-range-picker__commit${inBand ? " commit-range-picker__commit--selected" : ""}${first === commit.sha ? " commit-range-picker__commit--first" : ""}${index === highlightedIndex ? " commit-range-picker__commit--highlighted" : ""}`}
                      onClick={() => {
                        setHighlightedIndex(index);
                        chooseCommit(commit.sha);
                      }}
                    >
                      <span className="commit-range-picker__sha">{commit.shortSha}</span>
                      <FadeText className="commit-range-picker__subject">{commit.subject}</FadeText>
                      {endpoint && (
                        <span className="commit-range-picker__endpoint">{endpoint}</span>
                      )}
                      <FadeText
                        className="commit-range-picker__meta"
                        title={`${commit.authorName} · ${new Date(commit.authoredAt).toLocaleDateString()}`}
                      >
                        {commit.authorName} · {new Date(commit.authoredAt).toLocaleDateString()}
                      </FadeText>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
