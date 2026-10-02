# Agent documentation index

Load only the documentation relevant to the change.

- Broad runtime or repository work: `docs/architecture/overview.md`.
- SDK host, main/preload IPC, runtime-state schemas, process lifecycle, panels, transitions, the deployed authority-frame protocol, or per-plane synchronization: `docs/architecture/processes-and-ipc.md`, `docs/architecture/state-and-sessions.md`, `docs/decisions/0003-authority-frames-and-plane-synchronization.md`, and `docs/decisions/0005-retain-presentation-labels-across-authority-fences.md`.
- Submission admission, queue custody/restoration, editor revisions, ESC, renderer/UI acknowledgements, or close/cap behavior: also read those two architecture docs, `docs/decisions/0004-silent-reconciliation-replaces-user-review.md`, and `docs/ui-conventions.md`.
- Composer/slash execution or command admission/settlement: `docs/architecture/commands.md` and `docs/architecture/command-matrix.md`; for authority-frame migration also read `docs/decisions/0003-authority-frames-and-plane-synchronization.md`.
- Direct `!`/`!!` shell drafts, Shell Turns, PTY lifecycle, terminal normalization, shell input/resize/cancellation, or shell transcript rendering: `docs/product/elastic-shell-turns.md`; also read `docs/architecture/commands.md`, `docs/architecture/processes-and-ipc.md`, `docs/architecture/state-and-sessions.md`, `docs/architecture/runtime-services.md`, `docs/ui-conventions.md`, `docs/testing.md`, and `docs/compatibility/pi-1.0.0.md`.
- Tree APIs/navigation: `docs/architecture/conversation-tree.md`.
- Pi release compatibility, the pinned runtime, or private-Pi import policy:
  `docs/compatibility/pi-1.0.0.md`, `docs/architecture/runtime-services.md`,
  and `docs/decisions/0006-pinned-llama-private-extension-exception.md`.
- Crash diagnostics, rotating diagnostic logs, renderer/main/SDK-host error capture,
  or Crashpad: `docs/architecture/processes-and-ipc.md`,
  `docs/important-paths.md`, and `docs/testing.md`.
- Tests, fault injection, fixtures, or verification: `docs/testing.md`.
- Paths and persisted locations: `docs/important-paths.md`.
- Workspace saved-session search, its worker/index, result context, or search UI: `docs/architecture/session-search.md`, `docs/decisions/0002-workspace-session-search.md`, `docs/architecture/sidebar-shell-layout.md`, and `docs/ui-conventions.md`; also read `docs/testing.md` for corpus and gates.
- Release automation, final-app packaging gates, signing, notarization, or
  publication: `docs/releasing.md`, `RELEASING.md`, `docs/testing.md`, and the
  current compatibility audit when the Pi pin changes.
- Worktrees, sidebar, theming, runtime services, or visual conventions: use
  their corresponding architecture doc plus `docs/ui-conventions.md` where
  applicable.

The session runtime is SDK-host-only. Do not document or add a session fallback transport, synthetic liveness adapter, idle-LRU reaper, or prompt counter. Session search is persisted-JSONL-only: preview never activates a host; explicit opening uses the normal activation-visit lifecycle.
