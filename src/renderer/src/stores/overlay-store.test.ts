import { afterEach, describe, expect, it, vi } from "vitest";
import { getTopEscapeClaim, hasClaim, useOverlayStore } from "./overlay-store.js";

function reset(): void {
  useOverlayStore.setState({ count: 0, claims: [] });
}

describe("overlay-store — ordered Escape claims", () => {
  afterEach(reset);

  it("uses opaque tokens so stale release cannot remove another normal claim", () => {
    const first = useOverlayStore.getState()._acquire();
    const second = useOverlayStore.getState()._acquire();
    expect(hasClaim()).toBe(true);
    useOverlayStore.getState()._release(first);
    expect(getTopEscapeClaim()?.token).toBe(second);
    expect(useOverlayStore.getState().count).toBe(1);
    useOverlayStore.getState()._release(first);
    expect(useOverlayStore.getState().count).toBe(1);
    useOverlayStore.getState()._release(second);
    expect(hasClaim()).toBe(false);
  });

  it("gives normal overlays priority over newer routed claims", () => {
    const route = vi.fn();
    const normal = useOverlayStore.getState()._acquire();
    const routed = useOverlayStore.getState()._acquire(route);
    expect(getTopEscapeClaim()).toMatchObject({ token: normal });
    expect(getTopEscapeClaim()?.route).toBeUndefined();
    useOverlayStore.getState()._release(normal);
    expect(getTopEscapeClaim()).toMatchObject({ token: routed, route });
  });

  it("uses newest acquisition order within each priority class", () => {
    const firstRoute = vi.fn();
    const secondRoute = vi.fn();
    const firstRouted = useOverlayStore.getState()._acquire(firstRoute);
    const secondRouted = useOverlayStore.getState()._acquire(secondRoute);
    expect(getTopEscapeClaim()).toMatchObject({ token: secondRouted, route: secondRoute });
    const firstNormal = useOverlayStore.getState()._acquire();
    const secondNormal = useOverlayStore.getState()._acquire();
    expect(getTopEscapeClaim()).toMatchObject({ token: secondNormal });
    useOverlayStore.getState()._release(secondNormal);
    expect(getTopEscapeClaim()).toMatchObject({ token: firstNormal });
    useOverlayStore.getState()._release(firstNormal);
    useOverlayStore.getState()._release(secondRouted);
    expect(getTopEscapeClaim()).toMatchObject({ token: firstRouted, route: firstRoute });
  });
});
