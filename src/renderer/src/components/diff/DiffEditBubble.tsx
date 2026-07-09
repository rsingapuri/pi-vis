// DiffEditBubble — the floating "Edit" pill that appears over a text selection
// in the diff content, plus the selection controller that resolves the
// selection to an EditRange and opens an edit session.
//
// Eligibility (invariant 13) is deliberately PERMISSIVE: the bubble appears
// for any non-collapsed selection whose selected characters land on diff rows
// of exactly one file and cover at least one non-removed (context/add) line.
// The only exclusions are del-only selections and genuine multi-file
// selections. Boundary artifacts must not count against eligibility: a
// full-line drag parks the selection focus at offset 0 of the NEXT row (or in
// the next file's header), so rows/files touched with zero selected
// characters are trimmed before the checks run.
//
// The bubble NEVER renders while the mouse is down. It is the last child of
// .diff-content in DOM order, so showing it mid-drag puts a button under the
// moving cursor and the browser extends the selection into it — the highlight
// visibly jumps across the whole pane. Resolution happens on mouseup (and on
// selectionchange for keyboard-driven selections only).

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffModel } from "../../lib/diff/diff-model.js";
import { type EditRange, resolveEditRange } from "../../lib/diff/edit-range.js";
import { type EditCursorPosition, useDiffStore } from "../../stores/diff-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { IconPencil } from "../common/icons.js";

interface BubblePos {
  x: number;
  y: number;
}

interface Resolved {
  path: string;
  range: EditRange;
  cursor: EditCursorPosition | null;
  rect: DOMRect;
}

/** Diagnostic trail: why the last resolve attempt produced no bubble. Logged
 *  at the default console level (NOT console.debug — that hides under
 *  DevTools "Verbose") so a user report can pinpoint the rejecting gate. */
function rejected(reason: string, detail?: unknown): null {
  console.log(`[diff-edit] no bubble: ${reason}`, detail ?? "");
  return null;
}

/** Resolve the current selection to an editable range, or null if ineligible. */
function resolveSelection(): Resolved | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const domRange = sel.getRangeAt(0);
  const content = document.querySelector<HTMLElement>(".diff-content");
  if (!content) return null;

  // Files that actually contain selected row characters. Files merely touched
  // by a boundary (an overshoot into the next section's header) have zero
  // qualifying rows and don't count.
  const candidates = Array.from(
    content.querySelectorAll<HTMLElement>(".diff-file[data-path]"),
  ).filter((el) => intersects(domRange, el));
  if (candidates.length === 0) return null; // selection not over the diff
  const withRows: { file: HTMLElement; rows: HTMLElement[] }[] = [];
  for (const file of candidates) {
    const rows = selectedRowsInFile(domRange, file, sel.anchorNode);
    if (rows.length > 0) withRows.push({ file, rows });
  }
  if (withRows.length === 0) return rejected("no selected characters on any diff row");
  if (withRows.length > 1) {
    return rejected(
      "selection spans multiple files",
      withRows.map((w) => w.file.getAttribute("data-path")),
    );
  }

  const { file, rows } = withRows[0]!;
  const path = file.getAttribute("data-path");
  if (!path) return rejected("file section has no data-path");

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const el of rows) {
    const idx = Number(el.getAttribute("data-line-idx"));
    if (!Number.isInteger(idx)) continue;
    if (idx < lo) lo = idx;
    if (idx > hi) hi = idx;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return rejected("rows carry no usable data-line-idx");
  }

  const store = useDiffStore.getState();
  if (store.editSession) return rejected("an edit session is already open");
  const fs = store.fileState.get(path);
  if (!fs || fs.status !== "ready" || !fs.model || fs.model.kind !== "ok") {
    return rejected("file not editable", { path, status: fs?.status, kind: fs?.model?.kind });
  }
  const model = fs.model;

  const sessionId = store.sessionId;
  if (!sessionId) return rejected("no active session in diff store");
  const comments = useSessionsStore.getState().diffComments.get(sessionId);
  const commentedNewNos = new Set<number>();
  if (comments) {
    for (const c of comments.values()) {
      if (c.filePath === path) commentedNewNos.add(c.lineNumber);
    }
  }

  // Every model index counts as visible: a selection across a collapsed gap
  // is eligible — the card reveals the hidden context lines, and RowsView
  // suppresses the overlapped gap row while the card is open.
  const allLineIdxs = new Set(model.lines.map((_, idx) => idx));
  const editRange = resolveEditRange(model, allLineIdxs, lo, hi, commentedNewNos);
  if (!editRange) return rejected("no editable (context/add) line in range", { path, lo, hi });

  const cursor = resolveCursorPosition(domRange, file, model, editRange);
  console.log(`[diff-edit] bubble eligible: ${path} rows ${lo}–${hi}`);
  return { path, range: editRange, cursor, rect: selectionRect(domRange) };
}

/** Place the edit cursor immediately after the last highlighted editable
 *  character. The edit card may render multiple textareas (comments/deletions
 *  split editable runs), so the position is expressed as segment + offset. */
function resolveCursorPosition(
  selectionRange: Range,
  file: HTMLElement,
  model: DiffModel,
  editRange: EditRange,
): EditCursorPosition | null {
  let last: { lineIdx: number; endOffset: number } | null = null;
  for (const el of file.querySelectorAll<HTMLElement>("[data-line-idx]")) {
    if (!intersects(selectionRange, el)) continue;
    const lineIdx = Number(el.getAttribute("data-line-idx"));
    if (!Number.isInteger(lineIdx)) continue;
    if (lineIdx < editRange.startLineIdx || lineIdx > editRange.endLineIdx) continue;
    const ln = model.lines[lineIdx];
    if (!ln || ln.type === "del" || ln.newNo === null) continue;
    const codeCell = codeCellForSelectable(el);
    if (!codeCell) continue;
    const endOffset = selectedEndOffset(selectionRange, codeCell);
    if (endOffset === null) continue;
    last = { lineIdx, endOffset: Math.min(endOffset, ln.text.length) };
  }
  if (last) {
    const cursor = cursorForLine(editRange, model, last.lineIdx, last.endOffset);
    if (cursor) return cursor;
  }
  return fallbackCursor(editRange);
}

function codeCellForSelectable(el: HTMLElement): HTMLElement | null {
  if (el.classList.contains("diff-row__code")) return el;
  return el.querySelector<HTMLElement>(".diff-row__code:not(.diff-row__code--empty)");
}

function selectedEndOffset(selectionRange: Range, codeCell: HTMLElement): number | null {
  if (!intersects(selectionRange, codeCell)) return null;
  try {
    const cellRange = document.createRange();
    cellRange.selectNodeContents(codeCell);
    const inter = selectionRange.cloneRange();
    if (inter.comparePoint(cellRange.startContainer, cellRange.startOffset) === 0) {
      inter.setStart(cellRange.startContainer, cellRange.startOffset);
    }
    if (inter.comparePoint(cellRange.endContainer, cellRange.endOffset) === 0) {
      inter.setEnd(cellRange.endContainer, cellRange.endOffset);
    }
    if (inter.toString() === "") return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(codeCell);
    prefix.setEnd(inter.endContainer, inter.endOffset);
    return prefix.toString().length;
  } catch {
    return null;
  }
}

function cursorForLine(
  editRange: EditRange,
  model: DiffModel,
  lineIdx: number,
  lineOffset: number,
): EditCursorPosition | null {
  let segmentIndex = 0;
  for (const block of editRange.blocks) {
    if (block.kind !== "edit") continue;
    let offset = 0;
    for (let i = 0; i < block.lineIdxs.length; i++) {
      const idx = block.lineIdxs[i]!;
      const lineText = model.lines[idx]?.text ?? "";
      if (idx === lineIdx) return { segmentIndex, offset: offset + lineOffset };
      offset += lineText.length + 1;
    }
    segmentIndex++;
  }
  return null;
}

function fallbackCursor(editRange: EditRange): EditCursorPosition | null {
  let last: EditCursorPosition | null = null;
  let segmentIndex = 0;
  for (const block of editRange.blocks) {
    if (block.kind !== "edit") continue;
    last = { segmentIndex, offset: block.initialText.length };
    segmentIndex++;
  }
  return last;
}

/** Row elements of `file` genuinely covered by the selection. Boundary rows
 *  the selection merely touches (zero selected characters) are trimmed —
 *  except the row containing the selection ANCHOR: starting a drag past the
 *  end of a line selects none of that line's characters, but the user
 *  deliberately started there. The zero-character artifact to trim is always
 *  on the focus side (the drag parked just past a row it never covered). */
function selectedRowsInFile(
  range: Range,
  file: HTMLElement,
  anchorNode: Node | null,
): HTMLElement[] {
  const els = Array.from(file.querySelectorAll<HTMLElement>("[data-line-idx]")).filter((el) =>
    intersects(range, el),
  );
  const trimmable = (el: HTMLElement): boolean =>
    !(anchorNode !== null && el.contains(anchorNode)) && touchOnly(range, el);
  while (els.length > 0 && trimmable(els[0]!)) els.shift();
  while (els.length > 0 && trimmable(els[els.length - 1]!)) els.pop();
  return els;
}

/** True when the selection touches `el` without covering any of its
 *  characters (e.g. the focus of a full-line drag parked at offset 0 of the
 *  next row). Rows with no text at all (blank lines) are never touch-only. */
function touchOnly(range: Range, el: HTMLElement): boolean {
  if ((el.textContent ?? "") === "") return false;
  try {
    const rowRange = document.createRange();
    rowRange.selectNodeContents(el);
    const inter = range.cloneRange();
    // Clamp the selection clone to the row's contents (comparePoint === 0
    // means the row boundary lies inside the selection).
    if (inter.comparePoint(rowRange.startContainer, rowRange.startOffset) === 0) {
      inter.setStart(rowRange.startContainer, rowRange.startOffset);
    }
    if (inter.comparePoint(rowRange.endContainer, rowRange.endOffset) === 0) {
      inter.setEnd(rowRange.endContainer, rowRange.endOffset);
    }
    return inter.toString() === "";
  } catch {
    return false;
  }
}

function intersects(range: Range, el: HTMLElement): boolean {
  try {
    return range.intersectsNode(el);
  } catch {
    return false;
  }
}

/** Diagnostic helper: the content pane's viewport bounds (or null). */
function contentBounds(): { t: number; b: number } | null {
  const c = document.querySelector(".diff-content")?.getBoundingClientRect();
  return c ? { t: c.top, b: c.bottom } : null;
}

function selectionRect(range: Range): DOMRect {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  if (rects.length === 0) return range.getBoundingClientRect();
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

export function DiffEditBubble(): React.ReactElement | null {
  const editSession = useDiffStore((s) => s.editSession);
  const [pos, setPos] = useState<BubblePos | null>(null);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const bubbleRef = useRef<HTMLButtonElement | null>(null);
  // Ref mirrors so the once-registered listeners read live state.
  const posRef = useRef<BubblePos | null>(null);
  const resolvedRef = useRef<Resolved | null>(null);
  const mouseDownRef = useRef(false);
  const resolveRafRef = useRef(0);
  posRef.current = pos;
  resolvedRef.current = resolved;

  // Stable ref callback: fires only on REAL mount/unmount of the element
  // (an inline arrow would re-fire on every render and muddy the log).
  const attachBubble = useCallback((el: HTMLButtonElement | null) => {
    if (el !== null) console.log("[diff-edit] bubble element mounted");
    bubbleRef.current = el;
  }, []);

  const hide = useCallback((reason: string) => {
    // Only narrate transitions that actually remove a visible/resolved bubble
    // — hides from idle states are routine (every click) and would be noise.
    if (posRef.current !== null || resolvedRef.current !== null) {
      console.log(`[diff-edit] hidden (${reason})`);
    }
    setPos(null);
    setResolved(null);
  }, []);

  /** Position for the bubble under `rect`, in .diff-content CONTENT
   *  coordinates (the bubble is absolutely anchored inside the scroller, so
   *  it rides with the text — no scroll listener, no per-frame reposition).
   *  Null only when the pane is missing or the rect is degenerate. */
  const place = useCallback((rect: DOMRect): BubblePos | null => {
    const content = document.querySelector<HTMLElement>(".diff-content");
    if (!content) return null;
    // A zero rect means the selection's boxes were mid-rebuild this frame
    // (rows re-rendering underneath it) — nothing to anchor to.
    if (rect.width === 0 && rect.height === 0) return null;
    const c = content.getBoundingClientRect();
    const bw = bubbleRef.current?.offsetWidth ?? 56;
    const bh = bubbleRef.current?.offsetHeight ?? 28;
    // Viewport → content space.
    const relRight = rect.right - c.left + content.scrollLeft;
    const relTop = rect.top - c.top + content.scrollTop;
    const relBottom = rect.bottom - c.top + content.scrollTop;
    const x = Math.max(
      content.scrollLeft + 8,
      Math.min(relRight - bw / 2, content.scrollLeft + content.clientWidth - bw - 8),
    );
    let y = relBottom + 6;
    // Flip above the rect when the below-position would fall past the
    // currently visible pane bottom.
    if (rect.bottom + 6 + bh > c.bottom) y = Math.max(0, relTop - bh - 6);
    return { x, y };
  }, []);

  const scheduleResolve = useCallback(() => {
    if (resolveRafRef.current) cancelAnimationFrame(resolveRafRef.current);
    resolveRafRef.current = requestAnimationFrame(() => {
      resolveRafRef.current = 0;
      const r = resolveSelection();
      if (!r) {
        hide("selection no longer eligible");
        return;
      }
      const p = place(r.rect);
      if (p === null) {
        // Degenerate rect (rows re-rendering under the selection this frame).
        // Keep the bubble where it was rather than unmounting — tearing the
        // element down restarts its entry animation and a churn loop would
        // pin it at opacity 0 forever.
        if (posRef.current !== null) {
          console.log("[diff-edit] degenerate selection rect; keeping previous position");
          setResolved(r);
          return;
        }
        console.log("[diff-edit] eligible but no anchor rect", contentBounds());
        return;
      }
      if (posRef.current === null) {
        console.log(`[diff-edit] showing at ${Math.round(p.x)},${Math.round(p.y)} (content-space)`);
      }
      setResolved(r);
      setPos(p);
    });
  }, [hide, place]);

  // Listeners are registered ONCE (state read through refs): stable window
  // registration order keeps this handler ahead of the viewer host's own
  // capture keydown, so a visible bubble can claim Escape before the host.
  useEffect(() => {
    // Build marker: confirms THIS controller (with the permissive selection
    // logic) is the one mounted. If a diff viewer is open and this line is
    // absent from the console, a stale bundle / wrong directory is running.
    console.log("[diff-edit] selection controller mounted (build: permissive-v2)");
    const onMouseDown = (e: MouseEvent): void => {
      if (bubbleRef.current?.contains(e.target as Node)) return;
      mouseDownRef.current = true;
      hide("mousedown outside bubble"); // a new drag starts: no stale bubble under the cursor
    };
    const onMouseUp = (): void => {
      mouseDownRef.current = false;
      scheduleResolve();
    };
    const onBlur = (): void => {
      mouseDownRef.current = false;
    };
    const onSelectionChange = (): void => {
      if (mouseDownRef.current) return; // never resolve mid-drag
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        hide("selection collapsed");
        return;
      }
      // A selection mutating while the bubble is visible and no mouse button
      // is down means something OTHER than the user changed it (a re-render
      // remapping the highlight) — the smoking gun for the "shifting
      // selection" symptom.
      if (posRef.current !== null) {
        console.log("[diff-edit] selection changed while bubble visible (external remap?)");
      }
      scheduleResolve();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !posRef.current) return;
      // Dismiss the bubble and consume the key so the viewer stays open.
      e.preventDefault();
      e.stopImmediatePropagation();
      hide("escape");
    };
    // DIAGNOSTIC: detect continuous DOM churn in the diff content (rows
    // re-rendering under an active selection — the "shifting highlight"
    // culprit). Logs once per second while churn exceeds the threshold,
    // with a sample mutated node so the offending component is nameable.
    let mutationCount = 0;
    let mutationSample: string | null = null;
    const observer = new MutationObserver((muts) => {
      mutationCount += muts.length;
      if (mutationSample === null) {
        const t = muts[0]?.target;
        mutationSample =
          t instanceof Element
            ? t.className
            : (t?.parentElement?.className ?? String(t?.nodeName ?? "?"));
      }
    });
    const content = document.querySelector(".diff-content");
    if (content) observer.observe(content, { childList: true, characterData: true, subtree: true });
    const churnTick = window.setInterval(() => {
      if (mutationCount > 30) {
        console.log(
          `[diff-edit] diff DOM churning: ${mutationCount} mutations/s (sample target: ${JSON.stringify(mutationSample)})`,
        );
      }
      mutationCount = 0;
      mutationSample = null;
    }, 1000);

    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("keydown", onKey, true);
    return () => {
      observer.disconnect();
      window.clearInterval(churnTick);
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("keydown", onKey, true);
      if (resolveRafRef.current) cancelAnimationFrame(resolveRafRef.current);
      // Zero the id: a canceled rAF never runs to clear its own ref.
      resolveRafRef.current = 0;
    };
  }, [hide, scheduleResolve]);

  // Clear on session open so a stale bubble can't reappear at the old
  // position after the card closes.
  useEffect(() => {
    if (editSession) hide("edit session opened");
  }, [editSession, hide]);

  if (editSession || !pos || !resolved) return null;

  return (
    <button
      ref={attachBubble}
      type="button"
      className="diff-edit-bubble"
      data-testid="diff-edit-bubble"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.preventDefault()} // keep the selection
      onClick={() => {
        // Re-resolve at click time so keyboard adjustments after the last
        // mouseup open exactly what's highlighted now.
        const fresh = resolveSelection() ?? resolvedRef.current;
        hide("bubble clicked");
        if (!fresh) return;
        useDiffStore.getState().openEditSession(fresh.path, fresh.range, fresh.cursor);
        window.getSelection()?.removeAllRanges();
      }}
    >
      <IconPencil size="0.9em" />
      <span>Edit</span>
    </button>
  );
}
