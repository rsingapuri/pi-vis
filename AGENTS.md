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
├── resources/
│   └── pi-session-host/     # SDK-direct host subprocess (spawned via child_process.fork)
│       ├── host.mjs          # Entry: imports pi SDK, creates AgentSessionRuntime,
│       │                     #   binds extensions mode:"tui", bridges commands/events
│       ├── bootstrap.mjs     # HTTP dispatcher, trust resolver, theme init
│       ├── ui-context.mjs    # ~28-method ExtensionUIContext: dialogs, TUI no-ops,
│       │                     #   custom() → HostTerminal + TUI overlay bridge
│       └── bridge.mjs        # Command translation + event forwarding + setRebindSession
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
│   │   ├── settings/        # SettingsView (fonts, pi path, color scheme, diff viewer max file size, Account, Updates)
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
    ├── settings.ts          # AppSettingsSchema (Zod): fonts, paths, workspaceOrder + expandedWorkspaces, lastActiveWorkspace, color scheme, diff mode, diffMaxFileSizeMiB (diff viewer file-size cap, default 5), sidebar width/collapsed, window bounds
    ├── git.ts               # GitChangedFile, GitChangesResult, GitFileDiffResult types
    ├── result.ts            # Result<T,E> utility + assertNever
    └── session-file/        # Session file format schemas (header, message/model-change/snapshot entries)
```

## Architecture

### Four-Process Model (with SDK-host, progressive enhancement)

```
┌─────────────┐     IPC (typed)      ┌───────────┐   fork (child IPC)    ┌────────────────┐
│  Main Proc   │ ◄──────────────────► │ Renderer  │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ► │ pi-session-host│
│ (Node.js)    │   contextBridge      │ (React)   │  panel.* events      │ (SDK host,     │
│              │   window.pivis       │           │                      │  one per sess) │
└─────────────┘                      └───────────┘                      └────────────────┘
     ▲                                                                   │ imports user's │
     │                                                                   │ installed pi   │
     │                                                      ▲ FALLBACK: if host can't start │
     │                                                     ┌─────────────┐                │
     │                                                     │ pi --mode   │ ◄──────────────┘
     │                                                     │   rpc       │
     │                                                     │ (subprocess)│
     │                                                     └─────────────┘
```

- **PiProcess** (`src/main/pi/pi-process.ts`): legacy wrapper, spawns `pi --mode rpc` (fallback)
- **SessionHost** (`src/main/pi/session-host.ts`): SDK-direct wrapper, forks `resources/pi-session-host/host.mjs`
  - Same EventEmitter shape as PiProcess (event, uiRequest, exit, error events; sendCommand/sendUiResponse methods)
  - Additional panel events: panelOpen, panelData, panelClose, panelClearAll
  - `activateSession` tries SessionHost first; on failure falls back to PiProcess (progressive enhancement)
  - **Renderer contract unchanged**: PiRpcCommand/PiEvent/ExtensionUiRequest types preserved
- **Panel channel**: `session.panelEvent` (IPC: main→renderer), `session.panelInput` + `session.panelResize` (IPC: renderer→main→host). Panel events: `panel_open`/`panel_data`/`panel_close`/`panel_clear_all` (custom() rendering), `host_fallback` (host couldn't start — fell back to `pi --mode rpc`, panels unavailable; surfaced as a toast), `session_warning` (non-fatal warning like session-file lock contention; surfaced as a toast).
  - CustomPanelHost renders ANSI in xterm.js overlay (mirrors LoginTerminal)
  - Composer decoupled: extension commands fire-and-forget (execute.ts)
- **Project trust (security)**: the host wires `resolveProjectTrust` into `createAgentSessionServices` (deny-by-default, matching terminal pi). A folder with trust-requiring project-local resources prompts a React **select** dialog *during* host startup, offering pi's full choice set (trust folder / trust parent / trust this-session-only / deny / deny this-session-only — `buildProjectTrustOptions`); the chosen option's updates persist via the public `ProjectTrustStore.setMany` (`get()` walks ancestors, so a parent grant covers children). Because the prompt fires pre-`ready`, the registry attaches the `uiRequest`/panel listeners **before** `waitForReady`, and `SessionHost` pauses its startup watchdog while a pre-ready dialog is outstanding (a human, not a hang). Without this gate, pi loads project-local `.pi/` extensions ungated (`projectTrusted` defaults `true`). The host derives `agentDir` from `pi.getAgentDir()` so the trust store, services, and runtime agree and stay shared with terminal pi.
- **Zero private pi imports**: the host uses only pi's public `dist/index.js` surface (+ public pi-tui + bundled undici). The active theme comes from public `initTheme()` + reading `globalThis[Symbol.for("…:theme")]`, not a deep import. Enforced by `src/main/pi/host-imports.test.ts`.

### Three-Process Electron Model (legacy fallback)


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
- `session.panelInput` — keystrokes from the xterm.js panel overlay → host's custom() TUI
- `session.panelResize` — new xterm.js cols/rows → host, so the TUI layout matches the panel
- `settings.get` / `settings.set`
- `git.changes` / `git.fileDiff` (both accept optional `base?: string` for branch-relative diffs). `git.changes` also returns a `fingerprint` — a content hash of the working tree vs HEAD (always HEAD, regardless of `base`) plus untracked contents — that the diff viewer uses to detect whether tool calls actually changed files. This is the heavyweight path (file list + line counts + the full-patch fingerprint), reserved for the **open** viewer and its staleness probe.
- `git.changesCount` — lightweight changed-file **count** for the header badge while the viewer is **closed**. A single `git status --porcelain=v2 -z --untracked-files=all` scan (one working-tree walk), no line counts / fingerprint / file reads — so the every-tool-call badge refresh stays cheap on huge repos. Capped at the same `MAX_FILES` limit as `git.changes`.
- Perf notes: `getChanges`/`getFileDiff` run their independent git reads concurrently and pass `GIT_OPTIONAL_LOCKS=0` (read-only, no index.lock churn). The renderer's badge refresh is **single-flight** (`diff-store`): at most one scan runs at a time, and requests arriving mid-scan coalesce into one trailing scan — so overlapping multi-second scans can't pile up.
- `git.branches` — list local + remote branches
- `session.createWorktree` — creates a git worktree from a base branch and re-spawns the pi process into it
- `session.attachWorktree` — attaches an existing on-disk worktree to a fresh session (server-side re-runs `inspectWorktree` for the canonical toplevel); mirrors `session.createWorktree`'s success shape. `base === branch` is the "attached, not cut from anything" sentinel.
- `worktree.validate` — live-validate a candidate worktree path (`inspectWorktree` wrapped as `{ok}`); advisory only — the authoritative gate is `session.attachWorktree` re-running `inspectWorktree` server-side
- `worktree.pickDirectory` — native directory picker for the WorktreeBar's "Existing Worktree" segment; defaults to the repo's sibling `<repoName>-worktrees` dir when it exists, else the repo's parent
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

- **`sessions-store`** — The primary store. Maps `SessionId → SessionViewState` (transcript, streaming status, pending dialogs, status segments, widgets, stats, model info, thinking level, commands, worktreeCreate/worktreeBase/worktreeCreating/worktreeError/worktreePath/worktreeBranch/worktreeName/worktreeFromBase for worktree-per-session — `worktreeError` is the durable inline failure shown in the WorktreeBar). Handles all mutations via IPC calls + local state updates. Export `gitRootForSession(session)` helper that returns the worktree path if set, else the workspace path — used by the diff viewer and changes badge. **Composer draft preservation** lives in two in-memory (never persisted) maps, both read via `getState()` in the Composer's seeding effect so per-keystroke writes don't trigger re-renders: `newSessionDrafts: Map<workspacePath, string>` for *pending* new sessions (keyed by workspace, not session, because a pending session is hidden from the sidebar — switching away abandons it, and the only way back is clicking "+ New session" again, which creates a fresh session that re-seeds from the workspace slot), and `sessionDrafts: Map<SessionId, string>` for every *non-pending* session (so typed text survives switching to another session and back). Both are cleared the moment a message is actually sent (`addUserMessage`/`addBashCommand`/`addCustomMessage` clear on content landing; the Composer's post-submit clear also drops non-promoting slash-command text like `/model`, `/name`). `removeSession` drops the closed session's draft. **Editor-injection lifecycle:** `editorInjection` (from `set_editor_text` extension UI requests) persists in `SessionViewState` with a monotonic nonce so the Composer's effect re-fires on change. To prevent a stale injection from clobbering the restored draft on Composer remount (switch away and back), the injection is *consumed* — cleared via `clearEditorInjection` — the moment the user takes over the textarea (types / picks a suggestion) or sends content (`addUserMessage`/`addBashCommand`/`addCustomMessage` set `editorInjection: undefined`; the Composer's post-submit clear calls `clearEditorInjection` for non-promoting slash commands). A fresh injection arriving while the user is away still applies on remount (nonce changed, not consumed).
- **`transcript.ts`** — Reducer (not a store). `applyPiEvent(state, event) → TranscriptState` transforms pi streaming events into `TypedTranscriptBlock[]` (user, assistant, tool_call, bash, compaction, custom_message, error). Uses pending-echo matching to deduplicate user messages that pi echoes back. The `error` block surfaces pi's `stopReason: "error"` / `errorMessage` turns (provider failures) so a dropped stream is visible instead of looking like a silent cut-off. **Streaming perf:** the per-token deltas (`text_delta`, `thinking_delta`, `tool_execution_update`) use `patchBlock`, which clones only the `blocks` array spine (a cheap bulk `slice()`, not the per-element `.map` that made streaming O(n²) — the freeze) and replaces the single streamed slot with a new `data` object, leaving every other element ref stable. It scans from the tail to find the active block (always recently appended) so the lookup is O(1) in the common case. The block renderers are `React.memo`'d on `data`, so only the streamed block re-renders (O(1) reconcile per token); the array ref still changes each delta, so ref-equality consumers stay correct. Lifecycle events (`message_end`, `tool_execution_end`, …) use the `.map`-based `updateBlock` since they fire once per block, not per token. **Memory:** `blocks` is bounded — `compaction_end` trims to the most recent compaction marker onward (plus a `MAX_PRE_COMPACTION_KEEP=200` recent-context window on the first compaction) instead of appending unboundedly; reload from the session file restores the full history.
- **`diff-store`** — Manages diff viewer: file list from `git.changes` (optionally branch-relative via `base`), lazy Shiki tokenization, expand/collapse gap state, unified/split view mode, base branch selection with `loadBranches`/`setBase`/`setIncludeRemoteBranches`. Tracks a `stale` flag for the refresh-button dot: while the viewer is open, each per-tool-call badge refresh uses the full `git.changes` and compares its `fingerprint` against the `baselineFingerprint` captured at the last full viewer refresh, so the dot lights only when files actually changed (and clears if an edit is reverted). While the viewer is closed, the badge refresh uses the cheap `git.changesCount` instead (count only, no fingerprint).
- **`settings-store`** — Renderer mirror of app settings; applies fonts and color scheme.

### Model & thinking-level selection (invariants)

Two hard invariants govern the model + thinking-level dropdowns (`SessionHeader` / `SessionControls`):

1. The dropdown ALWAYS shows either the session's current model/level or the change the user just requested in that session.
2. A session's model/level NEVER changes unless the user changes it **in that same session** (dropdown or `/model` · thinking slash command).

These are enforced structurally by making the dropdowns a pure function of the per-session store fields `currentModel` / `thinkingLevel`, which are written by exactly three things, all session-scoped: (a) the **one-time** `bootstrapModelState(sessionId)` store action, (b) pi events for that session (`thinking_level_changed` → `applyEvent`), and (c) the user's explicit actions in that session, routed through the single mutation actions `applyModelChange` / `applyThinkingLevel`.

`applyModelChange(sessionId, model)` / `applyThinkingLevel(sessionId, level)` are the **only** way the UI mutates a session's model/level (the header dropdowns, the `/model` picker in `AppPickerHost`, and the exact-match `/model` path in `execute.ts` all go through `applyModelChange` — except `execute.ts`, which is set-after-success for the same effect via the injected deps). They update the store optimistically (so the dropdown shows the requested value immediately — invariant #1's "queued change about to be sent"), send the RPC, **reconcile** thinking with pi's actually-applied level (a model may clamp it), and **revert** to the prior value if the command fails (so the dropdown never lingers on a value pi didn't accept). The revert is skipped if a newer change has already superseded the optimistic value. The global last-used preference (`lastUsedModel` / `lastUsedThinkingLevel`) is persisted **only on success** — a failed switch must not leak into the next new session's default. Covered by `sessions-store.test.ts` ("applyModelChange / applyThinkingLevel (revert on failure)").

`bootstrapModelState` is the **only** place the *global* last-used preference (`settings.lastUsedModel` / `lastUsedThinkingLevel`, written whenever the user picks a model/level so the *next new* session inherits it) is ever applied to a session. It seeds the store from pi's authoritative `get_available_models` / `get_state`, and — for brand-new (`resumed === false`) sessions only — applies the global preference. The preferred model is applied first, then the preferred thinking level is applied **through `applyThinkingLevel`** (not a blind write) so it is reconciled against the just-chosen model and shows pi's clamped value — e.g. a remembered `xhigh` paired with a model that doesn't support it lands on the model's max, the same reconciliation the header dropdown performs. It is guarded by the per-session `modelInitialized` flag (set synchronously before any `await`), so it runs **at most once per session**. The guard lives in the store, not in `SessionHeader`, on purpose: only the *active* session's header is mounted (`TitleBar`), so every tab switch unmounts/remounts it and re-fires the bootstrap effect — a component-local guard (or the old per-mount effects) would re-read the *now-global* preference and silently re-apply another session's model. That was the cross-session leak this design closes. Covered by `sessions-store.test.ts` ("bootstrapModelState (model/thinking invariants)").

### Session Lifecycle

1. **Open**: `session.open` IPC → `SessionRegistry.openSession()` creates a `SessionId`, returns it (no process yet)
2. **Activate**: `session.activate` IPC → `SessionRegistry.activateSession()` spawns the **SessionHost** (SDK-direct, forks `resources/pi-session-host/host.mjs`) as progressive enhancement. A min-pi-version gate (`MIN_PI_VERSION` in `host.mjs`, compared via `version.mjs`'s `compareVersions`) exits the host with code 42 if pi is too old; `SessionHost` detects this and the registry falls back to **PiProcess** (`pi --mode rpc`), emitting a `host_fallback` panel event so the renderer shows an "update pi for panel support" toast. The caller's request (`_hostRequested`) is sticky across fallbacks: `/reload` re-tries the host iff the caller originally wanted it (a pi upgrade mid-session re-promotes), while a worktree respawn preserves the ACTUAL running mode (`_useHost`) since the pi install is unchanged. The registry holds a proper-lockfile advisory lock on the session file (released on close/exit/error/failed-activation; `onCompromised` is overridden to log-and-clear instead of throw).
3. **Ready**: Host sends `{type:"ready", piVersion}` (or RPC process emits first event / 2s timeout) → status becomes `"ready"` (with `piVersion` for the header)
4. **Streaming**: User sends prompt → `session.sendCommand` → pi emits `agent_start`, `message_*`, `tool_execution_*`, `agent_end` events
5. **Close**: `session.close` → process killed, advisory session-file lock released, session record retained for resume. Worktrees are left on disk (never removed).
6. **Idle eviction**: MAX_IDLE_PROCESSES = 10; oldest inactive process stopped when exceeded

### Worktree-per-session

A **WorktreeBar** above the composer appears in brand-new sessions (empty transcript).
It is a 3-way **segmented control**: `[In Workspace] [New Worktree] [Existing Worktree]`. The segment
selection drives which controls appear below it:

- **Workspace** (`worktreeMode = "none"`, default): run the session in the
  workspace cwd, no worktree.
- **New** (`worktreeMode = "create"`): show the shared `BranchDropdown` for the
  base branch. On first send, `session.createWorktree` IPC creates a git
  worktree in a sibling `<repoName>-worktrees/<friendlyName>` directory on a
  fresh `pi-vis-<friendlyName>` branch (e.g. `pi-vis-swift-otter`), cutting
  from the selected base branch.
- **Existing** (`worktreeMode = "attach"`): show a path **text input** plus a
  **"Browse…"** button (native directory picker via `worktree.pickDirectory`,
  defaulting to the repo's sibling `<repoName>-worktrees` dir when it exists).
  A debounced (~300ms) live validation line (`worktree.validate` → advisory
  `✓ On branch …` or `⚠ <error>`) gives fast feedback while the authoritative
  validation gate is the `session.attachWorktree` IPC re-running
  `inspectWorktree` server-side (so a stale/edited live result can never
  persist a bad path). On first send, `session.attachWorktree` IPC attaches
  the chosen worktree; the renderer uses the **same** success/failure
  handling as the create flow (`applyWorktree`, `clearWorktreeIntent`,
  toast `Attached worktree <name>`).

Both New and Existing converge on the same plumbing:

1. `setWorktreeAndRespawn()` re-points the session's `cwd` to the worktree and
   re-spawns the pi process there.
2. The WorktreeBar vanishes; the **WorktreeChip** (`⑂ swift-otter`) appears next to
   the session name in the header. Hover shows `branch · path` for attached
   worktrees (where `base === branch` is the "attached, not cut from anything"
   sentinel) and `branch · from <base> · path` for created worktrees.
3. `settings.worktrees` is persisted **keyed by the canonical worktree toplevel**
   (`git rev-parse --show-toplevel` + `fs.realpath`), not the raw user input.
   This is load-bearing for `resolveWorktreeForFile` on relaunch: pi writes the
   canonical cwd into the session header, and the persisted key must equal it
   byte-for-byte to re-attach the session to its workspace.

**Validation strategy** (`inspectWorktree` in `git/git.ts`): a two-part
check that guards against attaching to an unrelated repo. **Canonicalization
is the load-bearing part** — a fresh-context review found that skipping it
breaks subdir inputs, relaunch re-attach, and the workspace-self guard, all
at once. Order of checks (cheapest first, with crisp messages):

1. `fs.stat(input)` → missing/not-a-dir → "Directory not found." (Done
   *before* shelling out to git: `mapSpawnError` maps ENOENT to
   `git-missing` — wrong message.)
2. `git rev-parse --show-toplevel` fails → "Not a git repository."
3. Canonicalize the candidate to its worktree root + `fs.realpath`
   (collapses a pasted subdirectory of a worktree down to the worktree
   root, and resolves macOS `/var`↔`/private/var` symlinks). Every
   downstream use — the same-repo compare, the persisted
   `settings.worktrees` key, the respawn cwd, and the chip name — uses
   this canonical toplevel, never the raw input.
4. Same-repo proof via `git rev-parse --git-common-dir`: resolve both
   sides' common dirs (relative paths resolved against the canonical
   toplevel, then `realpath`'d), and compare for byte equality. Mismatch
   → "That directory belongs to a different repository."
5. Workspace-self guard: realpath'd toplevels match → "That's the current
   workspace — choose a different worktree directory." (Compare two
   *realpath'd* toplevels, not raw `rec.workspacePath` vs realpath'd
   candidate.)
6. Branch label: `git rev-parse --abbrev-ref HEAD`; `HEAD` (detached) →
   `--short HEAD`; falls through to `"(no commits)"` for an unborn HEAD.
   Never fails validation — attaching to an unborn-HEAD worktree is still
   valid.

The attach IPC is the **authoritative** gate: it re-runs `inspectWorktree`
server-side and uses the returned canonical `path`, so a stale/edited live
result can never persist a bad path.

**Reliability & error UX** (`createWorktree` in `git/git.ts`): `git worktree add`
is a full working-tree checkout, so on a large repo it can take minutes —
it runs with a generous `WORKTREE_ADD_TIMEOUT_MS` (10 min) instead of the 15s
default that governs the cheap read-only commands (the short default was
SIGTERM-ing the checkout on big repos and surfacing as a meaningless "code 1").
Failures are captured via `execGitCapture` (a non-throwing exec helper that
returns code + **stderr** + signal + `timedOut`) and turned into an actionable
message by `describeWorktreeAddFailure` (git's own stderr, or an explicit
timeout message). The base ref is pre-flight-validated (`rev-parse --verify
<base>^{commit}`) so a deleted/renamed base reads as a crisp message, not a
verbose git error. During creation the **composer is frozen** (`worktreeCreating`
forces `live=false`, disabling the textarea) so the in-flight send reads as
"sending", not stuck unsubmitted text. On failure the reason is shown **inline
and durably** in the WorktreeBar (`session.worktreeError` → `.worktree-bar__error`,
selectable, persists until the user retries or edits the inputs), and the
prompt text is preserved for retry — not lost behind an ephemeral toast.

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
so it keeps its full-screen centered treatment. Overlays (diff/picker/toast) live inside
`.app__session` (positioned ancestor) so they fill and clip to the card; the model/thinking
dropdowns anchor in the title bar (outside the card) so they're never clipped.

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
  `clamp(--space-5, 6cqi, --space-8)`, and a `@container mainpane (min-width: 560px)`
  rule applies the reading-measure caps (assistant 80%, user bubble ⅔); below that
  the caps yield to ~full width so text doesn't wrap into a sliver. The empty-state outer
  padding is likewise `cqi`-scaled. Overlays (diff/picker/toast) live inside
  `.app__session` (its own positioned ancestor), so the container's layout containment
  doesn't affect them.
- **Overflow containment**: the transcript feed and the sidebar list are vertical
  scrollers, so both set `overflow-x: hidden` — a long unbreakable token (a file path or
  identifier in inline code) or a wide row must never spawn a horizontal scrollbar on the
  whole pane. Wide things instead either wrap (`.transcript-block__content` /
  `.inline-code` use `overflow-wrap: anywhere`; blocks carry `min-width: 0`) or scroll
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
- **CSS**: Custom CSS with BEM naming (`composer__input-row--bash`). No CSS framework. CSS modules co-located with components. `global.css` defines an app-wide focus policy: pointer-driven focus has no outline (`:focus:not(:focus-visible)`), keyboard focus shows a lavender `:focus-visible` ring. **Exception**: the slot that the Composer occupies (`.ext-dialog-slot`, `.custom-panel`) suppresses `:focus-visible` on internal elements — the Composer's mauve input ring is the *only* focus affordance in that slot, and components that replace the Composer (extension dialogs, custom panels) inherit no focus rings. The dialog's option list uses a JavaScript-managed `.ext-dialog__option--highlighted` state for arrow-key navigation, and text fields use the caret — both are intent-revealing, not focus-revealing.
- **Design tokens** (`theme/theme.css` `:root`): a flat, modern token system that every component composes from — `--space-1…10` (rem spacing scale), `--radius-sm/md/lg/xl/pill` (soft, consistent corners), `--leading-*`/`--tracking-*` (type), and crucially the separation tokens: `--border` / `--border-faint` (both `surface0`) and `--border-strong` (`surface1`) for hairline edges, `--surface-raised` (`surface0`) / `--surface-inset` (`mantle`) for in-flow depth, and `--elevation-1/2/3` shadows for floating layers (menus → `-2`, modals → `-3`). The look leans on hairlines + surface elevation + spacing instead of high-contrast outlines and box-in-box nesting — e.g. tool cards are a raised `surface0` card over a recessed `mantle` well, no inner border. **All color tokens stay faithful to the canonical Catppuccin swatches** (the only sanctioned deviation is Latte's slightly-lightened surfaces in `catppuccin.ts`); borders/surfaces use real swatches, and accent fills use translucent real swatches (e.g. mauve focus ring) — never invented hues. There is **no MCM/mid-century vocabulary** anymore (the previous design language was removed).
- **Catppuccin theming**: Four variants (latte/frappé/macchiato/mocha). Default is mocha. Theme variables set via CSS custom properties.
- **Browser preview**: `npm run dev:renderer` loads `preview-stub.ts` which stubs `window.pivis` with a demo session and canned responses including streamed agent output.
- **Auth**: API keys stored in `~/.pi/agent/auth.json` using `proper-lockfile` for mutual exclusion with pi's token-refresh writes. Environment variables detected via `$SHELL -ilc env` (GUI apps don't inherit shell env). `getSubprocessEnv()` combines `process.env` + login-shell env for consistent subprocess PATH — used across git, updates, pty, and locate-pi. Atomic writes with tmp+rename, chmod 0600.
- **Login**: Native API-key sign-in (writes auth.json) + embedded xterm.js terminal for OAuth (spawns real `pi` in `node-pty`, watches `auth.json` for success detection).
- **Updates**: Background check at launch (3s delay, non-blocking, respects `updateCheckEnabled` setting). `update.run` spawns `pi update … --no-approve` via `spawn()` with 10-minute safety timeout, streams output via IPC events. The target maps to an explicit flag — `"all"` → `--all` (pi **and** extensions), `"pi"` → `--self`, `{extension}` → `--extension <src>`. This matters: bare `pi update` defaults to pi-only and **silently skips extensions** ("Run pi update --extensions to update extensions."), so the "Update now" button must pass `--all`. New sessions automatically use the updated binary.
- **Dependencies**: `@homebridge/node-pty-prebuilt-multiarch` (native, externalized from main bundle, asarUnpack in electron-builder), `@xterm/xterm` + `@xterm/addon-fit` (renderer), `proper-lockfile` + `@types/proper-lockfile` (main).

## Testing

- **Vitest** for unit tests. The glob is `["src/**/*.test.ts", "resources/**/*.test.mjs"]` — the second pattern is load-bearing: the SDK-host subprocess lives in `resources/pi-session-host/` as plain ESM and was previously excluded entirely. Host-subprocess units are colocated as `*.test.mjs` (matched there, never colliding with the Playwright `*.spec.mts` e2e). Everything else is colocated `*.test.ts`.
- **Host-subprocess unit coverage** (`resources/pi-session-host/*.test.mjs`): the **trust resolver** (`trust.test.mjs` — the security-critical deny-by-default gate, fully faked pi SDK), the **command bridge** (`bridge.test.mjs` — pi-vis-command → SDK-method mapping + `assertHostCapabilities`), the **version gate** (`version.test.mjs` — `compareVersions`, incl. pre-release ordering), and the **uiContext dialog contract** (`ui-context.test.mjs` — select/confirm/input/editor must UNWRAP the wire response to pi's value contract: `string`/`boolean`/`undefined`, not the raw `{type,id,value}` object). These functions are exported precisely so they're testable without importing `host.mjs`'s fork entry-point (which needs a real pi).
- **uiContext dialog contract (gotcha)**: `ctx.ui.select/input/editor` return the unwrapped **value** (`string`, `undefined` on cancel); `ctx.ui.confirm` returns a **boolean**. The host's `createDialog` resolves with the raw `ExtensionUiResponse` wire object, so `ui-context.mjs` MUST unwrap per-method. Returning the object breaks any extension that compares the result (`choice === "Settings"`, `choice.startsWith(...)`), e.g. `pi-subagents` `/agents → Settings`. The trust prompt (`host.mjs` `promptTrustChoice`) reads the raw response directly and is independent of this unwrapping.
- **Playwright** for E2E tests in `tests/e2e/` — tests app startup, commands, diff viewer, real pi integration. The inline-panel E2E (`panels.spec.mts`) is gated behind `PI_E2E=1` (needs a real pi + extension); it is the load-bearing gate for the un-`tsc`-checkable host↔pi behavioral contract and is **not yet in CI**.
- **Fake pi**: `tests/fixtures/fake-pi.mjs` is a scripted stand-in for the real pi binary (used in unit tests). Beyond RPC, it simulates `--version` (pinnable via `FAKE_PI_VERSION_FILE`/`FAKE_PI_VERSION`) and the `pi update` subcommand (bumps the version stamp, or fails/hangs via `FAKE_PI_UPDATE_EXIT`/`FAKE_PI_UPDATE_HANG`), so `updates.ts` can be tested end-to-end without touching the real install — see `src/main/updates.test.ts`
- **SessionHost stub-fork harness**: `tests/fixtures/fake-host-process.mjs` (`FakeHostProcess`) is a ChildProcess-shaped EventEmitter that drives the host wire protocol deterministically without forking a real `host.mjs`. `SessionHost.__forkOverride` is the test seam (a mutable `{fn}` — set it to return a `FakeHostProcess` and `SessionHost` constructs it instead of calling `child_process.fork`). This makes the lifecycle seams executable: `waitForReady` resolve/reject/timeout, the pre-ready dialog watchdog (W1), `sendCommand` correlation + `rejectAllPending`, panel I/O round-trips, and pre-ready `uiRequest` ordering (`src/main/pi/session-host.test.ts`). The fake mirrors the real host's **failure** modes, not just the happy path — it bounces pre-`ready` commands with "Not initialized" (host.mjs:340) and fails `.send()` after exit (channel closed) — so a registry routing regression (e.g. P1-i) trips a test instead of silently buffering. The registry concurrency tests (`src/main/sessions/session-registry.test.ts`, "concurrency & lock lifecycle" describe) reuse it to exercise close-during-activate cancellation (P1-e), queued-command rejection on close (P1-h), the `onCompromised` no-throw override (P1-d), failed-activation lock release (P1-f), and `/reload` host re-try (P2-b).
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
| `src/main/git/git.ts` (`inspectWorktree`) | Validation helper for the attach flow — canonicalizes the candidate to its worktree toplevel + verifies same-repo via `--git-common-dir`. Called by both `worktree.validate` (live, advisory) and `session.attachWorktree` (authoritative). |
| `src/main/workspaces.ts` (`pickWorktreeDirectory`) | Native directory picker for the WorktreeBar's "Existing Worktree" segment — opens at the repo's sibling `<repoName>-worktrees` dir when it exists. |
| `src/renderer/src/components/common/BranchDropdown.tsx` | Presentational branch dropdown (search, keyboard nav, remote toggle) |
| `src/renderer/src/components/common/BranchDropdown.css` | Branch dropdown styles (extracted from DiffViewer.css) |
| `src/renderer/src/components/composer/WorktreeBar.tsx` | Pre-send worktree bar — 3-way segmented control (`In Workspace | New Worktree | Existing Worktree`) + mode-specific controls (branch dropdown for New, path input + Browse + live validation line for Existing) |
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
| `src/renderer/src/stores/transcript.ts` | Event→block reducer — modify this to change how transcript renders |
| `src/renderer/src/stores/updates-store.ts` | Update notification + progress state |
| `src/renderer/src/lib/commands/` | Slash command definitions, parsing, and execution |
| `src/renderer/src/components/auth/LoginTerminal.tsx` | Embedded xterm.js terminal for pi's /login OAuth flow |
| `src/renderer/src/components/shell/UpdateBanner.tsx` | Dismissible update card — in a session it lives in the in-flow `.session-dock` (App.tsx/App.css), stacked ABOVE the WorktreeBar and the composer (dock is rigid `flex: 0 0 auto` so only the transcript absorbs vertical pressure; banner is `position: relative; z-index: 1`); floats bottom-right on the empty screen |
| `src/renderer/src/components/updates/UpdateProgress.tsx` | Modal streaming `pi update` output |
| `RELEASING.md` | macOS signing, notarization, and release build/publish docs |
| `build/notarize.cjs` | `afterSign` hook for macOS notarization (env-gated) |
| `scripts/install.sh` | End-user `curl \| bash` installer: fetches the latest release's `*-mac.zip`, installs to `/Applications`, strips quarantine (sidesteps Gatekeeper pre-notarization) |

## Releasing

See [RELEASING.md](./RELEASING.md) for macOS signing, notarization, and build instructions.
Required env vars (with no defaults): `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
Optional: `CSC_LINK`, `CSC_KEY_PASSWORD`.

End users install via `curl … | bash` → `scripts/install.sh` (README "Install"
section), which downloads the latest release's `*-mac.zip` and unpacks it to
`/Applications`. Cutting a release = `npm run dist` then `gh release create`
with the zip+dmg attached (see RELEASING.md "Publishing a GitHub release"). The
curl path avoids quarantine, so the ad-hoc-signed build launches without a
Gatekeeper prompt even before notarization is set up.

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
