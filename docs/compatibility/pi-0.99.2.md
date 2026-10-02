# Pi 0.99.2 compatibility audit

Audited against the upstream coding-agent changelogs, declarations, manifests,
and shipped runtime for 0.86.0, 0.86.1, 0.87.0, 0.87.1, 0.99.0, 0.99.1,
and 0.99.2. Pi-Vis bundles exact
`@earendil-works/pi-coding-agent@0.99.2` through
`src/main/pi/pinned-pi.ts`; it never discovers or updates a user-installed Pi.
A later pin requires a new audit.

The classifications below are deliberate:

- **Supported** means Pi-Vis integrates the public API, projects the new state,
  or inherits the behavior from the exact runtime and has an appropriate gate.
- **Upstream-internal** means the behavior runs inside the pinned public runtime
  without a separate Pi-Vis protocol or UI surface.
- **Intentionally inapplicable** means the change belongs to upstream's
  standalone CLI, fullscreen renderer, self-maintenance, or another surface
  that Pi-Vis intentionally replaces. It is not reimplemented merely to claim
  parity.

## Release and package boundary

- The installed and packaged production family is coding-agent plus its seven
  exact `0.99.2` Pi dependencies: `chord`, `pi-agent-core`, `pi-ai`,
  `pi-codemode`, `pi-mcp`, `pi-telemetry`, and `pi-tui`. The two new packages
  are not optional packaging extras: the public built-in factories load them.
- Node remains `>=22.19.0`. The audited nested dependencies are TypeBox
  `1.3.27`, Undici `8.10.2`, and pi-ai's OpenAI SDK `7.19.0`.
- `bin.pi` remains `dist/bundle/cli.js`. Pi-Vis resolves both `cliPath`, for
  real CLI subprocesses, and the supported modular `dist/cli.js` anchor
  (`path`), from which the SDK host derives the public `dist/index.js` entry.
- The root and `./rpc-entry` exports are compiled runtime surfaces. The
  `./client` and `./experimental/plugin` exports remain source-only and are not
  imported or packaged as Pi-Vis runtime APIs.

## Required breaking-change handling

| Release | Upstream change | Pi-Vis handling |
|---|---|---|
| 0.86.0 | Provider stream callbacks receive `TranscriptContext` rather than the old `Context`; extensions use `context.messages`, `getCurrentSystemPrompt()`, and `getCurrentTools()`. | The SDK host passes public runtime objects through rather than constructing provider contexts. Exact declarations and real extension journeys gate the new surface. |
| 0.86.0 | `ToolCall.arguments` and `ToolResultMessage.details` became JSON-compatible values, tool-result typing became conditional, and `JsonValue` arrays became readonly. | Shared Pi projections preserve JSON values instead of assuming mutable records. Tool-call/result and nested-call fixtures exercise the transported shapes. |
| 0.86.0 | `user_bash` is fail-closed: a thrown handler or invalid defined result aborts; only `undefined` continues to the next handler/default; valid results are `{ operations }` or `{ result }`. | Direct Shell Turns emit the public event once, honor both valid result branches, and use the host PTY only for `undefined`. Handler failures never fall through to an unintended shell spawn. |
| 0.87.0 | `shouldStopAfterTurn` was removed. `finishTurn` returns `{ action: "end" }` and runs after the callback, including error and abort paths. | Pi-Vis has no import of the removed callback. The exact runtime gate proves the new `finishTurn` lifecycle and the host relies on the public settled boundary. |
| 0.87.0 | `ContextEditEntry` joined `SessionEntry`; SessionManager owns the canonical provider context and assigning `agent.state.messages` no longer replaces history. | Session loading, transcript projection, tree reconstruction, and authority snapshots understand append-only `context_edit` entries. Replacement data is exactly `{ content: ContextEditableContent } | null`; only user, assistant, tool-result, and custom-message entries are editable, and Pi rejects system or other bookkeeping targets. Runtime changes use public `appendContextEdit`, navigation, append, and `refreshContext()` paths rather than mutating agent state. |
| 0.87.0 | Turn boundaries gained required fields and `AgentBeforeSettleEvent`; `ExtensionRunner.emit()` no longer accepts `turn_end`, which uses `emitBoundary()`; deferred runs begin only after `agent_settled` handlers finish. | Boundary behavior stays upstream-owned. Host ingress and transition gates wait for public settled state, and declaration/runtime tests reject the removed event path. |
| 0.99.0 | Prompt preflight, `steer()`, and `followUp()` now use disposition strings (`handled`, `queued`, or `started`) rather than booleans. | The bridge normalizes the exact public dispositions and state authority records custody only after the matching disposition. Synchronous queue events, handled input, and queued/started races are fault-injection tested. |
| 0.99.0 | Built-ins have canonical `builtin:<name>` identity; registry entries use `builtin` rather than `hidden`; `--no-extensions` includes built-ins. | Pi-Vis injects public codemode, tool-search, and MCP factories with `{ builtin: true, replaceable: true }`. The exact private adapter validates only llama.cpp's `{ name, factory, builtin: true }` entry. ResourceLoader owns disable/replacement/default-tool semantics. |
| 0.99.0 | Image-model helpers were replaced by discriminated chat/image/classifier `ModelRuntime` APIs; login options gained stable device identity; direct `AgentSession` instances may expose `routedModel`. | The host uses public typed runtime accessors and supplies its persisted app device ID for ChatGPT sign-in. Routed physical-model identity is projected separately from the selected virtual model for authority, display, and usage; it is not added to upstream's `RpcSessionState`, which has no `routedModel` field. Because each semantic snapshot is complete, omission of `routedModel` clears a prior virtual route; the renderer consults its compatibility snapshot only when no semantic snapshot exists. Removed image helper exports are rejected by the declaration gate. |
| 0.99.0 | Pi-TUI consolidated terminal color queries into `queryTerminalColors()` and changed its theme surface. | Pi-Vis imports only supported `TuiMainScreen` and public theme APIs. Its extension surfaces keep semantic app roles; no removed single-color query or TUI root class is imported. |
| 0.99.0 | Session/transcript unions added system messages, context edits, usage entries, bounded nested tool-call records, draft-null retain-none compaction, and provider-stream events. | Typed session-file/protocol schemas, history conversion, transcript reduction, and tree flattening preserve all applicable records. Live nested execution events retain `parentToolCallId`; the parent tool-result message retains `{ calls, complete }` without child results. `CompactionEntryDraft.firstKeptEntryId` and `appendCompaction()` accept `null`, but SessionManager normalizes it to the new compaction entry's own ID, so persisted `CompactionEntry.firstKeptEntryId` and successful `CompactionResult.firstKeptEntryId` are strings. Unknown provider payloads do not become renderer authority. |
| 0.99.0 | Built-in shell results are structured and bounded to one MiB, with `truncated` and optional `full_output_path`; empty output is `""`. Strict-prefer schemas are now the default. | Direct Shell Turns continue through public Bash APIs and preserve the canonical result. Pi-Vis does not recreate tool schemas or require the retired experimental flag; exact runtime tests assert strict-prefer defaults. |
| 0.99.0 | The published TypeScript target moved to TS 7 / ES2024 and the dependency/export closure changed. | Pi-Vis's build and exact package gates compile against the shipped declarations and require the complete eight-package production family in source and packaged artifacts. |

## Exhaustive feature disposition

### 0.86.0

| Changelog feature or added surface | Classification | Pi-Vis disposition |
|---|---|---|
| Prompt-cache warming, setting, event, and usage | Supported | Usage/cache fields are preserved and optional cache-warming notices are projected without duplicating provider accounting. |
| `/bug`, diagnostic bundle, transcript ZIP, and crash records | Intentionally inapplicable | Pi-Vis owns `diagnostics.log`, Crashpad, and app release/support flow; it does not run the upstream CLI uploader or duplicate sensitive bundle UI. |
| Transcript-aware prompt/tool updates from `before_agent_start` | Supported | The exact runtime owns the mutation and Pi-Vis preserves resulting system/context/tool records. |
| Offline Radius model catalog | Upstream-internal | Available through Pi's public runtime catalog; Pi-Vis keeps no provider table. |
| Per-model compaction budgets and `compaction.modelOverrides` reserve/keep values | Supported | Settings and compaction execution remain public-runtime-owned; session outcomes and boundaries are projected. |
| Fireworks native deferred tool loading | Upstream-internal | Provider/tool loading stays inside exact pi-ai/coding-agent. |
| Click-to-toggle branch, compaction, and skill entries | Intentionally inapplicable | This is upstream InteractiveMode presentation. Pi-Vis owns React transcript/tree affordances. |
| Public Radius catalog | Upstream-internal | Consumed dynamically through the runtime catalog, not copied into Pi-Vis. |
| `ctx.modelRegistry.stream()` / `streamSimple()` | Supported | Public extensions run against Pi's model registry without a host-side provider adapter. |
| `compat.allowedFallbackModels` | Upstream-internal | Resolved by the pinned model runtime. |
| Unsubscribe function returned by `pi.on()` | Supported | Extension lifecycle is owned by the public runner; no private listener cleanup is used. |
| Exported extension hook event/result types | Supported | The host compiles against and behaviorally exercises the public hook contracts. |

### 0.86.1

| Changelog feature or added surface | Classification | Pi-Vis disposition |
|---|---|---|
| Meta Muse provider login and `META_API_KEY` | Supported | Interactive methods are discovered dynamically through `ModelRuntime`; the account surface also exposes Meta's exact API-key environment/status entry and OAuth capability. Its static account metadata is gated against the complete installed provider registry so later ID, name, OAuth, or environment-variable drift fails tests. |
| Compile-cache changes | Upstream-internal | This is upstream CLI/runtime startup implementation and needs no Pi-Vis protocol. |

### 0.87.0

| Changelog feature or added surface | Classification | Pi-Vis disposition |
|---|---|---|
| Canonical session context and extension boundaries | Supported | SessionManager remains the single JSONL/provider-context authority; Pi-Vis projects it without a parallel history store. |
| Full transcript `context_with_system` | Supported | Extensions receive the public event after context assembly; system records are preserved by typed history/protocol projections. |
| Per-model image input limits and resize profiles | Upstream-internal | The runtime applies model metadata before provider submission. |
| Append-only context edits and `appendContextEdit(null)` omission/replacement semantics | Supported | Context edits survive load, navigation, tree copy, and renderer transcript projection with the typed content-only replacement shape; system-message targets remain invalid. |
| Actionable `turn_end` and `agent_before_settle` boundaries | Upstream-internal | Extension runner ordering is inherited; Pi-Vis waits for public settled state. |
| Retain-none compaction via `appendCompaction(summary, null, tokensBefore)` | Supported | `null` is a draft/write sentinel only. The runtime persists the new compaction's own ID as `firstKeptEntryId`; that self-referential string boundary remains navigable/projectable and means no preceding entry is retained. |

### 0.87.1

| Changelog feature or added surface | Classification | Pi-Vis disposition |
|---|---|---|
| Claude Opus 5.5, GPT-6 Sol/Luna, and xAI Grok 4.7 defaults | Supported | Models are inherited from exact pi-ai and appear through runtime catalog discovery. Pi-Vis has no mirrored model list. |

### 0.99.0

| Changelog feature or added surface | Classification | Pi-Vis disposition |
|---|---|---|
| Codemode, tool search, MCP, configuration, transports, and OAuth | Supported | Public factories are injected as replaceable built-ins. Their tools, commands, auth, and Pi-TUI surfaces use the existing extension bridge. |
| Tool namespaces, annotations, output schemas, structured content, `isError`, loadout preparation, execution APIs, and parent IDs for nested calls | Supported | Public tool execution stays in Pi. Live tool-result events retain `structuredContent`; upstream's persisted `ToolResultMessage` intentionally omits that live-only field while retaining content, details, usage, and the bounded `NestedToolCalls` record. Pi-Vis mirrors that durable/live distinction rather than inventing session data. |
| Warning when an extension replaces a built-in | Upstream-internal | ResourceLoader owns collision diagnostics. |
| Virtual models and routed physical models | Supported | Virtual selection and routed identity remain distinct in runtime state and usage. |
| ChatGPT sign-in and device ID | Supported | The app-owned login UI drives public `ModelRuntime.login()` and supplies a stable device ID without exposing credentials to renderer state/logs. |
| `system` theme default | Intentionally inapplicable | Pi-Vis owns its React system-theme setting and semantic palette; embedded Pi-TUI surfaces use the app's stable role mapping. |
| `#rgb`, OKLCH/OKHSL, theme styles/colors/appearance | Upstream-internal | Public Pi-TUI theme parsing is inherited for extension-owned content; Pi-Vis does not convert it into app palette tokens. |
| Llama and Jev classifier models | Supported | ModelRuntime exposes classifier capability to extensions and codemode; there is no redundant app classifier UI. |
| Fullscreen wheel-line setting | Intentionally inapplicable | Pi-Vis does not instantiate upstream fullscreen InteractiveMode. |
| Per-input RPC/session dispositions | Supported | The SDK bridge uses the same public dispositions even though Pi-Vis does not add a second JSON/RPC session transport. |
| Image generation and typed model-runtime accessors/auth | Supported | Extension/runtime calls use public typed accessors. Pi-Vis does not add an app-owned image-generation workflow. |
| Model catalog query types | Supported | Catalog refresh/readback uses the public runtime and owner fencing. |
| `provider_stream_event` | Upstream-internal | Provider events remain inside the extension/runtime boundary unless represented by typed session state. |
| HTML export reveal for `display: false` | Upstream-internal | Applied by Pi's export implementation; it is not transcript authority. |
| Claude Sonnet 5.5 | Supported | Inherited through the exact catalog. |
| Built-in disable syntax and inline `builtin: true` | Supported | Built-in factories and ResourceLoader preserve `-builtin:<name>` and replacement semantics. |
| `+`/`-` default-tool configuration | Supported | Pi's `defaultTools` remains authoritative and extension/custom tools are composed separately. |
| Codemode classifier usage/cost | Supported | Usage is owned by the runtime and preserved in typed usage/session records. |

### 0.99.1

| Changelog feature or added surface | Classification | Pi-Vis disposition |
|---|---|---|
| GPT-6.1 Sol for OpenAI, Azure, and OpenAI Codex, including the Codex default | Supported | Inherited through dynamic exact-runtime catalogs; no Pi-Vis provider/model table changes are needed. |

### 0.99.2

| Changelog feature or added surface | Classification | Pi-Vis disposition |
|---|---|---|
| MCP default codemode exposure no longer blocks the first prompt | Supported | Public MCP/codemode built-ins inherit the corrected startup ordering. |
| MCP system-prompt section, server descriptions/ranking, `searchTools`, and `describeNamespace` aliases | Supported | Public factories expose these capabilities to the runtime; Pi-Vis does not parse or re-rank MCP tools. |
| `oauth.clientName` | Supported | MCP configuration is loaded by Pi's public extension and OAuth implementation. |
| Provider bearer auth with global/extension scope and HTTPS/loopback restrictions | Supported | Validation and credential transport stay inside the public MCP runtime; secrets never enter Pi-Vis authority frames. |
| Anthropic workload-identity federation environment variables | Supported | The pinned provider inherits the environment and performs upstream authentication. The account surface evaluates the same login-shell plus Settings override used for host spawning, refreshes after a committed `piEnv` change, and reports only redacted provenance. It mirrors upstream precedence—stored credential, bearer token, OAuth token, API key, then federation—and recognizes federation only when the required rule, organization, and identity-token-file variables are all present. |
| `/reload` enables newly added `defaultTools` | Supported | Pi-Vis's app-owned `/reload` invokes the public runtime reload path, so the corrected ResourceLoader behavior applies. Removed tools stay enabled, tools manually disabled in-session stay disabled unless newly added, and explicit tool CLI controls retain precedence inside Pi. |
| Standalone `pi mcp add` and upstream MCP manager presentation | Intentionally inapplicable | Pi-Vis does not shell out to duplicate session control. MCP commands/panels come from the injected public built-in and app-owned settings remain authoritative. |

## Exhaustive Changed-entry disposition

These non-fix changelog entries are listed separately so presentation-only CLI
changes are not mistaken for omitted compatibility work.

| Release | Changed entry | Classification and disposition |
|---|---|---|
| 0.86.0 | Enable Node persistent compile cache before bundled CLI load | Upstream-internal: real CLI subprocesses inherit it; the SDK host has no duplicate cache bootstrap. |
| 0.86.0 | Progressive `--resume` results and faster `--continue` discovery | Intentionally inapplicable: Pi-Vis owns persisted workspace search/open and never starts a second CLI session transport. |
| 0.86.0 | Replace native clipboard dependency with bundled platform helpers/fallbacks | Upstream-internal for Pi-TUI content; app clipboard behavior remains Electron/React-owned. |
| 0.86.0 | Faster inherited fuzzy search | Upstream-internal: public upstream selectors/extensions inherit it; Pi-Vis search algorithms remain app-owned. |
| 0.86.1 | Enable Node persistent compile cache before bundled CLI load | Upstream-internal, with the same boundary as 0.86.0. |
| 0.87.1 | Make Grok 4.7 the xAI default | Supported through the exact dynamic catalog/default; no model table is copied. |
| 0.99.0 | TypeScript 7, ES2024, and Node type-stripping build | Supported: Pi-Vis compiles against and packages the published output; it does not run upstream source. |
| 0.99.0 | Startup banner/logo/theme-presentation changes and revised built-in colors | Intentionally inapplicable to React chrome; embedded public Pi-TUI surfaces inherit only their own renderer/theme behavior. |
| 0.99.0 | Background-first light/dark detection and `TERM=*-direct` truecolor | Upstream-internal for public Pi-TUI surfaces. Pi-Vis chrome uses semantic theme tokens. |
| 0.99.0 | Rename inherited OpenAI Codex provider to legacy | Supported through dynamic provider metadata; Pi-Vis has no hard-coded label. |
| 0.99.0 | Canonical `builtin:<name>` identity and removal of slash-command `[t]` tag | Supported for ResourceLoader identity; upstream autocomplete tags are intentionally inapplicable to the app command UI. |
| 0.99.0 | `--no-extensions` disables built-ins and `-e builtin:<name>` reloads one | Supported by the same public built-in identity/configuration contract; Pi-Vis does not reparse CLI flags. |
| 0.99.0 | Default tool-call renderer shows arguments and MCP server/tool labels | Intentionally inapplicable to the React transcript; extension-owned Pi-TUI panels inherit upstream presentation. |
| 0.99.0 | Structured Bash/PowerShell output grows to one MiB, adds truncation/path metadata, and uses `""` for empty output | Supported for codemode/tool calls through public structured results. The separate model-facing Direct Shell Turn remains bounded by Pi's canonical Bash-message contract. |
| 0.99.1 | GPT-6.1 Sol becomes the OpenAI Codex default | Supported through the dynamic catalog/default. |
| 0.99.2 | `codemode-deferred` aliases `codemode`; `direct` is required for always-declared MCP tools | Supported inside the public codemode/MCP factories and ResourceLoader configuration. |
| 0.99.2 | Codemode/tool-search descriptions stop embedding changing server/tool lists; `mcp_servers` system context is refreshed per prompt | Supported: transcript-aware system/context records are typed and Pi owns prompt construction. |
| 0.99.2 | Non-direct MCP servers connect in the background and are awaited only on search/use | Supported by the public runtime. Host startup does not add a competing readiness wait. |

## Exact private llama.cpp exception and public built-ins

Pi 0.99.2 ships four aggregate built-ins in
`dist/extensions/index.js`: llama.cpp, codemode, tool-search, and MCP. All use
`builtin: true`; codemode, tool-search, and MCP are replaceable and also have
public root factories. Pi-Vis creates those three exclusively from the public
exports.

Llama.cpp remains the only built-in without an equivalent public factory.
[ADR 0006](../decisions/0006-pinned-llama-private-extension-exception.md)
therefore renews the isolated adapter for exact `0.99.2`. The adapter imports
only the aggregate registry, selects exactly `llama.cpp`, validates
`{ name, factory, builtin: true }`, freezes that copied public inline-extension
shape, and returns immediately to public
`resourceLoaderOptions.extensionFactories` and runtime APIs. It never imports
a llama implementation submodule or privately loads the other built-ins.

## Shutdown and restart contract

Pi 0.99.2 adds MCP stdio subprocesses whose public close sequence may consume
about 2.5 seconds (stdin close, 500 ms grace, SIGTERM, then a two-second hard
kill). A host shutdown must therefore be awaitable and IPC-first:

1. Main fences new requests and disconnects child IPC. The child closes its
   outbound queue, disposes shell resources, and awaits public
   `runtime.dispose()` so extensions, MCP clients, and their subprocesses can
   close.
2. The child has a four-second fail-safe. Main waits 4.5 seconds before
   escalating to SIGTERM, leaving margin beyond MCP's close budget and the
   child fail-safe, then waits another three seconds before SIGKILL.
3. SessionRegistry awaits the actual child exit before releasing the advisory
   lock, installing a replacement, completing a planned worktree transition,
   or starting an automatic crash restart. Repeated `stop()` calls share the
   same promise. A lock acquisition that completes after shutdown starts is
   tracked through its compensating unlock before the record can drain.
4. Electron's first `before-quit` event is prevented while one shared
   `stopAllSessions()` promise drains session search, every registry record,
   host exit, and asynchronous advisory-lock unlock. Re-entrant quit events do
   not start another drain. The fence allows the final `app.quit()` through
   when cleanup settles, or after an 8.5-second app-level deadline just beyond
   the host's complete 7.5-second escalation budget.

This ordering is correctness, not cosmetic signal handling. Starting a
successor while its predecessor is disposing can overlap JSONL ownership,
extension work, and MCP descendants. Sending SIGTERM first is also unsafe:
user extensions may install signal handlers, so the old three-second hard-kill
timer could deterministically report SIGKILL even though the runtime was
healthy. Shutdown diagnostics distinguish graceful disconnect, timeout
escalation, signal, and final exit; a forced path remains bounded rather than
silently hanging. The outer Electron deadline is a last-resort process-exit
fence, not a shorter competing host timeout.

## Continuing contracts and regression gates

- The former local patch remains retired. Behavioral gates still cover
  unterminated JSONL-tail repair, indexed fragmented Mistral tool-call
  continuation, and custom-message/tool-result adjacency.
- Project-local resources remain trust-denied by default. Public built-ins are
  composed through ResourceLoader; they do not bypass trust or introduce a
  second session authority.
- Direct Shell Turns retain the public fail-closed `user_bash` contract. `!`
  keeps Pi's canonical Bash message in model context; `!!` excludes the whole
  message while retaining the human-visible record.
- `tests/pinned-pi-runtime.test.mts` gates the exact package closure,
  declarations, removed names, default schemas, model/catalog/auth/runtime
  surfaces, context edits, usage, nested calls, built-in factories, and bundled
  CLI version.
- Private-adapter, bootstrap, bridge/state-authority, session-file/protocol,
  registry lifecycle, real-SDK, and final packaged-app tests cover integration.
  `npm run test:full` and `npm run dist` remain release requirements.

## References

- [Upstream coding-agent 0.86.0 changelog](https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.86.1 changelog](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.87.0 changelog](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.87.1 changelog](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.99.0 changelog](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.99.1 changelog](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.99.2 changelog](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/CHANGELOG.md)
- [Pinned llama.cpp private-extension exception](../decisions/0006-pinned-llama-private-extension-exception.md)
- [Runtime services](../architecture/runtime-services.md)
- [Testing](../testing.md)
