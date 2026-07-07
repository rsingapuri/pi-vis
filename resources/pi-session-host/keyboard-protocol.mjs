/**
 * pi-session-host: Kitty keyboard protocol negotiation for in-process panels.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The Unified TUI (and custom() panels) are NOT a pty: they are an in-process
 * pi-tui `TUI` + `Editor` living in the SDK-host subprocess, rendered into the
 * Electron renderer's xterm.js over `panel_data`. In legacy encoding
 * Shift+Enter and Enter are physically indistinguishable (both `\r`), so a
 * multiline editor is impossible without enhanced keyboard encoding.
 *
 * The Kitty keyboard protocol (adopted by kitty, Ghostty, WezTerm, iTerm2, VS
 * Code, and — as of 6.1 — xterm.js) fixes this: the app pushes enhancement
 * flags and the terminal encodes modified keys unambiguously as CSI-u
 * (Shift+Enter → `\x1b[13;2u`). xterm.js 6.1 grants this behind the opt-in
 * `vtExtensions.kittyKeyboard` option (set in the renderer); THIS module
 * performs the host half of the handshake over the panel wire, byte-for-byte
 * mirroring pi-tui's `ProcessTerminal` state machine so extensions inherit
 * whatever protocol the terminal negotiated.
 *
 * The handshake is self-verifying: it writes the push+query+DA-sentinel, then
 * filters xterm's replies (`\x1b[?<flags>u`, `\x1b[?…c`) OUT of the input
 * stream so they never reach the editor or extension `onTerminalInput`. On
 * nonzero kitty flags it activates pi-tui's module-global decode
 * (`setKittyProtocolActive(true)`); on zero flags or a DA-first reply it falls
 * back to xterm `modifyOtherKeys` (byte-parity with pi). If xterm ever fails to
 * grant kitty (version drift, option regression), the host degrades to exactly
 * today's behavior instead of a half-enabled state.
 *
 * WHY REIMPLEMENTED, NOT IMPORTED
 * ───────────────────────────────
 * The parser is ~8 lines of regex, and `src/main/pi/host-imports.test.ts`
 * forbids reaching into pi-tui's compiled `dist/terminal.js` (non-index imports
 * are disallowed). pi-tui's public index DOES export `setKittyProtocolActive`
 * and `StdinBuffer`, which we feature-detect and inject — but the reply
 * parser/prefix-detector is private, so we reimplement it here. The regexes
 * mirror `parseKeyboardProtocolNegotiationSequence` /
 * `isKeyboardProtocolNegotiationSequencePrefix` exactly; if those change in a
 * future pi-tui, this module must be updated to match.
 */

// ─── Protocol constants (mirror pi-tui ProcessTerminal) ─────────────────────

// Flags: 1 = disambiguate escape codes, 2 = report event types, 4 = report
// alternate keys. pi runs flags=7 in real terminals; the handshake absorbs
// xterm granting fewer flags. Event types (flag 2) expose release events to
// host listeners — see createHostTerminal's isKeyRelease guard on the paste
// listener. The constant lives in one place if we ever need to drop to flags=1.
export const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;

// Push enhancement flags, then query current flags, then DA (device attributes)
// as a sentinel: terminals that don't know kitty answer DA first, which selects
// the modifyOtherKeys fallback without a startup timeout.
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u\x1b[c`;

const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const KITTY_POP = "\x1b[<u";
const MODIFY_OTHER_KEYS_ENABLE = "\x1b[>4;2m";
const MODIFY_OTHER_KEYS_DISABLE = "\x1b[>4;0m";

// Mirror readKeyboardProtocolNegotiationSequence's fragment-flush window: if a
// reply prefix lingers this long without completing, flush it as real input.
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;

// ─── Reply parser (reimplemented — do NOT deep-import pi-tui) ────────────────

/**
 * Parse a COMPLETE kitty/D A negotiation reply.
 * - `\x1b[?<flags>u` → { type:"kitty-flags", flags }
 * - `\x1b[?[\d;]*c`  → { type:"device-attributes" }
 * Mirrors pi-tui's parseKeyboardProtocolNegotiationSequence exactly.
 */
export function parseKeyboardProtocolNegotiationSequence(sequence) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-level kitty reply contract — ESC (\x1b) is the CSI introducer; mirrors pi-tui's parser exactly
  const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
  if (kittyFlags) {
    return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1], 10) };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-level DA reply contract — ESC (\x1b) is the CSI introducer; mirrors pi-tui's parser exactly
  if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
    return { type: "device-attributes" };
  }
  return undefined;
}

/**
 * Is `sequence` a PREFIX of a kitty/DA reply (i.e. a partial reply that may
 * complete across more than one chunk)? Mirrors pi-tui's
 * isKeyboardProtocolNegotiationSequencePrefix exactly. Bare `\x1b[` is a prefix
 * (could become `\x1b[?…`); `\x1b[?` + digits/semicolons is a prefix until it
 * terminates with `u` (kitty) or `c` (DA).
 */
export function isKeyboardProtocolNegotiationSequencePrefix(sequence) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is the CSI introducer for a partial reply prefix; mirrors pi-tui exactly
  return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

// ─── Per-terminal negotiator ────────────────────────────────────────────────

/**
 * Create a kitty keyboard protocol negotiator for one panel terminal.
 *
 * @param {object} deps
 * @param {(data: string) => void} deps.write
 *   Writes bytes to the terminal/panel (the handshake + fallbacks + cleanup).
 *   For a host panel this is `panelBridge.writePanel(panelId, data)`.
 * @param {(sequence: string) => void} deps.forward
 *   Forwards a REAL (non-negotiation) input sequence to the TUI/editor — i.e.
 *   the `onInput` handler pi-tui's TUI registered via `terminal.start()`.
 * @param {() => void} [deps.onKittyActive]
 *   Invoked once when kitty flags become nonzero for THIS terminal (so the
 *   host can activate pi-tui's module-global decode via the refcounted gate).
 * @returns {object} negotiator with push/filterInput/stop/isActive.
 */
export function createKeyboardProtocolNegotiator({ write, forward, onKittyActive }) {
  let pushed = false;
  let kittyActive = false;
  let modifyOtherKeysActive = false;
  let buffer = "";
  let flushTimer = null;

  function clearFlushTimer() {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function setBuffer(sequence) {
    clearFlushTimer();
    buffer = sequence;
  }

  function clearBuffer() {
    clearFlushTimer();
    buffer = "";
  }

  function flushBufferAsInput() {
    if (!buffer) return;
    const sequence = buffer;
    clearBuffer();
    forward(sequence);
  }

  function scheduleBufferFlush() {
    if (!buffer || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBufferAsInput();
    }, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
    // Don't keep the host alive for a fragment-flush (mirrors unref posture).
    flushTimer.unref?.();
  }

  function enableModifyOtherKeys() {
    if (kittyActive || modifyOtherKeysActive) return;
    write(MODIFY_OTHER_KEYS_ENABLE);
    modifyOtherKeysActive = true;
  }

  function disableModifyOtherKeys() {
    if (!modifyOtherKeysActive) return;
    write(MODIFY_OTHER_KEYS_DISABLE);
    modifyOtherKeysActive = false;
  }

  /**
   * Handle a parsed negotiation sequence (kitty-flags | device-attributes).
   * Returns true (consumed) for any recognized reply; the caller stops here.
   * Mirrors ProcessTerminal.handleKeyboardProtocolNegotiationSequence.
   */
  function handleNegotiation(negotiation) {
    if (!negotiation) return false;
    clearBuffer();
    if (negotiation.type === "kitty-flags") {
      if (negotiation.flags !== 0) {
        disableModifyOtherKeys();
        if (!kittyActive) {
          kittyActive = true;
          try {
            onKittyActive?.();
          } catch {
            /* a failing activate hook must not break decode */
          }
        }
      } else {
        // Zero flags: terminal pushed the flag set but reports none active —
        // kitty not actually supported. Fall back to modifyOtherKeys.
        enableModifyOtherKeys();
      }
      return true;
    }
    // device-attributes: terminal answered DA before any kitty reply ⇒ kitty
    // not supported. Fall back to modifyOtherKeys (no-op if kitty already won).
    if (!kittyActive) enableModifyOtherKeys();
    return true;
  }

  /**
   * Read a sequence through the buffer state machine. Mirrors
   * ProcessTerminal.readKeyboardProtocolNegotiationSequence. Returns:
   *   - a parsed negotiation object (consumed),
   *   - "pending" (a partial reply prefix — caller waits for the rest),
   *   - undefined (NOT a negotiation reply — caller forwards it).
   *
   * Side effect: when a buffered prefix turns out NOT to be a reply, the stale
   * buffer is flushed via `forward` (it was a real key mistaken for a prefix).
   */
  function readNegotiation(sequence) {
    if (buffer) {
      const bufferedSequence = buffer + sequence;
      const negotiation = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
      if (negotiation) {
        clearBuffer();
        return negotiation;
      }
      if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
        setBuffer(bufferedSequence);
        return "pending";
      }
      // Stale prefix: the buffered bytes were a real key. Flush them as input,
      // then re-evaluate the current sequence from scratch.
      flushBufferAsInput();
    }
    const negotiation = parseKeyboardProtocolNegotiationSequence(sequence);
    if (negotiation) return negotiation;
    if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
      setBuffer(sequence);
      return "pending";
    }
    return undefined;
  }

  return {
    /**
     * Push the enhancement handshake. Idempotent and re-callable: each call
     * re-writes bracketed-paste-enable + push + query + DA (the renegotiation
     * triggered by a force-resize after an xterm remount). Clears any pending
     * fragment buffer first so a stale prefix can't absorb the fresh replies.
     */
    push() {
      clearBuffer();
      write(BRACKETED_PASTE_ENABLE);
      write(KITTY_KEYBOARD_PROTOCOL_QUERY);
      pushed = true;
    },

    /**
     * Filter one (StdinBuffer-split) input sequence through the negotiation
     * state machine.
     * @returns {boolean} true if the sequence was CONSUMED by negotiation
     *   (a reply, or a pending partial-reply prefix); false if it is a real
     *   key the caller must forward to the TUI/editor. When the negotiator
     *   flushes a stale buffered prefix it forwards those bytes itself via
     *   `forward`, then returns whether the CURRENT sequence was consumed.
     */
    filterInput(sequence) {
      const negotiation = readNegotiation(sequence);
      if (negotiation === "pending") {
        scheduleBufferFlush();
        return true; // consumed — wait for the rest of the split reply
      }
      if (handleNegotiation(negotiation)) {
        return true; // consumed — a complete kitty/DA reply
      }
      return false; // real key — caller forwards `sequence`
    },

    /** Has THIS terminal successfully negotiated nonzero kitty flags? */
    get isActive() {
      return kittyActive;
    },

    /** Was modifyOtherKeys fallback written (no kitty support)? */
    get isModifyOtherKeysActive() {
      return modifyOtherKeysActive;
    },

    /** Has push() ever been called (i.e. cleanup bytes are owed on stop)? */
    get isPushed() {
      return pushed;
    },

    /**
     * Tear down: disable bracketed paste, pop kitty flags, disable
     * modifyOtherKeys — byte-for-byte parity with ProcessTerminal.stop().
     * Clears the fragment-flush timer. Safe to call once.
     */
    stop() {
      clearFlushTimer();
      clearBuffer();
      if (pushed) {
        write(BRACKETED_PASTE_DISABLE);
        write(KITTY_POP);
      }
      disableModifyOtherKeys();
    },
  };
}

// ─── Refcounted global gate ─────────────────────────────────────────────────

/**
 * Create a refcounted gate around pi-tui's module-global kitty decode
 * (`setKittyProtocolActive`). Multiple panels share the module-global: if panel
 * A negotiated kitty and panel B opens, closing B must NOT deactivate decode
 * for A. The refcount counts participating terminals; the global is activated
 * on the first successful negotiation and deactivated only when the last
 * terminal releases.
 *
 * @param {(active: boolean) => void} setKittyProtocolActive
 *   pi-tui's exported module-global setter (feature-detected by the caller).
 * @returns {object} gate with acquire/markActive/release/isActive/refCount.
 */
export function createKittyGlobalGate(setKittyProtocolActive) {
  let refCount = 0;
  let active = false;

  function setActive(value) {
    if (active === value) return;
    active = value;
    try {
      setKittyProtocolActive(value);
    } catch {
      /* a failing setter must not break panel I/O */
    }
  }

  return {
    /** A terminal is joining the kitty decode pool (panel started). */
    acquire() {
      refCount += 1;
    },
    /** This terminal successfully negotiated nonzero kitty flags. */
    markActive() {
      if (!active) setActive(true);
    },
    /** A terminal is leaving the pool (panel stopped/closed). */
    release() {
      refCount = Math.max(0, refCount - 1);
      if (refCount === 0) setActive(false);
    },
    get isActive() {
      return active;
    },
    get refCount() {
      return refCount;
    },
  };
}
