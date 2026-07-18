# Inline diff editing

The diff viewer (`DiffViewerHost` / `DiffFileSection`) lets the user select one
or more lines in a file section, click the range-anchored **Edit selection**
action in the left diff rail, and edit those lines in place in a mini-editor
card with syntax highlighting and auto-indent, then **Save** to write the
working-tree file via a compare-and-swap IPC channel. The experience is
*mentally invisible*: zero layout shift on open, zero async work on the critical
open path, and visuals identical to the surrounding diff rows.

This doc is the routing target for any change touching the diff edit machinery.
Read it before editing `components/diff/DiffEdit*`, `lib/diff/{splice,
auto-indent,edit-range,edit-anchor}.ts`, the diff-store edit-session state, or
the `git.writeWorkingFile` IPC.

## Base-relative commit ranges

The header keeps separate compact controls: **BaseBranchDropdown** selects
HEAD or a branch, and **CommitRangePicker** is shown only for a concrete base
with at least one `git.commits` candidate. The base trigger contains only the
branch/HEAD name. The range trigger contains only **All changes**,
**Uncommitted**, **1 commit**, or **N commits**. Its popup offers **Uncommitted
changes** (HEAD through the live checkout) followed by the newest-first,
virtualized 500-candidate commit list; it has no header, guidance dead-end, or
Apply/Cancel footer. Both live scopes apply immediately without discarding the
selected base. **All changes** is the default and highlights every candidate
commit plus the **Uncommitted changes** pseudo-commit; it is a comparison label,
not a menu choice. When a narrowed selection is active, a contextual **Select
all** command restores this default. Pointer-down on a commit
starts a local visual selection (only that commit remains highlighted); dragging
then releasing commits the normalized inclusive `{start, end}` band and keeps
it open for inspection. Releasing on **Uncommitted changes** extends from the
anchor's parent through the live working tree (`{start, end,
includeUncommitted: true}`). Shift-click is the keyboard/mouse equivalent: its
anchor is the existing range start (or the oldest commit for **All changes**) and
its clicked endpoint commits immediately. A plain commit click applies a
one-commit range and closes the popup. This live extended-range mode is editable; ordinary historical
ranges are not. Outside click and Escape only dismiss the popup and never roll
back or otherwise change the committed comparison. `git.commits` returns immutable full object
IDs plus short SHA, subject, author, and author time, oldest-to-newest
internally.

`setComparison({base, range})` remains the single store transition: one equality
guard, invalidation/generation bump, per-session base persistence update, and
refresh. The compatibility `setBase` and `setCommitRange` methods delegate to
it. An ordinary range compares `start^` through `end`, so both endpoint commits
are included; an `includeUncommitted` range instead compares `start^` through
the live working tree.

Historical range mode is deliberately separate from working-tree mode:

- `git.changes` receives the selected base and immutable range. Main validates
  full canonical IDs and membership/order within the bounded first-parent path.
  It first proves the merge base itself lies on HEAD's first-parent chain;
  second-parent-only topologies are rejected rather than offering commits past
  a false boundary. Main then returns concrete `{parent, end}` object IDs with
  the manifest.
  `git.fileDiff` uses that context directly (while verifying it still matches
  `start^` and `end`) rather than re-resolving mutable refs, so lazy reads remain
  valid after branch movement or validation-cache eviction. Manual manifest
  refreshes carry the same context and rebuild from those concrete objects
  rather than mutable refs. Mutable base/HEAD range validation is deduplicated
  only while concurrent requests are in flight; settled successes are never
  cached, so every fresh range selection rechecks current first-parent topology. It reads both sides
  from git objects and pins Git's attribute source to the immutable range
  endpoint so later `.gitattributes` edits cannot alter historical binary
  classification. Main capability-checks `git check-attr --source`; Git older
  than 2.42 gets a clear unsupported-version error rather than silently using
  ambient attributes. Ambient disk changes and
  untracked files cannot leak into the result.
- Editing and code comments are disabled because a historical object diff has
  no writable working-tree side. An open comment editor registers immutable
  custody in the diff store, disabling and guarding base/range changes until the
  editor is saved or cancelled so its component-local draft cannot be unmounted.
  Comment reconciliation, working-tree
  auto-refresh, stale indicators, and badge semantics remain working-tree-only.
- Comparison generations fence late list, file, tokenization, and worker-search
  responses whenever base/range changes. Both ordinary lazy loads and
  worker-search fetches carry the manifest's immutable historical context. File
  contents remain lazy and search remains worker-backed with bounded concurrency.
  Historical blobs that pass the configured size check are streamed from
  `git cat-file` with that same byte bound instead of inheriting the 64 MiB
  metadata-command buffer.
- The chosen base remains remembered per session for the app run, but
  `commitRange` is ephemeral: opening and closing the viewer both clear it.
  Reopening therefore always starts at **Working tree**, as does selecting a
  different base.

Commit history is capped to the newest 500 candidates and rendered in compact
fixed-height rows with the shared virtual-list primitive, so long histories show
several useful subjects without mounting the full list. Historical changed-file
enumeration is streamed and stopped after the 501st descriptor; both browsing
and search manifests are capped at 500. Working-tree mode retains complete
descriptor-only search because its status enumeration has separate bounds.

## Diff rendering scalability

`DiffFileSection` renders browsing rows in bounded chunks (`DIFF_ROW_RENDER_CHUNK`) with a hard normal-browsing DOM ceiling (`DIFF_ROW_RENDER_MAX`) so pathological diffs cannot mount tens of thousands of row nodes. **Search discovery is never render-capped.** It covers every add/del row and hunk-context row, plus unchanged gap context the user explicitly revealed; only the still-collapsed middle of an unchanged gap is outside the logical diff projection. A match after the DOM ceiling is shown as a small targeted row island with an omitted-range notice, never by mounting every preceding row or growing `renderCap`.

Search uses `GitChangesResult.searchFiles`: the complete descriptor-only working-tree manifest, or the same bounded 500-file manifest as historical browsing. File contents remain lazy: `useDiffSearch` fetches at most two files concurrently and sends model construction/scanning to a Vite module worker. Normal/active file loading also builds its model through `diff-model.worker.ts`, so jumping to an uncached distant result does not run jsdiff on the renderer interaction task. Results return as per-file transferable `Int32Array` data, coalesced to at most one React update per animation frame, so React stores only compact batches and decodes the active occurrence on demand instead of flattening every match into objects on each render. Query, case, projection, base, refresh, viewer-close, and session changes dispose the old worker generation; unavoidable late IPC results are ignored. Partial counts use `N+ · X/Y files`, do not wrap navigation until complete, and explicitly report binary/too-large/failed files as unavailable instead of silently claiming complete coverage. See [ADR 0001](../decisions/0001-worker-backed-diff-search.md).

## Segment model

A selection covers a contiguous range of model line indices. It is projected
into an **ordered block sequence** (`lib/diff/edit-range.ts`):

- `{kind:"edit", lineIdxs, newNos, initialText}` — a run of editable
  context/add lines. Each segment owns one textarea; comments break segments,
  but removed lines do not. `initialText` is the editable model lines joined by
  `\"\n\"`.
- `{kind:\"del\", lineIdx}` — a legacy inert removed-line block. Newly resolved
  ranges do not emit these: removed lines inside a selection are hidden while
  editing, and removed lines at the top/bottom edge are trimmed out of the edit
  range entirely.
- `{kind:\"comment\", newNo}` — an inert comment thread row that stays in place
  while editing. A commented context/add line ENDS its editable segment so the
  thread row can sit exactly where it was (this is why a comment on the *last*
  selected line naturally \"stays\").

`resolveEditRange` returns `null` for a hidden (collapsed-gap) line inside the
range, or a range with zero context/add (editable) lines (del-only selection).
The diff selection entry point asks it to widen the selected slice to the
nearest non-whitespace editable line above and below. Intervening blank lines
come with that context; removed rows are skipped because they have no writable
new-side line. The original DOM selection still determines the initial
textarea selection, so typing replaces only what the user highlighted.

Selections that include removed lines usually still become one contiguous
editable block: the removed rows are suppressed, and the replacement lines are
exactly the concat of the edit-segment buffers (empty buffer → zero lines).

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

## Initial editor selection

The only edit entry point is a highlighted selection. Opening the card focuses
the edit segment containing the highlighted editable text and preserves that
highlight as the textarea selection, so typing immediately replaces the text the
user selected in the diff. If a browser selection spans multiple editable
segments (comments/deletions split textareas), the robust fallback focuses the
last highlighted editable character because a textarea selection cannot cross
segment boundaries. If the DOM selection has no selected editable characters
(for example a blank-line-only selection), the fallback is the end of the last
editable segment.

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
swatches). Because those token colors are baked into inline spans, each open
segment subscribes to the active color scheme and re-tokenizes its current
uncontrolled textarea value on scheme changes without marking the edit dirty.

The card adds **no flow chrome**: the background matches the diff code canvas,
the ring is an inset `box-shadow`, and the footer is absolutely positioned
wholly below the editable text plane. The file body reserves only the footer's
bottom overhang, so the action pill cannot cover code while opening the editor
still shifts no surrounding glyph.

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
  moves it with the selected range natively — no scroll listener, no per-frame
  repositioning, and scrolling never dismisses it. Its anchor is deterministic:
  the selected range's left action rail, vertically centered on the selected row
  span, with a subtle accent line spanning that range. It does not use
  collision-based text-adjacent placement, so it never appears to wander around
  the code and never covers highlighted text. The icon is an illuminated drawing
  rather than a filled pill, and transient add-comment hover icons are suppressed
  only on selected rows while it is visible so the selected rail has a single
  primary action. The accessible label is explicit (`Edit selection`) and the
  keyboard shortcut (`Cmd/Ctrl+I`)
  opens the same edit session while the bubble is visible.
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
