# Elastic Shell Turns

**Status:** Implemented P0 contract

**Feature area:** Composer, direct shell execution, transcript

**Runtime baseline:** Pi 0.99.2

**Scope:** P0 product behavior and the contracts required to implement it

This document supersedes the draft `tty-plan.md`. It records the implemented P0
contract, the critique that shaped it, and the decisions for every open product
question.

## 1. Outcome

A direct `!` or `!!` command is a user-authored **Shell Turn**, not a Pi tool
call. The editable prefix makes the interpretation visible before submission.
After submission, Pi 0.99.2 extensions may supply a complete result or non-PTY
`BashOperations`; otherwise a single PTY-backed surface appears at the Composer
boundary and accepts interactive input in a fixed user-resizable viewport. All
three paths settle into the chronological transcript with their output visible.

The three provenances must remain visually and semantically distinct:

- **You said:** an ordinary prompt.
- **You ran:** a direct Shell Turn.
- **Pi ran:** an agent tool invocation.

P0 does not add a permanent terminal, persistent shell mode, agent takeover,
managed background jobs, automatic reruns, or multiple Shell Turns in one
session at the same time.

## 2. Corrections and decisions carried forward

The original proposal had several ambiguities that would otherwise lead to
incompatible implementations:

- Prefix recognition is position-zero and character-exact. The ordinary-message
  counterexample is ` !ls` (leading space), not `!ls`.
- Pi 0.99.2 excludes the entire Bash execution message for `!!`: both command
  and output. `!` makes both eligible for the next model interaction.
- "Full output" is bounded and must never be promised. P0 has explicit
  presentation, persistence, and model-projection limits.
- One foreground execution means one Pi-Vis-owned Shell Turn **per session**.
  Different live sessions may each own one; P0 provides no detached-job UI.
- Session switching is allowed and does not transfer terminal ownership.
- The unhandled interactive path always uses a terminal emulator. There is no
  output-size threshold that swaps a running PTY command from DOM rendering to
  a terminal. Extension-supplied results and `BashOperations` remain non-PTY.
- The settled surface uses normalized text and the shared transcript
  virtualizer; raw VT bytes are never session history or model context.
- Admission is idle-only and never queued. A rejected draft stays editable and
  cannot execute later without a new explicit submission.
- Unmatched durable start metadata, rather than a transient spinner, is the
  source of truth for interrupted recovery.

### 2.1 Critique of the draft

The draft's strongest choices were its provenance model, text-derived and
reversible Composer interpretation, one foreground execution per session, a
single PTY for the unhandled interactive path, and refusal to invent a hidden
persistent shell mode. Those decisions remain while pinned Pi supports the two
extension-handled non-PTY outcomes.

The draft needed tighter contracts in five places:

- Its position-zero example contained a contradictory duplicate `!ls` row.
- It described `!!` as excluding output, while Pi 0.99.2 excludes the entire
  canonical Bash execution message.
- "Full retained output" had no defined owner or bound. P0 now distinguishes
  bounded live emulator state, bounded reattach keyframes, Pi's canonical
  persisted result, and Pi's optional complete-output path.
- "One foreground execution" did not define the authority boundary, stale
  editor behavior, or whether rejected work could queue. Admission is now
  transactional, revision-fenced, session-local, and never queued.
- Interactive input, renderer reattach, and process cancellation needed exact
  ownership and sequencing rules. They now use owner/epoch/execution fences,
  acknowledged emulator reconstruction, ordered input, and graceful-then-force
  termination.

## 3. Terms

**Shell draft:** Composer text whose first character is `!`.

**Shell Turn:** One admitted user command, its execution or extension-supplied
result, normalized output, status, and metadata.

**Included turn:** A `!command` whose canonical Pi Bash execution message,
including command and normalized result, is eligible for Pi context under Pi's
existing rules.

**Excluded turn:** A `!!command` whose entire canonical Pi Bash execution
message is skipped when Pi constructs model input. It remains human-visible and
persisted.

**Terminal presentation plane:** Ephemeral, owner-fenced VT data used only to
render and reattach the unhandled live PTY. It is not canonical transcript
state and is absent from extension-handled non-PTY turns.

**Normalized output:** Plain UTF-8 text supplied by Pi's full-result or
`BashOperations` path, or derived by a stateful terminal emulator for an
unhandled PTY. It is the only output eligible for settled transcript rendering,
durable display retention, or Pi context.

## 4. Composer contract

### 4.1 Character-exact interpretation

Interpretation is a pure function of the raw editor value:

| Raw editor value | Interpretation |
| --- | --- |
| `ls` | Ordinary prompt |
| ` !ls` | Ordinary prompt; prefix is not at position zero |
| `!` | Incomplete included Shell draft |
| `!!` | Incomplete excluded Shell draft |
| `!ls` | Included command `ls` |
| `!!ls` | Excluded command `ls` |
| `!!!foo` | Excluded command `!foo` |
| `!\nls` | Included multiline command `ls` |

Parsing checks `!!` before `!`. The execution string is the suffix after the
one- or two-character prefix, trimmed at both ends exactly once. Interior
newlines and whitespace are preserved. If the trimmed suffix is empty, Enter
does not submit a prompt or start a process; focus remains in the editor and
the Composer gives the same brief danger-ring refusal used for other
non-admitted input. No visible helper or validation sentence appears.

The prefix remains ordinary editable text. It is never replaced by a chip and
does not create a separate undo entry. Selection, cut, paste, undo, redo, IME
composition, cursor motion, and deletion retain normal editor behavior. Adding
any character before the prefix immediately restores ordinary-prompt
interpretation without moving focus.

Shift+Enter inserts a newline. Pasting, including multiline paste, only edits
the draft. Only a subsequent explicit Enter outside IME composition may submit.

P0 rejects a command larger than 64 KiB of UTF-8 after trimming. Rejection
preserves the complete draft and reports the limit.

### 4.2 Presentation and accessibility

Shell interpretation adds no label, helper sentence, status row, placeholder,
or shell-specific border. The editable `!` or `!!` replaces the attachment
button in the same fixed-width slot, uses the interface font and semantic accent
color, and is the entire visible mode indicator. The ordinary `+` remains
quiet, so shell interpretation is distinct without adding text or chrome. The
command suffix uses the configured code font without moving the ordinary
Composer insertion edge when the prefix appears or changes width. The raw
prefix remains in the native editor value; presentation must not create a
hidden shell-mode state. Because the raw prefix is visually replaced, its
UI-font rendering mirrors native caret and selection feedback whenever either
intersects those characters.

The one- versus two-character prefix conveys context classification directly.
There is no separate "Pi can use output", "Not in Pi context", or
"Context included/excluded" label. Any future toggle must perform an ordinary
editor replacement of `!` with `!!` or vice versa as one undoable edit; it must
never mutate hidden mode state or execute a command.

Screen readers announce each transition once:

- "Shell input. Context included."
- "Shell input. Context excluded."
- "Message input." when leaving Shell draft interpretation.

An attempted empty Shell submission announces "Shell command required." through
the same hidden live region while the only visible response remains the brief
danger ring.

Escape never rewrites a non-empty draft.

### 4.3 Attachments and other staged prompt data

A Shell Turn consumes only the command text. Staged attachments, selected
context, and prompt-only metadata are not sent to the process or to Pi, and
remain staged for the next ordinary prompt. Attachment tiles, the attachment
button, and file-drop staging are suppressed while the draft is a Shell draft;
the untouched staged values reappear immediately when ordinary Composer mode
returns. Admission must not silently discard or reinterpret them.

The command draft is cleared only after the session authority acknowledges
admission and durably records the Shell Turn start. A pre-admission rejection
leaves text, selection, undo history, and staged prompt data intact.

## 5. Admission and concurrency

The SDK-host session authority is the sole admission authority. It accepts a
Shell Turn only when all of these are true:

- The request targets the currently accepted editor revision for the same
  session owner and epoch.
- The session is available and following its current authority.
- No direct Shell Turn is running or cancelling in that session.
- No agent response, compaction, retry, navigation, slash-command operation,
  submission-custody operation, or lifecycle transition owns the session.
- The renderer is not proposing stale state and the host has the execution
  capability selected by Pi's public `user_bash` result.
- The normalized command is non-empty and within the command limit.

The rule is deliberately idle-only. It avoids inserting Bash history while a
provider turn is in flight and gives the chronological transcript one
deterministic writer.

| Situation | Required result |
| --- | --- |
| Eligible first submission | Admit once and return its stable execution ID |
| Duplicate intent ID | Return the existing admission/result; never spawn twice |
| Agent or session operation active | Reject with reason and preserve draft |
| Shell Turn active in this session | Reject with reason and preserve draft |
| Shell Turn active only in another session | Allow if this session is otherwise eligible |
| Stale owner, epoch, or editor revision | Reject silently at the authority boundary; never replay |
| Hook preparation cancelled, or selected execution path unavailable before acceptance | Reject and preserve draft; create no Shell Turn |
| Spawn fails after accepted start | Settle a visible failed Shell Turn; do not restore or rerun the draft |

There is no shell queue, pending replay, automatic retry, or "run when idle"
behavior. Shell-created descendants remain part of the foreground process
group, but Pi-Vis does not expose them as managed jobs. A shell syntax such as
`cmd &` does not create a detachable Pi-Vis terminal and must not outlive host
cleanup guarantees.

## 6. Running-terminal experience

### 6.1 One execution and one surface

Every unhandled `user_bash` Shell Turn starts in a PTY from its first byte.
Pi-Vis never starts that path with pipes and restarts to "upgrade"
interactivity. The process, PTY, and execution ID stay unchanged as the
presentation resizes. An extension-supplied full result or `BashOperations`
path is explicitly non-PTY and never advertises terminal input or resize.

Starting a PTY does not immediately open the live viewport. Presentation has a
200 ms grace period, keyed to the exact session/owner/epoch/execution. During
that grace period the existing Composer-sized slot remains visually stable and
inert, while the host still captures terminal output from byte one. If the
execution settles before the threshold, xterm never mounts and the settled
Shell Turn appears directly in the transcript. If it is still active at the
threshold, the viewport mounts from the retained reconstruction stream. An
already-running execution shown after a session switch or renderer recovery is
older than the threshold and appears immediately; it must not pay the delay
again. Settlement, owner replacement, or session change cancels a pending
reveal. The grace period delays presentation only—never spawn, output capture,
admission acknowledgement, or settlement.

The live surface uses the Custom-view sizing contract: it opens at 50% of the
available session height, can be dragged between 20% and 90%, and uses the same
dedicated resize gutter with double-click reset. The gutter is a keyboard
separator: arrow keys adjust it in five-percentage-point steps, and Home/End
select the 20%/90% bounds. A bootstrap grid may exist before renderer
measurement, but it must not appear as a smaller provisional card. Once shown,
the viewport keeps the selected height until the user resizes or resets it.
Normal-screen output and DEC alternate-screen modes `?47`, `?1047`, and `?1049`
scroll or repaint inside that viewport; terminal mode and content volume never
expand or contract the card.

Every actual column or row change resizes both emulator and PTY and delivers
`SIGWINCH` through normal PTY behavior. Viewport size changes respect reduced
motion.

The running terminal uses the same neutral, inset Composer-replacement card as
the Unified TUI: identical side/bottom spacing, surface, hairline, radius, and
terminal padding. It adds no full-width title, command, elapsed-time, context,
or keyboard-help bars. It exposes no visible Stop or Force-stop control.
Return-to-live, reconstruction, and bounded-replay warnings use compact
icon-only affordances with accessible names. Status or provenance must never be
represented by a colored left-edge rail.

### 6.2 Keyboard ownership and cancellation

When the terminal owns focus:

- Text and terminal key sequences go only to its PTY.
- `Ctrl+C` sends ETX/SIGINT; it does not invoke Pi-Vis cancellation.
- `Ctrl+D` sends EOT.
- Escape is routed to the process.
- On macOS, `Cmd+C` copies a terminal selection and never sends input.
- On other platforms, `Ctrl+Shift+C` copies a terminal selection.
- Bracketed-paste mode is honored when the process enables it.

The viewport has no separate cancellation button. Terminal input remains the
interaction: Ctrl+C sends the ordinary interrupt byte, and the foreground
program decides how to handle it. Session close, host disposal, timeout, and
application shutdown retain owner-fenced process-group cleanup and may force
termination when graceful cleanup cannot finish; those lifecycle guarantees are
not exposed as viewport chrome.

On completion, Composer focus is restored only if this session is still active,
the terminal held focus, and no newer overlay, editor, or navigation target
owns focus. Background completion never changes the active session or steals
focus.

### 6.3 Follow and copy behavior

Streaming follows the bottom until the user scrolls away. New live output while
unpinned does not move the xterm viewport; a return-to-live control restores
following. Completion necessarily replaces the emulator with normalized
transcript output, so P0 preserves the transcript's outer scroll anchor but does
not persist an emulator row offset into that different representation. Output
and final normalized text remain selectable. The settled header has one
icon-only copy action, and it copies the complete retained normalized output.
It gives immediate recessed pointer-down feedback before the asynchronous
clipboard success indication. There is no command-copy action and no copy
button overlaid on the output viewport. A rerun action, when later added,
recalls an editable draft and never executes immediately.

## 7. Session and lifecycle behavior

The Shell Turn belongs permanently to the session that admitted it.

Switching sessions is allowed. The owning SDK host and process continue, the
origin session displays a running-shell indicator, and the destination session
does not gain input authority. Returning obtains a fresh terminal keyframe
before creating xterm or enabling input, even when no output arrived while the
surface was absent. Completion while away updates only the origin session.

A renderer reload may reattach because it does not dispose the owning SDK host.
Runtime replacement and other in-session transitions that would retire that
host are refused while the Shell Turn is active. Explicitly closing the session
instead ends its foreground Shell Turn and disposes the host; it never silently
turns the process into a background job. On session close, forced application
exit, host crash, or process crash, the process group is cleaned up where
possible and an unmatched durable start later rehydrates as **interrupted**,
never **running**. P0 does not reattach a process across application restart.

Input, resize, lifecycle termination signals, terminal publication, and
completion all carry and validate session owner, epoch, and execution ID. Each
actual reconstruction fence also receives a host-issued monotonic token. Its
acknowledgement must match that exact token and output sequence, so a delayed
acknowledgement for an equal-sequence predecessor cannot release the current
fence. Input, resize, and signals remain disabled while any authority plane
needs a baseline and until the current reconstruction is acknowledged. A stale
renderer cannot address a replacement PTY.

## 8. Settled Shell Turn and context

### 8.1 Transcript presentation

A completed turn is a dedicated user-authored transcript item, not a tool card:

```text
! npm test    exit 0 · 7.2 s
PASS src/parser.test.ts
```

It records command, included/excluded classification, start timestamp,
duration, cwd at start, completion status, exit code or terminating signal,
normalization kind, and retention/truncation metadata. States are **running**,
**completed**, **failed**, **cancelled**, and **interrupted**. Spawn failure is
failed; a host-recorded cancellation is cancelled; an unmatched start after
recovery is interrupted.

The settled Shell Turn remains in chronological position and starts expanded.
It has one disclosure controlling its normalized output and retained details;
the command, status, and header copy action remain visible when collapsed.
Disclosure state is local renderer presentation state, not transcript or
authority state, and completion-status changes—including failure, non-zero
exit, cancellation, and interruption—never reopen a turn the user collapsed.

Short normalized output of zero through eight rows is rendered inline while
expanded. Nine or more rows use a bounded scrolling viewport; values over 1,000
rows or 256 KiB use the shared `VirtualizedOutput` path. These are presentation
choices, not different storage or execution modes. The entire normalized value
retained by Pi's canonical result is reachable by expanding the single
disclosure. No-output success remains a single compact row.

Shell Turns remain visible in Compact transcript mode because they are explicit
user actions. Agent-generated bash retains the existing Pi tool-card treatment.
Implementing this feature therefore requires corresponding updates to
`docs/ui-conventions.md` and `docs/architecture/state-and-sessions.md`.

### 8.2 Pi 0.99.2 context contract

Execution first emits Pi 0.99.2's public `user_bash` extension event exactly
once. A handler may return a complete result, which is recorded without a
spawn, or replacement `BashOperations`, which are passed to the public
`AgentSession.executeBash(command, onChunk, { excludeFromContext, id,
operations })` surface as a non-PTY Shell Turn. Only an `undefined` result is
unhandled and continues through that same surface with the Pi-Vis PTY adapter;
a thrown handler or invalid defined result aborts. This preserves Pi's
fail-closed hook contract, canonical Bash message, and context behavior:

The hook promise never occupies the serialized mutation scheduler. The host
starts it only after an initial authority check, then re-enters serialized
ingress to revalidate owner, exact editor source, and foreground-work fences
before it creates a start marker or execution. Escape/legacy abort can fence a
pending hook despite the event's lack of `AbortSignal`; stable admission
settles as `not_admitted/cancelled`, preserves the draft, and consumes any late
handler resolution or rejection without starting or recording work.

- `!command` records the original command and normalized result in a Pi Bash
  execution message. Pi may include both on the next model interaction.
- `!!command` sets `excludeFromContext`; Pi 0.99.2 skips the entire Bash
  execution message, including command and output.
- Classification is frozen at admission and persists. It cannot be toggled
  retroactively.

`!` makes the canonical Bash message eligible for Pi context; it does not
promise that normal context-window and compaction rules will retain it forever.
Context exclusion is not deletion: the human transcript and session persistence
still contain the command and normalized output.

Pi 0.99.2 tail-truncates its model-facing canonical result to at most 50 KiB or 2,000
logical lines and may expose a full-output path. The UI must describe model
projection as normalized and possibly truncated; it must not imply that Pi saw
the entire human-retained value. Pi 0.99's separate structured Bash/PowerShell
results for codemode may retain up to one MiB; that does not enlarge this
model-facing Shell Turn contract.

### 8.3 Terminal normalization

Raw VT output is decoded and applied to a stateful terminal emulator. The
normalized representation is:

1. Primary-screen logical scrollback and its final visible screen, with cursor
   movement, erase operations, carriage-return progress, backspace, wrapping,
   Unicode width, and combining characters resolved.
2. For each alternate-screen interval, exactly one final visible frame captured
   immediately before leaving alternate screen, or at process exit if it never
   leaves. Retained frames are interleaved at that point and prefixed with a
   plain-text marker such as `[alternate screen final frame 120x32]`. Their
   aggregate retention is bounded; if older intervals or one oversized frame
   cannot fit, normalization emits an explicit counted omission marker instead
   of retaining unbounded screen history.
3. UTF-8 text with terminal controls, OSC title/hyperlink/cwd data, NULs, and
   invalid binary runs removed or replaced; trailing cells and blank rows are
   trimmed while line boundaries are preserved.

Frame churn, cursor coordinates, keypress events, terminal titles, and
intermediate alternate-screen frames are not retained. An empty retained
alternate screen is represented by the marker plus `[empty]`. End metadata
distinguishes `terminal_buffer` from `alternate_screen_final`; retention
metadata says when earlier final frames were omitted.

Terminal input bytes are never part of normalization. Consequently, input
entered while echo is disabled is not persisted or sent to Pi. If a process
itself echoes or later prints a secret, it is output and cannot be reliably
detected; P0 makes no secret-filtering claim.

The PTY adapter gives raw bytes to the live terminal plane but supplies only
the completed normalized projection to Pi's `onData` callback before returning
the Bash result. Thus Pi remains the canonical Bash persistence/context path
without receiving VT control sequences or user input.

Pi's legacy `commandTransport: "stdin"` shell configuration uses one
pre-parsed compound bootstrap with a per-execution readiness marker. Bootstrap
source and terminal echo are removed before publication, and input remains
fenced until the marker is observed. No trailing shell statement may remain in
the byte stream for an interactive command's `read` to consume.

## 9. Runtime and protocol architecture

### 9.1 Ownership

The PTY lives in the owning SDK-host process alongside `AgentSession`. The
existing main-process `src/main/pty.ts` launches the SDK host itself and is not
a reusable per-command terminal authority.

Only Pi's public 0.99.2 surface may be used after the already-approved pinned
private-registry lookup. The Shell Turn feature does not add another private Pi
import. The packaged application keeps the SDK host and native PTY dependency
unpacked, matching the existing host subprocess layout. Until the PTY dependency
is migrated, its exact pinned package receives the repository-owned
component-aware helper-path patch documented in
`docs/architecture/runtime-services.md`; the final app must pass both packaged
host- and main-resolution PTY smokes.

For an unhandled `user_bash` event, the custom PTY operation closes over a
host-owned terminal manager. It receives Pi's prefix-resolved command and
session cwd, spawns one process group, routes raw bytes to a headless emulator
and presentation subscribers, emits the final normalized value to Pi, and
returns exit status through `BashOperations`. Extension-provided results or
operations retain the same semantic transcript lifecycle but do not advertise
interactive PTY input. A running operations turn retains a bounded normalized-
output attach baseline with a dedicated update-sequence watermark; covered
replay is ignored after renderer recovery, later updates append once, and an
explicit omission notice remains until final canonical output replaces the
baseline.

### 9.2 Typed semantic and terminal contracts

All additions are typed in `src/shared/pi-protocol/` and, for main/renderer
transport, `src/shared/ipc-contract.ts`.

The semantic plane is canonical while a turn is live and includes:

- `executionId`, admission `intentId`, command, classification, and
  `cwdAtStart`;
- running/cancelling state and start time;
- explicit PTY classification, plus terminal mode and input readiness only for
  an interactive PTY path.

Completion metadata—duration, exit code or signal, normalization
kind, and Pi truncation metadata—travels on the typed transcript event and is
persisted in the canonical Bash record plus the Shell Turn completion marker.

The terminal presentation plane generalizes the existing fenced panel
transport instead of adding an unfenced generic `pty.data` channel. Every
publication/input/resize/keyframe message includes session owner, epoch,
execution ID, revision, fence token, and sequence as applicable. Reattachment
uses a host-side headless-emulator keyframe and exact-token acknowledgement
before input, matching existing panel reconstruction rules.

Raw terminal chunks, input bytes, and emulator buffers are presentation data.
They must not enter the semantic authority snapshot, authority journal,
application logs, diagnostics, analytics, crash breadcrumbs, or persisted
application state. Only normalized output and metadata cross into canonical
history.

### 9.3 Persistence and crash recovery

The host writes an append-only Shell Turn start marker before reporting
admission and before spawning. It contains a schema version, host-generated
execution ID, command, classification, cwd, and start time.

On normal completion:

1. Public `AgentSession.executeBash` writes the canonical Pi Bash execution
   message.
2. The host appends a Shell Turn end marker with completion and retention
   metadata.
3. History loading coalesces start marker, canonical Bash message, and end
   marker into one Shell Turn without duplicating the Bash entry.

If spawn fails after the start marker, the bridge records a sanitized failure
through public `recordBashResult` and appends a failed end marker. If the host
dies first, the unmatched start rehydrates as interrupted. Custom markers are
never converted to model messages; the canonical Pi Bash entry is the sole
model-context and durable output record. Pi may report `truncated` and a
`fullOutputPath`; the UI preserves both without claiming that every byte is
retained in the session JSONL.

## 10. Environment, cwd, and trust

The execution environment is frozen at admission:

- cwd is `sessionManager.getCwd()` for the owning session/worktree;
- Pi's current configured shell path and command prefix apply;
- the host's normal login-shell environment and configured `settings.piEnv`
  apply;
- `TERM=xterm-256color`, `COLORTERM=truecolor`, and measured dimensions are set
  for terminal capability.

The settled turn records only `cwdAtStart`, never environment values. `cd`
inside a Shell Turn affects that process and its descendants only; it does not
mutate the Pi session cwd or the next Shell Turn. OSC 7 and title sequences may
affect the live terminal locally but never session chrome or authority state.

Direct Shell Turns have the same explicit user execution authority as today's
direct Bash command. The UI must not imply that commands are sandboxed, offline,
safe, trusted, or prevented from reading project or machine data. Project trust
and model-context exclusion are independent controls. `!!` is neither secret
nor private because its human transcript is persisted.

## 11. Limits and degradation

Limits are measured after UTF-8 decoding and normalization unless stated
otherwise:

| Resource | P0 limit | Behavior at limit |
| --- | --- | --- |
| Command | 64 KiB UTF-8 | Reject before admission; preserve draft |
| Terminal input IPC record | 64 KiB | Reject oversized record; never split/replay it as a later intent |
| Terminal dimensions | 20–500 columns, 2–200 rows | Clamp host-side before PTY resize |
| Live emulator scrollback | 10,000 rows | Drop oldest live-only rows |
| Reattach keyframe/raw fallback | 1 MiB | Serialize the newest emulator state/scrollback that fits and show an omission notice when older live rows are absent |
| Retained alternate-screen final frames | 1 MiB aggregate | Drop oldest final frames, or omit one oversized frame, and insert a counted plain-text omission marker |
| PTY parser backlog | Pause at 256 KiB; resume at 64 KiB | Apply node-pty flow control without dropping or reordering bytes |
| Child IPC backlog | 8,192 messages or 8 MiB | Pause the PTY while queued; fail the host rather than silently lose an authority publication if the bounded queue is exceeded |
| Canonical Pi result | Pi 0.99.2 model-facing limit: 50 KiB or 2,000 lines | Use Pi's tail truncation, preserve `truncated`, and surface its optional complete-output path |

Live rendering continues after reattach retention fills. A reconstructed
surface exposes an icon-only warning with the accessible name "Earlier live
shell output omitted" when retention omitted prior output. Settled output uses
Pi's canonical truncation metadata and never claims that the session JSONL
contains bytes Pi placed at a separate complete-output path. These bounds must
not block PTY draining, reorder input, lose completion, or change exit status.

## 12. Resolved product questions

1. **Alternate-screen representation:** one sanitized final visible frame per
   retained alternate-screen interval, interleaved with normalized
   primary-screen scrollback and recorded as `alternate_screen_final`. The
   aggregate is bounded; a counted marker replaces omitted older or oversized
   frames.
2. **Session switching:** allow it; keep the process in the origin SDK host,
   show a session-local running indicator, reattach by acknowledged keyframe,
   and never steal focus on background completion.
3. **Context classification:** the implemented UI has no separate label;
   `!` versus `!!` is the presentation. Any later click behavior must be a
   visible, undoable prefix text edit, never a hidden toggle.
4. **History scope:** P1 history is session-local and contains completed Shell
   Turns for that session. A later opt-in workspace/worktree scope may be
   evaluated; global history is not the default.
5. **Environment and cwd:** freeze cwd/environment at admission, record
   `cwdAtStart`, do not persist environment values, and do not let `cd`, OSC 7,
   or titles mutate session chrome.
6. **Future persistent shell:** open it through an explicit `/terminal` command
   or equivalent. Bare `!` plus Enter remains protected as incomplete input.
7. **Virtualization threshold:** none for live execution; it is always xterm.
   The live xterm uses the fixed Custom-view-sized viewport regardless of
   terminal mode. Settled output renders up to eight rows inline, scrolls longer
   values, and virtualizes at 1,000 rows or 256 KiB.

## 13. Acceptance scenarios

P0 is complete only when all of these hold:

- Deleting, undoing, moving, or adding the prefix changes interpretation
  without focus loss or an extra undo record; ` !ls` remains an ordinary prompt.
- Shell mode replaces the attachment button with the accent-colored UI-font
  `!`/`!!`, renders only the command suffix in the code font, hides staged
  attachments without clearing them, and contains no explanatory UI copy.
- Bare `!`, bare `!!`, whitespace-only suffixes, IME Enter, and multiline paste
  never execute.
- `!ls` displays output from the first byte, settles visibly with its output
  expanded by default, can be collapsed and reopened without moving the
  chronological item, and is classified as included.
- `!!printf 'local-only\n'` settles visibly but neither its command nor output
  appears in the next provider request.
- An interactive local fixture can read stdin, receive resize and SIGWINCH, use
  Ctrl+C/Ctrl+D/Escape, and exit without changing PTY or PID.
- The live card opens at the shared 50% Custom-view height, drags only within
  the 20–90% range, and double-click resets without a provisional small card.
- A synthetic alternate-screen fixture repaints inside the same fixed-height
  terminal and settles to exactly one sanitized final frame.
- Scrolling away stops live follow; later live output does not snap back, and
  completion preserves the transcript's outer scroll anchor while settling to
  normalized output.
- Switching sessions leaves the origin command running; returning reconstructs
  before input; background completion does not steal focus.
- No visible Stop or Force-stop control appears; Ctrl+C remains terminal input,
  and host/session disposal still cleans up an interrupt-ignoring process group.
- Stale owner/epoch/input/resize/lifecycle-signal messages cannot reach a
  successor process.
- Renderer reload reattaches to a live host; host death rehydrates an unmatched
  start as interrupted with no running spinner.
- A post-admission spawn failure creates one failed Shell Turn; a
  pre-admission failure creates none and preserves the draft.
- A settled header has one output-copy action and no command-copy or
  output-overlay action; collapse keeps that header visible and later status
  updates do not reopen the local disclosure.
- Shell Turns remain visible in Compact mode while Pi-run Bash remains an
  operational tool card.
- Reattach remains bounded and explicitly reports omitted older live output;
  Pi result truncation/full-output metadata survives settlement and rehydration.
- Sustained output applies parser and child-IPC backpressure without byte loss,
  reordering, event-loop starvation, or unbounded alternate-frame retention.
- Echo-disabled input bytes are absent from logs, semantic state, transcript
  output, and provider input.
- The production host path can load and run the native PTY dependency.

## 14. Test and verification plan

Implementation must add focused tests in addition to the repository-wide gates.

### Pure and component tests

- Parser table for every prefix case, trimming, multiline values, empty suffix,
  size limit, paste, IME, caret, selection, and undo behavior.
- Composer rendering and ARIA transitions, absence of visible helper copy,
  attachment preservation, and absence of hidden mode state.
- Admission matrix, intent deduplication, accepted-editor revision, no
  queue/replay, per-session concurrency, and pre/post-admission failures.
- Immutable semantic reducers for every Shell Turn state and stale
  owner/epoch/execution rejection.
- History coalescing for start/Bash/end records, unmatched starts, duplicate
  records, failure metadata, exclusion persistence, and Compact mode.
- Normalizer corpus covering ANSI/CSI/OSC, CR progress, backspace, erase and
  cursor addressing, wrapping/resizes, OSC 7/title/hyperlinks, DEC alternate
  screens, multiple alternate intervals, wide/combining Unicode, invalid bytes,
  empty screens, and reconstruction boundaries.

### Host and protocol tests

- A fake PTY verifies one spawn, same PID across resizing, stdin ordering,
  SIGWINCH, exit/signal mapping, graceful and forced lifecycle cleanup, and
  spawn failure.
- Owner/epoch/execution fences cover input, resize, lifecycle signals,
  publication, keyframe, acknowledgement, detach, and successor replacement;
  delayed equal-sequence acknowledgements cannot cross reconstruction fence
  tokens.
- Retention tests cover bounded raw fallback, serialized keyframe recovery, and
  lossless semantic completion.
- Logging tests use canary secret input and assert that raw input/VT never enters
  authority frames, journals, logs, diagnostics, or crash data.
- Bridge contract tests assert one public Pi Bash execution with the frozen
  `excludeFromContext` classification and normalized output only.

### Render and E2E tests

- Render coverage for draft prefix typography, attachment suppression,
  text-free validation, fast settlement without mounting xterm, exact-execution
  cancellation of the 200 ms reveal timer, immediate return to an older live
  execution, the fixed 50%-default/20–90% live viewport and shared drag/reset
  affordance, absence of Stop/Force-stop chrome, running/settled/failed/
  cancelled/interrupted states, default-expanded and user-collapsed settled
  output, status-stable local disclosure state, zero/eight/nine-row output,
  long virtualization, truncation, reduced motion, focus, the single
  normalized-output copy action, and follow/unpin behavior.
- Deterministic fake-host E2E covers empty validation, an interactive stdin
  prompt, live-to-settled rendering, exclusion metadata, settled disclosure,
  normalized-output copying, and Composer focus. Native host tests cover actual
  PTY loading, stdin, resize, normalization, and exit without network access.

Before completion, run:

```text
npm run typecheck
npm run lint
npm test
npm run test:render
npm run test:e2e
```

`docs/testing.md` remains authoritative for repository-wide gates.
