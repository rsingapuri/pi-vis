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
│   │   ├── locate-pi.ts     # Finds pi binary via $SHELL/which/override; validates `--version` with login-shell env (pi's `env node` shebang needs node on PATH); caches result
│   │   └── locate-node.ts   # Resolves the user's system `node` (the same Node `pi` runs under) and decides whether to retarget the SDK-host fork onto it. The host is forked from Electron's main process and so defaults to Electron's BUNDLED Node (Electron 31 → Node 20.14), which lags the user's Node and breaks extensions needing newer built-ins — notably `@cursor/sdk`'s default `SqliteLocalAgentStore`, which needs `node:sqlite` (Node ≥ 22.5; works in terminal pi, breaks in the forked host). `chooseHostExecPath` retargets the host to the system Node ONLY when it's strictly newer than Electron's bundled version (self-justifying + adapts to a future Electron bump); else `undefined` → Electron default (today's behavior, the fallback). `resolveHostExecPath()` is cached (one login-shell round-trip per app lifetime).
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
│   │   ├── common/          # Shared primitives: FadeText (fade truncation + hover reveal glide — see Key Patterns), icons.tsx (the app's ONE SVG glyph set — see Key Patterns), BranchDropdown (search + scrolling list + pinned "Include remote branches" checkbox footer), viewer-header.css
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
    │   │   └── gruvbox-material-dark.json
    │   └── index.ts         # buildThemeRegistry/resolveTheme (fallback to default) + piThemeForTheme (appearance → pi light/dark) + re-exports buildPiThemeColors/buildPiThemeColorIndices/PI_ROLE_INDEX/PI_INDEX_TOKEN/PI_ROLES/PI_THEME_DEFAULTS
    ├── settings.ts          # AppSettingsSchema (Zod): fonts, paths, workspaceOrder + expandedWorkspaces, pinnedSessions (global, by session-file path, manual order), lastActiveWorkspace, colorScheme (now a free theme-id string, validated against the registry at apply time), diff mode, diffMaxFileSizeMiB (diff viewer file-size cap, default 5), diff rail width + visibility (persisted layout for the diff viewer's file-list sidebar), sidebar width/collapsed, window bounds
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
  - **Runs under the user's Node, not Electron's.** The fork passes `execPath: <system node>` when `resolveHostExecPath()` (`locate-node.ts`) finds a system Node strictly newer than Electron's bundled Node — closing the parity gap where the forked host (default: Electron's Node, e.g. 20.14 for Electron 31) lacked newer Node built-ins that terminal pi has. Concrete case: `@cursor/sdk`'s default `SqliteLocalAgentStore` needs `node:sqlite` (Node ≥ 22.5); it worked in terminal pi (user's Node) but threw in Pi-Vis (Electron's Node). Retargeting restores parity for `node:sqlite` and any newer-Node built-in. Falls back to Electron's bundled Node (`execPath` omitted) when no system Node is found or it isn't newer — today's behavior, so no regression. (Note the `pi --mode rpc` fallback path already ran under the user's Node via pi's `#!/usr/bin/env node` shebang, so only the SDK-host path needed this.)
  - Same EventEmitter shape as PiProcess (event, uiRequest, exit, error events; sendCommand/sendUiResponse methods)
  - Additional panel events: panelOpen, panelData, panelClose, panelClearAll, unifiedSubmitRequest (the unified-TUI editor submitted text → renderer runs the shared submit pipeline)
  - `activateSession` tries SessionHost first; on failure falls back to PiProcess (progressive enhancement)
  - **Renderer contract unchanged**: PiRpcCommand/PiEvent/ExtensionUiRequest types preserved
- **Unified TUI panel (factory `setWidget`)**: when an extension registers a *factory* `setWidget`, the host builds a real pi-tui `TUI` (Editor + widget Containers `[widgetAbove, editorContainer, widgetBelow]`) and opens a **persistent** `unified: true` panel. `UnifiedTuiHost` renders it in the Composer slot (xterm.js, sibling of `CustomPanelHost`). A **view switcher** (`UnifiedViewToggle`, a text-labeled segmented control in the right-side controls cluster of the session header, shown only while a unified panel is live) lets the user flip between the extension's TUI ("Extension") and the native Composer ("Input") without closing the widget — gated by the per-session `unifiedPanelHidden` store flag (default `false` = TUI visible, the parity-correct surface; reset to `false` on `panel_open`/`panel_close`/`unified_panel_reset` so a fresh panel always starts visible; `setUnifiedPanelHidden` is the only mutation). The toggle sits in the right-side controls cluster, before the changes button, for better visibility and to follow 2026 UX patterns where session-level toggles live in the header alongside other controls. The non-visible surface is simply unrendered — the TUI editor keeps its contents in the host process and the Composer draft lives in the store, so each survives a round-trip. `onTerminalInput` joins the TUI's pre-editor input chain (full pi parity); clipboard image paste is driven by a `tui.addInputListener` matching `app.clipboard.pasteImage` (the host uses pi-tui's **public base `Editor`**, which has no `onPasteImage`/`app.*` handling — that lives on pi's *private* `CustomEditor`, forbidden by `host-imports.test.ts` — **so `app.interrupt` (Escape) is NOT wired host-side**: Escape only cancels an open autocomplete in the base Editor, it cannot interrupt the agent from the host. Instead the **renderer-only global ESC handler** (`useGlobalEscapeInterrupt`) interrupts the agent for the unified panel too — it fires regardless of xterm focus and preempts the keystroke before it reaches the host, **except in viewport mode** (an overlay is open), where UnifiedTuiHost claims ESC so it defers to the host and the overlay closes (pi parity — see the ESC-to-interrupt Key Pattern). Idle ESC (no streaming turn) still reaches the host editor's autocomplete-cancel through the existing `onData → panelInput` path. See the "ESC-to-interrupt" Key Pattern for the full precedence model and why a host-side listener was rejected (focus-drift gap). Documented at `ui-context.mjs` `UNIFIED_KEYBINDINGS`). **EditorTheme gotcha (load-bearing):** pi-tui's `Editor` takes an `EditorTheme` (`{ borderColor:(s)=>string, selectList }`), **not** pi's full `Theme` singleton. Passing the singleton makes `Editor.render()` throw `this.borderColor is not a function` on the first render tick — the panel opens (Composer replaced) but never paints, and the throw inside pi-tui's render timer can crash the host (symptom: "fleet view disables the composer and nothing else happens"). `host.mjs` builds the right object with `buildEditorTheme(pi, theme)` (`editor-theme.mjs`), reconstructing pi's own `getEditorTheme()` from the PUBLIC surface (`theme.fg("borderMuted", …)` + the exported `getSelectListTheme()`), and passes it to `createUIContext({ editorTheme })`. The editor's `onSubmit` round-trips to the renderer (`session.unifiedSubmitRequest` → `session.unifiedSubmitResponse`) so a guard bail (no model) can restore the text; the store's `handleUnifiedSubmitRequest` builds the **same deps as the Composer** (via the shared `adoptSessionFileAndHydrate`) so `/fork`/`/clone`/`/switch_session`/`/resume` work identically. `createUIContext` returns `{ context, unified }` (a controller bundle: `dispose`/`resolveSubmit`/`resolveClipboardImage`) consumed by `host.mjs`/`bridge.mjs` — NOT via `globalThis`.
- **Panel channel**: `session.panelEvent` (IPC: main→renderer), `session.panelInput` + `session.panelResize` (IPC: renderer→main→host). Panel events: `panel_open`/`panel_data`/`panel_close`/`panel_clear_all` (custom() rendering), `panel_open` with `unified: true` (persistent unified-TUI panel — see above), `panel_mode` (`viewport`|`content` — toggles the unified panel's sizing model when a pi-tui overlay shows/hides; see the sizing-model note below), `unified_panel_reset` (host process gone on `/reload`/crash/close — drop stale `unifiedPanel` state; the dying host can't emit a reliable `panel_close`), `host_fallback` (host couldn't start — fell back to `pi --mode rpc`, panels unavailable; surfaced as a notification), `session_warning` (non-fatal warning like session-file lock contention; surfaced as a notification).
  - Both CustomPanelHost and UnifiedTuiHost render ANSI in an xterm.js overlay (mirroring LoginTerminal) and share the **sizing engine** (`panel-sizer.ts` `createPanelSizer`), but use it in DIFFERENT modes. `UnifiedTuiHost` **content-tracks**: its base render (the Editor + widget containers) has an intrinsic content height, so the grid hugs it. `CustomPanelHost` does NOT content-track — a custom() panel is ALWAYS a pi-tui *overlay*, composited full-frame against `terminal.rows` (blank-padded, often centered — e.g. /rtk's `maxHeight:"85%" anchor:center` modal), so its rendered height is a *function of the grid we report*; content-tracking it chases the centering padding and thrashes (a huge mostly-blank box with the modal shoved to an edge and clipped — the reported bug). Instead CustomPanelHost defaults to **`"viewport"` mode**: the grid is pinned to the display cap (~half the transcript column, or the user's drag-resized preference — see below), re-derived on resize (deterministic + re-expands, no window-resize hysteresis), and the overlay self-scrolls inside that steady "screen" exactly as in terminal pi; if the overlay is taller than the box pi-tui clips it (accepted at small window sizes — the extension's own centered look is preserved, and a future host `panel_mode:"content"` signal can opt a panel back into content-tracking). The host does NOT rewrite the extension's overlay options. **Manual resize:** an INVISIBLE top-edge strip (`.custom-panel__resize`, `cursor: row-resize` — the cursor change is the only affordance, the strip is transparent) lets the user drag the panel's height. The height is stored as a FRACTION of the transcript column in the app setting `customPanelHeightFraction` (0.2–0.9, `null` = default ~half), so it survives window/sidebar/font resizes (re-derived on every layout) and applies to every future custom() panel (a global preference, not per-content). The sizer reads it live via a `getHeightFraction` getter (drag-in-flight value → persisted preference → default), so a drag / settings change re-runs `sync()` WITHOUT rebuilding xterm (the lifecycle effect is keyed on `panelId` only; `fractionGetterRef` + a `customPanelHeightFraction` effect drive re-sync). Dragging commits the fraction on `mouseup` (debounced to a single write). Double-clicking the handle clears the override → default height. Does NOT affect the unified panel (it content-tracks). The load-bearing fact for the content-tracker (UnifiedTuiHost): **pi-tui writes ALL its rendered lines with no clamp to `terminal.rows`** — when content is taller than the grid it scrolls and **bottom-anchors**, pushing the top into scrollback (the "cut-off top line" bug). So the grid is NOT a fixed budget; it **tracks the content**: `createPanelSizer`'s `sync()` resizes the xterm `rows` toward `contentRows + 1` (a one-row blank **sentinel** distinguishes "content fits" from "content filled the grid and may be clipped"; on a `filled` measurement it jumps to a `hardMax` ceiling so the next render reveals the true height, then shrinks to fit) and reports it via `panelResize`. A height change makes pi-tui `fullRender(true)` (clears scrollback + re-lays-out), so the resize brings the clipped top back; convergence is ≤2 resizes (it re-runs `sync()` on a post-resize rAF since xterm reflows the buffer — doesn't depend on a host frame, so it settles in the host-less preview too). The **mount** (`.custom-panel__xterm` / `.unified-panel .xterm`) holds the full grid; the **card** — `.unified-panel` for the unified panel, or `.custom-panel__scroll` (a scroll wrapper inside `.custom-panel`, so the force-close ✕ stays pinned while the wrapper scrolls) for a custom() panel — is JS-sized to `min(contentRows, maxDisplayRows) × cellHeight + chrome`, where `maxDisplayRows = floor(0.5 × .app__session height / cellHeight)` is the deterministic display cap. A **`"viewport"` mode** (`getMode()`) instead pins a fixed grid (the display cap) via `applyFixedViewport(maxDisplayRows())` and stops tracking — used by custom() panels by default and by the unified panel when an overlay shows (the mode signal). `overflow-y` is set to `auto` ONLY when `contentRows > maxDisplayRows` (the card scrolls — not xterm's own viewport — top-anchored, so the spec's "scrollbar only past the max" holds); otherwise `hidden` (trailing blanks incl. the sentinel are clipped). `contentRows` is `max(lastNonBlankRow, cursorY) + 1` so the editor's (possibly blank) input line is never trimmed. Heights are measured in xterm's `write()` callback (after parse) — a synchronous read saw a not-yet-parsed buffer on cold mount, which made the panel open too short until a remount. Cell height comes from the render service (`_core._renderService.dimensions.css.cell.height`), not a `fontSize × 1.2` guess; re-derived (with cols) when `.app__session` resizes (window/sidebar/font). NOTE: a session can keep the panel mounted after work completes if an extension leaves a factory widget registered (e.g. `pi-subagents`' agent-widget lingers until the next main-agent turn — `setWidget(key, undefined)` is what disposes the unified TUI; `disposeUnifiedTui` fires only when **all** factories are cleared). That's extension/parity behavior (invisible in terminal pi where the TUI is always present), not a host bug; the UnifiedViewToggle is the user's escape hatch back to the Composer.
    - **Viewport mode (overlay robustness).** The grid-tracks-content model assumes content has an **intrinsic height independent of the rows it's given**. A pi-tui **overlay** (e.g. pi-subagents' "inspect" box, shown via `custom()` on the unified TUI) breaks that: pi-tui composites overlays **relative to `terminal.rows`**, so the box's rendered height is a *function* of the grid we report — and we report the grid from the rendered height. That's a feedback loop the content tracker can't converge (the "wiggle": the box redraws/shifts every frame). Fix: the host signals a **mode** on the panel. When `custom()`'s reuse path calls `tui.showOverlay`, `ui-context.mjs` emits `panel_mode: "viewport"` (and `"content"` in `teardown()`'s `hideOverlay`). In viewport mode `sync()` **pins a fixed grid** (`applyFixedViewport(maxDisplayRows())`) and stops tracking — the overlay gets a steady "screen" and renders identically to terminal pi, no wiggle. Mode lives on `unifiedPanel.mode` in the store and is read live via `modeRef` (a mid-panel mode flip must NOT rebuild xterm); a small effect keyed on `panelMode` re-runs `sync()` on the flip. The signal rides public surface only — `showOverlay`/`hideOverlay` are already called by the host (no new pi API). **Defense-in-depth:** `sync()` triggers are rAF-**coalesced** (`scheduleSync`), and a **resize-storm circuit breaker** (>6 resizes / 400ms ⇒ pin to the tallest size seen for a 1s cooldown, then re-evaluate) tames any *un*-signaled extension whose layout is grid-coupled. See `panel-events.ts` `PanelModeEvent`.
  - `session.unifiedSubmitRequest` (event, host→renderer) + `session.unifiedSubmitResponse` (invoke, renderer→host): the unified-TUI editor submit round-trip (correlated by id)
  - Composer decoupled: extension commands fire-and-forget (execute.ts)
- **Project trust (security)**: the host wires `resolveProjectTrust` into `createAgentSessionServices` (deny-by-default, matching terminal pi). A folder with trust-requiring project-local resources prompts a React **select** dialog *during* host startup, offering pi's full choice set (trust folder / trust parent / trust this-session-only / deny / deny this-session-only — `buildProjectTrustOptions`); the chosen option's updates persist via the public `ProjectTrustStore.setMany` (`get()` walks ancestors, so a parent grant covers children). Because the prompt fires pre-`ready`, the registry attaches the `uiRequest`/panel listeners **before** `waitForReady`, and `SessionHost` pauses its startup watchdog while a pre-ready dialog is outstanding (a human, not a hang). Without this gate, pi loads project-local `.pi/` extensions ungated (`projectTrusted` defaults `true`). The host derives `agentDir` from `pi.getAgentDir()` so the trust store, services, and runtime agree and stay shared with terminal pi.
- **Zero private pi imports**: the host uses only pi's public `dist/index.js` surface (+ public pi-tui + bundled undici). The active theme comes from public `initTheme()` + reading `globalThis[Symbol.for("…:theme")]`, not a deep import. Enforced by `src/main/pi/host-imports.test.ts`.
- **Color-scheme sync (terminal/ANSI surfaces — indexed-semantic architecture)**: every host-rendered surface — extension `theme.fg("text"|"muted"|"borderMuted"|…)`, the unified TUI, and `custom()` panels — emits **role-identity ANSI INDICES**, not baked RGB, so a scheme change recolors every cell (including ones already in the buffer) live at the renderer with zero re-emit and zero host involvement. The host is **color-agnostic**; the renderer is the single source of color truth. Mechanism, in two layers: (1) **`PIVIS_PI_THEME`** (`"dark"|"light"`) loads pi's built-in theme as a base via `initHostTheme` (the fallback if layer 2 fails, and the only signal on the RPC path); (2) **`PIVIS_PI_THEME_COLORS`** carries **STABLE per-role ANSI palette indices** (`piThemeColorIndices()` in `main/theme-loader.ts` → `buildPiThemeColorIndices()` in `shared/theme/pi-theme.ts`) — scheme-INDEPENDENT and constant — so the host does `new pi.Theme(fg, bg, "truecolor")` with **numeric** per-role values, which pi's `fgAnsi` emits verbatim as `\x1b[38;5;N m` (the numeric branch ignores `mode`), and writes the instance to the `globalThis[THEME_KEY]` symbol every extension reads (`applyPiVisTheme` in `bootstrap.mjs`). `PI_ROLE_INDEX` (in `shared/theme/pi-theme.ts`) assigns each of pi's ~50 roles a fixed, unique index in the xterm extended range (16+i in `PI_ROLES` order); `PI_INDEX_ROLE`/`PI_INDEX_TOKEN` reverse it. The RENDERER resolves each index against the active scheme at paint time via two surfaces: **xterm panels** (`buildXtermTheme(theme)` in `theme/xterm.ts` fills `ITheme.extendedAnsi[i]` = the active scheme's resolved hex for `PI_ROLES[i]`, from `buildPiThemeColors(theme)`; assigning `term.options.theme` rebuilds xterm's palette and repaints every indexed cell — verified against xterm's `ThemeService`, which stores cells by index and re-resolves), and **AnsiText** (`lib/ansi.tsx`'s `color256` maps `PI_INDEX_TOKEN` → `var(--<token>)`, so CSS variables recolor widget text live with no re-render). Both env vars are set fresh per spawn in `getHostEnv()` (`ipc.ts`). **Live changes:** a scheme change is handled ENTIRELY renderer-side — `UnifiedTuiHost`/`CustomPanelHost`/`LoginTerminal` subscribe to `colorScheme` reactively and assign `term.options.theme = buildXtermTheme(getTheme(scheme))`, which repaints buffered cells live. No session respawn is needed (so there is no busy-skip gap); the old `settings.set`→`SessionRegistry.reloadRunningSessions()` path was removed because the host no longer carries scheme color. (The `pi --mode rpc` fallback path has no host, so it still emits pi's default truecolor and loses fidelity there — accepted, since RPC is the legacy fallback.)

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
- `session.transcriptForEntries` — converts a raw `SessionTreeEntry[]` (root→leaf) to `TranscriptBlock[]` via the shared `entriesToTranscript` helper; used by the tree viewer after `navigate_tree` to rebuild the transcript from pi's in-memory branch without re-reading the session file
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
- `session.uiRequest` — Extension UI requests (dialogs, notifications, status bar, widgets)
- `session.statusChanged` — SessionStatus transitions
- `session.fileChanged` — session file association updated
- `auth.changed` — auth.json modified externally (e.g. pi's token refresh)
- `pty.data` / `pty.exit` — embedded terminal I/O
- `update.available` / `update.progress` / `update.done` — update lifecycle

### Pi RPC Protocol (`shared/pi-protocol/`)

Pi runs in `--mode rpc` with JSONL on stdin/stdout. Every command has a unique `id` for correlation. Key types:

- **Commands** (renderer → pi): `prompt`, `steer`, `follow_up`, `abort`, `bash`, `set_model`, `set_thinking_level`, `new_session`, `fork`, `clone`, `compact`, `get_commands`, `get_state`, `get_session_stats`, `get_available_models` (returns scoped subset when `scopedModels` is non-empty, else all), `get_scoped_models`, `set_scoped_models` (session-only scope), `save_scoped_models` (persists scope to pi's `settings.json` via `settingsManager.setEnabledModels` AND applies to the current session), etc.
- **Events** (pi → renderer): `agent_start/end`, `turn_start/end`, `message_start/update/end` (with nested `text_delta`/`thinking_delta` streaming), `tool_execution_start/update/end`, `compaction_start/end`, `queue_update`, `thinking_level_changed`, `session_info_changed`, `extension_error`
- **Extension UI**: pi extensions request UI via `ExtensionUiRequest` (select/confirm/input/editor dialogs, or fire-and-forget notify/setStatus/setWidget/setTitle/set_editor_text). Dialogs block until renderer responds via `session.respondToUiRequest`.

### State Management

All renderer state uses **Zustand** stores:

- **`sessions-store`** — The primary store. Maps `SessionId → SessionViewState` (transcript, streaming status, pending dialogs, status segments, widgets, notifications/toasts, stats, model info, thinking level, commands, worktreeCreate/worktreeBase/worktreeCreating/worktreeError/worktreePath/worktreeBranch/worktreeName/worktreeFromBase for worktree-per-session — `worktreeError` is the durable inline failure shown in the WorktreeBar). Handles all mutations via IPC calls + local state updates. Export `gitRootForSession(session)` helper that returns the worktree path if set, else the workspace path — used by the diff viewer and changes badge. **Composer draft preservation** lives in two in-memory (never persisted) maps, both read via `getState()` in the Composer's seeding effect so per-keystroke writes don't trigger re-renders: `newSessionDrafts: Map<workspacePath, string>` for *pending* new sessions (keyed by workspace, not session, because a pending session is hidden from the sidebar — switching away abandons it, and the only way back is clicking "+ New session" again, which creates a fresh session that re-seeds from the workspace slot), and `sessionDrafts: Map<SessionId, string>` for every *non-pending* session (so typed text survives switching to another session and back). Both are cleared the moment a message is actually sent (`addUserMessage`/`addBashCommand`/`addCustomMessage` clear on content landing; the Composer's post-submit clear also drops non-promoting slash-command text like `/model`, `/name`). `removeSession` drops the closed session's draft. **Editor-injection lifecycle:** `editorInjection` (from `set_editor_text` extension UI requests) persists in `SessionViewState` with a monotonic nonce so the Composer's effect re-fires on change. To prevent a stale injection from clobbering the restored draft on Composer remount (switch away and back), the injection is *consumed* — cleared via `clearEditorInjection` — the moment the user takes over the textarea (types / picks a suggestion) or sends content (`addUserMessage`/`addBashCommand`/`addCustomMessage` set `editorInjection: undefined`; the Composer's post-submit clear calls `clearEditorInjection` for non-promoting slash commands). A fresh injection arriving while the user is away still applies on remount (nonce changed, not consumed).
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
2. **Activate**: `session.activate` IPC → `SessionRegistry.activateSession()` spawns the **SessionHost** (SDK-direct, forks `resources/pi-session-host/host.mjs`) as progressive enhancement. A min-pi-version gate (`MIN_PI_VERSION` in `host.mjs`, compared via `version.mjs`'s `compareVersions`) exits the host with code 42 if pi is too old; `SessionHost` detects this and the registry falls back to **PiProcess** (`pi --mode rpc`), emitting a `host_fallback` panel event so the renderer shows an "update pi for panel support" notification. The caller's request (`_hostRequested`) is sticky across fallbacks: `/reload` re-tries the host iff the caller originally wanted it (a pi upgrade mid-session re-promotes), while a worktree respawn preserves the ACTUAL running mode (`_useHost`) since the pi install is unchanged. The registry holds a proper-lockfile advisory lock on the session file (released on close/exit/error/failed-activation; `onCompromised` is overridden to log-and-clear instead of throw).
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

### Conversation tree (`/tree`)

`/tree` opens a first-class, native overlay (Catppuccin-themed) for browsing the conversation DAG and switching the active leaf **in place** — distinct from `/fork`, which spawns a *new* session. Built on top of the SDK host's public tree surface; pi exposes `session.sessionManager.{getTree, getLeafId, getBranch, appendLabelChange}` and `session.navigateTree(targetId, options)` synchronously. The host bridge handles three new RPC commands: **`get_tree`**, **`navigate_tree`** (returns `branch` + `leafId` post-navigation), and **`set_label`** (sync, in-memory labelsById update). Capability gating is **per-command**, not host-wide: a missing `getTree`/`navigateTree` on older pi versions degrades to `phase: "unsupported"` (with the friendly "Tree view requires the SDK host — update pi" message — never pi's raw `"Unknown command: get_tree"`), so panels still work.

**Flat wire format (contextBridge depth limit).** pi's `getTree()` returns a *recursively nested* tree (`{entry, children:[...]}`) whose depth equals the longest root→leaf message chain — unbounded. Electron's `contextBridge` hardcodes a **1000-level object-nesting limit**, so a session with >1000 messages in its longest chain threw `recursion depth exceeded` the instant the response crossed the preload→renderer boundary, before the renderer ever saw it. The host bridge therefore **flattens** the nested tree into a `FlatTreeNode[]` (`{entry, parentId, label?, labelTimestamp?}`, `parentId: undefined` for top-level roots, sibling order preserved) — wire depth is now a constant. The renderer re-nests it in its own world (no contextBridge limit there) via `buildNestedTree` (`tree-flatten.ts`, iterative so a multi-thousand-deep chain can't stack-overflow). The recursive `SessionTreeNode`/`SessionTreeNodeSchema` types are kept for the renderer-internal nested form the flattener consumes; they NEVER cross the IPC/contextBridge boundary. Only `get_tree`'s response was affected — `navigate_tree`'s `branch` and `transcriptForEntries`' input are already flat arrays of shallow entries.

The transcript rebuild after navigation reads from pi's authoritative in-memory state via `_session.sessionManager.getBranch()` (synchronous; already root→leaf ordered) rather than re-reading the session file — freshly-appended entries (e.g. a just-synthesized `branch_summary`) may not be on disk yet. The conversion lives in a pure helper `entriesToTranscript(orderedEntries)` (`src/main/sessions/history-loader.ts`) extracted from the existing file-load path. `branch_summary` entries render as the existing `compaction` block type (with the summary text) — no new `TypedTranscriptBlock` member. Renderer state lives in `useTreeStore` (`src/renderer/src/stores/tree-store.ts`); the overlay is `TreeViewerHost` (`src/renderer/src/components/tree/TreeViewerHost.tsx`).

**Modal semantics mirror `DiffViewerHost` exactly** — `TreeViewerHost` is a direct child of `.app` (next to `DiffViewerHost`, NOT inside `.app__session`), and `.tree-overlay`/`.tree-viewer` copy `.diff-overlay`/`.diff-viewer` verbatim (`grid-area: main`, card-inset, scrim + backdrop blur, `--elevation-3`, the `.app--sidebar-collapsed` full-window variant, the pop-in animation, backdrop-click-to-close, `useEscapeClaim`). So the two overlays open at identical dimensions/shadow.

**The flattener (`tree-flatten.ts`, `flattenVisible` + display helpers; unit-tested in `tree-flatten.test.ts`) is a faithful port of pi's TUI tree-selector** (`modes/interactive/components/tree-selector.js`). Three parity facts the original implementation got wrong and that this port fixes:
- **Per-node filtering, NOT subtree pruning.** Real sessions begin with settings entries (`model_change`/`thinking_level_change`/`session_info`) at the *root*; the default filter hides those. The old code recursively skipped a filtered node's entire subtree, so default-filtering the settings roots pruned every message beneath them → the overlay showed nothing unless you switched to "All". The port flattens once, then filters each node independently; hidden nodes' descendants reattach to the nearest visible ancestor.
- **Branch-only indentation.** Depth increases only under a genuine branch point (a node with ≥2 *visible* children), so a linear conversation renders flat — no per-line staircase. Computed from the nearest-visible-ancestor chain.
- **No `tool_call` entry type exists in pi.** Tool calls live inside assistant-message content; tool *results* are `message` entries with `role: "toolResult"`. The "no-tools" filter hides those toolResult messages (the old code filtered a non-existent `tool_call` type, so "no-tools" was a no-op). A `toolCallMap` harvested from assistant content names each toolResult row.

The active root→leaf path is marked with a `•` bullet (pi's marker) and the active branch is sorted first among siblings. Filters are **keyboard-driven** (⌘/⌃ + d/t/u/l/a, mirroring pi — no button bar; the active non-default filter shows as a small tag by the title), and search matches per-node (AND-tokenized). The overlay-aware keydown guards in `App.tsx` (`useGlobalEscapeInterrupt` defer + the Cmd+G handler) include `.tree-overlay` so Escape/Cmd-G don't double-fire.

**Mid-turn guard**: `navigateTo` checks `useSessionsStore.getState().sessions.get(sessionId)?.isStreaming` first; pi's `navigateTree` has no internal streaming guard and overwrites agent state, so navigating mid-stream would corrupt the active turn (mirrors `executeReload`'s wording). On success → `seedHistory` from the returned branch, `injectEditorText` if `editorText` present, re-fetch `get_session_stats` only (no model/thinking reconcile — `navigateTree` mutates only `agent.state.messages`).

### Command System (`renderer/src/lib/commands/`)

The composer parses input into typed `ComposerAction` discriminated unions:
- `!text` → bash command
- `/command [args]` → slash command (builtins mirror pi's TUI: model, compact, name, session, new, export, fork, clone, resume, copy, quit, settings, diff, tree, login, reload)
- Otherwise → user prompt

Builtins are defined in `builtins.ts` (mirrors pi's interactive-mode.js). Discovered commands (extensions/prompts/skills) come from `get_commands` RPC. `parse.ts` resolves input to an action; `execute.ts` dispatches it.

**`/login`** dispatches `{ kind: "open-login" }` → the composer fires a `pivis:open-login` CustomEvent → `App.tsx` opens Settings scrolled to the Account section.

**`/scoped-models`** opens the `ScopedModelsPicker` (a multi-select checkbox list mirroring pi's TUI `showModelsSelector`). Two submit actions match pi's TUI: **Apply** (`set_scoped_models`, session-only — lost on `/reload` since a fresh process rebuilds from `settingsManager.getEnabledModels()`), and **Save to settings** (`save_scoped_models`, global — persists to pi's `settings.json` via `settingsManager.setEnabledModels` AND applies to the current session immediately). After either action the renderer re-fetches `get_available_models` (the bridge returns the scoped subset when `scopedModels` is non-empty) so the `/model` dropdown reflects the new scope live. Footer also has **Select all** / **Select none** bulk toggles.

## Key Patterns

- **ESC-to-interrupt (renderer-only)**: ESC reliably interrupts the running agent from any view/focus state, while every other ESC affordance (close autocomplete, picker, dialog, dropdown, Settings, diff viewer, changelog, update modal, rename field, confirm dialog) keeps working. The design is **renderer-only** — the unified-TUI panel gets NO host-side ESC listener. A single global capture-phase `keydown` handler (`useGlobalEscapeInterrupt`, mounted once in `App.tsx`) interrupts when no overlay claims ESC and the active session is streaming; idle ESC reaches the host editor's autocomplete-cancel through the existing `onData → panelInput → base Editor` path. Precedence: (1) `hasClaim()` → defer (an ESC-owning surface handles it); (2) `isStreaming` → interrupt (`stopImmediatePropagation` preempts the Composer's synthetic onKeyDown AND same-node capture listeners); (3) else no-op. Modified/IME ESC and non-active sessions are ignored. **Overlay-claim registry** (`overlay-store.ts`): a ref-counted counter of open ESC-owning surfaces; `useEscapeClaim(open)` (a `useLayoutEffect` — **load-bearing**, NOT `useEffect`; layout effects flush before the next dispatched keydown, which is what makes the autocomplete two-press model work under OS key-repeat) acquires on open and releases on cleanup. Every ESC-owning surface calls it: Composer autocomplete (`showSuggestions`), Settings (`showSettings`), `AppPickerHost` (`!!picker`), `ExtensionDialogHost` (`!!current`), `CustomPanelHost` (`!!panel`), `DiffViewerHost` (`open`), `ChangelogModal` (`open`), `UpdateProgress` (`!!activeRun`), `ConfirmDialog` (`true`), `SessionHeader` rename (`editingName`), `SessionControls` dropdowns (`modelOpen || thinkingOpen`), `BranchDropdown` (`open`), `NotificationStack` expanded history (`notificationPanelOpen`), and **`UnifiedTuiHost` ONLY in viewport mode** (`panelMode === "viewport"`, i.e. a pi-tui overlay is open on the unified TUI). This last one is the ESC-parity fix: with an overlay up, ESC must do what pi's TUI does — **close the overlay** (overlay-close outranks interrupt), not abort the stream. Claiming defers the keystroke to the host, which closes the overlay. In **content** mode (no overlay) UnifiedTuiHost stays unclaimed, so a streaming ESC interrupts (the `app.interrupt` the base Editor can't supply). The **Composer autocomplete claim holds regardless of streaming** — an open autocomplete always consumes the first ESC (close), and only once closed does ESC abort (the invariant: autocomplete-open → close; autocomplete-closed → abort). **Streaming liveness (S1/S2)**: `isStreaming` clears at the earliest of a final (`!willRetry`) `agent_end`, a failed `auto_retry_end` (`success:false`, guarded on `isStreaming` so it's a no-op in the normal retry-exhaustion path where the final `agent_end` already cleared it — this is the load-bearing fix for **abort-during-retry-backoff**: when pi is sleeping between retry attempts and the user aborts, pi cancels the backoff and emits `auto_retry_end{success:false}` but NO further `agent_end`, because the only `agent_end` already fired carried `willRetry:true` before the backoff; without this branch the "Running for …" timer sticks on forever after the abort), a transition INTO a terminal `SessionStatus` (`"exited"`/`"failed"`, in `setSessionStatus` — never on a benign `ready`/`starting` re-emit), or a rejected/failed prompt send (`executeSendPrompt`'s try/catch + `!res.success` guard). `abortSession(sid)` is a no-op (no IPC) when `!isStreaming` and rejection-safe. **Autocomplete two-press model**: while suggestions are visible the Composer claims ESC, so the first ESC hides them (`setDismissed(true)`, NOT just a highlight reset) instead of aborting; `dismissed` resets on any text change or suggestion pick. This is the fix for the `/log` case — typing `/log`, ESC dismisses suggestions, then Enter submits the literal `/log` (previously Enter applied the `/login ` completion).

- **Branded types** for IDs: `SessionId`, `RpcRequestId` are `string & { __brand: "..." }` — prevents accidental mixing
- **Zod schemas everywhere**: All protocol types, settings, session files validated with Zod. Schemas live in `shared/` and are the single source of truth.
- **Pure transcript reducer**: `transcript.ts` is a pure function — no side effects, no store access, no in-place mutation. Easy to test. The per-token streaming path (`patchBlock`) is still pure: it returns a fresh array, but copies only the spine and replaces the one streamed slot, so it dodges the O(n) per-element `.map` that made streaming O(n²) on long sessions without sacrificing immutability or referential integrity.
- **Transcript activity cards**: operational/context events (`compaction`, `custom_message` notices, `/session` output) render with the same `.tool-card` shell as normal tool calls, not as tiny freestanding text or a separate visual system. They keep chronological placement in the transcript, use a `context`/`notice` tool-name label + FadeText subject, show a short markdown preview, and expand in-place for the full details.
- **Fire-and-forget UI requests**: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` are handled as side effects in `addUiRequest` without awaiting a response. Dialog types (`select`/`confirm`/`input`/`editor`) block pi until the renderer responds.
- **Notifications** (`components/notifications/NotificationStack.tsx`): session toasts are now retained in per-session notification history but presented as transient in-session cards. `NotificationStack` mounts inside `.transcript-region` (the positioned wrapper around `TranscriptView`), not in the whole `.app__session`, so cards overlay transcript content without reserving horizontal space and cannot cover the composer/dock/status area. A new notification shows a top-right stacked-card preview for ~6.5s (paused while hovered), then fades out unless the user clicks it; clicking the preview or the title-bar `NotificationBellButton` (rendered only while notifications exist) sets `notificationPanelOpen` and expands the full scrollable list with top/bottom fade overlays so text can be selected/copied. Notification type is indicated only by a tiny muted semantic marker (no headers or colored borders). The expanded history claims ESC and closes on bare Escape so it cannot accidentally abort a streaming agent. Dismiss removes one toast (`dismissToast`); Clear all uses `clearToasts` and closes the panel. Cleared notifications do not reappear, but future notifications create a fresh transient preview.
- **Map immutability**: Zustand stores create new `Map` instances on every update (never mutate in-place) since Zustand uses reference equality for selectors.
- **CSS**: Custom CSS with BEM naming (`composer__input-row--bash`). No CSS framework. CSS modules co-located with components. `global.css` defines an app-wide focus policy: pointer-driven focus has no outline (`:focus:not(:focus-visible)`), keyboard focus shows a lavender `:focus-visible` ring. **Exception**: the slot that the Composer occupies (`.ext-dialog-slot`, `.custom-panel`, `.picker-slot`) suppresses `:focus-visible` on internal elements — the Composer's mauve input ring is the *only* focus affordance in that slot, and components that replace the Composer (extension dialogs, custom panels, built-in pickers) inherit no focus rings. The dialog's option list uses a JavaScript-managed `.ext-dialog__option--highlighted` state for arrow-key navigation, and text fields use the caret — both are intent-revealing, not focus-revealing.
- **Truncation = FadeText, not ellipsis** (`components/common/FadeText.tsx`): every single-line label that can outgrow its box (sidebar workspace/session names, session-header title + model label, status-bar model, tool-card subjects, composer suggestion descriptions + placeholder, dock/update-banner names, widget lines, diff-tree dir/file labels, diff file-header dirnames, picker item names, trust cwd, tree-viewer rows, branch-dropdown labels/trigger) renders inside `<FadeText>` instead of `text-overflow: ellipsis`. Overflow is JS-measured (ResizeObserver on both the clipping outer span and the content inner span; jsdom-guarded for unit tests); when overflowing, the trailing edge fades via a mask and hovering the text — or an ancestor marked `.fade-scope` (rows/buttons pass their whole hover area) — glides the text sideways to reveal the tail (duration proportional to hidden width), gliding back on leave. `head` prop flips the direction for values whose TAIL matters (directory paths): tail visible at rest, leading edge fades, hover reveals the head — this replaced the old `direction: rtl` left-ellipsis hack (and its slash-reordering workaround) in the diff viewer. **One FadeText per truncatable value**: the diff file header wraps the ENTIRE path (dim dirname span + bright basename span as children of a single head-mode FadeText) — splitting one string across two adjacent FadeTexts produces a double fade with two tiny disconnected glides (and, for paths, a stray leading `/` once the dirname collapses). `pre` preserves whitespace (dock widget lines). Site CSS keeps layout/color (`flex`/`min-width: 0`/color) and must NOT re-add `overflow/white-space/text-overflow`; FadeText owns clipping. Respects `prefers-reduced-motion` (no glide).
- **Scrollbars**: one app-wide treatment in `theme.css` — a slim rounded pill floating in a transparent gutter (fixed px width; transparent 3px border + `background-clip: padding-box` inset the thumb), `surface-2` → `surface-3` on hover. Components must NOT restyle scrollbars (`scrollbar-width`/`scrollbar-color` also override the webkit styling in Chromium 121+, so don't use them either); the sanctioned exceptions hide the bar entirely because an edge-fade mask is the scroll affordance (`.transcript-view`, `.sidebar__workspaces`, `.notification-stack__list`).
- **Icons = shared SVG set, never text glyphs** (`components/common/icons.tsx` + `.icon`/`.icon-btn` in `theme.css`): every chrome glyph (`▾ ✓ × ▼ ▲ ⑂` and the old border-drawn chevrons) is a stroke SVG from the shared set — `IconChevronDown/Up/Right`, `IconCheck`, `IconClose`, `IconBell`, `IconBranch` — 12×12 viewBox, 1.5px rounded strokes, `currentColor`, 1em default sizing (`.icon` also handles baseline alignment for inline use). Interactive icons sit in the global `.icon-btn` ghost chrome (1.714rem square hit target, no resting fill, `surface-2` lift on hover, built-in `:disabled`); components add their BEM class only for placement/size overrides (e.g. the Dock's compact 1.286rem dismiss). Viewer-specific glyphs (search, refresh, case, label) stay local to their host but follow the same geometry. Dropdown-trigger carets are 0.714em at 0.8 opacity (`.session-header__caret`, `.branch-dropdown__caret`).
- **Popup card language** (dropdowns/pickers/suggestions): every floating list — model + thinking dropdowns, BranchDropdown, slash suggestions, `/model`-style pickers, the ContextMeter card — is a raised `--surface` card (`--radius-lg`, hairline border, `--elevation-2`) whose **inner list scrolls with padding** (`0.143rem var(--space-2) var(--space-2)`, flex column, 0.143rem gap) and whose rows are **rounded inset rows** (`--radius-md`, transparent 1px border; highlighted = `--surface-2` fill + `--surface-3` border) — never full-bleed strips butting into the card's rounded corners. Search inputs are fixed (non-scrolling) headers; pinned footers (BranchDropdown's remote checkbox) are full-bleed bars under a hairline `border-top`. Slash-suggestion source badges are a colored dot + ghost text (dot hue = source: accent/built-in, success/extension, info/prompt, warning-soft/skill), not outlined pills.
- **Stats live in the ContextMeter** (`session-header/ContextMeter.tsx`): the title-bar context ring opens a dropdown card with the context headline + linear meter (accent → `warning-soft` ≥80% → `danger` ≥90%), the token breakdown (input/output/cache read/hit rate), and cost under a hairline. The StatusBar under the composer is deliberately minimal — one `path · model` line (both FadeTexts, no wrapping) plus extension ANSI segments; it must NOT re-grow the old raw sigil line (`↑3.2K ↓290 R2.2K …`) that duplicated the ContextMeter. Composer discovery hints (`/ commands`, `! bash`; `⏎ steer`, `esc abort` while streaming) are kbd chips inside the placeholder overlay (`.composer__hints`), hidden once the user types and below 37.5rem — the placeholder itself is just "Message pi…".
- **Design tokens** (`theme/theme.css` `:root`): a flat, modern token system that every component composes from — `--space-1…10` (rem spacing scale), `--radius-sm/md/lg/xl/pill` (soft, consistent corners), `--leading-*`/`--tracking-*` (type), and crucially the separation tokens: `--border` / `--border-faint` (both `--surface`) and `--border-strong` (`--surface-2`) for hairline edges, `--surface-raised` (`--surface`) / `--surface-inset` (`--bg-sunken`) for in-flow depth, and `--elevation-1/2/3` shadows for floating layers (menus → `-2`, modals → `-3`). Built-in pickers (`/model`, `/fork`, `/resume`) are **not** modals — they replace the Composer in the flex slot (`.picker-slot`, an in-flow raised `--surface` card at `--elevation-1`), matching extension dialogs and custom panels. The look leans on hairlines + surface elevation + spacing instead of high-contrast outlines and box-in-box nesting — e.g. tool cards are a raised `--surface` card over a recessed `--bg-sunken` well, no inner border. There is **no MCM/mid-century vocabulary** anymore (the previous design language was removed).

### Theming (semantic, palette-agnostic)

Themes are **single config files**, not code edits. A theme is a `Theme` (`shared/theme/tokens.ts`): `{ id, name, appearance, colors, syntax }`, where `colors` fills the **26 semantic roles** in `COLOR_TOKENS` (backgrounds `--bg`/`--bg-sunken`/`--bg-deep`, surfaces `--surface`/`--surface-2`/`--surface-3`, a text-emphasis ramp `--text`/`--text-secondary`/`--text-muted`/`--text-disabled`/`--text-faint`/`--text-ghost`, and accents/status `--accent`/`--accent-soft`/`--success`/`--warning`/`--warning-soft`/`--danger`/`--info`/`--info-soft`/`--cyan`/`--magenta`/`--cursor`/`--shadow`/`--scrim`/`--input-bg`). **No component references a palette-specific swatch name** (the old `--ctp-mauve`, `--ctp-surface0`, …) — every component uses a `--<token>` semantic role or a composite `--color-*` token built on them, so a new colorscheme is purely data.

- **Bundled** themes: one pure-data JSON file per colorscheme under `shared/theme/themes/` (`catppuccin-{mocha,macchiato,frappe,latte}.json` + `gruvbox-material-dark.json`), each the full `Theme` shape. `bundled.ts` imports them and parses each through `ThemeSchema` so a malformed bundled theme fails loudly at startup. They share the exact on-disk format as user themes, so a brand-new colorscheme is literally one dropped JSON file.
- **User-droppable** themes: `<userData>/themes/*.json` validated against `ThemeSchema` by `main/theme-loader.ts` (invalid/duplicate files skipped, never fatal); exposed via the `themes.listUser` IPC; the renderer merges them over the bundled set (`theme/registry.ts`, user id wins on collision). The settings picker (`SettingsView`) lists `listThemes()`; `settings.colorScheme` stores the chosen `id` (a free string — `resolveTheme` falls back to the default if a saved id no longer resolves).
- **Application**: `settings-store.applyColorScheme` writes each `theme.colors[role]` as `--<role>` on `:root` and calls `setShikiTheme(theme)`.
- **Syntax highlighting** (`syntax`): either `{ ref: "<shiki-theme-name>" }` (reuse a Shiki-bundled TextMate theme, e.g. `catppuccin-mocha`, `nord`) or `{ inline: <TextMate theme object> }` (ship one — the Gruvbox theme uses this because no Gruvbox theme is bundled with Shiki). `shiki.ts` constructs the highlighter from the concrete object themes (the patched Catppuccin grammars) and then `loadTheme`s each string-ref theme individually with try/catch, so a single unresolvable ref (bundled or user) can never abort highlighting app-wide; it just makes that one theme fall back to the default at render. `setShikiTheme` lazy-loads user refs/inlines the same way. **UI accent tokens can't drive syntax** — this is why `syntax` is its own field, not derived from `colors`.
- **Catppuccin fidelity** (design constraint for the *Catppuccin* themes specifically): their token values stay faithful to the canonical swatches (the only sanctioned deviation is Latte's slightly-lightened surfaces, visible in `themes/catppuccin-latte.json`); depth comes from the surface ramp + hairlines + elevation, accents from translucent real swatches — never invented hues.
- **Catppuccin theming**: Four variants (latte/frappé/macchiato/mocha). Default is mocha. Theme variables set via CSS custom properties.
- **Browser preview**: `npm run dev:renderer` loads `preview-stub.ts` which stubs `window.pivis` with a demo session and canned responses including streamed agent output.
- **Auth**: API keys stored in `~/.pi/agent/auth.json` using `proper-lockfile` for mutual exclusion with pi's token-refresh writes. Environment variables detected via `$SHELL -ilc env` (GUI apps don't inherit shell env). `getSubprocessEnv()` combines `process.env` + login-shell env for consistent subprocess PATH — used across git, updates, pty, and locate-pi. Atomic writes with tmp+rename, chmod 0600.
- **Login**: Native API-key sign-in (writes auth.json) + embedded xterm.js terminal for OAuth (spawns real `pi` in `node-pty`, watches `auth.json` for success detection).
- **Updates**: Background check at launch (3s delay, non-blocking, respects `updateCheckEnabled` setting). `update.run` spawns `pi update … --no-approve` via `spawn()` with 10-minute safety timeout, streams output via IPC events. The target maps to an explicit flag — `"all"` → `--all` (pi **and** extensions), `"pi"` → `--self`, `{extension}` → `--extension <src>`. This matters: bare `pi update` defaults to pi-only and **silently skips extensions** ("Run pi update --extensions to update extensions."), so the "Update now" button must pass `--all`. New sessions automatically use the updated binary.
- **Dependencies**: `@homebridge/node-pty-prebuilt-multiarch` (native, externalized from main bundle, asarUnpack in electron-builder), `@xterm/xterm` + `@xterm/addon-fit` (renderer), `proper-lockfile` + `@types/proper-lockfile` (main).

## Testing

- **Vitest** for unit tests. The glob is `["src/**/*.test.ts", "src/**/*.test.tsx", "resources/**/*.test.mjs"]` — the second pattern is load-bearing: the SDK-host subprocess lives in `resources/pi-session-host/` as plain ESM and was previously excluded entirely. Host-subprocess units are colocated as `*.test.mjs` (matched there, never colliding with the Playwright `*.spec.mts` e2e). The `*.test.tsx` pattern covers React-rendering unit tests (e.g. the ESC hook/autocomplete tests) that need jsdom; those files opt in with a `// @vitest-environment jsdom` comment. Everything else is colocated `*.test.ts`.
- **Host-subprocess unit coverage** (`resources/pi-session-host/*.test.mjs`): the **trust resolver** (`trust.test.mjs` — the security-critical deny-by-default gate, fully faked pi SDK), the **command bridge** (`bridge.test.mjs` — pi-vis-command → SDK-method mapping + `assertHostCapabilities`), the **version gate** (`version.test.mjs` — `compareVersions`, incl. pre-release ordering), and the **uiContext dialog contract** (`ui-context.test.mjs` — select/confirm/input/editor must UNWRAP the wire response to pi's value contract: `string`/`boolean`/`undefined`, not the raw `{type,id,value}` object). These functions are exported precisely so they're testable without importing `host.mjs`'s fork entry-point (which needs a real pi).
- **Unified-TUI host-render gate** (`unified-tui.test.mjs`): the regression gate for the "factory `setWidget` opens a panel that never paints" class of bug. It drives the REAL `createUIContext` → REAL pi-tui `Editor` render with the REAL pi theme (located via `PIVIS_TEST_PI_BIN`/`command -v pi`; **skips** when pi is absent, like the `PI_E2E` gate) and asserts the editor actually renders frames (`panel_data` is produced and contains the widget content). It also pins the contract directly: `buildEditorTheme(pi, theme).borderColor` is a function while the raw `theme.borderColor` is not. **This is the layer the faked-output unified-panel tests (`tests/render/unified-panel.spec.mts`, `tests/e2e/unified-panel.spec.mts`) cannot reach** — both fake the host's ANSI, so they validate the renderer pipeline but never run `ensureUnifiedTui()`'s real pi-tui construction (where the EditorTheme bug lived).
- **uiContext dialog contract (gotcha)**: `ctx.ui.select/input/editor` return the unwrapped **value** (`string`, `undefined` on cancel); `ctx.ui.confirm` returns a **boolean**. The host's `createDialog` resolves with the raw `ExtensionUiResponse` wire object, so `ui-context.mjs` MUST unwrap per-method. Returning the object breaks any extension that compares the result (`choice === "Settings"`, `choice.startsWith(...)`), e.g. `pi-subagents` `/agents → Settings`. The trust prompt (`host.mjs` `promptTrustChoice`) reads the raw response directly and is independent of this unwrapping.
- **Playwright** for E2E tests in `tests/e2e/` — tests app startup, commands, diff viewer, real pi integration. The inline-panel E2E (`panels.spec.mts`) is gated behind `PI_E2E=1` (needs a real pi + extension); it is the load-bearing gate for the un-`tsc`-checkable host↔pi behavioral contract and is **not yet in CI**. The "+ New session" sidebar button's accessible name is **"New session"** (the `+` is an aria-hidden SVG) — `getByRole("button", { name: "New session" })`, NOT `"+ New session"`.
- **Self-contained unified-panel E2E** (`tests/e2e/unified-panel.spec.mts`, no `PI_E2E` gate): launches the REAL app but substitutes `host.mjs` with `tests/fixtures/fake-unified-host.mjs` via the `PIVIS_TEST_HOST_SCRIPT` env seam (read in `session-host.ts`'s constructor). The fake speaks the SessionHost wire protocol and drives the factory-`setWidget` flow (`panel_open{unified:true}` + streaming `panel_data`), so the test exercises SessionHost wire → registry forwarding → IPC → store reducer → `UnifiedTuiHost` → xterm render, plus keystroke routing back over `panel_input` (asserted via the `PIVIS_TEST_HOST_INPUT_FILE` side channel). It is the regression gate for "the Composer was replaced by nothing." **Caveat:** the fake emits canned ANSI, so it does NOT cover the host's real pi-tui render — that's `unified-tui.test.mjs`'s job.
- **Renderer render tests** (`tests/render/`, `npm run test:render`): headless chromium against `npm run dev:renderer` (real React app, stubbed `window.pivis` from `preview-stub.ts`). `unified-panel.spec.mts` drives `?unified=1` (the stub emits the panel events a factory `setWidget` produces) to render-test the `UnifiedTuiHost` → xterm pipeline without Electron or pi. `esc-interrupt.spec.mts` pins the ESC two-press timing + unified-panel interception, and `esc-surface-coverage.spec.mts` is the regression matrix asserting each ESC-owning surface claims ESC (so a background streaming session isn't aborted). Both drive streaming/abort via `window.__pivisPreview` hooks (`startStreaming`/`stopStreaming`/`abortCalls`/`panelInputLog`) added to `preview-stub.ts` — these are test-only and NOT part of the real IPC contract.
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
