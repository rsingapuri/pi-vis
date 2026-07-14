# Testing

## Verification commands

```sh
npm run typecheck
npm run lint
npm test
npm run test:render
npm run test:e2e
npm run test:full    # typecheck, lint, unit, build, render, Electron E2E
```

`npm run test:full` is the local release gate. If the non-TTY lint wrapper reports a parser artifact, verify with `./node_modules/.bin/biome check .` or `script -q /dev/null npm run lint`.

## State-authority regression coverage

- `resources/pi-session-host/state-authority.test.mjs` is the direct fault-injection gate. It tests direct snapshots, identity/epoch transitions, FIFO custody behind compaction/navigation, submission dispositions, ESC target selection, queue-restoration attachment custody, editor revision rejection, and transition batches.
- `src/main/pi/session-host.test.ts` exercises host-envelope identity/sequence validation, transport-gap fencing, full-snapshot recovery, host control watchdogs, and host wire acknowledgements using the stub-fork seam.
- `src/main/sessions/session-registry.test.ts` covers snapshot leases/availability, uncapped activation, untouched activation-visit retirement and its safety fences, retained-intent uncertainty after failure, stale and lost-ack ESC, unified-submit continuation identity, renderer-generation claims, bounded claim expiry/tombstones, acknowledged renderer/UI operations, close prepare/confirm mutation checks, and correlated/ambiguous reload settlement.
- `src/main/sessions/bound-history.test.ts` fault-injects cold activation, same-file host restart, epoch transition, file mismatch, and close/recreate while persisted history I/O is delayed.
- `src/renderer/src/stores/sessions-store.test.ts` verifies renderer snapshot ordering/availability gating, dispositions, queue restoration, editor revisions, unified host/epoch response binding, expired continuation suppression, same-file/same-cursor delayed-history fencing, generation-safe UI projection, and authoritative user-echo attachment rendering.
- `tests/fake-session-host-esc.test.mts` drives the real child-process fixture over IPC and verifies navigation → compaction → retry → streaming → bash → editor ESC priority, cancellation, late-output/persistence suppression, and attachment-aware queue restoration.
- `tests/lifecycle-boundary-model.test.mts` exhaustively enumerates the finite internal operation/boundary/lifecycle-cut reference model for submissions, effectful commands, reload, ESC, editor patches, picker continuations, and claimed/unclaimed unified actions, then runs reproducible generated schedules over the same state space. The model explicitly checks one dispatch per intent, terminal-versus-review exclusivity, permanent `outcome_unknown` replay refusal, correlated Composer non-clearing after a lifecycle cut, and zero admission while unavailable, transitioning, closing, or identity-stale. It is not treated as implementation conformance by itself: deferred-promise tests in `bridge.test.mjs`, `state-authority.test.mjs`, `session-registry.test.ts`, and `sessions-store.test.ts` drive the real adapters at those cuts (including active-command/replacement overlap, predecessor-epoch terminal submission, command settlement after epoch change, close freeze, stale picker/editor continuation, and unified expiry). The model is not a universal proof of arbitrary JavaScript schedules.

## Workspace session-search coverage

Search tests use a generated isolated JSONL corpus: two workspaces, a mapped worktree, more than 30 sessions, exact/prefix/camel/snake/path/typo cases, pre-compaction and alternate-branch-only matches, repeated occurrences, corrupt/intermediate rows, incomplete and appended rows, and an excluded archived source. Unit/integration coverage verifies catalog ownership/confinement, transactional append/rebuild/corruption/restart behavior, deterministic relevance (Recall@10, MRR, nDCG), generation fencing, revision-invalidated pagination, exact context relocation/stale outcomes, and opaque-target validation. Electron/render coverage proves scope and worktree inclusion, sidebar-pagination independence, default-on/restart-scoped enablement, disabled-launch chrome suppression, ESC/focus behavior, preview's zero host/session side effects, and explicit open's normal activation-visit release behavior.

Before release, run `PIVIS_SEARCH_BENCH_MIB=500 npm run bench:session-search`, build the `.app`, then run `node scripts/verify-packaged-session-search.mjs <path-to-Pi-Vis.app>`. The packaged check launches the asar-unpacked worker under the packaged Electron Node runtime and requires SQLite/FTS initialization. The benchmark drives the production service, catalog, and compiled worker against an isolated corpus, samples process RSS from the unblocked parent during indexing, and gates relevance, cold progressive first result, warm-query p95, and end-to-end completed-append detection from an early source while a bulk source is still reconciling. Gates: warm query p95 <150 ms; first initial-index result <500 ms; complete append <2 s; stale UI suppression <100 ms; no search-caused main-thread task >16 ms; worker RSS <192 MiB for 500 MiB sources; IPC batches <=50 results and <=128 KiB; preview creates no host.

Run the focused tests while changing these surfaces:

```sh
npx vitest run resources/pi-session-host/state-authority.test.mjs
npx vitest run src/main/pi/session-host.test.ts src/main/sessions/session-registry.test.ts
npx vitest run src/renderer/src/stores/sessions-store.test.ts
```

## Other layers

Vitest covers TypeScript source, host `.mjs` units, test harness units, and deterministic child-process protocol tests. Playwright E2E builds a fresh production app; renderer tests run against the preview stub. Normal Electron E2E includes delayed history activation/retry, claimed-unified watchdog review with exactly-one dispatch, process-level streaming/queue/compaction/bash ESC cancellation, and a fake-host seam where the first authoritative user echo precedes the submit response so Composer echo deduplication is exercised in the real IPC ordering. `tests/fixtures/fake-pi.mjs` is retained for executable version and update tests, while `fake-host-process.mjs` drives the SDK-host wire protocol without a real pi install. `real-sdk-host-smoke.spec.mts` runs automatically when a real Pi binary is installed and pins compatibility to Pi 0.80.6. Its no-network cases use isolated agent/session directories to gate first-use diagnostics, real extension submission, expected empty-session compaction failure, Composer clearing, and post-command host liveness. Its successful-compaction case starts a test-owned OpenAI-compatible server bound to `127.0.0.1`, installs an isolated custom model, completes deterministic turns, and requires one summarization request, `Context compacted`, and a persisted JSONL compaction entry. It never treats dispatch, clearing, or a surfaced failure as success. Its opt-in `PIVIS_REAL_USER_HOST_SMOKE=1` case loads the developer's actual global/project extensions without making model calls. Provider-spending and real-panel suites remain opt-in where documented.

Worktree commands use `scripts/ensure-worktree-dev.mjs` to reuse a compatible sibling `node_modules`; caches are worktree-local. E2E uses isolated settings/session directories and defaults to one worker.

## Proposed authority-frame migration verification

The authority-frame work in [ADR 0003](decisions/0003-authority-frames-and-plane-synchronization.md) is not represented as already covered by the compatibility suites above. Before each production migration slice, add deterministic fault tests for the real child, main router, and renderer reducer that prove:

- a following plane is exact only through its named cursor; a frame in flight never becomes a claim of present-time equality;
- dropped, reordered, duplicate, and bounded-buffer-overflow publications enter `synchronizing` and recover only through baseline plus contiguous replay;
- attach racing a transition cannot omit a boundary or let predecessor data mutate the successor;
- detached compaction/operations recover current state plus journal records, with explicit truncation low/high-watermark behavior;
- same-owner duplicate intents invoke Pi once, conflicting IDs reject, and post-dispatch loss remains non-replayable `outcome_unknown`;
- getter/event disagreement keeps the conservative barrier, including compaction retry waits;
- transcript, extension UI, and panel planes synchronize independently; panel input stays fenced until keyframe or acknowledged repaint;
- lock contention fails mutable activation and child loss never synthesizes terminal operation success.

Run the shadow reducer against the compatibility projection during the migration and assert only explicitly bridged baselines agree. Documentation-only changes do not execute these tests; implementation changes must run the relevant focused suites and the full release gate before the ADR can move beyond proposed.
