import type React from "react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
// @vitest-environment jsdom
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasClaim, useOverlayStore } from "../stores/overlay-store.js";
import { useEscapeClaim, useRoutedEscapeClaim } from "./useEscapeClaim.js";

let container: HTMLDivElement | null = null;

function reset(): void {
  useOverlayStore.setState({ count: 0, claims: [] });
}

afterEach(() => {
  if (container) {
    document.body.removeChild(container);
    container = null;
  }
  reset();
});

function render(node: React.ReactElement): {
  unmount: () => void;
  rerender: (n: React.ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => {
      root.render(node);
    });
  });
  return {
    unmount: () => {
      act(() => {
        flushSync(() => {
          root.unmount();
        });
      });
    },
    rerender: (n) => {
      act(() => {
        flushSync(() => {
          root.render(n);
        });
      });
    },
  };
}

function Harness({ open }: { open: boolean }): React.ReactElement {
  useEscapeClaim(open);
  return <div />;
}

function RoutedHarness({ open, route }: { open: boolean; route: () => void }): React.ReactElement {
  useRoutedEscapeClaim(open, route);
  return <div />;
}

describe("useEscapeClaim — O2 hook wiring", () => {
  it("mounts open -> claims; flip to closed -> releases", () => {
    expect(hasClaim()).toBe(false);
    const { rerender } = render(<Harness open={true} />);
    expect(hasClaim()).toBe(true);
    rerender(<Harness open={false} />);
    expect(hasClaim()).toBe(false);
  });

  it("mount open then unmount -> released", () => {
    const { unmount } = render(<Harness open={true} />);
    expect(hasClaim()).toBe(true);
    unmount();
    expect(hasClaim()).toBe(false);
  });

  it("mounts closed -> no claim", () => {
    const { unmount } = render(<Harness open={false} />);
    expect(hasClaim()).toBe(false);
    unmount();
    expect(hasClaim()).toBe(false);
  });

  it("releases a routed claim as soon as its surface becomes hidden", () => {
    const route = vi.fn();
    const { rerender } = render(<RoutedHarness open={true} route={route} />);
    expect(useOverlayStore.getState().claims).toHaveLength(1);
    rerender(<RoutedHarness open={false} route={route} />);
    expect(useOverlayStore.getState().claims).toHaveLength(0);
  });

  it("keeps a routed callback current without reacquiring its ordered claim", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<RoutedHarness open={true} route={first} />);
    const token = useOverlayStore.getState().claims[0]!.token;
    rerender(<RoutedHarness open={true} route={second} />);
    const claim = useOverlayStore.getState().claims[0]!;
    expect(useOverlayStore.getState().claims).toHaveLength(1);
    expect(claim.token).toBe(token);
    claim.route!();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("concurrent instances are ref-counted (two open -> two releases to clear)", () => {
    function Pair(): React.ReactElement {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      useEscapeClaim(a);
      useEscapeClaim(b);
      return (
        <div>
          <button type="button" onClick={() => setA(false)} data-a="1" />
          <button type="button" onClick={() => setB(false)} data-b="1" />
        </div>
      );
    }
    const { unmount } = render(<Pair />);
    expect(hasClaim()).toBe(true);
    const btnA = container!.querySelector<HTMLButtonElement>('[data-a="1"]')!;
    act(() => {
      btnA.click();
    });
    expect(hasClaim()).toBe(true); // still one claim
    const btnB = container!.querySelector<HTMLButtonElement>('[data-b="1"]')!;
    act(() => {
      btnB.click();
    });
    expect(hasClaim()).toBe(false);
    unmount();
  });
});
