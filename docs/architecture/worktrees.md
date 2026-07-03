# Worktree-per-session

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
2. The WorktreeBar vanishes; the **WorktreeChip** (`⑂ swift-otter`) appears in
   the header's right-side control row, immediately before the unified view toggle
   (when present) and changes/diff button. Hover shows `branch · path` for attached
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
38px title bar. The name and right-side WorktreeChip stay up top. The `SessionControls` component
is the single source of truth rendered in either position. Mechanism: a
`ResizeObserver` on `.session-header` flips `headerCompact` when the header's
*available* width drops below 560px. Two things make this correct: (1) `.session-header`
has `min-width: 0` so as a `flex: 1` child it clamps to the title bar's available width
instead of ballooning to its content's intrinsic width — without it the un-shrinkable
controls push the header past the viewport and the breakpoint never fires; (2) the model
picker button is width-capped + ellipsized so one long model id can't blow out the
cluster. The 560 threshold sits just above the cluster's realistic max (~540px) so
controls reflow before they'd clip. See [Responsive layout system](#responsive-layout-system).
