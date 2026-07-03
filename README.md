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
- **Full extension compatibility.** Every session runs the real `pi` binary, so
  your extensions, skills, prompts, slash commands, and compaction behave exactly
  as they do in the terminal — including their dialogs, toasts, status bar, and
  widgets.
- **Themes.** Four built-in Catppuccin variants (Latte, Frappé, Macchiato,
  Mocha) plus Gruvbox Material.

## Install (macOS, Apple Silicon)

```
curl -fsSL https://raw.githubusercontent.com/rsingapuri/pi-vis/main/scripts/install.sh | bash
```

This downloads the latest release and installs `Pi-Vis.app` to `/Applications`.
Because the download happens over `curl` rather than a browser, macOS does not
quarantine it, so the app launches without a Gatekeeper "unidentified developer"
prompt.

> **Not yet notarized.** v0.1 is ad-hoc signed but not Apple-notarized
> (notarization is a fast-follow). If you instead download the `.dmg`/`.zip`
> from the [releases page](https://github.com/rsingapuri/pi-vis/releases) in a
> browser, macOS will quarantine it; clear that with:
> ```
> xattr -dr com.apple.quarantine /Applications/Pi-Vis.app
> ```

Builds are **Apple Silicon (arm64) only** — Intel Macs need a [source build](#building).

## Requirements

- Node.js 20+
- pi coding agent CLI installed globally:
  ```
  npm i -g --ignore-scripts @earendil-works/pi-coding-agent
  ```

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

- Every session runs `pi --mode rpc` as a subprocess — exact terminal parity, same extensions, same compaction
- RPC protocol: JSONL on stdin/stdout with correlated request IDs
- Extension UI (select/confirm/input/editor dialogs, toasts, status segments, widgets) fully serialized over RPC
- Session files in `~/.pi/agent/sessions/` are enumerated for workspace history; the file's header `cwd` field is used for grouping (not directory-name encoding)
- Settings: `~/Library/Application Support/pi-vis/settings.json` (overrideable via `PIVIS_SETTINGS_DIR` env var for tests)

## Key files

| Path | Purpose |
|------|---------|
| `src/shared/pi-protocol/` | Zod schemas for every RPC command, event, response, extension-ui type |
| `src/shared/ipc-contract.ts` | Typed IPC surface (renderer ↔ main) |
| `src/main/pi/jsonl-stream.ts` | Byte-level JSONL parser (splits only on `\n`, never Unicode separators) |
| `src/main/pi/pi-process.ts` | Single pi subprocess wrapper with correlated RPC |
| `src/main/sessions/session-registry.ts` | SessionId → PiProcess lifecycle, blocks double-open |
| `src/renderer/src/stores/transcript.ts` | Pure reducer: PiEvent → TranscriptBlock[] |
| `tests/fixtures/fake-pi.mjs` | Scripted stand-in for real pi (for e2e tests) |

## Acknowledgements

Built-in color themes include palette values derived from the MIT-licensed
[Catppuccin](https://github.com/catppuccin/catppuccin) and
[Gruvbox Material](https://github.com/sainnhe/gruvbox-material) projects. See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the required license
notices.

## Verification checklist

1. `npm run typecheck && npm test` — all green
2. `npm run dev` — app opens, add a workspace, create session, type a prompt
3. Extension parity: install `pi-headroom` extension, start session, trigger large tool output — headroom status/toasts appear in the GUI
4. Resume: create a session in the GUI, quit, reopen — history loads correctly
5. `/login` for API-key provider works via dialog roundtrip
6. `npm run dist` produces a launchable `.dmg`
