# 0004: Silent reconciliation replaces user review

## Status

Accepted

## Context

Interrupted queue custody and uncertain delivery can leave Pi-Vis with recoverable draft text/attachments but no safe basis to replay work automatically. The former review-card flow made that transport and reconciliation detail a persistent user decision, even when persisted session evidence could determine whether the text was processed.

## Decision

Main reconciles each queue-restoration record against persisted session history and emits the one-way `session.restoreDraft` instruction. `not_processed` custody restores directly. For uncertain custody, only an exact appended persisted user-message match proves the input was processed and yields `dropped`; missing, malformed, unreadable, or inconclusive evidence restores the draft. A command-only restoration is `dropped`. The renderer applies a restoration once by ID, merges restoreable text and attachments into its current draft, and immediately calls `session.acknowledgeRestoration`. There is no renderer review channel, review card, restore/dismiss control, or acknowledgement chosen by the user.

A tab close is likewise unconditional: `session.close` fences ingress, makes best-effort child shutdown, releases the in-memory runtime, and leaves persisted session files/worktrees on disk. It does not run a renderer close-review handshake.

This does not change the safety rule for mutations: a post-dispatch `outcome_unknown`, a lost acknowledgement, or a restoration that reconciliation cannot establish as unprocessed is never automatically replayed against a replacement host. Reconciliation may restore a draft for the user to inspect and submit; it never dispatches that draft.

## Consequences

Reconciliation intentionally has a false-negative recognition bias: extension transformation, a non-identical persisted representation, or unavailable evidence can fail to identify input that Pi already processed, so Pi-Vis restores a draft that may be redundant. That tradeoff preserves recoverability instead of falsely declaring the input processed. It is safe only because restoration never dispatches work: the user must make a new submission decision, and Pi-Vis never automatically replays ambiguous model/tool effects.

`session.restoreDraft` plus acknowledgement is the restoration lifecycle. Queue-restoration records may remain as authority/custody evidence for transcript ownership and main-side reconciliation, but they do not create user-facing review UI.

## References

- [Processes and IPC](../architecture/processes-and-ipc.md)
- [State and sessions](../architecture/state-and-sessions.md)
- [ADR 0003: Authority frames and per-plane synchronization](0003-authority-frames-and-plane-synchronization.md)
- `src/main/sessions/session-registry.ts`
- `src/renderer/src/stores/sessions-store.ts`
- `src/shared/ipc-contract.ts`
