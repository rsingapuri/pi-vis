// Global ESC-to-interrupt handler. Mounted ONCE in App.tsx.
//
// Precedence (active session), first match wins:
//   1. newest normal claim -> DEFER (its DOM surface owns ESC)
//   2. newest routed claim -> consume and route it once to that surface
//   3. no claim -> INTERRUPT (main/host routes the abort)
//   4. else -> no-op (let ESC reach whatever is focused)
//
// Capture phase + stopImmediatePropagation: preempts React's synthetic
// onKeyDown on the Composer AND any other capture-phase window ESC listener
// (structural precedence, not situational — stopPropagation alone would NOT
// block same-node capture listeners).
//
// INVARIANTS (L3): G1 mutual exclusivity; G2 interrupt when unclaimed+active
// regardless of focus; G3 never interrupt idle; G4 no modified/IME ESC; G5
// active session only.

import { useEffect } from "react";
import { getTopEscapeClaim, hasClaim } from "../stores/overlay-store.js";
import { useSessionsStore } from "../stores/sessions-store.js";

export function useGlobalEscapeInterrupt(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // G4 bare ESC
      if (e.isComposing || e.keyCode === 229) return; // G4 IME candidate window
      const claim = getTopEscapeClaim();
      if (claim) {
        if (!claim.route) return; // G1 normal claims defer to DOM
        e.preventDefault();
        e.stopImmediatePropagation();
        // A route has exclusively consumed this key even if its surface is
        // fenced, unavailable, or buggy. Never fall through to an interrupt.
        try {
          claim.route();
        } catch {
          // Routed panels own Escape; a route failure must not become a global abort.
        }
        return;
      }
      // Defense for tests/external presentation code that sets the reactive
      // count directly. Real acquisitions always have a token above.
      if (hasClaim()) return;
      const store = useSessionsStore.getState();
      const sid = store.activeSessionId; // G5
      if (!sid) return;
      // Cached renderer liveness is never an ESC routing authority. The host
      // checks fresh AgentSession getters and acknowledges the honest branch.
      e.preventDefault();
      e.stopImmediatePropagation();
      void store.abortSession(sid);
    };
    window.addEventListener("keydown", onKey, true); // capture
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
