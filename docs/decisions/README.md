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
- [0003: Authority frames and per-plane synchronization](0003-authority-frames-and-plane-synchronization.md) — deployed session-runtime, IPC, command, and authority-reducer architecture; amended by 0004.
- [0004: Silent reconciliation replaces user review](0004-silent-reconciliation-replaces-user-review.md) — conservative automatic draft recovery and silent tab disposal.
