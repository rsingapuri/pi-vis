# Pi-Vis

A desktop app for the [pi.dev](https://pi.dev) coding agent. Run several agents
at once, review their changes in a full-featured diff viewer, and let each one
work on its own git worktree — all with full parity to the pi CLI and its
extensions.

## Features

- **Run many agents in parallel.** Each session is an independent pi agent. Kick
  off work across multiple projects from one workspace sidebar and switch between
  them while they run — no juggling terminal tabs.
- **Built-in diff viewer.** See exactly what an agent changed in a
  syntax-highlighted unified or split diff, with branch-relative comparisons. A
  live changed-files badge updates as the agent edits.
- **Worktree per session.** Spin up an isolated git worktree on a fresh branch
  before sending your first prompt, so parallel agents never step on each other or
  your working tree. No manual `git worktree` setup.
- **Full extension compatibility.** Every session runs the bundled, unmodified
  Pi runtime, so
  your extensions, skills, prompts, slash commands, and compaction behave exactly
  as they do in the terminal — including their dialogs, toasts, status bar, and
  widgets.
- **Themes.** Twelve built-in colorschemes — Catppuccin (Latte, Frappé,
  Macchiato, Mocha), Everforest and Gruvbox Material in dark + light, the
  OLED-black Glow Sticks, and Cendre in Hard, Medium, and Soft depths — plus
  user-droppable theme JSON files.

## Download

Download the latest release from the [Pi-Vis landing page](https://rsingapuri.github.io/pi-vis/) or from [GitHub Releases](https://github.com/rsingapuri/pi-vis/releases/latest).

## Install (macOS, Apple Silicon)

```
curl -fsSL https://raw.githubusercontent.com/rsingapuri/pi-vis/main/scripts/install.sh | bash
```

This downloads the latest notarized release and installs `Pi-Vis.app` to `/Applications`.

Builds are **Apple Silicon (arm64) only** — Intel Macs need a [source build](#building).

## Requirements

- The packaged app has no Node.js or global Pi CLI prerequisite; it ships and
  exclusively uses its pinned Pi runtime.
- Building from source requires Node.js 22.19 or newer.

## Setup

```
npm install
```

## Development

```
npm run dev
```

Opens the Electron app with HMR. The renderer is also accessible at http://localhost:5173 (with a stub pivis API).

## Testing

```
npm test           # unit tests (vitest)
npm run test:e2e   # e2e smoke tests (playwright)
```

## Building

```
npm run build      # typecheck + electron-vite build
npm run dist       # build + electron-builder (mac dmg/zip)
```

## Architecture

- Each live session runs in an SDK-direct host (`resources/pi-session-host/`) and has one `AgentSession` authority; there is no secondary RPC session transport.
- The host publishes direct snapshots with identity, epoch, sequence, availability leases, queues, catalog, and editor revisions. Renderer state is a validated projection, not synthetic liveness.
- Text/image submission has explicit dispositions and FIFO custody across compaction/navigation; ESC queue restoration, renderer generations, and UI/panel acknowledgements make handoffs recoverable.
- The registry refuses activation at its process cap and uses a two-phase close checkpoint rather than evicting idle sessions.
- Extension UI and pi-tui panels are bridged from the host and rendered natively.
- Session files in `~/.pi/agent/sessions/` provide persisted history; headers group sessions by `cwd`.

## Key files

| Path | Purpose |
|------|---------|
| `resources/pi-session-host/state-authority.mjs` | Direct AgentSession snapshots, admission, custody, escape, and transitions |
| `src/main/sessions/session-registry.ts` | Host lifecycle, leases, capacity, acknowledgements, and close checkpoints |
| `src/shared/pi-protocol/runtime-state.ts` | Runtime state schemas |
| `src/shared/ipc-contract.ts` | Typed renderer ↔ main IPC surface |
| `src/renderer/src/stores/sessions-store.ts` | Renderer runtime projection and session UI state |
| `tests/fixtures/fake-pi.mjs` | Version/update test executable |

## Acknowledgements

Built-in color themes include palette and syntax values from MIT-licensed
projects, including [Cendre](https://cendretheme.com/),
[Catppuccin](https://github.com/catppuccin/catppuccin), and
[Gruvbox Material](https://github.com/sainnhe/gruvbox-material). See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution and the
required license notices.

## Verification checklist

1. `npm run typecheck && npm test` — all green
2. `npm run dev` — app opens, add a workspace, create session, type a prompt
3. Extension parity: install `pi-headroom` extension, start session, trigger large tool output — headroom status/toasts appear in the GUI
4. Resume: create a session in the GUI, quit, reopen — history loads correctly
5. `/login` for API-key provider works via dialog roundtrip
6. `npm run dist` produces a launchable `.dmg`
