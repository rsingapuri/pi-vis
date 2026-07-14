# Pi command matrix

This matrix is exhaustive for `PiRpcCommandSchema`. The executable source of truth is `PI_COMMAND_POLICY` in `src/shared/pi-protocol/commands.ts`; `commands.test.ts` fails when a discriminant is added without policy coverage.

All renderer rows require `(requestId, expectedHostInstanceId, expectedSessionEpoch)`. **Intent** means an additional intent id is mandatory and post-dispatch transport loss becomes `outcome_unknown` review custody. Text rows never use `session.sendCommand`.

### Authority-frame migration status

This table documents the deployed policy/settlement compatibility contract. Under the proposed [authority-frame ADR](../decisions/0003-authority-frames-and-plane-synchronization.md), every mutation row—not only rows marked **Intent**—will receive a stable child-recorded intent and terminal outcome in an atomic authority frame. Read-only rows remain classified queries with an explicit retry policy. Until that migration is complete, the table's current intent markings and correlated IPC settlements remain authoritative; neither a receipt nor a returned promise is completion evidence, and no mixed legacy/frame state may be treated as one cursor.

| Commands | Class | Reachable surface | Settlement / outcome evidence |
|---|---|---|---|
| `prompt`, `steer`, `follow_up` | effectful, submission-only | Composer, unified editor, extensions | `session.submit` dispositions; host admission and queue custody tests |
| `get_available_models`, `get_scoped_models`, `get_logout_providers` | read-only | model/scope/logout pickers | identity-bound response; picker/store tests |
| `get_commands` | read-only | ready-time command discovery | identity-bound catalog update; store tests |
| `get_state`, `get_session_stats` | read-only | bootstrap, `/session`, reconciliation, header/tree stats | identity-bound read and stale-write fencing; executor/store/header tests |
| `get_messages`, `get_fork_messages`, `get_last_assistant_text` | read-only | SDK integrations, `/fork`, `/copy` | bridge response plus executor outcome tests |
| `get_trust_state`, `get_tree`, `render_entry`, `get_cache_miss_notices` | read-only | trust/tree/transcript/history UI | identity-bound continuation; tree/render/cache tests |
| `set_model`, `set_scoped_models`, `save_scoped_models` | idempotent | model and scope controls | explicit terminal response plus authoritative read-back |
| `logout_provider` | idempotent explicit-state | logout picker | terminal credential-store response and model refresh |
| `set_thinking_level` | idempotent | header/bootstrap | terminal response plus authoritative clamp read-back |
| `set_session_name` | idempotent | `/name`, header | terminal response; optimistic state only after success |
| `set_auto_compaction`, `set_auto_retry`, `set_steering_mode`, `set_follow_up_mode` | idempotent | extension/unified command surfaces | bridge contract tests and correlated settlement |
| `set_trust` | idempotent | trust picker | terminal persistence response; correlated reload/resync |
| `set_label` | idempotent | tree viewer | terminal response followed by same-runtime tree refresh |
| `abort`, `abort_bash`, `abort_retry` | effectful + intent | ESC/host controls and integrations | explicit completion or unknown-effect review; bridge/state-authority tests |
| `bash` | effectful + intent | `!` / `!!` | exit code/output is operation outcome; transport ambiguity is review custody |
| `cycle_model`, `cycle_thinking_level` | effectful + intent | extension/unified controls | correlated host response; never rebound or replayed |
| `compact` | effectful + intent | `/compact`, extensions | `compaction_end` and persisted compaction prove success; domain and unknown paths are separate |
| `export_html` | effectful + intent | `/export`, `/share` | returned path/file is success evidence; `/share` uses the same custody path |
| `navigate_tree` | effectful + intent | tree viewer | returned branch and same-runtime transcript rebuild; cancellation is not success |
| `new_session`, `switch_session`, `fork`, `clone` | replacement + intent | slash/picker/extensions | correlated transition successor; successor-bound `get_state` and `fileChanged` |

## Deterministic gates

- Shared policy/schema tests prove every discriminant has one class and required identity/intent fields.
- Registry fault-injection tests prove unavailable/stale commands do not dispatch, domain failures settle `completed`, post-dispatch loss settles `outcome_unknown` with durable review, and claimed unified actions expire into one tombstoned non-replayable review.
- SessionHost tests prove child-IPC dispatch and terminal host/epoch correlation.
- Renderer tests prove all direct command call sites construct the mandatory request and stale continuations do not write state.
- Bridge tests prove each command reaches the intended public SDK operation or an explicit structured capability/domain failure.
- Electron fake-host tests cover first-use, picker, command, delayed-history, unified-claim, and ESC cancellation/queue-restoration behavior without model/network nondeterminism.
- The Pi 0.80.6 localhost-provider smoke proves a real successful model-backed compaction by asserting the HTTP summarization request, `Context compacted`, a persisted `compaction` JSONL entry, Composer clearing, and continued host liveness.

External provider aliases, credentials, and backend availability remain integration dependencies. A dispatch, cleared editor, or surfaced provider failure is never recorded as successful operation evidence.
