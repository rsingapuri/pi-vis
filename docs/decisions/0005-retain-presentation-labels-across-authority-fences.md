# 0005: Retain presentation labels across authority fences

## Status

Accepted — amends [ADR 0003](0003-authority-frames-and-plane-synchronization.md)

## Context

A semantic-plane fence makes control state unavailable while a baseline is recovered. Clearing compatibility presentation fields during that interval made stable sidebar labels and header metadata briefly fall back to defaults, even though the values were only temporarily stale.

## Decision

When the semantic plane is not `following`, retain the last known `sessionName`, `sessionTitle`, `currentModel`, `currentProvider`, and `thinkingLevel` as stale presentation. Clear dispatch identity and other authoritative control state, including host identity, running state, queued messages, and editor injection. Only a following successor baseline replaces retained presentation.

Routed physical-model metadata follows complete-snapshot replacement semantics. When a semantic snapshot exists, its missing `routedModel` explicitly clears the previous route; a compatibility runtime snapshot may supply the stale presentation route only while the semantic snapshot itself is absent. A newly selected physical model therefore cannot inherit the prior virtual model's routed destination from compatibility state.

A direct Shell Turn has one narrower presentation exception. During a
recoverable same-owner semantic `synchronizing` fence, the Composer slot may
keep the prior xterm mounted and frozen only when stale diagnostic Bash
activity and the independently retained streaming PTY block identify the exact
same execution. This is not retained semantic running state: input, resize,
Escape, and signals remain fenced, and an unavailable plane, owner/execution
mismatch, or settled PTY block removes the surface. A fresh reconstruction
revision and acknowledgement are required before control resumes.

Interactive controls continue to use the authoritative semantic snapshot and remain fenced until that plane follows.

## Consequences

Labels, metadata, and the exact matching frozen PTY surface can remain visually
stable during recovery instead of flashing to defaults or Composer. Retained
presentation is diagnostic only and cannot authorize interaction or establish
runtime state.

## References

- [ADR 0003: Authority frames and per-plane synchronization](0003-authority-frames-and-plane-synchronization.md)
- [State and sessions](../architecture/state-and-sessions.md)
- [Processes and IPC](../architecture/processes-and-ipc.md)
