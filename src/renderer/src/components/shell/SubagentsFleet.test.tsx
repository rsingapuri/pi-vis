// @vitest-environment jsdom
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentsFleet } from "./SubagentsFleet.js";

function mount(node: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
  rerender: (node: React.ReactElement) => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => root.render(node));
  });
  return {
    container,
    unmount: () => {
      act(() => {
        flushSync(() => root.unmount());
      });
      document.body.removeChild(container);
    },
    rerender: (next) => {
      act(() => {
        flushSync(() => root.render(next));
      });
    },
  };
}

function snapshotLine(snapshot: unknown): string {
  return `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`;
}

function baseSnapshot(): Record<string, unknown> {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1704067200000,
    caps: {
      maxRuns: 20,
      maxChildrenPerNode: 8,
      maxDepth: 3,
      maxStringLength: 160,
      maxSerializedBytes: 32768,
    },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [],
  };
}

describe("SubagentsFleet", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the header and empty state when no snapshot line is present", () => {
    const { container, unmount } = mount(<SubagentsFleet lines={["no prefix here"]} />);
    expect(container.textContent).toContain("Subagents");
    expect(container.textContent).toContain("No active subagent runs");
    unmount();
  });

  it("collapses to the header summary on click and expands again", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [
          { id: "r1", kind: "subagent", label: "dev", state: "running", startedAt: 1704067200000, updatedAt: 1704067260000 },
          { id: "r2", kind: "subagent", label: "qa", state: "queued" },
          { id: "r3", kind: "subagent", label: "scout", state: "complete", startedAt: 1704067200000, endedAt: 1704067230000 },
        ],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet lines={lines} />);
    const header = container.querySelector<HTMLButtonElement>(".subagents-fleet__header");
    expect(header).not.toBeNull();
    expect(header!.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("dev");

    act(() => {
      header!.click();
    });
    expect(header!.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".subagents-fleet__runs")).toBeNull();
    expect(container.textContent).toContain("2 active");
    expect(container.querySelector(".subagents-fleet__node-label")).toBeNull();

    act(() => {
      header!.click();
    });
    expect(header!.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("dev");
    unmount();
  });

  it("renders a run tree with label, state, current tool, and activity counters", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [
          {
            id: "parent-run",
            kind: "subagent",
            label: "researcher",
            state: "running",
            startedAt: 1704067200000,
            updatedAt: 1704067290000,
            activity: {
              currentTool: "search",
              turnCount: 5,
              toolCount: 3,
            },
            children: [
              {
                id: "child-step",
                kind: "step",
                label: "summarize",
                state: "complete",
                startedAt: 1704067201000,
                endedAt: 1704067203000,
              },
            ],
          },
        ],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet lines={lines} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Subagents");
    expect(text).toContain("researcher");
    expect(text).toContain("parent-run");
    expect(text).toContain("running");
    expect(text).toContain("search");
    expect(text).toContain("5 turns");
    expect(text).toContain("3 tools");
    expect(text).toContain("1m 30s");
    expect(text).toContain("summarize");
    expect(text).toContain("subagent");
    expect(text).toContain("step");
    expect(text).toContain("child-step");
    expect(text).toContain("complete");
    expect(text).toContain("2s");
    unmount();
  });

  it("renders distinct failed and paused badges", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [
          { id: "failed-run", kind: "subagent", label: "f", state: "failed" },
          { id: "paused-run", kind: "subagent", label: "p", state: "paused" },
        ],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet lines={lines} />);
    const badges = container.querySelectorAll(".subagents-fleet__badge");
    expect(badges).toHaveLength(2);
    expect(badges[0]?.classList.contains("subagents-fleet__badge--failed")).toBe(true);
    expect(badges[1]?.classList.contains("subagents-fleet__badge--paused")).toBe(true);
    unmount();
  });

  it("shows the byte-limit and omission notice when the snapshot is truncated", () => {
    const lines = [
      snapshotLine({
        ...baseSnapshot(),
        caps: {
          maxRuns: 20,
          maxChildrenPerNode: 8,
          maxDepth: 3,
          maxStringLength: 160,
          maxSerializedBytes: 4096,
        },
        omitted: { runs: 2, children: 5, byteLimitExceeded: true },
        runs: [{ id: "run-1", kind: "subagent", label: "kept", state: "running" }],
      }),
    ];
    const { container, unmount } = mount(<SubagentsFleet lines={lines} />);
    const text = container.textContent ?? "";
    expect(text).toContain("truncated to 4.0 KiB budget");
    expect(text).toContain("2 runs omitted");
    expect(text).toContain("5 nested children omitted");
    expect(container.querySelector(".subagents-fleet__notice--warning")).not.toBeNull();
    unmount();
  });

  it("keeps the last valid snapshot after a malformed update", () => {
    const validLines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [{ id: "run-1", kind: "subagent", label: "kept", state: "running" }],
      }),
    ];
    const { container, rerender, unmount } = mount(<SubagentsFleet lines={validLines} />);
    expect(container.textContent).toContain("kept");

    rerender(<SubagentsFleet lines={["PI_SUBAGENT_ASYNC_JSON:not valid json"]} />);
    expect(container.textContent).toContain("kept");
    expect(container.textContent).toContain("running");

    unmount();
  });

  it("clears the panel when the widget lines are retracted", () => {
    const validLines = [
      snapshotLine({
        ...baseSnapshot(),
        runs: [{ id: "run-1", kind: "subagent", label: "kept", state: "running" }],
      }),
    ];
    const { container, rerender, unmount } = mount(<SubagentsFleet lines={validLines} />);
    expect(container.textContent).toContain("kept");

    rerender(<SubagentsFleet lines={[]} />);
    expect(container.textContent).toContain("No active subagent runs");
    expect(container.textContent).not.toContain("kept");

    unmount();
  });

  it("ignores malformed snapshot lines gracefully", () => {
    const lines = ["PI_SUBAGENT_ASYNC_JSON:not valid json"];
    const { container, unmount } = mount(<SubagentsFleet lines={lines} />);
    expect(container.textContent).toContain("Subagents");
    expect(container.textContent).toContain("No active subagent runs");
    unmount();
  });
});
