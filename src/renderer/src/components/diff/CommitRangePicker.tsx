import type { GitCommitMetadata, GitCommitRange, GitCommitsResult } from "@shared/git.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useVirtualList } from "../../hooks/useVirtualList.js";
import { useDiffStore } from "../../stores/diff-store.js";
import { FadeText } from "../common/FadeText.js";
import { ScrollFadeFrame } from "../common/ScrollFadeFrame.js";
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
  const workingTreeScope = useDiffStore((s) => s.workingTreeScope);
  const editing = useDiffStore((s) => s.editSession !== null || s.commentEditorFiles.size > 0);
  const setCommitRange = useDiffStore((s) => s.setCommitRange);
  const showUncommittedChanges = useDiffStore((s) => s.showUncommittedChanges);
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<GitCommitMetadata[]>([]); // oldest → newest
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [dragSelection, setDragSelection] = useState<{
    anchor: string;
    end: string | "uncommitted";
  } | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const ignoreClickRef = useRef(false);
  useEscapeClaim(open);

  const key = root && base ? `${root}\0${base}` : null;
  const available = key !== null && loadedKey === key && commits.length > 0;

  const close = useCallback((): void => {
    setOpen(false);
    setFirst(null);
    setDragSelection(null);
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
  const label =
    range === null
      ? workingTreeScope === "uncommitted"
        ? "Uncommitted"
        : "All changes"
      : `${count === 1 ? "1 commit" : `${count} commits`}${range.includeUncommitted ? " + uncommitted" : ""}`;
  const selectedRange = dragSelection
    ? {
        start: dragSelection.anchor,
        end:
          dragSelection.end === "uncommitted"
            ? (commits[commits.length - 1]?.sha ?? dragSelection.anchor)
            : dragSelection.end,
        includeUncommitted: dragSelection.end === "uncommitted",
      }
    : range;
  // A base-relative working-tree comparison is the default: it includes every
  // candidate commit and the live working tree, so the picker starts as "all".
  const selectedIndices = selectedRange
    ? [
        commits.findIndex((commit) => commit.sha === selectedRange.start),
        commits.findIndex((commit) => commit.sha === selectedRange.end),
      ]
    : [0, commits.length - 1];
  const startIndex = selectedIndices[0] ?? -1;
  const endIndex = selectedIndices[1] ?? -1;
  const includesUncommitted =
    selectedRange?.includeUncommitted === true ||
    (selectedRange === null && workingTreeScope === "base");
  const allChangesSelected = range === null && workingTreeScope === "base";

  useEffect(() => {
    if (open) virtual.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, open, virtual.ensureIndexVisible]);

  const chooseCommit = (sha: string, selectRange: boolean): void => {
    const anchor = first ?? range?.start ?? commits[0]?.sha ?? null;
    if (!selectRange || anchor === null) {
      // A plain click is a complete one-commit comparison. Shift-click uses
      // the current selection's start as its anchor and keeps this popup open.
      setCommitRange({ start: sha, end: sha });
      close();
      return;
    }
    const start = commits.findIndex((commit) => commit.sha === anchor);
    const end = commits.findIndex((commit) => commit.sha === sha);
    if (start < 0 || end < 0) return;
    const normalizedStart = commits[Math.min(start, end)]!.sha;
    setCommitRange({
      start: normalizedStart,
      end: commits[Math.max(start, end)]!.sha,
    });
    setFirst(normalizedStart);
  };

  const chooseUncommitted = (selectRange: boolean): void => {
    const anchor = first ?? range?.start ?? commits[0]?.sha ?? null;
    if (!selectRange || anchor === null) {
      showUncommittedChanges();
      close();
      return;
    }
    const start = commits.findIndex((commit) => commit.sha === anchor);
    if (start < 0 || commits.length === 0) return;
    const normalizedStart = commits[start]!.sha;
    setCommitRange({
      start: normalizedStart,
      end: commits[commits.length - 1]!.sha,
      includeUncommitted: true,
    });
    setFirst(normalizedStart);
  };

  const endpointAt = (clientX: number, clientY: number): string | "uncommitted" | null => {
    const element = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-commit-sha], [data-uncommitted-endpoint]");
    if (!element) return null;
    return element.dataset.uncommittedEndpoint === "true"
      ? "uncommitted"
      : (element.dataset.commitSha ?? null);
  };

  const finishDrag = (anchor: string, end: string | "uncommitted"): void => {
    if (end === "uncommitted") {
      const start = commits.findIndex((commit) => commit.sha === anchor);
      const last = commits[commits.length - 1];
      if (start < 0 || !last) return;
      setCommitRange({ start: commits[start]!.sha, end: last.sha, includeUncommitted: true });
      setFirst(commits[start]!.sha);
      setDragSelection(null);
      return;
    }
    if (anchor === end) {
      setCommitRange({ start: anchor, end: anchor });
      close();
      return;
    }
    const start = commits.findIndex((commit) => commit.sha === anchor);
    const endIndex = commits.findIndex((commit) => commit.sha === end);
    if (start < 0 || endIndex < 0) return;
    const normalizedStart = commits[Math.min(start, endIndex)]!.sha;
    setCommitRange({ start: normalizedStart, end: commits[Math.max(start, endIndex)]!.sha });
    setFirst(normalizedStart);
    setDragSelection(null);
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
        if (commit) chooseCommit(commit.sha, event.shiftKey);
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
        onClick={() => {
          if (open) {
            close();
          } else {
            setFirst(range?.start ?? commits[0]?.sha ?? null);
            setOpen(true);
          }
        }}
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
          onPointerMove={(event) => {
            if (!dragSelection) return;
            const end = endpointAt(event.clientX, event.clientY);
            if (end !== null) setDragSelection({ ...dragSelection, end });
          }}
          onPointerUp={(event) => {
            if (!dragSelection) return;
            const end = endpointAt(event.clientX, event.clientY) ?? dragSelection.end;
            ignoreClickRef.current = true;
            finishDrag(dragSelection.anchor, end);
          }}
        >
          <div className="commit-range-picker__scopes">
            {!allChangesSelected && (
              <button
                data-autofocus
                type="button"
                className="commit-range-picker__working commit-range-picker__select-all"
                onClick={() => {
                  setCommitRange(null);
                  close();
                }}
              >
                Select all
              </button>
            )}
            <button
              data-autofocus={allChangesSelected || undefined}
              type="button"
              className={`commit-range-picker__working${includesUncommitted ? " commit-range-picker__working--selected" : ""}`}
              aria-pressed={includesUncommitted}
              data-uncommitted-endpoint="true"
              onClick={(event) => chooseUncommitted(event.shiftKey)}
            >
              <span>Uncommitted changes</span>
              {includesUncommitted && <span className="commit-range-picker__endpoint">End</span>}
            </button>
          </div>
          <ScrollFadeFrame
            frameClassName="commit-range-picker__list-shell"
            scrollerRef={virtual.containerRef}
            onScroll={virtual.onScroll}
            className="commit-range-picker__list"
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
                        : !includesUncommitted && original === endIndex
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
                      data-commit-sha={commit.sha}
                      className={`commit-range-picker__commit${inBand ? " commit-range-picker__commit--selected" : ""}${index === highlightedIndex ? " commit-range-picker__commit--highlighted" : ""}`}
                      onPointerDown={(event) => {
                        if (event.button !== 0 || event.shiftKey) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setHighlightedIndex(index);
                        setFirst(commit.sha);
                        setDragSelection({ anchor: commit.sha, end: commit.sha });
                      }}
                      onClick={(event) => {
                        if (ignoreClickRef.current) {
                          ignoreClickRef.current = false;
                          return;
                        }
                        setHighlightedIndex(index);
                        chooseCommit(commit.sha, event.shiftKey);
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
          </ScrollFadeFrame>
        </div>
      )}
    </div>
  );
}
