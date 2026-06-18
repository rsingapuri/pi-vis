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
│   ├── workspaces.ts        # Workspace picker (OS dialog), recents management
│   ├── pi/                  # Pi subprocess management
│   │   ├── pi-process.ts    # Wraps a single `pi --mode rpc` child process; spawned with login-shell env (PATH etc.); correlated RPC over JSONL
│   │   ├── jsonl-stream.ts  # Byte-level JSONL parser (splits on \n only, never Unicode separators)
│   │   └── locate-pi.ts     # Finds pi binary via $SHELL/which/override; validates `--version` with login-shell env (pi's `env node` shebang needs node on PATH); caches result
│   ├── sessions/            # Session lifecycle
│   │   ├── session-registry.ts   # SessionId → PiProcess lifecycle; MAX_IDLE_PROCESSES=10
│   │   ├── session-discovery.ts  # Scans ~/.pi/agent/sessions/ for workspace-linked session files
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
│   │   ├── shell/           # TitleBar, Sidebar (workspace switcher, session list, tabs, drag/drop), StatusBar,
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
│   │   ├── sessions-store.ts   # Primary store: SessionViewState per session, transcript, streaming, pickers
│   │   ├── transcript.ts       # Pure reducer: PiEvent → TypedTranscriptBlock[] (with pending-echo matching)
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
    ├── settings.ts          # AppSettingsSchema (Zod): fonts, paths, recents, color scheme, diff mode, window bounds
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
- `workspace.pick` / `workspace.recents` / `workspace.remove` / `workspace.listSessions`
- `session.open` → `{ outcome: "opened"|"existing"|"missing", sessionId, ... }`
- `session.activate` / `session.reload` / `session.close` / `session.loadHistory`
- `session.sendCommand` — sends PiRpcCommand, returns PiRpcResponse
- `session.respondToUiRequest` — sends ExtensionUiResponse back to pi
- `settings.get` / `settings.set`
- `git.changes` / `git.fileDiff` (both accept optional `base?: string` for branch-relative diffs)
- `git.branches` — list local + remote branches
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

- **`sessions-store`** — The primary store. Maps `SessionId → SessionViewState` (transcript, streaming status, pending dialogs, status segments, widgets, stats, model info, thinking level, commands). Handles all mutations via IPC calls + local state updates.
- **`transcript.ts`** — Pure reducer (not a store). `applyPiEvent(state, event) → TranscriptState` transforms pi streaming events into `TypedTranscriptBlock[]` (user, assistant, tool_call, bash, compaction, custom_message). Uses pending-echo matching to deduplicate user messages that pi echoes back.
- **`diff-store`** — Manages diff viewer: file list from `git.changes` (optionally branch-relative via `base`), lazy Shiki tokenization, expand/collapse gap state, unified/split view mode, base branch selection with `loadBranches`/`setBase`/`setIncludeRemoteBranches`
- **`settings-store`** — Renderer mirror of app settings; applies fonts and color scheme.

### Session Lifecycle

1. **Open**: `session.open` IPC → `SessionRegistry.openSession()` creates a `SessionId`, returns it (no process yet)
2. **Activate**: `session.activate` IPC → `SessionRegistry.activateSession()` spawns `PiProcess` (runs `pi --mode rpc`)
3. **Ready**: Process emits first event or 2s timeout → status becomes `"ready"`
4. **Streaming**: User sends prompt → `session.sendCommand` → pi emits `agent_start`, `message_*`, `tool_execution_*`, `agent_end` events
5. **Close**: `session.close` → process killed, session record retained for resume
6. **Idle eviction**: MAX_IDLE_PROCESSES = 10; oldest inactive process stopped when exceeded

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
- **Pure transcript reducer**: `transcript.ts` is a pure function — no side effects, no store access. Easy to test.
- **Fire-and-forget UI requests**: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` are handled as side effects in `addUiRequest` without awaiting a response. Dialog types (`select`/`confirm`/`input`/`editor`) block pi until the renderer responds.
- **Map immutability**: Zustand stores create new `Map` instances on every update (never mutate in-place) since Zustand uses reference equality for selectors.
- **CSS**: Custom CSS with BEM naming (`composer__input-row--bash`). No CSS framework. CSS modules co-located with components. `global.css` defines an app-wide focus policy: pointer-driven focus has no outline (`:focus:not(:focus-visible)`), keyboard focus shows a lavender `:focus-visible` ring.
- **Catppuccin theming**: Four variants (latte/frappé/macchiato/mocha). Default is mocha. Theme variables set via CSS custom properties.
- **Browser preview**: `npm run dev:renderer` loads `preview-stub.ts` which stubs `window.pivis` with a demo session and canned responses including streamed agent output.
- **Auth**: API keys stored in `~/.pi/agent/auth.json` using `proper-lockfile` for mutual exclusion with pi's token-refresh writes. Environment variables detected via `$SHELL -ilc env` (GUI apps don't inherit shell env). `getSubprocessEnv()` combines `process.env` + login-shell env for consistent subprocess PATH — used across git, updates, pty, and locate-pi. Atomic writes with tmp+rename, chmod 0600.
- **Login**: Native API-key sign-in (writes auth.json) + embedded xterm.js terminal for OAuth (spawns real `pi` in `node-pty`, watches `auth.json` for success detection).
- **Updates**: Background check at launch (3s delay, non-blocking, respects `updateCheckEnabled` setting). `update.run` spawns `pi update --no-approve` via `spawn()` with 10-minute safety timeout, streams output via IPC events. New sessions automatically use the updated binary.
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
| `src/renderer/src/components/shell/UpdateBanner.tsx` | Dismissible update card — sits above the composer (session) or floats bottom-right (empty screen) |
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
