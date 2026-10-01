# Pi 0.85.1 compatibility audit

Audited against the upstream 0.84.3, 0.84.4, 0.85.0, and 0.85.1
changelogs, published declarations, package manifests, and runtime shipped in
`@earendil-works/pi-coding-agent@0.85.1` on 2026-09-05. Production Pi-Vis
bundles that exact dependency through `src/main/pi/pinned-pi.ts`; it never
discovers or updates a user-installed Pi. A later pin requires a new audit.

## Release and package boundary

- The exact installed and packaged Pi production closure is
  `chord`, `pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-telemetry`, and
  `pi-tui`, all at `0.85.1`. Telemetry is transitive through agent-core;
  Chord is new at this boundary. Coding-agent no longer has runtime
  dependencies on `pi-client` or `pi-protocol`, and final-app verification
  proves those removed packages are absent rather than carrying forward the
  0.84.2 closure accidentally.
- Node remains `>=22.19.0`, TypeBox remains `1.3.7`, Undici remains `8.9.0`,
  and pi-ai's OpenAI SDK remains `6.40.0`.
- The published `pi` binary moved to `dist/bundle/cli.js`. Pi-Vis resolves and
  verifies two paths deliberately: `cliPath` is that manifest-declared bundle
  and is used by real CLI subprocesses, PTY launch, updates, and CLI auth tests;
  `path` is the supported modular `dist/cli.js` anchor used only to derive
  `dist/index.js` for the SDK host and the audited llama adapter. Using the
  bundle as the SDK anchor would break public module resolution.
- The supported local SDK root (`dist/index.js`) and stdio RPC entry remain
  published. The `./client` and `./experimental/plugin` exports are source-only
  in 0.85.1 and are not runtime APIs. Pi-Vis neither imports nor packages them.

## Required breaking-change handling

| Upstream change | Pi-Vis handling |
|---|---|
| pi-ai renamed `GoogleThinkingLevel` to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` (0.84.3) | Pi-Vis has no local import of the old name. The exact declaration gate requires both new names and rejects the removed export so a future accidental dependency cannot compile unnoticed. |
| agent-core calls `prepareNextTurn` only after stop/queue checks determine another assistant turn will start (0.84.4) | The SDK host inherits the corrected lifecycle. A behavioral exact-runtime test stops after one assistant response and proves the prepare callback is not invoked speculatively. Pi-Vis does not add a second preparation hook. |
| pi-ai renamed `createGatewayBindingFetch` to `createAiBindingFetch` (0.85.0) | Pi-Vis does not construct Cloudflare bindings. The declaration gate requires the new public name and rejects the old one; provider transport remains upstream-owned. |
| pi-tui removed implicit `PI_HARDWARE_CURSOR`, `PI_CLEAR_ON_SHRINK`, and log-directory defaults (0.85.0) | On every runtime factory invocation, the host reads public `SettingsManager` values, calls public `setCapabilityOverrides()`, and updates one stable TUI config. Both Unified and standalone `TuiMainScreen` construction sites pass hardware-cursor and agent-log-directory arguments and call `setClearOnShrink()` explicitly. Focused tests cover both sites and a settings rebind. |
| Coding-agent's published executable changed to the bundle (0.85.1) | CLI-facing consumers use `cliPath`; SDK import derivation stays on the modular `path`. Resolver, PTY, update, exact-runtime, and packaged-path tests gate the split. |
| The published dependency/export closure changed (0.85.1) | Source and packaged gates require all six exact Pi packages, including Chord and telemetry, and prove client/protocol are absent. Source-only exports are recorded but never resolved at runtime. |

## Adopted new features

### Model and thinking persistence

Pi 0.84.3 changed model and thinking selection to session-only by default and
added explicit persistence. Pi-Vis now preserves that distinction:

- ordinary model/header selection and `/thinking <level>` send public
  `AgentSession.setModel(..., { persist: false })` or
  `setThinkingLevel(..., { persist: false })` through typed intents;
- `/model` and `/thinking` open searchable app-owned pickers;
- Enter applies only to the current session, while Ctrl+S sets Pi's default
  through `{ persist: true }`; and
- `/thinking <search>` exactly matches a currently available level,
  case-insensitively, or reports Pi's available-level guidance.

The supported coding-agent SDK does not export its interactive
`KeybindingsManager` or an accessor for `keybindings.json`; those live in a
private InteractiveMode module. Pi-Vis therefore uses Pi's cross-platform
publicly documented/default save chord, literal Ctrl+S (including macOS), for
its React-owned pickers and does not pretend to honor a private configurable
binding. Native upstream InteractiveMode selectors continue to honor their
configured bindings. Picker admission is once-only, failure keeps the picker
open, and the renderer does not show an optimistic “saved” toast from an
admission receipt; terminal intent outcomes remain authoritative.

### Runtime, provider, tool, and persistence surfaces

- The optional PowerShell tool, definitions, operations, result guards, and
  event types are public and declaration-gated. Because the host intentionally
  omits an explicit built-in tool array, Pi's `defaultTools` owns Windows
  PowerShell enablement just as it owns the other built-ins; custom extension
  tools remain composed separately.
- `providerThinkingLevel`, `vllmPriority`, `supportsMaxOutputTokens`,
  `supportsMidConvoEffort`, and provider-neutral thinking-budget/tool-choice
  behavior remain upstream-owned metadata. Live and persisted assistant
  schemas are passthrough and focused fixtures prove provider thinking,
  `endTurn`, and tool namespaces survive the host boundary.
- `SessionManager.inMemory(..., entries)`, assistant message frames,
  `session_compact_failed`, `ui_prompt_start`/`ui_prompt_end`, structured RPC
  `clear_queue` command/response shapes, public
  `detectSupportedImageMimeTypeFromFile()`, the complete PowerShell tool
  surface, and the three compaction-summary helpers' optional routing
  `sessionId` are declaration gated. Existing SDK-direct session creation
  remains file-backed, so Pi-Vis does not duplicate its authority or JSONL
  format with an in-memory store; its production transport likewise remains
  the SDK host rather than RPC.
- GPT-6 Astra is available through both OpenAI and OpenAI Codex because model
  catalogs/providers are inherited from exact pi-ai; the runtime gate resolves
  both built-ins. xAI Responses support, Claude effort persistence, catalog
  additions, proxy behavior, stream normalization, provider retry fixes, and
  model corrections are inherited without a parallel Pi-Vis provider table.
- Extension UI prompt events and compaction-failure events flow through Pi's
  public extension runner. Pi-Vis's existing blocking-dialog lifecycle remains
  the app authority boundary and does not synthesize duplicate events.

### Release-by-release feature disposition

This is the exhaustive disposition of the **New Features**, **Breaking
Changes**, and **Added** entries in the coding-agent changelogs for the four
audited releases. Provider/catalog items are inherited from exact pi-ai rather
than mirrored in Pi-Vis.

| Release | Integrated or contract-gated | Inherited from the exact runtime | Intentionally not a Pi-Vis surface |
|---|---|---|---|
| 0.84.3 | PowerShell/default-tools; session-only model and thinking mutation plus explicit persistence; `/thinking`; `session_compact_failed`; exported compaction-summary routing IDs | provider-neutral `toolChoice`; configurable OpenAI-compatible thinking budgets; Anthropic refusal fallback; ZAI and DeepSeek catalog additions | installer-managed Pi self-update; InteractiveMode compaction/branch usage notices |
| 0.84.4 | terminal capability overrides; UI prompt events; `supportsMidConvoEffort`; public image-MIME detection; RPC `clear_queue` declaration compatibility | DeepSeek V4 Flash Vision and Windows PowerShell/Bash lifecycle fixes | InteractiveMode cache/thinking notices, fullscreen copy-on-select/Ctrl+X, and native selector presentation beyond the equivalent current markers in Pi-Vis pickers |
| 0.85.0 | restored in-memory-session entry signature; `vllmPriority`, `supportsMaxOutputTokens`, assistant-frame utilities, and the changed publish/export closure | persistent Claude effort, model/provider corrections, catalog changes, and provider stream normalization | InteractiveMode fullscreen jump/search/indicator/drag-selection/LaTeX presentation; upstream RPC abort behavior because Pi-Vis has no RPC session transport |
| 0.85.1 | exact bundle-versus-modular CLI split; GPT-6 Astra resolution through both advertised providers; corrected model/thinking save semantics on Pi-Vis's public-API picker path | prompt-cache option correction and the upstream native pickers' configurable save binding | InteractiveMode Alt-wheel acceleration and hover-selection behavior |

### Exact event-union distinction

There are three intentionally different public contracts:

- lower-level agent-core `AgentEvent` no longer includes `auto_retry_end`;
- coding-agent `AgentSessionEvent`, which the SDK host actually subscribes to,
  still explicitly includes and emits `auto_retry_end`; and
- JSON/RPC `JsonAgentSessionEvent` uses its own delta-plus-usage projection.

The host wire schema and transcript reducer therefore retain
`auto_retry_end`. Retry completion is also represented in coding-agent by
`agent_end.willRetry` and final `agent_settled`, but removing the higher-level
event would reject real 0.85.1 traffic. The declaration gate tests both sides
of this distinction. Direct SDK cumulative assistant checkpoints are still
materialized only at attach barriers; renderer streaming remains linear.

## Inherited fixes and retired local patch

Pi 0.84.4 contains upstream fixes for all three defects previously patched in
the 0.84.2 install:

- extension `triggerTurn: false` custom messages no longer split an assistant
  tool call from its provider-required tool results;
- `SessionManager` separates an unterminated valid or invalid JSONL tail before
  the next append; and
- indexed fragmented Mistral tool calls remain one call when continuation
  chunks omit the ID.

The repository patch file and generic install/prebuild patch step are removed;
0.85.1 is consumed pristine. The behavioral gates remain:
`tests/pinned-pi-upstream-fixes.test.mts` covers JSONL and Mistral, while the
real-SDK regression journey covers custom-message/tool-result adjacency.
These tests guard behavior rather than private file hashes and must remain on
future pin upgrades.

Other host-relevant upstream changes and fixes across 0.84.3–0.85.1 are
inherited from the exact runtime: post-tool compaction, summary output room and
tool-choice isolation; fork boundaries and imported/in-memory collision
handling; extension-factory rollback, skill discovery/Bash-only availability,
resource-glob expansion, lazy extension loading, BOM handling, and
configuration-file permissions; `models.json` `supportsFinishReason` schema
parity; scoped-default-model saves; edit input and
write-result corrections; EXIF orientation, terminal capability detection,
restricted-seccomp startup, and Windows shell abort handling; OpenAI Codex
terminal SSE parsing, GitHub Copilot thinking, NO_PROXY matching, tool `cwd`,
proxy transport, model-catalog corrections, provider request/response and
reasoning normalization, managed tool downloads, and prompt-cache options.
Pi-Vis does not fork those implementation tables. Upstream session sharing,
single-executable archive composition, and interactive-only warning or
autocomplete presentation do not run on the SDK-host/React surface.

## Deliberately inapplicable interactive features

Pi-Vis does not instantiate upstream `InteractiveMode` or `TuiAltScreen`; it
owns the React transcript and embeds only content-hugging public
`TuiMainScreen` extension surfaces. Consequently, upstream fullscreen jump to
latest, Alt-wheel acceleration, copy-on-select/Ctrl+X, hover selection,
scrollbars, transcript search acceleration, working-indicator placement,
drag-selection, and LaTeX presentation changes do not apply to the app
transcript. They are not reimplemented merely to claim parity. Equivalent
Pi-Vis behavior remains governed by its own UI contracts and tests.

The SDK host also does not adopt the source-only experimental client/plugin
harness, managed self-update server commands, or a second JSON/RPC session
transport. The app retains one SDK-host authority, coding-agent JSONL
persistence, and the app-owned release updater.

## Exact private llama.cpp exception

Upstream 0.85.1 still ships llama.cpp as the sole hidden entry in
`dist/extensions/index.js`, absent from the public root export. The audited
registry shape remains exactly `{ name: "llama.cpp", factory, hidden: true }`.
[ADR 0006](../decisions/0006-pinned-llama-private-extension-exception.md)
therefore renews the isolated adapter for exact version `0.85.1` only. It
derives the shipped registry from the already validated modular CLI anchor,
copies only the public inline-extension fields, freezes the result, and returns
immediately to public `resourceLoaderOptions.extensionFactories` and session
APIs. A shape or version failure disables only local llama management and
publishes a fixed capability diagnostic. No other private Pi import is
authorized.

## Continuing SDK-host contracts

Pi's `defaultTools` still owns initial built-in selection because the host does
not pass an explicit built-in list. Direct Shell Turns emit public `user_bash`
once: handler-supplied results avoid a spawn, replacement `BashOperations` use
public non-PTY execution, and only an unhandled event uses the host PTY. `!`
keeps the canonical Bash message in context and `!!` excludes the complete
message. Project-local resources remain trust-denied by default.

The services runtime, owner/epoch authority frames, typed host protocol,
session JSONL, model/auth catalog ownership, Markdown transformers, custom TUI
panels, and private-llama isolation remain unchanged except where called out
above. Pi-Vis does not use a user-installed binary or a fallback session
transport.

## Release gates

- `npm ci` must recreate the pristine exact lock graph and run only the
  separately audited node-pty postinstall patch.
- `tests/pinned-pi-runtime.test.mts` gates the complete source closure,
  declarations, renamed/added APIs, event-union distinction, model catalog,
  prepare-next-turn timing, and bundled CLI auth forms.
- `resources/pi-session-host/ui-context.test.mjs`, bridge/state-authority,
  protocol/session-file fixtures, command/parser/picker tests, and
  `tests/pinned-pi-upstream-fixes.test.mts` cover the host integration.
- `npm run test:full` and `npm run dist` remain mandatory. The packaged
  verifier requires both CLI paths, executes the bundled CLI for exact version
  output, checks the exact six-package Pi closure and absence of client/protocol,
  validates the exact private llama entry and executable node-pty, and runs a
  real packaged Electron journey.
- Publication additionally requires the manual provider-backed Kitty/input and
  GUI/IME/dead-key gates in `RELEASING.md`, plus signing, Gatekeeper,
  notarization, and stapling where applicable.

## References

- [Upstream coding-agent 0.84.3 changelog](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.84.4 changelog](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.85.0 changelog](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/CHANGELOG.md)
- [Upstream coding-agent 0.85.1 changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/CHANGELOG.md)
- [Pinned llama.cpp private-extension exception](../decisions/0006-pinned-llama-private-extension-exception.md)
- [Runtime services](../architecture/runtime-services.md)
- [Testing](../testing.md)
