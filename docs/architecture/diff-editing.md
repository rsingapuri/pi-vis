# Inline diff editing

The diff viewer (`DiffViewerHost` / `DiffFileSection`) lets the user select one
or more lines in a file section, click a floating **Edit** bubble, and edit
those lines in place in a mini-editor card with syntax highlighting and
auto-indent, then **Save** to write the working-tree file via a compare-and-swap
IPC channel. The experience is *mentally invisible*: zero layout shift on open,
zero async work on the critical open path, and visuals identical to the
surrounding diff rows.

This doc is the routing target for any change touching the diff edit machinery.
Read it before editing `components/diff/DiffEdit*`, `lib/diff/{splice,
auto-indent,edit-range,edit-anchor}.ts`, the diff-store edit-session state, or
the `git.writeWorkingFile` IPC.

## Segment model

A selection covers a contiguous range of model line indices. It is projected
into an **ordered block sequence** (`lib/diff/edit-range.ts`):

- `{kind:"edit", lineIdxs, newNos, initialText}` — a run of editable
  context/add lines. Each segment owns one textarea; dels and comments break
  segments. `initialText` is the model lines joined by `\"\n\"`.
- `{kind:\"del\", lineIdx}` — an inert, dimmed, read-only removed line. Still
  selectable/copyable (that is the \"restore a deleted line\" affordance) but
  never editable, and never re-enters the file on save.
- `{kind:\"comment\", newNo}` — an inert comment thread row that stays in place
  while editing. A commented context/add line ENDS its editable segment so the
  thread row can sit exactly where it was (this is why a comment on the *last*
  selected line naturally \"stays\").

`resolveEditRange` returns `null` for a hidden (collapsed-gap) line inside the
range, or a range with zero context/add (editable) lines (del-only selection).

The editable text is therefore a **sequence of segments** around the inert
rows — not one textarea. On save the replacement lines are the concat of the
edit-segment buffers (empty buffer → zero lines).

## Freeze semantics

While an edit session is open for file F (one editor at a time):

- `handleChangesResult` reuses F's previous `FileState` **verbatim** regardless
  of `fileSig`, keeps F's `GitChangedFile` entry (at its old index) if it
  vanished from `git.changes`, and sets `queuedRefresh` when F's sig changed or
  it disappeared.
- `ensureFileLoaded` early-returns for F.
- Close/cancel flushes `queuedRefresh` via `refresh()`.
- The viewer's auto-refresh on `agent_end` / window focus therefore cannot
  touch a file being edited.

## CAS save protocol

Save writes directly to the working tree via the `git.writeWorkingFile` IPC
(`src/main/git/git.ts` `writeWorkingFile`). It is a **compare-and-swap**:

1. `replacementLines` = concat of edit-block buffers (empty → 0 lines).
2. `nextNewText = spliceNewLines(baseNewText, startNewNo, endNewNo, replacementLines)`.
3. `expectedHash` = sha256 hex of `baseNewText` (UTF-8) — symmetric with main's
   `createHash(\"sha256\").update(Buffer.from(current, \"utf8\"))`.
4. `invoke(\"git.writeWorkingFile\", { root, path, content: nextNewText, expectedHash })`.
5. `ok` → **commit** (see below).
6. `conflict` → re-fetch `git.fileDiff`; `findUniqueBlock` (the model splitter)
   locates the original edited block in the fresh text; unique → recompute
   range/hash against the fresh base, **retry once** (success → commit against
   the fresh base); else `phase = \"conflict\"` (footer: message + Copy edit +
   Cancel). Ambiguous/absent block → no retry.
7. `error` → `phase = \"error\"`, message in footer with Retry/Cancel.

Main rejects absolute paths, `..`-escaping paths, symlinks (`lstat`, never
followed), and non-regular files as `error`; ENOENT and hash mismatch are
`conflict`. The TOCTOU window between read and write is accepted (single-user
desktop; the working-tree fingerprint catches concurrent losers).

### Single-commit save (no flash)

`commitSave`:

1. `newModel = buildDiffModel(oldText, nextNewText)` (old side is unchanged).
2. `newTokens = await tokenizeLines(nextNewText, lang)` (warm → effectively
   synchronous; seeded from existing `FileState.newTokens` for the first paint).
3. `newGapState = carryGapState(newModel, visibleOldLineNos(oldModel, oldGapState))`
   — revealed gaps stay revealed (save never changes the old side, so old-side
   line numbers key gap visibility).
4. `applyDiffEditReanchor(...)` **FIRST** (invariant 7) — the edit-aware comment
   pass commits before the new model becomes visible, so the generic
   `reconcileDiffCommentsForFile` sees consistent anchors and no-ops.
5. ONE store `set()`: the new `FileState` Map entry `{ ...prev, model, newText,
   newTokens, gapState }` and `editSession: null`; the file generation is bumped
   to discard in-flight tokenization.
6. The path is added to closure-level `justSavedPaths`, then `void refresh()`.
   `handleChangesResult` reuses the just-saved FileState verbatim (WE are the
   change) and clears the mark — this kills the \"Loading…\" flash and
   re-baselines the fingerprint so the stale dot stays dark.

## Comment re-anchor (invariant 6)

`reanchorCommentsForEdit` (`lib/diff/edit-anchor.ts`) is deterministic because
it knows the exact edit (no fuzzy text-match):

- **above-range**: untouched.
- **below-range**: `lineNumber` **and** `originalLineNumber` += delta, with
  `anchorStatus` preserved (no new \"relocated\"/\"stale\" badges from
  renumbering alone).
- **in-range, text survives uniquely** in the replacement → renumber to that
  line, keeping status.
- **in-range, unmatched** → `stale`, lineNumber clamped to the new file length,
  nearest-free-line walk on key collision.

This is strictly better than letting the generic reconcile guess (which would
mark every below-range comment \"relocated\", or \"stale\" for non-unique text
like `}`).

## Splice (byte-exact, invariant 3)

`spliceNewLines(rawText, startNewNo, endNewNo, replacementLines)`
(`lib/diff/splice.ts`) splices by **character offsets** into raw `newText`,
never splitting/rejoining the whole file. Bytes outside the replaced range
(EOL style incl. CRLF, BOM, missing final newline) are preserved byte-for-byte.
Replacement lines join with the region-dominant EOL (file-dominant fallback). A
trailing EOL is appended iff the replaced region's last line had one.

Buffers seed from **model line text** (CR-free); the splice works on **raw
`newText` offsets**. `splitAndNormalizeLines` is exported from `diff-model.ts`
so conflict re-anchor splits fresh text with the exact same rule.

## Cursor placement

The only edit entry point is a highlighted selection. Opening the card focuses
whichever edit segment contains the last highlighted editable character and
places the cursor immediately after that character. If the DOM selection has no
selected editable characters (for example a blank-line-only selection), the
robust fallback is the end of the last editable segment.

## Editor (layered, invariant 14)

The card (`components/diff/DiffEditCard.tsx`) renders a layered editor per
segment (react-simple-code-editor technique): one shared metrics class on BOTH
an in-flow `<pre>` (Shiki tokens, sync via `tokenizeLinesSync` + the warm
singleton) and an absolute transparent `<textarea>`. The pre determines the
wrapper's auto height (with a trailing `\"\n \"` sentinel so an empty last line
keeps height); the textarea overlays it. Textareas are uncontrolled
(`defaultValue`); programmatic insertions (auto-indent, Tab) go through
`document.execCommand(\"insertText\")` so native undo survives, and `.value` is
never assigned after mount. All custom key handling early-returns during IME
composition. Editor text uses the same Shiki token → inline-color span painting
as the diff rows, so it is pixel-identical (semantic tokens only — no palette
swatches).

The card adds **no flow chrome**: the ring is an inset `box-shadow` and the
footer is absolutely positioned. Opening it shifts no surrounding glyph.

## Keyboard / ESC ownership (invariants 11–13)

Inside a segment textarea: `Enter` → newline + auto-indent
(`enterInsertion`); `Tab`/`Shift+Tab` → indent/dedent each line (`indentEdit`);
`Cmd/Ctrl+Enter` → Save; `Escape` → `stopPropagation` (CommentEditor pattern)
so neither the viewer-close branch nor the global interrupt sees it, then
cancel (dirty → `ConfirmDialog(\"Discard edit?\")`). The viewer's Escape branch
and backdrop click, while a session exists, bump `editCancelNonce`; the card
watches it and runs its cancel flow (confirm if dirty). `ConfirmDialog` claims
ESC itself.

The bubble appears when (invariant 13): the selection is non-collapsed, its
selected characters land on `data-line-idx` rows in exactly ONE file, the file
is `ready` + `model.kind === \"ok\"`, contains ≥1 non-removed (context/add)
line, and no edit session is open. It is intentionally permissive about
selection endpoints, collapsed-gap boundaries, and split-view side: if the
highlighted selection includes any editable working-tree text, the affordance
appears. The only exclusions are del-only selections and selections whose
characters genuinely span multiple files.

Controller rules that keep it permissive and non-disruptive
(`DiffEditBubble.tsx`):

- **Never resolve or render mid-drag.** The bubble is the last child of
  `.diff-content` in DOM order; rendering it under a moving cursor lets the
  browser extend the selection into it, jumping the highlight across the
  pane. A document-level mousedown sets a drag flag (and hides any stale
  bubble); resolution runs on mouseup, and on `selectionchange` only when the
  mouse is up (keyboard selections). The bubble is also `user-select: none`.
- **Boundary trimming.** A full-line drag parks the selection focus at offset
  0 of the NEXT row — or in the next file's header. Rows the selection merely
  touches with zero selected characters are trimmed (blank-line rows are
  kept), and a file with no qualifying rows doesn't count toward the one-file
  rule. The row containing the selection ANCHOR is never trimmed: starting a
  drag past the end of a line selects none of its characters, but the user
  deliberately started there — the artifact is always on the focus side.
- **The bubble rides with the content.** It is absolutely anchored in
  `.diff-content` coordinates (the pane is `position: relative`), so scrolling
  moves it with the text natively — no scroll listener, no per-frame
  repositioning, and scrolling never dismisses it.
- **Resilient to row re-renders under the selection.** If the selection's
  client rects come back degenerate mid-resolve (rows rebuilding underneath
  it), the bubble keeps its previous position instead of unmounting — tearing
  the element down restarts its entry animation, and repeated churn would pin
  it at opacity 0.
- **Escape dismisses the bubble only.** The bubble's capture keydown consumes
  Escape (`stopImmediatePropagation`) while visible; the host's Escape branch
  also skips `closeViewer` when a bubble is in the DOM.
- **Collapsed gaps don't disqualify.** The bubble passes every model index as
  visible to `resolveEditRange`; a gap-crossing selection opens a card that
  reveals the hidden context lines, and RowsView suppresses gap rows whose
  line range overlaps the edit range while the card is open.

## Split view caveat

In split view the card spans the full row width keeping the split grid
template; the old column renders frozen and the new column hosts the block
sequence. A block with unequal left/right wrap heights repacks slightly —
inherent to editing one side of a row-paired layout. (Precedent: split comment
threads already span `grid-column: 3 / -1`.)
