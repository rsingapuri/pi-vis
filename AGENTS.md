# AGENTS.md — Pi-Vis Codebase Guide

## What Is This App?

**Pi-Vis** is an Electron desktop GUI for the [pi.dev](https://pi.dev) coding agent CLI. It provides a graphical interface for multiple parallel pi sessions with a workspace sidebar, diff viewer, extension dialog support, and a Catppuccin-themed UI. Each session spawns `pi --mode rpc` as a subprocess and communicates over JSONL on stdin/stdout with correlated RPC request IDs.

- **App ID:** `dev.pivis.app`
- **~20K lines** of TypeScript/CSS across `src/`
- **Platforms:** macOS (primary, dmg/zip), Windows (nsis), Linux (AppImage/snap)

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Electron app with HMR |
| `npm run dev:renderer` | Renderer-only at localhost:5173 with stub pivis API |
| `npm run build` | Typecheck + electron-vite build |
| `npm run dist` | Build + electron-builder (mac dmg/zip) |
| `npm test` | Unit tests (vitest) |
| `npm run test:e2e` | E2E smoke tests (playwright) |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run lint` | Biome linter |
| `npm run format` | Biome formatter |

## Code Structure

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # Entry: BrowserWindow creation, IPC init, settings/window persistence, background update check, CSP, navigation hardening (external links open in OS browser)
│   ├── ipc.ts               # All ipcMain.handle() registrations — the main-process API surface (auth, pty, updates)
│   ├── auth.ts              # Auth file management: read/write ~/.pi/agent/auth.json with proper-lockfile, login-shell env detection, fs.watch
│   ├── pty.ts               # Embedded terminal (node-pty) for pi /login OAuth flow
│   ├── updates.ts           # Update checker (pi.dev/api/latest-version) + runner (spawns `pi update`)
│   ├── settings-store.ts    # Reads/writes ~/Library/Application Support/pi-vis/settings.json
│   ├── workspaces.ts        # Workspace picker (OS dialog), manual ordering (workspaceOrder), multi-expand tracking
│   ├── pi/                  # Pi subprocess management
│   │   ├── pi-process.ts    # Wraps a single `pi --mode rpc` child process; spawned with login-shell env (PATH etc.); correlated RPC over JSONL
│   │   ├── jsonl-stream.ts  # Byte-level JSONL parser (splits on \n only, never Unicode separators)
│   │   └── locate-pi.ts     # Finds pi binary via $SHELL/which/override; validates `--version` with login-shell env (pi's `env node` shebang needs node on PATH); caches result
│   ├── sessions/            # Session lifecycle
│   │   ├── session-registry.ts   # SessionId → PiProcess lifecycle; MAX_IDLE_PROCESSES=10
│   │   ├── session-discovery.ts  # Scans ~/.pi/agent/sessions/ for workspace-linked session files; extracts per-session `lastActiveAt` (newest user-message timestamp) used as the persistent sidebar sort key (preferred over file mtime, which passive opens bump)
│   │   └── history-loader.ts     # Reads session JSONL files into TranscriptBlock[]
│   └── git/
│       └── git.ts           # Git diff/changes via child_process; worktree-aware
│
├── preload/
│   └── index.ts             # contextBridge exposing typed `window.pivis` API (invoke + on)
│
├── renderer/src/            # React 19 SPA
│   ├── App.tsx              # Root: wires IPC event listeners, layout (TitleBar + Sidebar + main area)
│   ├── main.tsx             # React entry; wraps <App> in a top-level ErrorBoundary; preview-stub only loads when import.meta.env.DEV
│   ├── preview-stub.ts      # Stubs window.pivis for standalone browser dev (demo session + streaming)
│   ├── components/
│   │   ├── composer/        # Textarea input: prompts, !bash, /slash commands, image attach, autocomplete
│   │   ├── transcript/      # TranscriptView, DiffBlock (renders user/assistant/tool_call/bash/compaction blocks)
│   │   ├── shell/           # TitleBar, Sidebar (workspace switcher with manual drag-reorder + multi-expand chevrons, session list, tabs, drag/drop), StatusBar,
│   │   │                   #   UpdateBanner (compact dismissible update card: above the composer in a session, floating bottom-right on the empty screen)
│   │   ├── auth/            # LoginTerminal (embedded xterm.js terminal for pi's /login OAuth flow)
│   │   ├── updates/         # UpdateProgress (modal with streaming `pi update` output via AnsiText)
│   │   ├── diff/            # DiffViewerHost, DiffFileSection (Shiki-highlighted unified/split diffs)
│   │   ├── ext-ui/          # ExtensionDialogHost (select/confirm/input/editor dialogs + toasts)
│   │   ├── ErrorBoundary.tsx # React error boundary (reloadable card) — used at TWO levels: top-level in main.tsx (whole shell) + per-session in App; prevents render crashes from white-screening
│   │   ├── pickers/         # AppPickerHost (model picker, thinking level picker)
│   │   ├── session-header/  # SessionHeader (model dropdown, thinking level, token stats, session name)
│   │   ├── settings/        # SettingsView (fonts, pi path, color scheme, diff view mode, Account, Updates)
│   │   └── setup/           # PiNotFound (shown when pi binary can't be located)
│   ├── stores/              # Zustand stores
│   │   ├── sessions-store.ts   # Primary store: SessionViewState per session, transcript, streaming, pickers, workspace order + multi-expand (workspaceOrder/expandedWorkspaces decoupled from activeWorkspacePath)
│   │   ├── transcript.ts       # Reducer: PiEvent → TypedTranscriptBlock[] (pending-echo matching; O(1) per-token streaming patch; compaction-trimmed to bound memory)
│   │   ├── diff-store.ts       # Diff viewer state: file list, Shiki tokenization, expand/collapse gaps
│   │   ├── settings-store.ts   # Renderer mirror of AppSettings with font/scheme application
│   │   └── updates-store.ts    # Update status + active-run state for the in-app update system
│   ├── lib/
│   │   ├── commands/        # Slash command system (builtins mirror pi's TUI, parser, executor, model resolver)
│   │   ├── diff/            # Diff model (hunk parsing, gap computation), Shiki tokenizer, intraline diff
│   │   ├── shiki.ts         # Shiki highlighter singleton (lazy init, Catppuccin themes)
│   │   ├── markdown.tsx     # react-markdown with remark-gfm + Shiki code blocks
│   │   ├── ansi.tsx         # ANSI escape code → React (for terminal output rendering)
│   │   └── format.ts        # Token/cost formatting helpers
│   └── theme/
│       ├── catppuccin.ts    # Latte/Frappé/Macchiato/Mocha palette definitions
│       └── theme.css        # CSS variables from Catppuccin
│
└── shared/                  # Shared types (imported by main, preload, and renderer)
    ├── auth.ts              # ProviderAuthStatus, PROVIDERS constant (transcribed from pi's docs/providers.md), AuthCredential
    ├── updates.ts           # PiUpdateStatus, ExtensionUpdate, UpdateStatus types
    ├── ipc-contract.ts      # Typed IPC surface: IpcInvokeContract (request/response) + IpcEventContract (push events)
    ├── pi-protocol/         # Zod schemas for the pi RPC protocol
    │   ├── commands.ts      # PiRpcCommand (prompt, steer, abort, set_model, bash, compact, etc.)
    │   ├── events.ts        # PiEvent (agent_start/end, message_*, tool_execution_*, compaction_*, etc.)
    │   ├── responses.ts     # PiRpcResponse, SessionState, ModelInfo, SessionStats, SlashCommandInfo
    │   ├── extension-ui.ts  # ExtensionUiRequest/Response (select, confirm, input, editor, notify, setStatus, setWidget, setTitle, set_editor_text)
    │   ├── messages.ts      # Wire message types
    │   └── thinking.ts      # ThinkingLevel enum + schema
    ├── ids.ts               # Branded types: SessionId, RpcRequestId; ID generators (timestamp+counter)
    ├── settings.ts          # AppSettingsSchema (Zod): fonts, paths, workspaceOrder + expandedWorkspaces, lastActiveWorkspace, color scheme, diff mode, sidebar width/collapsed, window bounds
    ├── git.ts               # GitChangedFile, GitChangesResult, GitFileDiffResult types
    ├── result.ts            # Result<T,E> utility + assertNever
    └── session-file/        # Session file format schemas (header, message/model-change/snapshot entries)
```

## Architecture

### Three-Process Electron Model

```
┌─────────────┐     IPC (typed)      ┌───────────┐    JSONL/stdin/stdout    ┌────────────┐
│  Main Proc   │ ◄──────────────────► │ Renderer  │ ──────────────────────► │ pi --mode   │
│ (Node.js)    │   contextBridge      │ (React)   │                         │   rpc       │
│              │   window.pivis       │           │                         │ (subprocess)│
└─────────────┘                      └───────────┘                         └────────────┘
     ▲ Preload exposes typed pivis API
     │ IPC channels defined in shared/ipc-contract.ts
```

- **Main process** manages pi subprocess lifecycle, git operations, settings persistence, workspace discovery
- **Preload** exposes `window.pivis.invoke(channel, args)` and `window.pivis.on(channel, callback)` via contextBridge
- **Renderer** is a React SPA using Zustand for state. No Electron APIs accessed directly.

### IPC Contract (`shared/ipc-contract.ts`)

**Invoke channels** (request/response):
- `pi.locate` — find pi binary
- `workspace.pick` / `workspace.list` / `workspace.remove` / `workspace.listSessions`
- `session.open` → `{ outcome: "opened"|"existing"|"missing", sessionId, ... }`
- `session.activate` / `session.reload` / `session.close` / `session.loadHistory`
- `session.sendCommand` — sends PiRpcCommand, returns PiRpcResponse
- `session.respondToUiRequest` — sends ExtensionUiResponse back to pi
- `settings.get` / `settings.set`
- `git.changes` / `git.fileDiff` (both accept optional `base?: string` for branch-relative diffs). `git.changes` also returns a `fingerprint` — a content hash of the working tree vs HEAD (always HEAD, regardless of `base`) plus untracked contents — that the diff viewer uses to detect whether tool calls actually changed files. This is the heavyweight path (file list + line counts + the full-patch fingerprint), reserved for the **open** viewer and its staleness probe.
- `git.changesCount` — lightweight changed-file **count** for the header badge while the viewer is **closed**. A single `git status --porcelain=v2 -z --untracked-files=all` scan (one working-tree walk), no line counts / fingerprint / file reads — so the every-tool-call badge refresh stays cheap on huge repos. Capped at the same `MAX_FILES` limit as `git.changes`.
- Perf notes: `getChanges`/`getFileDiff` run their independent git reads concurrently and pass `GIT_OPTIONAL_LOCKS=0` (read-only, no index.lock churn). The renderer's badge refresh is **single-flight** (`diff-store`): at most one scan runs at a time, and requests arriving mid-scan coalesce into one trailing scan — so overlapping multi-second scans can't pile up.
- `git.branches` — list local + remote branches
- `session.createWorktree` — creates a git worktree from a base branch and re-spawns the pi process into it
- `app.versions`
- `auth.status` / `auth.saveApiKey` / `auth.remove`
- `pty.start` (with optional `cols`/`rows` for viewport matching) / `pty.write` / `pty.resize` / `pty.kill`
- `update.check` / `update.run`

**Event channels** (main → renderer push):
- `session.event` — PiEvent (streaming transcript events)
- `session.uiRequest` — Extension UI requests (dialogs, toasts, status bar, widgets)
- `session.statusChanged` — SessionStatus transitions
- `session.fileChanged` — session file association updated
- `auth.changed` — auth.json modified externally (e.g. pi's token refresh)
- `pty.data` / `pty.exit` — embedded terminal I/O
- `update.available` / `update.progress` / `update.done` — update lifecycle

### Pi RPC Protocol (`shared/pi-protocol/`)

Pi runs in `--mode rpc` with JSONL on stdin/stdout. Every command has a unique `id` for correlation. Key types:

- **Commands** (renderer → pi): `prompt`, `steer`, `follow_up`, `abort`, `bash`, `set_model`, `set_thinking_level`, `new_session`, `fork`, `clone`, `compact`, `get_commands`, `get_state`, `get_session_stats`, etc.
- **Events** (pi → renderer): `agent_start/end`, `turn_start/end`, `message_start/update/end` (with nested `text_delta`/`thinking_delta` streaming), `tool_execution_start/update/end`, `compaction_start/end`, `queue_update`, `thinking_level_changed`, `session_info_changed`, `extension_error`
- **Extension UI**: pi extensions request UI via `ExtensionUiRequest` (select/confirm/input/editor dialogs, or fire-and-forget notify/setStatus/setWidget/setTitle/set_editor_text). Dialogs block until renderer responds via `session.respondToUiRequest`.

### State Management

All renderer state uses **Zustand** stores:

- **`sessions-store`** — The primary store. Maps `SessionId → SessionViewState` (transcript, streaming status, pending dialogs, status segments, widgets, stats, model info, thinking level, commands, worktreeCreate/worktreeBase/worktreePath/worktreeBranch/worktreeName/worktreeFromBase for worktree-per-session). Handles all mutations via IPC calls + local state updates. Export `gitRootForSession(session)` helper that returns the worktree path if set, else the workspace path — used by the diff viewer and changes badge.
- **`transcript.ts`** — Reducer (not a store). `applyPiEvent(state, event) → TranscriptState` transforms pi streaming events into `TypedTranscriptBlock[]` (user, assistant, tool_call, bash, compaction, custom_message, error). Uses pending-echo matching to deduplicate user messages that pi echoes back. The `error` block surfaces pi's `stopReason: "error"` / `errorMessage` turns (provider failures) so a dropped stream is visible instead of looking like a silent cut-off. **Streaming perf:** the per-token deltas (`text_delta`, `thinking_delta`, `tool_execution_update`) use `patchBlock`, which clones only the `blocks` array spine (a cheap bulk `slice()`, not the per-element `.map` that made streaming O(n²) — the freeze) and replaces the single streamed slot with a new `data` object, leaving every other element ref stable. It scans from the tail to find the active block (always recently appended) so the lookup is O(1) in the common case. The block renderers are `React.memo`'d on `data`, so only the streamed block re-renders (O(1) reconcile per token); the array ref still changes each delta, so ref-equality consumers stay correct. Lifecycle events (`message_end`, `tool_execution_end`, …) use the `.map`-based `updateBlock` since they fire once per block, not per token. **Memory:** `blocks` is bounded — `compaction_end` trims to the most recent compaction marker onward (plus a `MAX_PRE_COMPACTION_KEEP=200` recent-context window on the first compaction) instead of appending unboundedly; reload from the session file restores the full history.
- **`diff-store`** — Manages diff viewer: file list from `git.changes` (optionally branch-relative via `base`), lazy Shiki tokenization, expand/collapse gap state, unified/split view mode, base branch selection with `loadBranches`/`setBase`/`setIncludeRemoteBranches`. Tracks a `stale` flag for the refresh-button dot: while the viewer is open, each per-tool-call badge refresh uses the full `git.changes` and compares its `fingerprint` against the `baselineFingerprint` captured at the last full viewer refresh, so the dot lights only when files actually changed (and clears if an edit is reverted). While the viewer is closed, the badge refresh uses the cheap `git.changesCount` instead (count only, no fingerprint).
- **`settings-store`** — Renderer mirror of app settings; applies fonts and color scheme.

### Session Lifecycle

1. **Open**: `session.open` IPC → `SessionRegistry.openSession()` creates a `SessionId`, returns it (no process yet)
2. **Activate**: `session.activate` IPC → `SessionRegistry.activateSession()` spawns `PiProcess` (runs `pi --mode rpc`)
3. **Ready**: Process emits first event or 2s timeout → status becomes `"ready"`
4. **Streaming**: User sends prompt → `session.sendCommand` → pi emits `agent_start`, `message_*`, `tool_execution_*`, `agent_end` events
5. **Close**: `session.close` → process killed, session record retained for resume. Worktrees are left on disk (never removed).
6. **Idle eviction**: MAX_IDLE_PROCESSES = 10; oldest inactive process stopped when exceeded

### Worktree-per-session

A **WorktreeBar** above the composer appears in brand-new sessions (empty transcript).
It has a "Create worktree" checkbox and a branch dropdown (reusing the shared
`BranchDropdown` presentational component). On first send with the box checked:

1. `session.createWorktree` IPC creates a git worktree in a sibling
   `<repoName>-worktrees/<friendlyName>` directory on a fresh `pivis/<friendlyName>`
   branch (e.g. `pivis/swift-otter`), cutting from the selected base branch.
2. `setWorktreeAndRespawn()` re-points the session's `cwd` to the worktree and
   re-spawns the pi process there.
3. The WorktreeBar vanishes; the **WorktreeChip** (`⑂ swift-otter`) appears next to
   the session name in the header. Hover shows the full branch · base · path.

**Responsive reflow**: At narrow widths the secondary controls (model picker,
thinking level, changes badge, context meter) drop into a **SessionSubBar** below the
38px title bar. The name + WorktreeChip stay up top. The `SessionControls` component
is the single source of truth rendered in either position. Mechanism: a
`ResizeObserver` on `.session-header` flips `headerCompact` when the header's
*available* width drops below 560px. Two things make this correct: (1) `.session-header`
has `min-width: 0` so as a `flex: 1` child it clamps to the title bar's available width
instead of ballooning to its content's intrinsic width — without it the un-shrinkable
controls push the header past the viewport and the breakpoint never fires; (2) the model
picker button is width-capped + ellipsized so one long model id can't blow out the
cluster. The 560 threshold sits just above the cluster's realistic max (~540px) so
controls reflow before they'd clip. See [Responsive layout system](#responsive-layout-system).

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

### Responsive layout system

The app is fully usable from the enforced floor (`minWidth: 480`, `minHeight: 400` in
`main/index.ts`) up to any size. Three independent mechanisms:

- **Collapsible sidebar**: a toggle in the title bar (`TitleBar.tsx`) and `Cmd/Ctrl+B`
  flip `settings.sidebarCollapsed` (persisted). Collapsed → the grid's sidebar column
  becomes `0` and `.sidebar` is `display: none`. The grid track is
  `min(var(--sidebar-width), 38%)` so even expanded the sidebar can never eat more than
  ~⅓ of a narrow window (a no-op on normal windows). `sidebarWidth` is persisted too;
  App keeps a live local copy for smooth dragging and writes to settings on drag-end.
- **Compact title bar**: the SessionSubBar reflow described above.
- **Title bar layout**: the session name is left-aligned and sized to its text
  (`flex: 0 1 auto`, not `1`) — a modern editor convention, and it leaves the slack to
  its right as part of the title bar's `-webkit-app-region: drag` region (only the
  name button / chip / controls are `no-drag`). A full-width centered title would
  otherwise cover the whole bar as a no-drag element, leaving nothing to grab the window
  by.
- **Fluid transcript**: `.app__main` is a size-query container (`container: mainpane /
  inline-size`). The transcript's horizontal padding scales with the pane via
  `clamp(--mcm-base, 6cqi, --mcm-large)`, and a `@container mainpane (min-width: 560px)`
  rule restores the MCM reading-measure caps (assistant 80%, user bubble ⅔); below that
  the caps yield to ~full width so text doesn't wrap into a sliver. The empty-state outer
  padding is likewise `cqi`-scaled. Overlays (diff/picker/toast) live inside
  `.app__session` (its own positioned ancestor), so the container's layout containment
  doesn't affect them.
- **Overflow containment**: the transcript feed and the sidebar list are vertical
  scrollers, so both set `overflow-x: hidden` — a long unbreakable token (a file path or
  identifier in inline code) or a wide row must never spawn a horizontal scrollbar on the
  whole pane. Wide things instead either wrap (`.transcript-block__content` /
  `.mcm-inline-code` use `overflow-wrap: anywhere`; blocks carry `min-width: 0`) or scroll
  inside their own box (code blocks, and markdown tables via `display: block; width:
  max-content; overflow-x: auto`). `::-webkit-scrollbar-corner` is transparent so the
  corner where two scrollbars meet doesn't render as a light square.

### Reload

`/reload` restarts a session's pi subprocess so settings, keybindings, extensions, skills, prompts, and themes are re-read from disk. pi's TUI `/reload` calls `session.reload()` in-process, but **RPC mode does not expose `reload` as a sendable command** — it's only wired as an extension command-context action. Restarting the subprocess is the equivalent available over RPC. The session record and its `sessionFile` are preserved (so pi resumes the same session), and the renderer's transcript is untouched. Refuses while the session is mid-turn (mirrors pi's "Wait for the current response to finish before reloading." guard). On success, pi re-emits `session_info_changed` and the renderer refreshes commands.

### Command System (`renderer/src/lib/commands/`)

The composer parses input into typed `ComposerAction` discriminated unions:
- `!text` → bash command
- `/command [args]` → slash command (builtins mirror pi's TUI: model, compact, name, session, new, export, fork, clone, resume, copy, quit, settings, diff, login, reload)
- Otherwise → user prompt

Builtins are defined in `builtins.ts` (mirrors pi's interactive-mode.js). Discovered commands (extensions/prompts/skills) come from `get_commands` RPC. `parse.ts` resolves input to an action; `execute.ts` dispatches it.

**`/login`** dispatches `{ kind: "open-login" }` → the composer fires a `pivis:open-login` CustomEvent → `App.tsx` opens Settings scrolled to the Account section.

## Key Patterns

- **Branded types** for IDs: `SessionId`, `RpcRequestId` are `string & { __brand: "..." }` — prevents accidental mixing
- **Zod schemas everywhere**: All protocol types, settings, session files validated with Zod. Schemas live in `shared/` and are the single source of truth.
- **Pure transcript reducer**: `transcript.ts` is a pure function — no side effects, no store access, no in-place mutation. Easy to test. The per-token streaming path (`patchBlock`) is still pure: it returns a fresh array, but copies only the spine and replaces the one streamed slot, so it dodges the O(n) per-element `.map` that made streaming O(n²) on long sessions without sacrificing immutability or referential integrity.
- **Fire-and-forget UI requests**: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` are handled as side effects in `addUiRequest` without awaiting a response. Dialog types (`select`/`confirm`/`input`/`editor`) block pi until the renderer responds.
- **Map immutability**: Zustand stores create new `Map` instances on every update (never mutate in-place) since Zustand uses reference equality for selectors.
- **CSS**: Custom CSS with BEM naming (`composer__input-row--bash`). No CSS framework. CSS modules co-located with components. `global.css` defines an app-wide focus policy: pointer-driven focus has no outline (`:focus:not(:focus-visible)`), keyboard focus shows a lavender `:focus-visible` ring.
- **Catppuccin theming**: Four variants (latte/frappé/macchiato/mocha). Default is mocha. Theme variables set via CSS custom properties.
- **Browser preview**: `npm run dev:renderer` loads `preview-stub.ts` which stubs `window.pivis` with a demo session and canned responses including streamed agent output.
- **Auth**: API keys stored in `~/.pi/agent/auth.json` using `proper-lockfile` for mutual exclusion with pi's token-refresh writes. Environment variables detected via `$SHELL -ilc env` (GUI apps don't inherit shell env). `getSubprocessEnv()` combines `process.env` + login-shell env for consistent subprocess PATH — used across git, updates, pty, and locate-pi. Atomic writes with tmp+rename, chmod 0600.
- **Login**: Native API-key sign-in (writes auth.json) + embedded xterm.js terminal for OAuth (spawns real `pi` in `node-pty`, watches `auth.json` for success detection).
- **Updates**: Background check at launch (3s delay, non-blocking, respects `updateCheckEnabled` setting). `update.run` spawns `pi update … --no-approve` via `spawn()` with 10-minute safety timeout, streams output via IPC events. The target maps to an explicit flag — `"all"` → `--all` (pi **and** extensions), `"pi"` → `--self`, `{extension}` → `--extension <src>`. This matters: bare `pi update` defaults to pi-only and **silently skips extensions** ("Run pi update --extensions to update extensions."), so the "Update now" button must pass `--all`. New sessions automatically use the updated binary.
- **Dependencies**: `@homebridge/node-pty-prebuilt-multiarch` (native, externalized from main bundle, asarUnpack in electron-builder), `@xterm/xterm` + `@xterm/addon-fit` (renderer), `proper-lockfile` + `@types/proper-lockfile` (main).

## Testing

- **Vitest** for unit tests, colocated as `*.test.ts` next to source files
- **Playwright** for E2E tests in `tests/e2e/` — tests app startup, commands, diff viewer, real pi integration
- **Fake pi**: `tests/fixtures/fake-pi.mjs` is a scripted stand-in for the real pi binary (used in unit tests). Beyond RPC, it simulates `--version` (pinnable via `FAKE_PI_VERSION_FILE`/`FAKE_PI_VERSION`) and the `pi update` subcommand (bumps the version stamp, or fails/hangs via `FAKE_PI_UPDATE_EXIT`/`FAKE_PI_UPDATE_HANG`), so `updates.ts` can be tested end-to-end without touching the real install — see `src/main/updates.test.ts`
- **Test overrides**: `tests/fixtures/captures/` contains captured pi protocol data for fixture-based testing

## Important Paths

| Path | Purpose |
|---|---|
| `~/.pi/agent/sessions/` | Session files (JSONL format) |
| `~/.pi/agent/auth.json` | Auth credentials (api_key/oauth); read/written by `auth.ts` with proper-lockfile |
| `build/notarize.cjs` | macOS notarization hook (env-gated, skips unless Apple creds present) |
| `~/.pi/agent/settings.json` | Pi settings including `packages[]` for extension management |
| `~/.pi/agent/npm/node_modules/` | Installed pi extension packages |
| `~/Library/Application Support/pi-vis/settings.json` | App settings |
| `build/entitlements.mac.plist` | macOS hardened runtime entitlements for signing (allow-jit, allow-unsigned-executable-memory, disable-library-validation) |
| `.github/workflows/ci.yml` | CI workflow (typecheck, lint, test, build on push/PR) |
| `src/main/index.ts` | Main entry: BrowserWindow creation, IPC init, CSP, navigation hardening (external links open in OS browser, no in-app navigation) |
| `src/renderer/src/components/ErrorBoundary.tsx` | React error boundary — catches render crashes without white-screening the app |
| `src/shared/ipc-contract.ts` | The typed IPC boundary — start here when adding new main↔renderer communication |
| `src/shared/pi-protocol/` | Source of truth for all pi RPC types |
| `src/main/git/worktree-names.ts` | Curated word lists + `generateWorktreeName()` for worktree branches |
| `src/renderer/src/components/common/BranchDropdown.tsx` | Presentational branch dropdown (search, keyboard nav, remote toggle) |
| `src/renderer/src/components/common/BranchDropdown.css` | Branch dropdown styles (extracted from DiffViewer.css) |
| `src/renderer/src/components/composer/WorktreeBar.tsx` | Pre-send worktree creation bar (checkbox + branch picker) |
| `src/renderer/src/components/composer/WorktreeBar.css` | WorktreeBar styles |
| `src/renderer/src/components/session-header/SessionSubBar.tsx` | Compact-mode secondary controls strip |
| `src/renderer/src/components/session-header/SessionSubBar.css` | SessionSubBar styles |
| `src/shared/auth.ts` | Provider definitions (transcribed from pi's docs/providers.md) |
| `src/shared/updates.ts` | Update status types |
| `src/main/auth.ts` | Auth file management: read/write with proper-lockfile, env detection, fs.watch |
| `src/main/pty.ts` | Embedded terminal (node-pty) for OAuth login |
| `src/main/updates.ts` | Update checker + runner (spawns `pi update`) |
| `src/main/ipc.ts` | All IPC handler registrations |
| `src/renderer/src/stores/sessions-store.ts` | Primary renderer state — most UI logic lives here |
| `src/renderer/src/stores/transcript.ts` | Event→block reducer — modify this to change how transcript renders |
| `src/renderer/src/stores/updates-store.ts` | Update notification + progress state |
| `src/renderer/src/lib/commands/` | Slash command definitions, parsing, and execution |
| `src/renderer/src/components/auth/LoginTerminal.tsx` | Embedded xterm.js terminal for pi's /login OAuth flow |
| `src/renderer/src/components/shell/UpdateBanner.tsx` | Dismissible update card — in a session it lives in the in-flow `.session-dock` (App.tsx/App.css), stacked ABOVE the WorktreeBar and the composer (dock is rigid `flex: 0 0 auto` so only the transcript absorbs vertical pressure; banner is `position: relative; z-index: 1`); floats bottom-right on the empty screen |
| `src/renderer/src/components/updates/UpdateProgress.tsx` | Modal streaming `pi update` output |
| `RELEASING.md` | macOS signing, notarization, and release build docs |
| `build/notarize.cjs` | `afterSign` hook for macOS notarization (env-gated) |

## Releasing

See [RELEASING.md](./RELEASING.md) for macOS signing, notarization, and build instructions.
Required env vars (with no defaults): `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
Optional: `CSC_LINK`, `CSC_KEY_PASSWORD`.

## Maintaining This File

This document must stay in sync with the codebase. **Update this file whenever you make changes that affect any of the following:**

- Project structure (new directories, moved/deleted files, renamed modules)
- Architecture (new processes, changed data flow, new IPC channels or events)
- State management (new stores, changed store shape, new reducer logic)
- Protocols (new pi RPC commands, changed event schemas, new extension-ui methods)
- Tooling (new npm scripts, changed test framework, new build steps)
- Key patterns (new conventions, changed CSS approach, new external dependencies)

If something described here no longer matches the code, fix it in the same change.
Do not let this file become stale — a wrong AGENTS.md is worse than no AGENTS.md.
