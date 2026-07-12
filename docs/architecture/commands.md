# Command system

The composer parses `!text` as bash, `/command [args]` as a slash command, and other input as a user submission. Slash matching is character-exact at the first position; leading-whitespace text such as `  /tmp/file` remains an ordinary prompt. Built-ins and discovered extension/prompt/skill commands are resolved by the SDK host. `execute.ts` routes non-text commands through `session.sendCommand`; text and images use the sole submission path, `session.submit`. Diff comments and file/image attachments are staged prompt context: every slash command receives only its command text, clears only that text after acknowledged execution, and leaves the staged context for a later ordinary prompt. This also applies to extension/template/skill and unknown slash commands that travel through `session.submit`; the host defensively strips slash-command images and preserves authoritative editor attachments.

## Submission contract

Before submitting, the renderer uses the current authoritative runtime snapshot and includes its host identity, session epoch, and editor revision. It also sends an intent id, requested queue mode (`steer` or `followUp`), surface (`composer` or `unified`), text, and images. The host—not the composer—decides admission and returns a disposition.

The UI must not synthesize streaming, queue delivery, or prompt counters. `consumed` means pi admitted the request; `in_custody` means it is retained behind a compaction/navigation barrier; stale/rejected/unknown outcomes preserve recoverable editor content. Direct snapshot queues replace visible pending messages. Queue restoration after ESC is review-required and acknowledged, including attachment custody.

The unified editor uses the same contract. Its host→renderer submit request and renderer→host response both carry the originating host/epoch identity. Main assigns the request one stable submission intent and requires the renderer generation to claim the whole unified action before execution. The claim has an unguessable ID and bounded deadline. Unclaimed requests may replay after reattachment; claimed requests never rerun and become non-replayable review if acknowledgement is lost or the deadline expires. Prompt admission also reuses the same in-flight/result promise, and expired stable intents are tombstoned until explicit review acknowledgement, so replay or a late continuation cannot dispatch text twice. Its shared submit pipeline acknowledges only that runtime; a stale continuation becomes review-required restoration rather than reaching a successor. An unsuccessful guard response restores host editor text. Editor patches are revisioned, so a stale renderer cannot overwrite the host's canonical draft.

`/reload` has its own request and intent ids plus explicit `not_executed`, `completed`, or `outcome_unknown` settlement. A completed response names the acknowledged successor identity; Composer resynchronizes exactly that successor before clearing. It is refused while the authoritative snapshot is non-idle. `/tree` navigation uses the host's public in-memory tree API and is likewise protected from mid-turn mutation. `/share` carries the Composer/unified runtime identity and an export intent through its main-owned `gh` flow, so its `export_html` command cannot rebind after delayed auth work.

## Command admission and settlement

Every renderer-originated non-text command carries a request id and the complete runtime identity that produced it. Effectful and replacement commands also carry an intent id. `SessionRegistry` is the sole admission authority and returns one of three correlated settlements:

- `not_executed` — the command did not cross child IPC (unavailable/transitioning/closing runtime, stale identity, or dispatch failure);
- `completed` — the active SDK host returned a terminal response, including a domain failure such as `Nothing to compact`;
- `outcome_unknown` — an effectful command crossed child IPC but its acknowledgement was lost.

A recognized command may clear after a matching `completed` domain failure because Pi consumed the command, but tests must not call that operation successful. `not_executed` and `outcome_unknown` preserve Composer/unified editor custody. An unknown effect is never replayed automatically: main retains its intent and publishes an interrupted-command review marker, retired only by explicit acknowledgement.

`PI_COMMAND_POLICY` in `src/shared/pi-protocol/commands.ts` exhaustively classifies every `PiRpcCommand` as read-only, idempotent explicit-state, effectful, or replacement. Text command discriminants remain submission-only. Main-owned read probes use a separate read-only API and are identity-bound; renderer command requests are never queued across activation or replacement. The host rejects ordinary command ingress once transition starts and refuses replacement while another command or submission remains active. Main rechecks the expected epoch after every non-replacement response; a response crossing an epoch boundary cannot settle as predecessor `completed` and effectful work becomes review-required unknown.

See `command-matrix.md` for the complete command and test matrix.
