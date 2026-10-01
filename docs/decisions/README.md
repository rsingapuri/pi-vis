# Architecture decision records

Use this directory for durable architectural decisions that should outlive a single implementation change.

## Format

Create files named `NNNN-short-title.md`:

```md
# NNNN: Short title

## Status

Accepted | Proposed | Superseded

## Context

What problem or constraint forced this decision?

## Decision

What are we choosing?

## Consequences

What trade-offs, follow-up work, or invariants does this create?

## References

- Related files/docs/tests
```

Link new ADRs from the relevant `docs/architecture/*.md` file and from `docs/agent-index.md` when agents should read them for future work.

## Current records

- [0001: Worker-backed diff search](0001-worker-backed-diff-search.md)
- [0002: Workspace session search](0002-workspace-session-search.md) — persisted-JSONL authority, disposable index, exact read-only context, and lifecycle isolation.
- [0003: Authority frames and per-plane synchronization](0003-authority-frames-and-plane-synchronization.md) — deployed session-runtime, IPC, command, and authority-reducer architecture; amended by 0004 and 0005.
- [0004: Submitted composer clears are irreversible](0004-silent-reconciliation-replaces-user-review.md) — submitted input never reappears after a visible clear; settlement stays one-way and tab disposal remains silent.
- [0005: Retain presentation labels across authority fences](0005-retain-presentation-labels-across-authority-fences.md) — stale presentation remains visible while semantic controls are fenced.
- [0006: Pinned llama.cpp private-extension exception](0006-pinned-llama-private-extension-exception.md) — one exact-version private registry lookup restores Pi's built-in llama.cpp manager while all runtime injection remains public.
