// Claim ownership of ESC while `open` is true. While any claim is active the
// global ESC-to-interrupt handler defers, letting this surface's own ESC
// handler run (close/cancel). See overlay-store.ts for invariants.
//
// CRITICAL: uses useLayoutEffect (NOT useEffect). Layout effects run
// synchronously after DOM commit, BEFORE the browser paints and BEFORE the
// next dispatched event. This is load-bearing for the two-press model: ESC
// closing autocomplete must release the claim before the NEXT keydown is
// dispatched (OS key-repeat can fire ~30Hz; a passive useEffect would not
// have flushed yet, silently swallowing the second ESC). DO NOT "simplify"
// this to useEffect — it reintroduces a 3-press bug.

import { useLayoutEffect, useRef } from "react";
import { type EscapeRoute, useOverlayStore } from "../stores/overlay-store.js";

export function useEscapeClaim(open: boolean): void {
  useLayoutEffect(() => {
    if (!open) return;
    const { _acquire, _release } = useOverlayStore.getState();
    const token = _acquire();
    return () => _release(token);
  }, [open]);
}

/**
 * Claim Escape for a terminal-like surface that must receive the key even when
 * its DOM input is temporarily fenced. The route stays current without
 * changing acquisition order on ordinary renders.
 */
export function useRoutedEscapeClaim(open: boolean, route: EscapeRoute): void {
  const routeRef = useRef(route);
  routeRef.current = route;
  useLayoutEffect(() => {
    if (!open) return;
    const { _acquire, _release } = useOverlayStore.getState();
    const token = _acquire(() => routeRef.current());
    return () => _release(token);
  }, [open]);
}
