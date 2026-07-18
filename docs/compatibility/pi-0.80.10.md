# Pi 0.80.3 → 0.80.10 compatibility audit

Audited against upstream `v0.80.3` through `v0.80.10` on 2026-07-16. Production Pi-Vis bundles and runs exactly `@earendil-works/pi-coding-agent@0.80.10` (a production dependency; see `src/main/pi/pinned-pi.ts`) — the user's own pi install is never detected or used, because upstream ships breaking SDK changes in patch releases. Tests run against the same pinned package. Changing the pin is a Pi-Vis release decision and requires re-auditing this document against the new version. The host's 0.80.6–0.80.7 adapter paths remain in the code but are unreachable in production while the pin is 0.80.10.

## Integration-significant handling

| Upstream change | Pi-Vis handling |
|---|---|
| `agent_settled` | Preserved as a transcript event. Runtime liveness comes from direct `AgentSession` snapshots, not settlement/event inference. |
| `entry_appended` / `registerEntryRenderer()` | The SDK host renders the public component to ANSI; custom entries remain ordered transcript blocks. |
| Extension command errors | `bindExtensions().onError` enters the owner-scoped transcript presentation plane and becomes one session-local error notification; throwing extensions cannot disappear behind Pi's internal command catch. |
| `showCacheMissNotices` | The host derives and replays non-persisted notices against the active runtime/history. |
| Optional session name metadata | `session_info_changed.name` remains optional and can clear renderer state. |
| `ThinkingLevel.max` | Typed in command, event, settings, and controls; model capability maps remain authoritative. |
| Public model/scope/session exports | Consumed only through public SDK APIs. |
| `ModelRuntime` replaces SDK auth/model options | On Pi 0.80.8+, the host uses `AgentSession.modelRuntime` for available-model reads, catalog refresh, model lookup, stored-credential listing, provider labels, and logout. Catalog refresh is dispatched as the stable `refreshModels` intent (not a read); its bounded outcome is followed by an owner-fenced available-model read. A bridge-local adapter retains the equivalent public `modelRegistry`/`authStorage` calls for the supported Pi 0.80.6–0.80.7 range; no private API is imported. |
| Dynamic provider catalogs | Fixture model/auth discovery stays isolated and offline; scoped-model refresh uses the public runtime and the tests use only the loopback provider. Runtime-native provider login reads public provider auth metadata and calls `ModelRuntime.login()` only through owner-bound intents; legacy `ModelRegistry` continues using the embedded terminal fallback. Credentials and provider errors never enter authority outcomes. |
| Project-local resources | Loaded through the deny-by-default trust resolver; reload reinitializes resources in the host transition. |

## Authority compatibility

Pi 0.80.10 supplies the public getters/methods the host snapshots directly: streaming/idle/compaction/retry/bash state, model/session metadata, pending queues, prompt preflight, queue clearing, navigation, abort primitives, and the canonical model/auth runtime. The host capability gate accepts either that runtime or the public legacy model registry exposed by the unchanged 0.80.6 production minimum. Pi-Vis validates those capabilities at host initialization. Snapshot identity, epoch, sequence, and leases protect renderer state across reload/rebind; submission dispositions, custody, editor revisions, and acknowledged queue restoration are Pi-Vis protocol features around those public APIs.

The compaction getter/event ordering introduced in Pi 0.80.6 remains in 0.80.10: automatic compaction sets `isCompacting` immediately after `compaction_start`, and compaction clears it in `finally` immediately after `compaction_end`. The host therefore keeps a conservative callback-settlement barrier and samples the public getter in a microtask. For an explicit compact command, custody remains fenced until both the terminal event/getter reconciliation and the public `compact()` promise settle. This avoids both false `missing_compaction_start` anomalies and permanently stranded post-compaction submissions without inferring liveness from transcript events.

## Regression gates

`tests/pinned-pi-runtime.test.mts` gates the manifest pin, installed package version, and executable layout. `tests/e2e/real-sdk-host-smoke.spec.mts`, `tests/e2e/real-sdk-transcript-lifecycle.spec.mts`, and the mandatory `tests/e2e/real-sdk-regressions.spec.mts` run against that executable with isolated `createRealSdkFixture` directories and only a loopback model provider where needed. The regression fixture adds real static/factory widgets, custom-overlay Escape completion, naming, and a deliberate `compact` collision; its journeys gate unified editor custody, native-command precedence/immediate compaction, session/tree relaunch reconstruction, and draft/search focus recovery. They cover real extension, prompt, streaming, tool, retry, interruption, compaction, persistence, and reload paths.

Run `npm run test:e2e:real-pi` for the focused compatibility gate or `npm run test:full` for the release gate. Targeted authority/reducer coverage is in `resources/pi-session-host/state-authority.test.mjs`, `src/main/sessions/session-registry.test.ts`, `src/renderer/src/stores/sessions-store.test.ts`, and `npm run test:transcript`.
