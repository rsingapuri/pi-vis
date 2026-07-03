# Important paths

## Important Paths

| Path | Purpose |
|---|---|
| `~/.pi/agent/sessions/` | Session files (JSONL format) |
| `~/.pi/agent/auth.json` | Auth credentials (api_key/oauth); read/written by `auth.ts` with proper-lockfile |
| `~/.pi/agent/settings.json` | Pi settings including `packages[]` for extension management |
| `~/.pi/agent/npm/node_modules/` | Installed pi extension packages |
| `~/Library/Application Support/pi-vis/settings.json` | App settings |
| `build/entitlements.mac.plist` | macOS hardened runtime entitlements for signing (allow-jit, allow-unsigned-executable-memory, disable-library-validation) |
| `.github/workflows/ci.yml` | CI workflow (typecheck, lint, test, build on push/PR) |
| `tests/e2e/electron-launch.mts` | Electron 43-compatible e2e launcher: spawns the Electron binary directly, strips `ELECTRON_RUN_AS_NODE`, enables CDP through `PIVIS_TEST_REMOTE_DEBUGGING_PORT`, tracks pids for teardown, and returns the minimal app handle used by the Playwright suites |
| `src/main/index.ts` | Main entry: BrowserWindow creation, IPC init, CSP, navigation hardening (external links open in OS browser, no in-app navigation); owns the `PIVIS_TEST_REMOTE_DEBUGGING_PORT` e2e seam used by `tests/e2e/electron-launch.mts` for Electron 43-compatible CDP launch |
| `src/renderer/src/components/ErrorBoundary.tsx` | React error boundary — catches render crashes without white-screening the app |
| `src/shared/ipc-contract.ts` | The typed IPC boundary — start here when adding new main↔renderer communication |
| `src/shared/pi-protocol/` | Source of truth for all pi RPC types |
| `src/main/git/worktree-names.ts` | Curated word lists + `generateWorktreeName()` for worktree branches |
| `src/main/git/git.ts` (`inspectWorktree`) | Validation helper for the attach flow — canonicalizes the candidate to its worktree toplevel + verifies same-repo via `--git-common-dir`. Called by both `worktree.validate` (live, advisory) and `session.attachWorktree` (authoritative). |
| `src/main/workspaces.ts` (`pickWorktreeDirectory`) | Native directory picker for the WorktreeBar's "Existing Worktree" segment — opens at the repo's sibling `<repoName>-worktrees` dir when it exists. |
| `src/renderer/src/components/common/BranchDropdown.tsx` | Presentational branch dropdown (search, keyboard nav, remote toggle) |
| `src/renderer/src/components/common/BranchDropdown.css` | Branch dropdown styles (extracted from DiffViewer.css) |
| `src/renderer/src/components/composer/WorktreeBar.tsx` | Pre-send worktree bar — 3-way segmented control (`In Workspace | New Worktree | Existing Worktree`) + mode-specific controls (branch dropdown for New, path input + Browse + live validation line for Existing) |
| `src/renderer/src/stores/tree-store.ts` | Conversation-tree viewer state — `openTreeForSession`/`navigateTo`/`setLabel` actions; degrades to `phase: "unsupported"` on RPC fallback or older pi versions |
| `src/renderer/src/components/tree/TreeViewerHost.tsx` | Native conversation-tree overlay (Catppuccin-themed) — tree rendering, current-leaf marker, filter modes, search, label add/edit, opt-in `summarize on switch` toggle |
| `src/renderer/src/components/tree/tree-flatten.ts` | Pure filter/search/fold flattening + display helpers for the tree overlay (`flattenVisible`, `entryDisplayText`, `roleGlyph`, `buildNestedTree` — flat→nested reconstitution of the wire `FlatTreeNode[]`); unit-tested in `tree-flatten.test.ts` |
| `src/main/sessions/history-loader.ts` (`entriesToTranscript`) | Pure helper that converts an ordered branch (root→leaf) of session-tree entries into the renderer-facing `TranscriptBlock[]` — reused by `/tree`'s navigate path to rebuild transcripts from pi's in-memory state without re-reading the session file |
| `src/renderer/src/components/composer/WorktreeBar.css` | WorktreeBar styles (segmented control, attach input, status line) |
| `src/renderer/src/components/session-header/SessionSubBar.tsx` | Compact-mode secondary controls strip |
| `src/renderer/src/components/session-header/SessionSubBar.css` | SessionSubBar styles |
| `src/shared/auth.ts` | Provider definitions (transcribed from pi's docs/providers.md) |
| `src/shared/updates.ts` | Update status types |
| `src/main/auth.ts` | Auth file management: read/write with proper-lockfile, env detection, fs.watch |
| `src/main/pty.ts` | Embedded terminal (node-pty) for OAuth login |
| `src/main/updates.ts` | Update checker + runner (spawns `pi update`) |
| `src/main/ipc.ts` | All IPC handler registrations |
| `src/renderer/src/stores/sessions-store.ts` | Primary renderer state — most UI logic lives here |
| `src/renderer/src/components/notifications/NotificationStack.tsx` + `NotificationStack.css` | Persistent in-session notification stack overlaying the transcript region; collapsed pile, expanded scroll/fade list, dismiss/clear actions |
| `src/renderer/src/stores/transcript.ts` | Event→block reducer — modify this to change how transcript renders |
| `src/renderer/src/stores/updates-store.ts` | Update notification + progress state |
| `src/renderer/src/lib/commands/` | Slash command definitions, parsing, and execution |
| `src/renderer/src/components/auth/LoginTerminal.tsx` | Embedded xterm.js terminal for pi's /login OAuth flow |
| `src/renderer/src/components/shell/Dock.tsx` + `Dock.css` | Above-composer **tray** — a bordered, rounded card (`.dock`, surface0 + `--border-strong`, rounded top + flat bottom, no bottom border) that **connects to the composer as a stacked-card pair**: it sits flush on the composer's input box, sharing the input box's top border as the seam. The composer flattens its top corners when the tray is present via a CSS-only `:has()` rule (`.session-dock:has(.dock) ~ .composer .composer__input-box`) — no dock-presence flag threaded through React. The **same connection applies to every card that can replace the Composer in its slot**: the custom panel (`.custom-panel`, incl. the `.unified-panel` variant), the built-in pickers (`.picker-slot .picker`), and the extension dialogs (`.ext-dialog-slot .ext-dialog`) all flatten their top corners and lift to `--border-strong` via the sibling `:has()` rule in `App.css`, so the stack reads as one connected unit regardless of which surface is mounted. The composer input box now carries an **always-visible** `--border-strong` border (was the faint `--border`) so it reads as a defined card unfocused, lifting to mauve on focus. Inside the tray each item is a **floating pill** (`.dock__widget` / `.dock__update`) on a **recessed `--ctp-base` fill** (darker than the surface0 tray — real contrast in both light/dark flavors; surface1 was too low-contrast) + `--border-strong`. Collects every above-composer notification/control: one pill per extension `setWidget` key (sorted, `Map<string,string[]>` lines via AnsiText, left) + the update pill (right, `margin-left: auto`); pills `flex-wrap` and keep a stable order (reserved trailing slot for a future Input/Extension toggle). **Returns `null` when empty** so there is never a phantom box. The update pill's detail list (`ExtensionRow`s) opens as a **floating popover anchored above the pill** so expansion never reflows the tray height; the popover claims ESC (`useEscapeClaim`) + closes on ESC/outside-click. The Dock renders below the `WorktreeBar` in `.session-dock` (adjacent to the composer). Replaces the old stacked UpdateBanner card + `.composer__widget-strip` |
| `src/renderer/src/components/shell/UpdateBanner.tsx` | **Floating-only** update card for the empty (no-session) screen (bottom-right). The in-session update notification moved to the Dock chip rail. Still dispatches the `pivis:run-update` CustomEvent and honors `lastDismissedPiVersion` |
| `src/renderer/src/components/common/viewer-header.css` | Shared overlay **viewer-header reflow** consumed by both DiffViewerHost and TreeViewerHost (alongside their own `__header` classes): a left cluster (title + context, `flex: 1 1 auto; min-width: 0`, shrinks/ellipsizes) + right cluster (action controls + essential `×` close, `flex: 0 1 auto; margin-left: auto`). The header `flex-wrap: wrap`s, so at narrow widths the right cluster drops to a second row and stays right-pinned — controls never clip. The tree's search input flexes (6–14rem) so it gives way before the close button does |
| `src/renderer/src/components/updates/UpdateProgress.tsx` | Modal streaming `pi update` output |
| `RELEASING.md` | macOS signing, notarization, and release build/publish docs |
| `scripts/install.sh` | End-user `curl \| bash` installer: fetches the latest release's `*-mac.zip`, installs to `/Applications`, strips quarantine (sidesteps Gatekeeper pre-notarization) |
