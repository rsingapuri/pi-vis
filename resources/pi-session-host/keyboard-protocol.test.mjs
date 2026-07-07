/**
 * Unit tests for the host-side kitty keyboard protocol negotiator + global gate.
 *
 * These exercise the state machine DIRECTLY (no xterm, no pi-tui, no panels),
 * mirroring the cases ProcessTerminal handles — they are the byte-level
 * invariants (I5/I10/I13) the host-render and e2e suites build on top of.
 *
 * What's covered:
 *   - push() writes the exact handshake (bracketed paste + push + query + DA)
 *   - whole / split / duplicate kitty replies are consumed, never forwarded
 *   - real-key sequences (incl. a CSI prefix like \x1b[A) are forwarded
 *   - 150ms fragment-flush forwards a stale buffered prefix (fake timers)
 *   - nonzero kitty flags → onKittyActive fires exactly once; kittyActive=true
 *   - zero flags → modifyOtherKeys fallback written, no activate
 *   - DA-first → modifyOtherKeys fallback written, no activate
 *   - stop() writes the cleanup bytes (bracketed paste disable + kitty pop)
 *   - createKittyGlobalGate refcount semantics (one close doesn't disable all)
 */
import { describe, expect, it, vi } from "vitest";
import {
  createKeyboardProtocolNegotiator,
  createKittyGlobalGate,
  isKeyboardProtocolNegotiationSequencePrefix,
  parseKeyboardProtocolNegotiationSequence,
} from "./keyboard-protocol.mjs";

/** A negotiator wired to recording write/forward/onKittyActive callbacks. */
function makeNegotiator() {
  const written = [];
  const forwarded = [];
  const onKittyActive = vi.fn();
  const negotiator = createKeyboardProtocolNegotiator({
    write: (d) => written.push(d),
    forward: (d) => forwarded.push(d),
    onKittyActive,
  });
  return { negotiator, written, forwarded, onKittyActive };
}

/**
 * Feed a sequence the way the host's StdinBuffer `data` handler does: the
 * negotiator consumes negotiation replies/prefixes; anything it returns false
 * for is a real key the handler forwards to the TUI/editor. (The negotiator
 * also forwards a stale buffered prefix itself when its fragment-flush fires.)
 */
function feed(negotiator, seq, forwarded) {
  if (!negotiator.filterInput(seq)) forwarded.push(seq);
}

const HANDSHAKE = ["\x1b[?2004h", "\x1b[>7u\x1b[?u\x1b[c"];

describe("parseKeyboardProtocolNegotiationSequence", () => {
  it("parses a kitty-flags reply", () => {
    expect(parseKeyboardProtocolNegotiationSequence("\x1b[?7u")).toEqual({
      type: "kitty-flags",
      flags: 7,
    });
    expect(parseKeyboardProtocolNegotiationSequence("\x1b[?0u")).toEqual({
      type: "kitty-flags",
      flags: 0,
    });
  });

  it("parses a device-attributes reply", () => {
    expect(parseKeyboardProtocolNegotiationSequence("\x1b[?c")).toEqual({
      type: "device-attributes",
    });
    expect(parseKeyboardProtocolNegotiationSequence("\x1b[?1;2c")).toEqual({
      type: "device-attributes",
    });
  });

  it("returns undefined for real keys", () => {
    expect(parseKeyboardProtocolNegotiationSequence("\x1b[A")).toBeUndefined();
    expect(parseKeyboardProtocolNegotiationSequence("\r")).toBeUndefined();
    expect(parseKeyboardProtocolNegotiationSequence("a")).toBeUndefined();
    expect(parseKeyboardProtocolNegotiationSequence("\x1b[13;2u")).toBeUndefined();
  });
});

describe("isKeyboardProtocolNegotiationSequencePrefix", () => {
  it("recognizes partial reply prefixes", () => {
    expect(isKeyboardProtocolNegotiationSequencePrefix("\x1b[")).toBe(true);
    expect(isKeyboardProtocolNegotiationSequencePrefix("\x1b[?")).toBe(true);
    expect(isKeyboardProtocolNegotiationSequencePrefix("\x1b[?7")).toBe(true);
    expect(isKeyboardProtocolNegotiationSequencePrefix("\x1b[?1;2")).toBe(true);
  });

  it("rejects complete replies and real keys", () => {
    expect(isKeyboardProtocolNegotiationSequencePrefix("\x1b[?7u")).toBe(false);
    expect(isKeyboardProtocolNegotiationSequencePrefix("\x1b[?c")).toBe(false);
    expect(isKeyboardProtocolNegotiationSequencePrefix("\x1b[A")).toBe(false);
    expect(isKeyboardProtocolNegotiationSequencePrefix("\r")).toBe(false);
  });
});

describe("createKeyboardProtocolNegotiator.push", () => {
  it("writes bracketed-paste-enable + kitty push/query/DA", () => {
    const { negotiator, written } = makeNegotiator();
    negotiator.push();
    expect(written).toEqual(HANDSHAKE);
    expect(negotiator.isPushed).toBe(true);
  });

  it("is re-callable (renegotiate): each call re-writes the handshake", () => {
    const { negotiator, written } = makeNegotiator();
    negotiator.push();
    negotiator.push();
    expect(written).toEqual([...HANDSHAKE, ...HANDSHAKE]);
  });
});

describe("createKeyboardProtocolNegotiator.filterInput — kitty success", () => {
  it("consumes a whole kitty-flags reply and activates exactly once", () => {
    const { negotiator, forwarded, onKittyActive } = makeNegotiator();
    expect(negotiator.filterInput("\x1b[?7u")).toBe(true); // consumed
    expect(negotiator.isActive).toBe(true);
    expect(onKittyActive).toHaveBeenCalledTimes(1);
    expect(forwarded).toEqual([]); // never reaches the editor
  });

  it("consumes a duplicate reply idempotently (no second activate)", () => {
    const { negotiator, onKittyActive } = makeNegotiator();
    negotiator.filterInput("\x1b[?7u");
    negotiator.filterInput("\x1b[?7u");
    expect(onKittyActive).toHaveBeenCalledTimes(1);
    expect(negotiator.isActive).toBe(true);
  });

  it("consumes a kitty reply split across two sequences", () => {
    const { negotiator, forwarded, onKittyActive } = makeNegotiator();
    // First fragment is a prefix → consumed (pending).
    expect(negotiator.filterInput("\x1b[?7")).toBe(true);
    expect(forwarded).toEqual([]);
    // Completing fragment → consumed and activated.
    expect(negotiator.filterInput("u")).toBe(true);
    expect(negotiator.isActive).toBe(true);
    expect(onKittyActive).toHaveBeenCalledTimes(1);
    expect(forwarded).toEqual([]);
  });

  it("forwards a real key that merely starts with a CSI byte", () => {
    const { negotiator, forwarded } = makeNegotiator();
    expect(negotiator.filterInput("\x1b[A")).toBe(false); // not consumed
    feed(negotiator, "\x1b[A", forwarded); // host handler forwards it
    expect(forwarded).toEqual(["\x1b[A"]);
  });

  it("forwards plain printable bytes", () => {
    const { negotiator, forwarded } = makeNegotiator();
    feed(negotiator, "abc", forwarded);
    feed(negotiator, "\r", forwarded);
    expect(forwarded).toEqual(["abc", "\r"]);
  });

  it("forwards ESC under kitty (\x1b[27u) — it is NOT a negotiation reply (I8)", () => {
    // Kitty encodes Escape as \x1b[27u. It must reach the TUI/editor (autocomplete
    // cancel, overlay close), never be swallowed by the negotiation filter.
    const { negotiator, forwarded } = makeNegotiator();
    expect(negotiator.filterInput("\x1b[27u")).toBe(false);
    feed(negotiator, "\x1b[27u", forwarded);
    expect(forwarded).toEqual(["\x1b[27u"]);
  });
});

describe("createKeyboardProtocolNegotiator.filterInput — fallbacks", () => {
  it("zero kitty flags → modifyOtherKeys fallback, no activate", () => {
    const { negotiator, written, onKittyActive } = makeNegotiator();
    expect(negotiator.filterInput("\x1b[?0u")).toBe(true); // consumed
    expect(negotiator.isActive).toBe(false);
    expect(negotiator.isModifyOtherKeysActive).toBe(true);
    expect(onKittyActive).not.toHaveBeenCalled();
    expect(written).toContain("\x1b[>4;2m");
  });

  it("DA-first reply → modifyOtherKeys fallback, no activate", () => {
    const { negotiator, written, onKittyActive } = makeNegotiator();
    expect(negotiator.filterInput("\x1b[?1;2c")).toBe(true); // consumed
    expect(negotiator.isActive).toBe(false);
    expect(negotiator.isModifyOtherKeysActive).toBe(true);
    expect(onKittyActive).not.toHaveBeenCalled();
    expect(written).toContain("\x1b[>4;2m");
  });

  it("kitty wins: DA arriving AFTER kitty does not flip to fallback", () => {
    const { negotiator, written } = makeNegotiator();
    negotiator.filterInput("\x1b[?7u"); // kitty active
    negotiator.filterInput("\x1b[?c"); // late DA — consumed, no fallback
    expect(negotiator.isActive).toBe(true);
    expect(written).not.toContain("\x1b[>4;2m");
  });
});

describe("createKeyboardProtocolNegotiator — fragment flush", () => {
  it("flushes a stale buffered prefix as real input after the timeout", () => {
    vi.useFakeTimers();
    try {
      const { negotiator, forwarded } = makeNegotiator();
      // `\x1b[?` is a prefix but `\x1b[?X` (a real keystroke continuation) never
      // completes into a reply. Buffer it, then advance past the flush window.
      negotiator.filterInput("\x1b[?");
      expect(forwarded).toEqual([]);
      vi.advanceTimersByTime(151);
      expect(forwarded).toEqual(["\x1b[?"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT flush while a reply is still completing within the window", () => {
    vi.useFakeTimers();
    try {
      const { negotiator, forwarded, onKittyActive } = makeNegotiator();
      negotiator.filterInput("\x1b[?7");
      vi.advanceTimersByTime(100); // within 150ms
      expect(forwarded).toEqual([]);
      // Now the reply completes → consumed, no flush.
      negotiator.filterInput("u");
      expect(forwarded).toEqual([]);
      expect(onKittyActive).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createKeyboardProtocolNegotiator.stop", () => {
  it("writes bracketed-paste-disable + kitty pop after a push", () => {
    const { negotiator, written } = makeNegotiator();
    negotiator.push();
    written.length = 0;
    negotiator.stop();
    expect(written).toContain("\x1b[?2004l");
    expect(written).toContain("\x1b[<u");
  });

  it("writes modifyOtherKeys-disable if the fallback was active", () => {
    const { negotiator, written } = makeNegotiator();
    negotiator.push();
    negotiator.filterInput("\x1b[?0u"); // enable modifyOtherKeys
    written.length = 0;
    negotiator.stop();
    expect(written).toContain("\x1b[>4;0m");
  });

  it("is a no-op write when never pushed (status-quo for kitty-less host)", () => {
    const { negotiator, written } = makeNegotiator();
    negotiator.stop();
    expect(written).toEqual([]);
  });

  it("clears a pending fragment-flush timer", () => {
    vi.useFakeTimers();
    try {
      const { negotiator, forwarded } = makeNegotiator();
      negotiator.filterInput("\x1b[?");
      negotiator.stop();
      // Advancing past the window must NOT flush (timer was cleared).
      vi.advanceTimersByTime(200);
      expect(forwarded).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createKittyGlobalGate", () => {
  it("activates on first markActive and deactivates when refcount hits zero", () => {
    const setActive = vi.fn();
    const gate = createKittyGlobalGate(setActive);
    gate.acquire();
    gate.markActive();
    expect(setActive).toHaveBeenCalledWith(true);
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(gate.isActive).toBe(true);

    gate.release();
    expect(setActive).toHaveBeenCalledWith(false);
    expect(gate.isActive).toBe(false);
    expect(gate.refCount).toBe(0);
  });

  it("closing one panel does NOT disable decode for another (refcount)", () => {
    const setActive = vi.fn();
    const gate = createKittyGlobalGate(setActive);
    gate.acquire(); // panel A
    gate.acquire(); // panel B
    gate.markActive();
    expect(gate.isActive).toBe(true);

    gate.release(); // panel A closes
    expect(gate.isActive).toBe(true); // B still needs it
    expect(setActive).toHaveBeenCalledTimes(1); // never deactivated

    gate.release(); // panel B closes
    expect(gate.isActive).toBe(false);
    expect(setActive).toHaveBeenLastCalledWith(false);
  });

  it("markActive is idempotent (multiple negotiators on the shared gate)", () => {
    const setActive = vi.fn();
    const gate = createKittyGlobalGate(setActive);
    gate.acquire();
    gate.markActive();
    gate.markActive(); // duplicate
    expect(setActive).toHaveBeenCalledTimes(1);
  });

  it("release never drives refcount below zero", () => {
    const setActive = vi.fn();
    const gate = createKittyGlobalGate(setActive);
    gate.acquire();
    gate.markActive(); // setActive(true)
    gate.release(); // setActive(false)
    gate.release(); // extra release — refcount clamped, no spurious call
    expect(gate.refCount).toBe(0);
    // Exactly one activate + one deactivate; the extra release re-activates
    // nothing (the invariant the gate exists to preserve).
    expect(setActive).toHaveBeenCalledTimes(2);
    expect(setActive).toHaveBeenLastCalledWith(false);
  });

  it("a throwing setter is tolerated (no throw)", () => {
    const gate = createKittyGlobalGate(() => {
      throw new Error("boom");
    });
    expect(() => {
      gate.acquire();
      gate.markActive();
      gate.release();
    }).not.toThrow();
  });
});
