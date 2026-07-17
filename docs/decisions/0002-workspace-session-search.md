# 0002: Workspace session search

## Status

Accepted

## Context

Saved session history needs fast workspace-scoped search without making persisted history, previews, or search UI participate in the live SDK-host runtime.

## Decision

Search is a local, global worker-owned SQLite FTS index over validated persisted JSONL sources. The index lives at `<userData>/session-search/v1/`, is rebuildable/disposable, and is never content authority. JSONL remains authoritative. A source catalog maps validated, non-archived session files to a currently registered workspace or known worktree; every query, target resolution, and context read revalidates that ownership.

Search covers session names, user messages, visible assistant prose, persisted errors, displayed custom messages, compaction summaries, branch summaries, all persisted branches, and history before compaction markers. It excludes archived sessions, thinking, ordinary tool input/output, images/base64, hidden custom/extension data, tool metadata files, removed workspaces, drafts, and unpersisted streaming output.

The worker prioritizes queries over bounded indexing. Cold catalog discovery publishes prioritized bounded batches, known-source append detection uses a fast stat-only pass while search is open, and complete reconciliation runs at startup and is requested by search/focus/resume thereafter, with ambient requests coalesced to no more than once per 30 seconds. Complete appended rows are committed with their source offset atomically. Shrink/replacement/identity mismatch rebuilds a source. Corrupt, incomplete, or failed indexes are quarantined/rebuilt; worker failure permits one bounded restart. Failure never impairs ordinary session use or modifies source JSONL.

Results use opaque renderer- and workspace-scoped targets. Context revalidates the source and returns a bounded, read-only exact occurrence with deterministic saved-branch ancestry and following context. It reports `ready`, `relocated`, `changed`, `removed`, `forbidden`, or `unavailable`; it never silently substitutes different content. Non-latest persisted paths are labelled **Other saved branch**; opening follows the session's current saved path, not that historical branch.

Opening the search surface and preview never contact `SessionRegistry`, create a host, or mutate workspace/session/branch/transcript/draft/attachment/unread/editor/runtime state. Only explicit **Open session** resolves a revalidated target and delegates to the normal stored-session open and renderer activation-visit lifecycle. The source descriptor is acquired before worker validation; header session/workspace authority and exact target evidence are rechecked through that descriptor, which is retained across the cold activation IPC gap. POSIX hosts inherit a fresh same-inode descriptor; Windows hosts use an identity-checked hard-link runtime pin. Pathname replacement therefore cannot redirect the opened source. Search adds neither a fixed host cap nor idle/LRU reaping and never retires a pre-existing host.

## Invariants

1. JSONL is sole content authority; the index is disposable.
2. Every query is limited to one current workspace and its known worktrees.
3. Index/query/preview send no SDK-host commands.
4. Search open and result selection cause no host activation.
5. Explicit open uses normal activation-visit ownership and safe rapid-switch release.
6. Search adds no generalized reaping and retires no pre-existing host.
7. Each result names one persisted entry, content part, and occurrence.
8. Preview is read-only for session, workspace, branch, transcript, draft, attachments, unread state, editor revision, and runtime identity.
9. Compaction never cuts off searchable history.
10. All persisted branches remain searchable.
11. Partial, skipped, stale, and unavailable coverage is visible.
12. Reads are validated regular JSONL files beneath the canonical sessions root.
13. Renderer targets are opaque; source paths are never authoritative renderer input.
14. Query batches and context are generation-fenced.
15. Reads, rows, candidates, batches, memory, and indexing work are bounded.
16. Queries are local only: not logged, persisted, or sent in telemetry.
17. UI uses semantic tokens, shared icons, `FadeText`, existing focus policy, and ESC claims.

## Consequences

A default-on, restart-scoped `sessionSearchEnabled` setting is the operational escape hatch; when disabled at launch, main creates no search service, catalog, or worker and renderer search affordances are absent. Otherwise, the workspace-row search icon (revealed on workspace hover or keyboard focus, with no resting name-width reservation) and `Cmd/Ctrl+Shift+F` open a scoped modal. The modal preview is separate from live transcript UI; ESC closes/backs out under its claim and never interrupts the underlying host. Explicit opening is the only search action that may focus a workspace/session or activate a host.

Acceptance gates: warm-query p95 <150 ms; first initial-index result <500 ms; a completed appended entry searchable <2 s; stale UI suppression <100 ms; no search-caused main-thread task >16 ms; worker RSS <192 MiB for a 500 MiB corpus; batches <=50 results and <=128 KiB; preview creates no host.

## References

- [Session search architecture](../architecture/session-search.md)
- [Processes and IPC](../architecture/processes-and-ipc.md)
- [State and sessions](../architecture/state-and-sessions.md)
- `src/main/sessions/session-search/`
