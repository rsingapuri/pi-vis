# 0006: Pinned llama.cpp private-extension exception

## Status

Accepted

## Context

Pi 0.99.2 implements local llama.cpp router discovery, load/unload, download,
connection recovery, provider registration, and its interactive manager as a
CLI built-in extension. The package ships that extension, but its public
SDK entry does not export either the built-in registry or the llama factory.
Consequently, an SDK-only host cannot provide the feature through public imports
alone even though Pi's public resource loader supports inline extension
factories and Pi-Vis already supports Pi-TUI custom panels.

The 0.99.2 audit found four aggregate built-ins: llama.cpp, codemode,
tool-search, and MCP. All carry `builtin: true`; the latter three are
replaceable and have public root factories, while llama.cpp remains absent from
every public coding-agent export. The exception therefore renews only for the
llama entry without expanding its path or runtime authority.

Omitting the manager creates a material feature difference from the pinned Pi
CLI. Copying the implementation would create a larger fork and make Pi-Vis
responsible for router and provider behavior.

## Decision

Pi-Vis permits one private Pi dependency:
`resources/pi-session-host/pinned-pi-private.mjs` may derive
`dist/extensions/index.js` from the already validated modular Pi entry, select
exactly one built-in named `llama.cpp`, validate its shape, and copy only the
public `InlineExtension` fields `{ name, factory, builtin }`.

The exception has these boundaries:

- It is approved only for exact Pi version 0.99.2.
- It imports the aggregate built-in registry, never a llama implementation
  submodule, and never privately injects any other built-in. Codemode,
  tool-search, and MCP are created from their public root factories.
- The resulting factory is injected through public
  `resourceLoaderOptions.extensionFactories`; all subsequent service, provider,
  command, auth, and UI interaction uses Pi's public extension/runtime surface.
- A runtime shape/import failure leaves ordinary sessions usable and publishes
  a fixed capability diagnostic. Detailed paths and import errors remain in
  host logs.
- Unit and import-discipline tests are release-blocking for the version,
  registry path, exact four-entry registry, builtin flag, and factory shape. A
  real pinned-Pi E2E uses a loopback llama router to exercise command
  registration, catalog sync, the custom Pi-TUI panel, Escape, and
  native-provider model selection.
- Any Pi pin change requires re-auditing this decision and deliberately updating
  the exact version gate and tests. The exception must be removed if Pi exposes
  an equivalent public factory or built-in-extension option.

## Consequences

Pi-Vis has feature parity with Pi 0.99.2's local llama.cpp manager without
forking its implementation. The cost is a deliberately accepted package-layout
dependency: a repackaged or changed private registry can disable the feature
until Pi-Vis is updated. Structural tests catch that in development, and the
loopback E2E catches failures that preserve the file shape but break
registration, provider composition, or Pi-TUI bridging.

This decision does not weaken the general public-SDK boundary. Every other
private Pi import remains prohibited.

## References

- [Pi 0.99.2 compatibility audit](../compatibility/pi-0.99.2.md)
- [Runtime services](../architecture/runtime-services.md)
- [Processes and IPC](../architecture/processes-and-ipc.md)
- [Testing](../testing.md)
