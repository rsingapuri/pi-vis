# 0002: Authority frames and per-plane synchronization

## Status

Proposed

## Context

A renderer cannot know about a child-process Pi mutation at the instant it occurs. Existing identities, snapshot sequences, leases, resyncs, and transition batches detect some discontinuities, but must not be described as instantaneous equality or allow a partial recovery to appear authoritative. High-volume transcript and panel traffic also cannot honestly share one semantic cursor without explicit reconstruction.

## Decision

Migrate the session protocol to child-owned authority frames.

- The SDK-host `SessionController` is the sole interpreter of Pi semantic state and serializes semantic mutations.
- The guarantee is **exact as of cursor**: a `following` projection has all complete frames through `(hostInstanceId, sessionEpoch, transportSequence, snapshotSequence)`, not knowledge of a mutation still in transit.
- A semantic frame contains ordered records and one complete terminal semantic snapshot. Main routes the frame opaquely and the renderer reduces it atomically.
- Synchronization is independent for semantic control, transcript, extension UI, and each panel. Each is `following`, `synchronizing`, or `unavailable`; stale retained values are diagnostic, not authoritative.
- Attach and recovery install a serialized baseline at a publication high-water mark and replay a contiguous buffered tail. A gap or overflow requires another baseline.
- Every mutation receives a stable, owner-bound intent ID recorded before possible Pi dispatch. Receipts describe admission/delivery only; typed outcomes arrive in frames. Ambiguous post-dispatch results are `outcome_unknown` and never replay automatically across replacement.
- The child retains a bounded operation journal with explicit low/high watermarks and truncation. It records operation observation, outcomes, and anomalies without implying coverage before its low watermark.
- Panel reconstruction requires a framebuffer keyframe or acknowledged reset/full repaint; panel input is fenced until reconstruction. Unsupported state after host loss is unavailable.
- Replacements require a child ingress freeze, main advisory-lock permit, and one terminal successor frame. Advisory locks prevent accidental competing Pi-Vis ownership only.

## Consequences

This is a phased migration. The present snapshot/resync, disposition, editor revision, renderer generation, panel sequence, and transition-batch contracts stay as compatibility behavior until an end-to-end frame path is available. Mixed legacy and frame data must meet only at explicit baselines and must never be combined as a single cursor.

The rollout order is child serialization and journal; main buffered attach/per-plane routing; renderer shadow reducer; interrupt/compaction; submission/editor/queues; remaining mutations; presentation reconstruction; and legacy-path removal. Tests must cover dropped/reordered frames, attach racing a transition, detached operations, duplicate intents, ambiguous dispatch, getter/event disagreement, panel reconstruction, retry barriers, and lock contention.

## References

- [Processes and IPC](../architecture/processes-and-ipc.md)
- [State and sessions](../architecture/state-and-sessions.md)
- [Command system](../architecture/commands.md)
- [Testing](../testing.md)
