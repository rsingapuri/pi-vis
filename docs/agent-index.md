# Agent documentation index

Use this file to load only the project context needed for the task at hand. Start with the row matching the files or behavior you will touch; do not read every doc by default.

## Always useful

- New to the repo or changing broad structure: `docs/architecture/overview.md`
- Changing test coverage, fixtures, or verification strategy: `docs/testing.md`
- Looking for key files or persistent on-disk locations: `docs/important-paths.md`
- Changing release/install/update packaging or the GitHub Pages download site: `docs/releasing.md` and `RELEASING.md`
- Changing this documentation system: `docs/maintenance.md`

## Main process, subprocesses, and protocols

Read `docs/architecture/processes-and-ipc.md` when touching:

- `src/main/index.ts`
- `src/main/ipc.ts`
- `src/preload/**`
- `src/shared/ipc-contract.ts`
- `src/shared/pi-protocol/**`
- IPC channels/events
- pi RPC command/event schemas

Read `docs/architecture/state-and-sessions.md` when touching:

- `src/main/sessions/**`
- `src/main/pi/**`
- session activation/reload/close behavior
- model or thinking-level selection semantics
- renderer session state in `src/renderer/src/stores/sessions-store.ts`

Read both `docs/architecture/processes-and-ipc.md` and `docs/architecture/state-and-sessions.md` when touching:

- `resources/pi-session-host/**` (including `keyboard-protocol.mjs` — the Kitty keyboard handshake; see the "Keyboard protocol negotiation" subsection of processes-and-ipc.md)
- SDK-host fallback behavior
- extension UI request/response flow
- custom or unified TUI panel host wiring
- terminal keyboard encoding / Shift+Enter / Kitty protocol (renderer option in `src/renderer/src/theme/xterm.ts`; also read `docs/ui-conventions.md`'s Shift+Enter pattern)

## Renderer state, commands, and transcript

Read `docs/architecture/diff-editing.md` when touching:

- inline line editing in the diff viewer (`DiffEditBubble`, `DiffEditCard`, the edit session in `diff-store.ts`)
- `src/renderer/src/lib/diff/splice.ts` / `auto-indent.ts` / `edit-range.ts` / `edit-anchor.ts`
- the `git.writeWorkingFile` IPC channel / CAS save protocol / comment re-anchor

Read `docs/ui-conventions.md` when touching:

- transcript rendering or scrolling
- notification behavior
- ESC handling or overlay ownership
- truncation, icons, popup cards, focus rings, scrollbars, or general UI patterns

Read `docs/architecture/commands.md` when touching:

- `src/renderer/src/lib/commands/**`
- slash command parsing/execution
- app pickers opened by slash commands

Read `docs/architecture/conversation-tree.md` when touching:

- `src/renderer/src/stores/tree-store.ts`
- `src/renderer/src/components/tree/**`
- `session.transcriptForEntries`
- `get_tree`, `navigate_tree`, or `set_label` commands

## Git, workspaces, and worktrees

Read `docs/architecture/worktrees.md` when touching:

- `src/main/git/**`
- `src/main/workspaces.ts` worktree helpers
- `src/renderer/src/components/composer/WorktreeBar.*`
- worktree IPC channels or validation

Read `docs/architecture/sidebar-shell-layout.md` when touching:

- `src/renderer/src/components/shell/Sidebar.*`
- workspace ordering/expand state
- pinned sessions
- `TitleBar`, `SessionHeader`, `SessionSubBar`, shell layout, or responsive layout

## Theming and visual design

Read `docs/architecture/theming.md` and `docs/ui-conventions.md` when touching:

- `src/shared/theme/**`
- `src/renderer/src/theme/**`
- theme JSON files
- Shiki or xterm theme plumbing
- component CSS that uses semantic color tokens

## Updates, auth, terminal, and release-adjacent features

Read `docs/architecture/runtime-services.md`, plus `docs/architecture/processes-and-ipc.md` for IPC changes, when touching:

- `src/main/auth.ts`
- `src/main/pty.ts`
- `src/main/updates.ts`
- `src/renderer/src/preview-stub.ts`
- `src/renderer/src/components/auth/**`
- `src/renderer/src/components/updates/**`
- native runtime dependencies
- installer/release scripts

## When adding a new architectural decision

- Add an ADR under `docs/decisions/NNNN-short-title.md`.
- Link it from the relevant architecture doc.
- Update this index if future agents need to know when to read it.
