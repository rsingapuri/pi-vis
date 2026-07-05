# Sidebar and shell layout

### Workspace sidebar ordering & expand state

The sidebar renders workspaces in **manual order** — the user drags a hover-revealed
grip handle on a workspace row to reorder, and the new order is persisted to
`settings.workspaceOrder` (`src/shared/settings.ts`). Ordering is **stable across
restarts**: nothing reorders workspaces on close/reopen. A newly-picked workspace
(via `+` → Open Workspace) is **appended to the bottom** and **auto-expanded** —
never prepended to slot 0 (the old `recentWorkspaces` recency-sort behavior was
dropped because ambient activity mutating order is a bug, not a feature). The main
process (`src/main/workspaces.ts`) prunes paths that no longer exist on disk on read,
without reordering survivors (pruning ≠ reordering).

**Multiple workspaces can be expanded simultaneously** (`settings.expandedWorkspaces`):
each workspace header has a chevron that toggles its session-list visibility
independently, so the user can monitor recent sessions across workspaces at once.
Expand state is decoupled from the active workspace: clicking the header **activates**
a workspace (sets focus + opens/switches to a session in it) and **never collapses**
it — collapse is via the chevron only, so an active workspace can stay expanded while
the user works in another expanded one. `activeWorkspacePath` (focus/active CSS) and
`expandedWorkspaces` (session-list visibility) are independent concerns in
`sessions-store.ts`; `setActiveSession` derives `activeWorkspacePath` from the session's
workspace. The `workspace.list` IPC channel (renamed from `workspace.recents`)
returns the ordered, existence-pruned list.

**Pinned sessions** (`settings.pinnedSessions`, a global array of session-file paths):
a pinned row floats to the TOP of its workspace's session list, above the
activity-sorted rows, in persisted manual order. Each row has a pin button (hover-
revealed when unpinned, always-visible accent-filled when pinned); pinning appends
to the array (lands at the bottom of the pinned group), and pinned rows are
HTML-draggable to reorder within the group (drop targets only exist on pinned
rows, so the group is self-contained). The array is global across workspaces — each
workspace view renders only its own keys in their relative order. Keyed by file
path (stable across relaunch and shared by the live row and its stored counterpart,
so a pin survives the live→stored idle-eviction transition). Stale keys are filtered
at render, not pruned, matching `archivedSessions`' trade-off. Because pinned rows
sit at the front of the unified list and pagination slices from the front
(`visibleSessions = unifiedSessions.slice(0, visibleCount)`), pinned rows are never
pushed off the first page by newer unpinned sessions.

### Shell layout (canvas + floating content card)

The window is a single unified **canvas** (`.app` background = `mantle`). The title bar
and sidebar have **no borders** — they're the top and left strips of that canvas, the
same color. The content area (`.app__main`) is a **floating, rounded card** (`base`
background, hairline border, `--radius-lg`, `--elevation-1`) inset from the canvas by a
`--space-2` gap on the left (from the sidebar), right, and bottom, and flush under the
38px title bar. `overflow: hidden` on the card clips every full-width strip inside it
(transcript, worktree bar, composer, status bar) to the rounded corners, so none of them
form hard outer 90° seams — that grid-of-rectangles look was the thing being replaced.
Setup mode (`.app--setup`, `PiNotFound`) renders directly in `.app`, not `.app__main`,
so it keeps its full-screen centered treatment. In-session notifications live inside
`.transcript-region` (the positioned transcript wrapper) so they overlay only the scrollable
transcript and stop before the composer; the model/thinking dropdowns anchor in the title bar
(outside the card) so they're never clipped.

### Responsive layout system

The app is fully usable from the enforced floor (`minWidth: 480`, `minHeight: 400` in
`main/index.ts`) up to any size. Three independent mechanisms:

- **Collapsible sidebar**: a toggle in the title bar (`TitleBar.tsx`) and `Cmd/Ctrl+B`
  flip `settings.sidebarCollapsed` (persisted). When collapsed, hovering either the
  far-left edge reveal strip or the title-bar toggle temporarily peeks the sidebar as
  an overlay. Collapsed → the grid's sidebar column becomes `0` and `.sidebar` is
  removed from layout. The grid track is
  `min(var(--sidebar-width), 38%)` so even expanded the sidebar can never eat more than
  ~⅓ of a narrow window (a no-op on normal windows). `sidebarWidth` is persisted too;
  App keeps a live local copy for smooth dragging and writes to settings on drag-end.
- **Compact title bar**: the SessionSubBar reflow described above.
- **Title bar layout**: the session name is left-aligned and sized to its text
  (`flex: 0 1 auto`, not `1`) — a modern editor convention, and it leaves the slack to
  its right as part of the title bar's `-webkit-app-region: drag` region. The
  worktree chip lives with the right-side controls (before the unified view toggle
  and changes/diff button), not beside the title. Only the name button / chip /
  controls are `no-drag`. In sidebar-visible mode, the left
  traffic-light clearance leaves a real gutter before the sidebar toggle; in collapsed
  mode, the floating pill's extra breathing room is its outer inset, not extra internal
  padding on the end controls. The collapsed floating pill uses a border but no
  side-casting shadow, so it doesn't read as a stray fade over the transcript. A
  full-width centered title would otherwise cover the whole bar as a no-drag element,
  leaving nothing to grab the window by.
- **Fluid transcript**: `.app__main` is a size-query container (`container: mainpane /
  inline-size`). The transcript's horizontal padding scales with the pane via
  `clamp(--space-5, 6cqi, --space-8)`. **One uniform, centered reading column** is
  set once on `.transcript-blocks` (`max-width: var(--transcript-measure)` =
  60rem ≈ 840px — wider than a pure-prose measure because the surface mixes prose
  with code blocks/diffs/tool cards; `margin-inline: auto`), shared by every block type (assistant
  text, user bubbles, tool cards, code blocks, thinking) so the line length never
  grows unbounded on a wide monitor and every element reads as a single coherent
  width; below the measure the column shrinks to fill the pane (the `cqi` side
  padding supplies gutters). There are no per-type percentage caps anymore — user
  bubbles right-align within the column at ~85% to keep the "mine" asymmetry. The
  empty-state outer padding is likewise `cqi`-scaled. Transcript notifications live
  inside `.transcript-region` (a positioned flex wrapper around `TranscriptView`), so
  the container's layout containment doesn't affect them and they never reserve
  horizontal space.
- **Overflow containment**: the app grid's content column is `minmax(0, 1fr)`
  (and collapsed mode uses `minmax(0, 1fr)` too), with `min-width: 0` on the
  title bar, main card, session, transcript region, and rigid dock/composer
  slots. This is load-bearing: otherwise a long title/FadeText or other
  min-content-sized child can widen the grid during sidebar collapse and make
  the title bar/main pane clip against the viewport instead of shrinking. The
  transcript feed and the sidebar list are vertical scrollers, so both set
  `overflow-x: hidden` — a long unbreakable token (a file path or identifier in
  inline code) or a wide row must never spawn a horizontal scrollbar on the
  whole pane. Wide things instead either wrap (`.transcript-block__content` /
  `.inline-code` use `overflow-wrap: anywhere`; blocks carry `min-width: 0`) or
  scroll inside their own box (code blocks, and markdown tables via `display:
  block; width: max-content; overflow-x: auto`). `::-webkit-scrollbar-corner`
  is transparent so the corner where two scrollbars meet doesn't render as a
  light square.
