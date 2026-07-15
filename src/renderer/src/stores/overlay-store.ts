// Ordered Escape-claim registry. Claims are acquired per mounted surface, so
// duplicate component instances and React StrictMode cleanup stay safe. The
// count remains reactive for presentation consumers; global keyboard routing
// gives visible DOM overlays priority, then reads the newest routed claim.

import { create } from "zustand";

export type EscapeRoute = () => void;
export type EscapeClaimToken = symbol;

interface EscapeClaim {
  token: EscapeClaimToken;
  route: EscapeRoute | undefined;
}

interface OverlayState {
  count: number;
  claims: readonly EscapeClaim[];
  /** Acquire an ordered normal or routed claim. Internal hook plumbing. */
  _acquire: (route?: EscapeRoute) => EscapeClaimToken;
  /** Release this exact acquisition; stale cleanup cannot release a newer claim. */
  _release: (token: EscapeClaimToken) => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  count: 0,
  claims: [],
  _acquire: (route) => {
    const token = Symbol("escape-claim");
    set((state) => {
      const claims = [...state.claims, { token, route }];
      return { claims, count: claims.length };
    });
    return token;
  },
  _release: (token) =>
    set((state) => {
      const claims = state.claims.filter((claim) => claim.token !== token);
      return claims.length === state.claims.length ? state : { claims, count: claims.length };
    }),
}));

/** Non-reactive read for event handlers (do not subscribe in render). */
export function hasClaim(): boolean {
  return useOverlayStore.getState().count > 0;
}

/**
 * Visible DOM overlays own Escape before terminal-routed surfaces regardless of
 * mount order. Within either class, the newest surface owns Escape first.
 */
export function getTopEscapeClaim(): EscapeClaim | undefined {
  const claims = useOverlayStore.getState().claims;
  for (let i = claims.length - 1; i >= 0; i -= 1) {
    if (claims[i]?.route === undefined) return claims[i];
  }
  return claims[claims.length - 1];
}
