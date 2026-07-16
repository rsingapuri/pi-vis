# 0005: Retain presentation labels across authority fences

## Status

Accepted — amends [ADR 0003](0003-authority-frames-and-plane-synchronization.md)

## Context

A semantic-plane fence makes control state unavailable while a baseline is recovered. Clearing compatibility presentation fields during that interval made stable sidebar labels and header metadata briefly fall back to defaults, even though the values were only temporarily stale.

## Decision

When the semantic plane is not `following`, retain the last known `sessionName`, `sessionTitle`, `currentModel`, `currentProvider`, and `thinkingLevel` as stale presentation. Clear dispatch identity and other control state, including host identity, running state, queued messages, and editor injection. Only a following successor baseline replaces retained presentation.

Interactive controls continue to use the authoritative semantic snapshot and remain fenced until that plane follows.

## Consequences

Labels and metadata can be stale during recovery, but do not flash to defaults. Retained presentation is diagnostic only and cannot authorize interaction or establish runtime state.

## References

- [ADR 0003: Authority frames and per-plane synchronization](0003-authority-frames-and-plane-synchronization.md)
- [State and sessions](../architecture/state-and-sessions.md)
- [Processes and IPC](../architecture/processes-and-ipc.md)
