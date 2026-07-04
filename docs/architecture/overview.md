# Project overview

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
│   ├── index.ts             # Entry: BrowserWindow creation, IPC init, settings/window persistence, background update check, CSP, navigation hardening (external links open in OS browser). Test isolation: when PIVIS_SETTINGS_DIR is set (the e2e suites), the WHOLE userData dir is redirected there BEFORE requestSingleInstanceLock — the single-instance lock and Chromium's ProcessSingleton are keyed on userData, so without this a test instance collides with a running production Pi-Vis (or parallel test workers) and quits before creating a window
│   ├── ipc.ts               # All ipcMain.handle() registrations — the main-process API surface (auth, pty, updates)
│   ├── auth.ts              # Auth file management: read/write ~/.pi/agent/auth.json with proper-lockfile, login-shell env detection, fs.watch
│   ├── pty.ts               # Embedded terminal (node-pty) for pi /login OAuth flow
│   ├── updates.ts           # Update checker (pi.dev/api/latest-version) + runner (spawns `pi update`)
│   ├── settings-store.ts    # Reads/writes ~/Library/Application Support/pi-vis/settings.json
│   ├── workspaces.ts        # Workspace picker (OS dialog), manual ordering (workspaceOrder), multi-expand tracking
│   ├── pi/                  # Pi subprocess management
│   │   ├── pi-process.ts    # Wraps a single `pi --mode rpc` child process; spawned with login-shell env (PATH etc.); correlated RPC over JSONL
│   │   ├── jsonl-stream.ts  # Byte-level JSONL parser (splits on \n only, never Unicode separators)
│   │   ├── locate-pi.ts     # Finds pi binary via $SHELL/which/override; validates `--version` with login-shell env (pi's `env node` shebang needs node on PATH); caches result
│   │   └── locate-node.ts   # Resolves the user's system `node` (the same Node `pi` runs under) and decides whether to retarget the SDK-host fork onto it. The host is forked from Electron's main process and so defaults to Electron's BUNDLED Node (historically Electron 31 → Node 20.14, which lacked `node:sqlite` and broke `@cursor/sdk`'s `SqliteLocalAgentStore`; today Electron 43 → Node 24.17). `chooseHostExecPath` retargets the host to the system Node ONLY when it's strictly newer than Electron's bundled version — the comparison is dynamic (`process.versions.node`), so the Electron 43 bump automatically raised the bar (a system Node ≤ 24.17 now stays on Electron's Node); else `undefined` → Electron default (the fallback). `resolveHostExecPath()` is cached (one login-shell round-trip per app lifetime).
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
│       ├── editor-theme.mjs  # buildEditorTheme(pi, theme): reconstructs pi's
│       │                     #   getEditorTheme() ({borderColor, selectList}) from the
│       │                     #   PUBLIC surface — pi-tui's Editor needs it, NOT the raw theme
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
│   │   ├── common/          # Shared primitives: FadeText (fade truncation + hover reveal glide — see docs/ui-conventions.md), icons.tsx (the app's ONE SVG glyph set — see docs/ui-conventions.md), BranchDropdown (search + scrolling list + pinned "Include remote branches" checkbox footer), viewer-header.css
│   │   ├── composer/        # Textarea input: prompts, !bash, /slash commands, image attach, autocomplete
│   │   ├── transcript/      # TranscriptView, DiffBlock (renders user/assistant/tool_call/bash/compaction blocks)
│   │   ├── notifications/   # NotificationStack (persistent in-session alerts, stacked/expandable over the transcript)
│   │   ├── shell/           # TitleBar, Sidebar (workspace switcher with manual drag-reorder + multi-expand chevrons, session list, tabs, drag/drop), StatusBar,
│   │   │                   #   Dock (above-composer tray — bordered card connected to the composer, floating pills inside: extension widget pills + update pill; floating UpdateBanner bottom-right on the empty screen)
│   │   ├── auth/            # LoginTerminal (embedded xterm.js terminal for pi's /login OAuth flow)
│   │   ├── updates/         # UpdateProgress (modal with streaming `pi update` output via AnsiText)
│   │   ├── diff/            # DiffViewerHost, DiffFileSection (Shiki-highlighted unified/split diffs)
│   │   ├── ext-ui/          # ExtensionDialogHost (select/confirm/input/editor dialogs); CustomPanelHost + UnifiedTuiHost (inline xterm panels) + panel-sizer.ts (shared grid-tracks-content sizing engine)
│   │   ├── ErrorBoundary.tsx # React error boundary (reloadable card) — used at TWO levels: top-level in main.tsx (whole shell) + per-session in App; prevents render crashes from white-screening
│   │   ├── pickers/         # AppPickerHost — /model, /fork, /resume pickers that replace the Composer in the flex slot (same in-place treatment as ExtensionDialogHost/CustomPanelHost), not modal overlays
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
│   │   ├── shiki.ts         # Shiki highlighter singleton (lazy init; constructs from concrete object themes, then loads each string-ref theme individually so a single bad ref can't abort highlighting; setShikiTheme resolves a Theme's syntax ref|inline)
│   │   ├── markdown.tsx     # react-markdown with remark-gfm + Shiki code blocks
│   │   ├── ansi.tsx         # ANSI escape code → React (for terminal output rendering)
│   │   └── format.ts        # Token/cost formatting helpers
│   └── theme/
│       ├── registry.ts      # Renderer theme registry (bundled + user themes); getTheme/listThemes/setUserThemes
│       ├── xterm.ts         # buildXtermTheme(theme): xterm 16-color palette + extendedAnsi (indices 16.., role identity → active-scheme hex) from a Theme's semantic colors; the load-bearing surface for live re-theming (shared by the 3 terminal panels)
│       └── theme.css        # :root semantic palette (Mocha defaults for pre-JS paint) + composite tokens — NO Catppuccin swatch names
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
    ├── theme/               # Theming system (semantic, palette-agnostic — see "Theming" below)
    │   ├── tokens.ts        # COLOR_TOKENS vocabulary (26 semantic roles) + Zod ThemeSchema (id/name/appearance/colors/syntax ref|inline)
    │   ├── pi-theme.ts      # Bridge to pi's OWN theme vocabulary (~50 roles): PI_ROLES/PI_BG_ROLES, palette-agnostic PI_THEME_DEFAULTS (pi-role→token); buildPiThemeColorIndices() → {fg,bg} role→index maps the host installs (emits role-identity bytes, not RGB), and buildPiThemeColors(theme) → {fg,bg} role→hex maps the renderer resolves per scheme; PI_ROLE_INDEX/PI_INDEX_ROLE/PI_INDEX_TOKEN (the stable index↔role↔token contract shared host↔renderer)
    │   ├── bundled.ts       # Imports the JSON below, parses each through ThemeSchema, exports BUNDLED_THEMES + DEFAULT_THEME_ID
    │   ├── themes/          # One pure-data JSON colorscheme per file (full Theme shape: id/name/appearance/colors/syntax)
    │   │   ├── catppuccin-mocha.json / catppuccin-macchiato.json / catppuccin-frappe.json / catppuccin-latte.json
    │   │   ├── gruvbox-material-dark.json / gruvbox-material-light.json
    │   │   ├── everforest-dark.json / everforest-light.json
    │   │   └── glow-sticks.json
    │   └── index.ts         # buildThemeRegistry/resolveTheme (global fallback) + resolveThemeForAppearance (split light/dark fallback) + piThemeForTheme (appearance → pi light/dark) + re-exports buildPiThemeColors/buildPiThemeColorIndices/PI_ROLE_INDEX/PI_INDEX_TOKEN/PI_ROLES/PI_THEME_DEFAULTS
    ├── settings.ts          # AppSettingsSchema (Zod): fonts, paths, piEnv (user-configured KEY=value vars merged into every pi session/login-terminal spawn after login-shell env; PIVIS_* reserved), workspaceOrder + expandedWorkspaces, pinnedSessions (global, by session-file path, manual order), lastActiveWorkspace, lightColorScheme/darkColorScheme + themeMode (free theme-id strings resolved against the registry at apply time; mode may follow system), diff mode, diffMaxFileSizeMiB (diff viewer file-size cap, default 5), diff rail width + visibility (persisted layout for the diff viewer's file-list sidebar), sidebar width/collapsed, window bounds
    ├── git.ts               # GitChangedFile, GitChangesResult, GitFileDiffResult types
    ├── result.ts            # Result<T,E> utility + assertNever
    └── session-file/        # Session file format schemas (header, message/model-change/snapshot entries)
```
