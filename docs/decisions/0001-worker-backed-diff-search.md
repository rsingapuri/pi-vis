# 0001: Worker-backed uncapped diff search

## Status

Accepted

## Context

The diff viewer intentionally caps mounted rows and normal file sections so a pathological change cannot freeze Chromium. Search previously reused that rendered-row projection and its cap. As a result, occurrences after the cap were either omitted or required mounting every preceding row. Loading files for search also built models and could synchronously tokenize them on the renderer thread.

A reviewer must be able to find every occurrence in the actual text diff without trading correctness for DOM or main-thread safety. Unchanged text hidden in the middle of a collapsed gap is full-file context rather than part of the logical patch and may remain outside the default scope.

## Decision

Search discovery and rendering limits are separate systems:

- Discovery covers every add/del row and hunk-context row, plus explicitly revealed gap context. It never accepts a DOM row limit.
- `git.changes` returns a complete descriptor-only `searchFiles` manifest alongside the capped browsable `files` list.
- A Vite module worker builds unloaded diff models and scans files. `useDiffSearch` fetches file contents with bounded concurrency, uses generation disposal for cancellation, and ignores late IPC responses.
- Worker results are transferable, fixed-stride `Int32Array` buffers retained per file and coalesced to at most one React update per animation frame. React decodes only the active result and computes global navigation over per-file counts instead of repeatedly flattening all matches.
- Normal file loading uses a separate module worker for `buildDiffModel`, so navigating to an uncached result does not run jsdiff on the renderer interaction task.
- Partial search reports exact file progress and a lower-bound result count. Navigation does not wrap until discovery completes. Binary, too-large, and failed files are reported as unavailable rather than silently omitted.
- Normal browsing keeps `DIFF_ROW_RENDER_CHUNK` and `DIFF_ROW_RENDER_MAX`. A distant active match mounts only a small targeted row island with an omitted-range notice; search never increases `renderCap`.
- The packaged CSP explicitly permits same-origin module workers. Environments without `Worker` use the same pure engine through an asynchronous compatibility fallback.

## Consequences

- Search remains responsive and complete across changed rows even when the target is beyond the normal DOM ceiling or beyond the capped file rail.
- Search and split rendering share the same model projection, including row/side ordering.
- File contents are still bounded by the existing binary/file-size safety policy. Such files are visible as unavailable; the UI never presents a misleading complete result count for them.
- IPC requests already in flight cannot be physically aborted, but generation checks prevent their data from entering a newer search.
- Search state is progressive: result ordinals may move as earlier files complete, while active logical identity remains stable.

## References

- `src/renderer/src/hooks/useDiffSearch.ts`
- `src/renderer/src/lib/diff/diff-search.worker.ts`
- `src/renderer/src/lib/diff/diff-search-protocol.ts`
- `src/renderer/src/lib/diff/diff-model.worker.ts`
- `src/renderer/src/components/diff/DiffFileSection.tsx`
- `docs/architecture/diff-editing.md`
