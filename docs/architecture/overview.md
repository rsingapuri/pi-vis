# Project overview

## Runtime architecture

Pi-Vis is an Electron GUI for pi. A live session has one execution authority: the SDK-direct `AgentSession` hosted by `resources/pi-session-host/host.mjs`. Main forks one host per active session; the host imports the public SDK of the pi runtime bundled with the app (an exact pinned version — see `src/main/pi/pinned-pi.ts`) and owns the live `AgentSession`, extension runtime, command admission, and direct state reads. There is **no RPC session fallback**.

The renderer talks only to main through the typed `window.pivis` contract. Main forwards host records, validates host identity/epoch/transport sequence, and never reconstructs session liveness from transcript events. Session files remain the persisted history source; they are not live-state authority.

## State authority

The host's state-authority layer publishes direct public `AgentSession` snapshots. A snapshot carries host instance identity, session epoch, monotonic snapshot sequence, availability lease data, direct streaming/idle/compaction/retry/bash values, model/session metadata, queue arrays, extension catalog, and editor revision/text. Main accepts only current identity and increasing sequence values; an expired lease, bad identity, or transport gap makes the runtime unavailable until a full resync succeeds.

Submissions use `session.submit`, not `session.sendCommand`. Each request includes the expected host/epoch and editor revision. The host returns an explicit disposition (`not_submitted`, `in_custody`, `consumed`, `rejected`, `completed`, `extension_error`, or `outcome_unknown`). Work blocked by compaction or navigation is held in FIFO custody and drains before later ingress. Once submitted input visibly clears, that editor presentation is irreversible: later queue settlement may report dropped or uncertain custody, but it can never reinsert the submitted text, attachments, or comments into Composer.

Runtime replacement (`new`, fork, switch, clone, reload) uses one prepare/permit/commit handshake. The child first freezes semantic ingress and asks main to validate the target and reserve its advisory lock; after a permit it performs the SDK transition, obtains a second successor permit when the target file is discovered late, and emits one terminal batch. Main installs that batch only while the successor lock is held, then releases the predecessor lock. Contention is a hard activation failure; denied/lost permits roll back while retaining the old lock. Renderer attach generations, UI-operation acknowledgements, panel input sequences, and editor patch revisions prevent stale UI work from being applied after a replacement.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Electron app with HMR |
| `npm run dev:renderer` | Renderer-only preview |
| `npm run build` | Typecheck + electron-vite build |
| `npm run dist` | Build + Electron packaging |
| `npm test` | Unit tests |
| `npm run test:e2e` | Electron E2E tests |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | Biome check |
| `npm run test:full` | Full local verification |

## Code structure

- `resources/pi-session-host/` — SDK host, bridge, UI context, and state authority.
- `src/main/sessions/session-registry.ts` — host lifecycle, snapshot lease validation, unused activation-visit retirement, close checkpoint, and renderer/UI acknowledgement routing.
- `src/main/ipc.ts` / `src/shared/ipc-contract.ts` — typed renderer↔main API.
- `src/shared/pi-protocol/runtime-state.ts` — snapshot, disposition, transition, and runtime-state schemas.
- `src/renderer/src/stores/sessions-store.ts` — renderer projection of authoritative runtime state and UI state.
- `tests/fixtures/fake-pi.mjs` — version/update test executable only; it is not a session runtime.
