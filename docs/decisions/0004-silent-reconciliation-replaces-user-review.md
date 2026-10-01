# 0004: Submitted composer clears are irreversible

## Status

Accepted

## Context

Interrupted queue custody and uncertain delivery can leave Pi-Vis unable to
prove whether submitted work reached Pi. Earlier implementations treated the
submitted payload as recoverable draft custody. They could reinsert it after a
guard failure, renderer reattachment, host restart, queue interruption, or
delayed reconciliation—even after the user had watched it disappear and begun
typing a new prompt. That made an old submission indistinguishable from current
input and could also mask or overwrite newer text and attachments.

## Decision

The visible clear is an irreversible presentation commit. Once a submitted
revision leaves either Composer or the Unified TUI editor, the payload consumed
by that submission can never be projected into an editor again. An ordinary
prompt consumes its text, staged attachments, and submitted comment revisions.
A slash command or Shell Turn consumes only its command text; independently
staged attachments and conflict candidates remain editor custody. Execution
custody and editor presentation are separate state machines.

Unified TUI commits this boundary synchronously in `Editor.onSubmit`, because
Pi clears the public editor before invoking that callback. The host immediately
advances the current editor revision and exposes the empty/newer draft as
authority. It retains an immutable pending source—stable intent, source
revision, raw classification, and frozen attachments—only long enough to
validate at-most-once dispatch. Admission validates that source before any Pi
side effect. An acknowledgement or failure retires it but never changes the
current editor.

Every queue-restoration record for work that crossed this boundary includes
`clearedIntentIds`. Main resolves such a record to `dropped` regardless of
`not_processed`, persistence evidence, or reconciliation failure, and uses that
result to fence host editor recovery. Command-only records are also dropped.
A `restore` disposition is reserved for a pre-clear recovery checkpoint; it can
permit main to recover already-visible host editor state, but the renderer does
not synthesize or merge submitted record text into Composer. It only retires an
exact pending correlation and acknowledges the record. Thus a pre-clear refusal
keeps the draft it already owns, while post-clear and newer editor state remain
untouched.

There is no renderer review channel, restoration card, restore/dismiss control,
or user-selected acknowledgement. `session.restoreDraft` remains a one-way,
idempotent settlement/acknowledgement protocol name for compatibility.

A tab close is likewise unconditional: `session.close` fences ingress, makes best-effort child shutdown, releases the in-memory runtime, and leaves persisted session files/worktrees on disk. It does not run a renderer close-review handshake.

This does not change the mutation safety rule: `outcome_unknown` work and lost
acknowledgements are never replayed against a replacement host. The outcome can
remain unknown even though its submitted editor presentation is permanently
retired.

## Consequences

An interrupted post-clear submission may therefore be absent from both the
transcript and the editor. This is intentional: automatically reconstructing it
would contradict the visible commit and risks a duplicate submission. Outcome
markers and toasts describe uncertainty without retaining replay affordances.

Queue-restoration records may remain as bounded authority/custody evidence for
transcript ownership and crash fencing. They are never composer content. The
renderer applies record IDs idempotently, acknowledges redelivery, and leaves
all current text, attachments, injections, and comment revisions unchanged.

## References

- [Processes and IPC](../architecture/processes-and-ipc.md)
- [State and sessions](../architecture/state-and-sessions.md)
- [ADR 0003: Authority frames and per-plane synchronization](0003-authority-frames-and-plane-synchronization.md)
- `src/main/sessions/session-registry.ts`
- `src/renderer/src/stores/sessions-store.ts`
- `src/shared/ipc-contract.ts`
