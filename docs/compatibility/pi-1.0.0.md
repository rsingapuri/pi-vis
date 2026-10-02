# Pi 1.0.0 compatibility audit

This is the current runtime compatibility contract for Pi-Vis. It records the
audit from the previously shipped 0.99.2 pin to exact
`@earendil-works/pi-coding-agent@1.0.0`; the
[0.99.2 audit](pi-0.99.2.md) remains historical evidence and is not the current
implementation target.

Pi-Vis consumes the package as an SDK host. It does not embed upstream
`InteractiveMode`, adopt the standalone CLI's screen lifecycle, or expose Pi
self-update. The application pin, public API checks, one narrow private
exception, security closure, real-runtime behavior gates, and packaged-artifact
checks move together.

## Audited package and public surface

- The coding-agent package and its Pi family dependencies (`chord`,
  `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`, `pi-telemetry`, and
  `pi-tui`) are exact 1.0.0 at runtime. The coding-agent manifest continues to
  declare Node `>=22.19.0`, the modular SDK anchor remains `dist/cli.js`, and
  the published executable remains `dist/bundle/cli.js`.
- The public `AgentSession`, `AgentSessionRuntime`, `ModelRuntime`,
  `ResourceLoader`, `SessionManager`, extension, and Pi-TUI surfaces used by the
  host remain compatible. Pi-Vis still derives the public root entry from the
  validated modular anchor rather than importing a path supplied by the user.
- The public 1.0 additions used by Pi-Vis are codemode image generation through
  `ModelRegistry.generateImages()`, the MCP `oauth.authServerMetadataUrl`
  setting, and the Radius MCP URL/provider-auth contract. `QuietStartup` is
  exported but belongs to upstream CLI presentation, not the SDK-host UI.
- Provider IDs, authentication capabilities, and environment-variable
  precedence remain runtime-derived and declaration-gated. They are not copied
  into a second model catalog.

### Removed agent-core harness surfaces

Pi 1.0 reduces `@earendil-works/pi-agent-core` to its agent-loop/runtime core.
Its package exports only `.` and `./package.json`; the audited runtime root is
`Agent`, `agentLoop`, `agentLoopContinue`, `runAgentLoop`,
`runAgentLoopContinue`, `runToolCall`, `setDefaultStreamFn`, and `streamProxy`.
The former root exports `AgentHarness`, `DurableRuntime`, `PromptTemplate`,
`SearchService`, `SessionStorage`, `uuidv7`, and the pi-telemetry reexports are
gone. So are the durable/session-storage and sessions/runtime families, pico3,
and the harness tools, compaction, skills/templates, system-prompt, search, and
telemetry schemas.

The package no longer publishes these subpaths:

- `./node`
- `./harness/context`
- `./experimental/pico3`
- `./harness/env/nodejs`
- `./harness/runtime/reducer`
- `./harness/session`
- `./harness/session/testing`

Upstream moved those responsibilities to `@earendil-works/pi-durable`.
Pi-Vis used none of the removed surfaces and must not add `pi-durable` merely to
restore them. Session durability, authority, search, and replay remain the
app-owned contracts documented under `docs/architecture/`.

## Pi 1.0 feature disposition

| Pi 1.0 change | Pi-Vis disposition |
|---|---|
| Leaner codemode and improved script diagnostics | Inherited from the exact public codemode factory. Pi-Vis does not copy the prompt or error formatter. |
| Codemode member probing | Inherited breaking behavior: scripts must use `"name" in tools`; `typeof tools.name` now triggers the actionable unknown-member path. No Pi-Vis script depends on the retired probe. |
| `models.generateImages()` and `ctx.modelRegistry.generateImages()` | Inherited through the public model registry. Generated base64 image blocks, nested-call records, and usage follow the existing typed tool-result, authority, persistence, replay, and transcript-image paths. A script must call `image(block)` to attach generated output. |
| Radius at top-level `/login` plus one-step MCP setup | Pi-Vis's dynamic provider picker exposes Radius as the final top-level choice. It does not instantiate upstream `InteractiveMode`, so the post-login MCP offer is implemented explicitly as described below. |
| Anthropic copy-code login | Supported by the app-owned `auth_url` plus `manual_code` interaction. The preceding URL and instructions remain available while the code/redirect prompt is active, which is required for a browser running on another machine. |
| OAuth account/subscription labels | The host derives `isSubscription` from the public provider definition and the login/logout pickers say **Subscription** only for subscription-backed OAuth; other OAuth methods say **Account**. API-key labeling is unchanged. |
| MCP OAuth hardening | Inherited from the public MCP factory: configured authorization-server metadata, RFC 9207 issuer checking, credentials keyed by server name and URL, legacy URL-only migration, empty optional-field handling, and scope-preserving step-up stay upstream-owned. Secrets never cross Pi-Vis IPC. |
| Deferred MCP tool restoration | Pi persists tool declarations and owns ResourceLoader reconnects. Because the public SDK session factory supplies an initial default loadout and therefore bypasses Pi's constructor-time transcript restore, Pi-Vis adds one hidden public extension for non-reload startup/resume: it derives the current names from `SessionManager.buildSessionContext()`, calls public `setActiveTools()` for definitions already present, and gives pending names one reconnect opportunity at `before_agent_start` before abandoning any still unavailable. Pi's native path owns `/reload`; the bridge stores no second durable loadout. |
| Fullscreen TUI by default | Intentionally inapplicable. Pi-Vis embeds public `TuiMainScreen` in content-hugging custom/unified panels; upstream `InteractiveMode` and its alternate-screen default are not constructed. |
| `quietStartup: "header"` | Intentionally inapplicable. Pi-Vis owns application startup chrome and does not render the standalone CLI startup banner. The setting may remain in Pi settings without changing the app shell. |
| “not configured” login/logout wording | App-owned equivalent. Pi-Vis shows **Connected** only for configured rows; an unbadged row is the unconfigured state. It does not copy upstream `InteractiveMode` text. |
| Wrapped MCP sign-in links and OAuth page logo | Inherited where Pi owns the MCP/browser flow. Pi-Vis's own auth dialog already renders the URL as a clickable browser action rather than terminal text. |
| `--provider` without `--model` now fails | Intentionally inapplicable to session selection: Pi-Vis uses public model objects and never launches an agent session through those CLI flags. The bundled CLI itself remains exact-version tested. |
| System-theme chroma fix | Inherited by embedded Pi-TUI surfaces. React chrome remains on semantic Pi-Vis theme tokens and does not copy upstream palette swatches. |
| Leading-whitespace slash autocomplete | Intentionally inapplicable. Pi-Vis's app-owned parser requires `/` at position zero; leading whitespace deliberately makes an ordinary prompt, as documented in the command contract. |
| Fullscreen highlight/color and upstream transcript-memory fixes | Intentionally inapplicable to the React transcript and non-fullscreen embedded panels; public Pi-TUI rendering fixes are inherited wherever those components are used. |

## Radius MCP integration boundary

Successful Radius OAuth authentication is distinct from optional MCP
configuration. A committed credential remains a successful login even if the
configuration step is declined or fails.

1. After a successful Radius OAuth login, the host inspects only the global
   `<agentDir>/mcp.json`. It never writes project-local MCP configuration and
   therefore does not weaken project-trust deny-by-default behavior.
2. If an equivalent Radius server using provider auth is absent, the active
   login interaction asks for explicit consent and names the destination path.
   Cancel is treated as a decline, not as a failed or rolled-back login.
3. On consent, the host takes a dedicated lock, rereads the file, preserves
   unrelated top-level fields and non-target servers, configures the public
   Radius MCP URL with `{ "auth": { "provider": "radius" } }`, and removes
   conflicting OAuth configuration from that server. It prefers `radius`, then
   `radius-mcp`, then
   the first free deterministic `radius-mcp-N` name, so colliding entries are
   never overwritten.
4. The write uses an exclusive same-directory temporary file, `fsync`, atomic
   rename, and the existing file mode (or `0600` for a new file). Malformed
   configuration fails closed and is never replaced.
5. The bounded login intent reports only `unchanged`, `declined`, `configured`,
   or `failed`. Apart from the consent prompt's destination path, filesystem
   errors and credential/provider detail remain in the SDK host.
6. Only a `configured` result requests the ordinary owner-fenced `/reload` from
   the same renderer/runtime identity. A stale owner cannot reload a successor;
   refusal leaves the configuration ready for the next user reload.

This is deliberately small app-owned orchestration around Pi's public global
MCP/provider-auth format. Resource discovery, connection, OAuth, tool exposure,
and disposal remain upstream-owned. The separate hidden transcript-restoration
extension bridges the SDK factory gap described above using only public session
context and extension APIs; neither path creates app-owned MCP credentials or a
second persisted loadout.

## Private llama.cpp exception

Pi 1.0.0 still ships exactly four aggregate built-ins in
`dist/extensions/index.js`: llama.cpp, codemode, tool-search, and MCP. The latter
three remain replaceable and have public root factories. llama.cpp remains
non-replaceable in that registry and has no public factory.

[ADR 0006](../decisions/0006-pinned-llama-private-extension-exception.md)
therefore renews the single exception for exact 1.0.0. The isolated adapter may
derive the aggregate registry from the validated public entry, select only the
single `llama.cpp` match, validate that entry's `{ name, factory, builtin }`
shape, and return those public inline-extension fields. It deliberately ignores
other registry entries so a future private built-in is never injected. The
separate `tests/pinned-pi-runtime.test.mts` audit pins today's exact four-entry
registry. The adapter may not import a
llama implementation submodule or any other private Pi surface. All injection,
commands, provider registration, auth, model selection, and Pi-TUI behavior
after that lookup use public APIs. A future pin must repeat the audit and remove
the exception if Pi publishes an equivalent factory.

## Security and packaging closure

The published 1.0.0 tarball is consumed without a local runtime patch. Its
embedded shrinkwrap still records vulnerable `brace-expansion@5.0.9` beneath
`minimatch@10.2.6`, even though minimatch accepts a safe compatible version.
The authoritative application lock therefore deliberately omits Pi's
`hasShrinkwrap` marker and resolves every actual Pi-to-minimatch brace path to
`brace-expansion@5.0.12`.

`scripts/verify-pi-security-closure.mjs` fails closed on the exact 1.0.0 tarball
URL or integrity changing, shrinkwrap reinflation, a changed embedded vulnerable
baseline, unsafe root-lock metadata, stale installed bytes, or a runtime
resolution other than 5.0.12. Root postinstall and worktree preflight run that
gate. `scripts/verify-packaged-pty.mjs` repeats the real resolution after
electron-builder re-hoisting and verifies the exact package family, public SDK
and CLI entry points, private adapter, codemode worker/WASM, and native PTY from
`app.asar.unpacked`.

Electron's patched `fs` and builder hoisting remain material: package resolution
must remap an `app.asar` hit to `app.asar.unpacked`, search ancestor
`node_modules` layouts, and unpack all production modules. A repository-tree
pass cannot waive final-artifact verification.

## Regression and release gates

The major-version pin does not retire behavioral guarantees introduced in
earlier Pi releases. These remain release-blocking against the pristine 1.0.0
runtime:

- repair of an unterminated final JSONL row;
- continuation of fragmented, indexed Mistral tool calls; and
- custom-message/tool-result adjacency for a `triggerTurn: false` message on
  the next provider request.

Current repository gates pin the exact dependency family and removed agent-core
surfaces, public declarations/additions, the four-entry private registry, the
adapter's exact-version llama selection/shape, the real llama manager, the
historical runtime regressions, the security closure, and the exact CLI
version. Focused Pi 1.0 tests also cover installed provider subscription
metadata, a mocked public `ModelRegistry.generateImages()` pass-through,
codemode output/error helpers, a real codemode tool request through the session
model registry with ordered text/image output and cost accounting, MCP OAuth
declarations plus loopback behavior for configured authorization-server
metadata, issuer rejection, credential isolation and migration, empty optional
fields, and scope-preserving step-up, restoration of a
tool-search-loaded deferred MCP tool after resume and native reload, plus the
bridge's first-prompt abandonment and restored-tool-removal boundaries,
Radius's ordinary consent/write paths including deterministic collision
resolution and a distinct edit made while waiting for the configuration lock,
and the app-owned Anthropic prompt sequence.

The account/subscription path has installed provider-metadata coverage, bridge
unit coverage for literal `true` versus omitted metadata, and rendered
**Account** and **Subscription** assertions. The OAuth loopback suite invokes
the published Pi CLI and public `pi-mcp/oauth` surfaces rather than inspecting
declarations alone. Release acceptance remains `npm ci`, the full verification
suite, and `npm run dist`; focused declaration tests are not a substitute for
real SDK-host and packaged-app journeys.

## Historical chronology

The complete 0.84.4–0.99.2 migration chronology, including removed RPC/client
surfaces, session runtime extraction, tool schema changes, model-runtime
composition, and the original upstream-fix provenance, remains in the
[Pi 0.99.2 compatibility audit](pi-0.99.2.md). This document supersedes its
current-version conclusions without rewriting that history.

## References

- [Pi 1.0.0 coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md)
- [Pinned llama.cpp private-extension exception](../decisions/0006-pinned-llama-private-extension-exception.md)
- [Runtime services](../architecture/runtime-services.md)
- [Processes and IPC](../architecture/processes-and-ipc.md)
- [Testing](../testing.md)
- [Release process](../../RELEASING.md)
