// DiffEditCard — the inline editor that replaces a selected diff-row slice.
//
// The card renders the edit-range block sequence in flow: editable segments
// (layered Shiki editor), inert dimmed del rows (copyable), and inert comment
// threads (read-only). It adds NO flow chrome (inset ring + absolute footer)
// so opening it shifts no surrounding glyph. Buffers live in uncontrolled
// textareas (native undo survives); the card collects them at save time.

import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { ThemedToken } from "shiki";
import { type CodeComment, codeCommentKey } from "../../lib/diff-comments.js";
import { enterInsertion, indentEdit } from "../../lib/diff/auto-indent.js";
import type { DiffModel } from "../../lib/diff/diff-model.js";
import { langForPath, tokenizeLinesSync } from "../../lib/diff/highlight.js";
import type { EditSession } from "../../stores/diff-store.js";
import { useDiffStore } from "../../stores/diff-store.js";
import { ConfirmDialog } from "../shell/ConfirmDialog.js";
import "./DiffEditCard.css";

interface DiffEditCardProps {
  session: EditSession;
  model: DiffModel;
  oldTokens: ThemedToken[][] | null | undefined;
  commentsForSession: Map<string, CodeComment> | undefined;
  sessionId: SessionId;
  filePath: string;
  gutterW: string;
  basename: string;
  viewMode: "unified" | "split";
}

export function DiffEditCard({
  session,
  model,
  oldTokens,
  commentsForSession,
  sessionId: _sessionId,
  filePath,
  gutterW,
  basename,
  viewMode,
}: DiffEditCardProps): React.ReactElement {
  const saveEditSession = useDiffStore((s) => s.saveEditSession);
  const cancelEditSession = useDiffStore((s) => s.cancelEditSession);
  const markEditDirty = useDiffStore((s) => s.markEditDirty);
  const editCancelNonce = useDiffStore((s) => s.editCancelNonce);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const taRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const lang = langForPath(filePath);
  const saving = session.phase === "saving";
  const split = viewMode === "split";

  // Build the new-side line → token map for inert rows / pre overlay seed.
  const oldTokenByLineNo = (lineNo: number | null): ThemedToken[] | null =>
    lineNo !== null && oldTokens ? (oldTokens[lineNo - 1] ?? null) : null;

  const collectBuffers = (): string[] => {
    const out: string[] = [];
    let seg = 0;
    for (const block of session.blocks) {
      if (block.kind !== "edit") continue;
      out.push(taRefs.current[seg]?.value ?? "");
      seg++;
    }
    return out;
  };

  const handleSave = (): void => {
    if (!session.dirty || saving) return;
    void saveEditSession(collectBuffers());
  };

  const requestCancel = (): void => {
    if (saving) return;
    if (session.dirty) setConfirmDiscard(true);
    else cancelEditSession();
  };

  // The viewer's Esc / backdrop / close bump editCancelNonce; react here so the
  // card (which owns the ConfirmDialog) runs the cancel flow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally fires only on the nonce; session.dirty + cancelEditSession are read live
  useEffect(() => {
    if (editCancelNonce > 0) requestCancel();
  }, [editCancelNonce]);

  const copyEdit = async (): Promise<void> => {
    const buffers = collectBuffers();
    const text = buffers.join("\n");
    try {
      await window.pivis.invoke("clipboard.writeText", { text });
      setCopied(true);
    } catch {
      /* best effort */
    }
  };

  let segmentIndex = 0;

  return (
    <div
      className="diff-edit-card"
      data-testid="diff-edit-card"
      style={{ ["--gutter-w" as string]: gutterW }}
    >
      {session.blocks.map((block) => {
        if (block.kind === "del") {
          const ln = model.lines[block.lineIdx];
          if (!ln || ln.type !== "del") return null;
          if (split) {
            return (
              <div
                className="diff-row diff-row--split diff-row--del diff-row--inert-del"
                key={`del-${block.lineIdx}`}
              >
                <div className="diff-row__comment-cell" />
                <div className="diff-row__num">{ln.oldNo}</div>
                <div className="diff-row__code">
                  {paintTokens(oldTokenByLineNo(ln.oldNo), ln.text)}
                </div>
                <div className="diff-row__num diff-row__num--right diff-row__num--empty" />
                <div className="diff-row__code diff-row__code--empty" />
              </div>
            );
          }
          return (
            <div
              className="diff-row diff-row--del diff-row--inert-del"
              key={`del-${block.lineIdx}`}
            >
              <div className="diff-row__comment-cell" />
              <div className="diff-row__num">{ln.oldNo}</div>
              <div className="diff-row__num diff-row__num--empty" />
              <div className="diff-row__marker" />
              <div className="diff-row__code">
                {paintTokens(oldTokenByLineNo(ln.oldNo), ln.text)}
              </div>
            </div>
          );
        }
        if (block.kind === "comment") {
          const comment = commentsForSession?.get(codeCommentKey(filePath, block.newNo));
          if (!comment) return null;
          return (
            <div
              className={`diff-comment-thread diff-comment-thread--inert${split ? " diff-comment-thread--split" : ""}`}
              key={`cmt-${block.newNo}`}
            >
              <div className="diff-comment-thread__rail" aria-hidden />
              <div className="diff-comment-thread__card">
                <div className="diff-comment-body">
                  <div className="diff-comment-body__meta">
                    <span>
                      {filePath}:{comment.lineNumber}
                    </span>
                  </div>
                  <div className="diff-comment-body__text">{comment.text}</div>
                </div>
              </div>
            </div>
          );
        }
        // edit segment
        const idx = segmentIndex++;
        const cursorForSegment =
          session.initialCursor?.segmentIndex === idx ? session.initialCursor : null;
        const autofocus =
          cursorForSegment !== null || (session.initialCursor === null && idx === 0);
        return (
          <div
            className={`diff-row${split ? " diff-row--split" : ""} diff-row--edit-segment`}
            key={`seg-${block.lineIdxs[0]}`}
          >
            <div className="diff-row__comment-cell" />
            {split ? (
              <>
                <div className="diff-row__num diff-row__num--empty" />
                <div className="diff-row__code diff-row__code--empty" />
                <div className="diff-row__num diff-row__num--right" />
              </>
            ) : (
              <>
                <div className="diff-row__num" />
                <div className="diff-row__num" />
                <div className="diff-row__marker" />
              </>
            )}
            <div className="diff-row__code">
              <SegmentEditor
                initialText={block.initialText}
                lang={lang}
                indentUnit={session.indentUnit}
                disabled={saving}
                autofocus={autofocus}
                initialCursorOffset={cursorForSegment?.offset ?? null}
                registerRef={(el) => {
                  taRefs.current[idx] = el;
                }}
                onDirty={markEditDirty}
                onSave={handleSave}
                onCancelRequest={requestCancel}
              />
            </div>
          </div>
        );
      })}

      <div className="diff-edit-card__footer">
        {session.phase === "conflict" && (
          <span className="diff-edit-card__message">File changed on disk.</span>
        )}
        {session.phase === "error" && (
          <span className="diff-edit-card__message">{session.errorMessage ?? "Save failed."}</span>
        )}
        {copied && <span className="diff-edit-card__message">Copied.</span>}
        {(session.phase === "conflict" || session.phase === "error") && (
          <button type="button" className="diff-edit-card__cancel" onClick={() => void copyEdit()}>
            Copy edit
          </button>
        )}
        <button
          type="button"
          className="diff-edit-card__cancel"
          onClick={requestCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="diff-edit-card__save"
          onClick={handleSave}
          disabled={!session.dirty || saving}
        >
          {saving ? "Saving…" : "Save"}
          {!saving && <span className="diff-edit-card__kbd">{isMac() ? "⌘↵" : "Ctrl↵"}</span>}
        </button>
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard edit?"
          message={`Your unsaved changes to ${basename} (lines ${session.startNewNo}–${session.endNewNo}) will be lost.`}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onConfirm={() => {
            setConfirmDiscard(false);
            cancelEditSession();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}

// ── Segment editor (layered pre + transparent textarea) ────────────────

interface SegmentEditorProps {
  initialText: string;
  lang: string | null;
  indentUnit: string;
  disabled: boolean;
  autofocus: boolean;
  initialCursorOffset: number | null;
  registerRef: (el: HTMLTextAreaElement | null) => void;
  onDirty: () => void;
  onSave: () => void;
  onCancelRequest: () => void;
}

function SegmentEditor({
  initialText,
  lang,
  indentUnit,
  disabled,
  autofocus,
  initialCursorOffset,
  registerRef,
  onDirty,
  onSave,
  onCancelRequest,
}: SegmentEditorProps): React.ReactElement {
  const [buffer, setBuffer] = useState(initialText);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(() =>
    tokenizeLinesSync(initialText, lang),
  );
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    registerRef(taRef.current);
    return () => registerRef(null);
  }, [registerRef]);

  useEffect(() => {
    if (!autofocus) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const cursor = Math.max(0, Math.min(initialCursorOffset ?? 0, initialText.length));
    ta.setSelectionRange(cursor, cursor);
  }, [autofocus, initialCursorOffset, initialText.length]);

  const retokenize = (text: string): void => {
    setTokens(tokenizeLinesSync(text, lang));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // IME composition: let the composition through; all custom handling waits.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const ta = e.currentTarget;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === "Escape") {
      // Claim Escape so neither the viewer-close branch nor the global
      // interrupt sees it; route to cancel-with-confirm (if dirty).
      e.stopPropagation();
      onCancelRequest();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const patch = indentEdit(
        ta.value,
        ta.selectionStart,
        ta.selectionEnd,
        indentUnit,
        e.shiftKey ? "out" : "in",
      );
      ta.setSelectionRange(patch.replaceStart, patch.replaceEnd);
      document.execCommand("insertText", false, patch.replacement);
      ta.setSelectionRange(patch.selStart, patch.selEnd);
      setBuffer(ta.value);
      retokenize(ta.value);
      onDirty();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const insertion = enterInsertion(ta.value, ta.selectionStart, indentUnit);
      document.execCommand("insertText", false, insertion);
      setBuffer(ta.value);
      retokenize(ta.value);
      onDirty();
    }
  };

  return (
    <div className="diff-edit-editor">
      <pre className="diff-edit-pre" aria-hidden>
        {paintOverlay(tokens, buffer)}
      </pre>
      <textarea
        ref={taRef}
        className="diff-edit-textarea"
        defaultValue={initialText}
        onKeyDown={handleKeyDown}
        onInput={(e) => {
          setBuffer(e.currentTarget.value);
          retokenize(e.currentTarget.value);
          onDirty();
        }}
        wrap="soft"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        disabled={disabled}
        aria-label="Edit selected lines"
      />
    </div>
  );
}

/** Paint the token overlay for a segment's pre, with a trailing-line sentinel so
 *  an empty/trailing-newline last line keeps its height (textarea parity). */
function paintOverlay(tokens: ThemedToken[][] | null, buffer: string): React.ReactNode {
  if (tokens === null) return buffer.endsWith("\n") || buffer === "" ? `${buffer} ` : buffer;
  const lines = tokens;
  const trailingNewline = buffer.endsWith("\n") || buffer === "";
  const parts: React.ReactNode[] = [];
  lines.forEach((toks, i) => {
    if (i > 0) parts.push("\n");
    parts.push(paintTokens(toks, ""));
  });
  if (trailingNewline) {
    if (lines.length > 0) parts.push("\n");
    parts.push(" ");
  } else if (lines.length === 0) {
    parts.push(buffer);
  }
  return parts;
}

/** Paint a single line's tokens as colored inline spans (same painting as the
 *  diff rows, so editor text is pixel-identical). Falls back to plain `text`
 *  when there are no tokens (unknown lang / cold highlighter). */
function paintTokens(tokens: ThemedToken[] | null | undefined, text: string): React.ReactNode {
  if (!tokens || tokens.length === 0) {
    return text.length === 0 ? " " : text;
  }
  return tokens.map((t, i) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are recreated per keystroke
      key={i}
      style={t.color !== undefined ? { color: t.color } : undefined}
    >
      {t.content}
    </span>
  ));
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform);
}
