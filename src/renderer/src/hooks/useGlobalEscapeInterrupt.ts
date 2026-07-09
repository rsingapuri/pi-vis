// Global ESC-to-interrupt handler. Mounted ONCE in App.tsx.
//
// Precedence (active session), first match wins:
//   1. hasClaim()  -> DEFER (an overlay/autocomplete owns ESC)
//   2. interruptible runtime op -> INTERRUPT (main/host routes the abort)
//   3. else         -> no-op (let ESC reach whatever is focused)
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
import { hasClaim } from "../stores/overlay-store.js";
import { isSessionAbortable, useSessionsStore } from "../stores/sessions-store.js";

export function useGlobalEscapeInterrupt(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // G4 bare ESC
      if (e.isComposing || e.keyCode === 229) return; // G4 IME candidate window
      if (hasClaim()) return; // G1 defer
      const store = useSessionsStore.getState();
      const sid = store.activeSessionId; // G5
      if (!sid) return;
      const s = store.sessions.get(sid);
      if (!isSessionAbortable(s)) return; // G3
      e.preventDefault();
      e.stopImmediatePropagation(); // G2 preempt Composer + same-node capture listeners
      void store.abortSession(sid);
    };
    window.addEventListener("keydown", onKey, true); // capture
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
