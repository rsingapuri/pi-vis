// @vitest-environment jsdom
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "../../stores/diff-store.js";
import { CommitRangePicker } from "./CommitRangePicker.js";

const commits = [
  { sha: "aaa-full", shortSha: "aaa", subject: "oldest", authorName: "A", authoredAt: 0 },
  { sha: "bbb-full", shortSha: "bbb", subject: "middle", authorName: "B", authoredAt: 0 },
  { sha: "ccc-full", shortSha: "ccc", subject: "newest", authorName: "C", authoredAt: 0 },
];

function mount(node: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => flushSync(() => root.render(node)));
  return {
    container,
    unmount: () => {
      act(() => flushSync(() => root.unmount()));
      container.remove();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openPicker(container: HTMLDivElement): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".commit-range-picker__trigger")!.click();
  });
  await settle();
}

function clickText(container: HTMLDivElement, text: string): void {
  const popup = container.querySelector(".commit-range-picker__popup") ?? container;
  const button = [...popup.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  act(() => button!.click());
}

describe("CommitRangePicker", () => {
  let setCommitRange: ReturnType<typeof vi.fn>;

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  function setup(base: string | null = "main", commitList = commits): void {
    setCommitRange = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("window", {
      pivis: {
        invoke: vi.fn(async (channel: string) =>
          channel === "git.commits"
            ? { kind: "ok", head: "head", mergeBase: "base", commits: commitList, truncated: false }
            : { kind: "ok", repoRoot: "/repo", files: [], truncated: false, fingerprint: "clean" },
        ),
      },
    });
    useDiffStore.setState({
      root: "/repo",
      selectedBase: base,
      commitRange: null,
      editSession: null,
      commentEditorFiles: new Set(),
      setCommitRange,
    });
  }

  it("stays hidden for HEAD and for a concrete base with no candidates", async () => {
    setup(null);
    const head = mount(<CommitRangePicker />);
    await settle();
    expect(head.container.querySelector(".commit-range-picker__trigger")).toBeNull();
    head.unmount();

    setup("main", []);
    const empty = mount(<CommitRangePicker />);
    await settle();
    expect(empty.container.querySelector(".commit-range-picker__trigger")).toBeNull();
    empty.unmount();
  });

  it("shows only the range scope and commits Working tree immediately", async () => {
    setup();
    const view = mount(<CommitRangePicker />);
    await settle();
    expect(view.container.textContent).toContain("Working tree");
    expect(view.container.textContent).not.toContain("main");
    await openPicker(view.container);
    clickText(view.container, "Working tree");
    expect(setCommitRange).toHaveBeenCalledWith(null);
    view.unmount();
  });

  it("commits the first endpoint immediately, then commits its inclusive range", async () => {
    setup();
    const view = mount(<CommitRangePicker />);
    await settle();
    await openPicker(view.container);
    clickText(view.container, "ccc");
    expect(setCommitRange).toHaveBeenCalledTimes(1);
    expect(setCommitRange).toHaveBeenLastCalledWith({ start: "ccc-full", end: "ccc-full" });
    expect(view.container.querySelector(".commit-range-picker__popup")).not.toBeNull();

    clickText(view.container, "aaa");
    expect(setCommitRange).toHaveBeenCalledTimes(2);
    expect(setCommitRange).toHaveBeenLastCalledWith({ start: "aaa-full", end: "ccc-full" });
    expect(view.container.querySelector(".commit-range-picker__popup")).toBeNull();
    view.unmount();
  });

  it("shows only the applicable scroll-edge fades", async () => {
    setup();
    const view = mount(<CommitRangePicker />);
    await settle();
    await openPicker(view.container);
    const listbox = view.container.querySelector<HTMLDivElement>(
      "[aria-label='Commits, newest first']",
    )!;
    Object.defineProperties(listbox, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    act(() => listbox.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(listbox.classList.contains("commit-range-picker__list--fade-top")).toBe(false);
    expect(listbox.classList.contains("commit-range-picker__list--fade-bottom")).toBe(true);

    listbox.scrollTop = 100;
    act(() => listbox.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(listbox.classList.contains("commit-range-picker__list--fade-top")).toBe(true);
    expect(listbox.classList.contains("commit-range-picker__list--fade-bottom")).toBe(true);
    view.unmount();
  });

  it("keeps 500 commits virtualized and supports keyboard selection", async () => {
    const history = Array.from({ length: 500 }, (_, index) => ({
      sha: `commit-${index}`,
      shortSha: `${index}`,
      subject: `Commit ${index}`,
      authorName: "A",
      authoredAt: index,
    }));
    setup("main", history);
    const view = mount(<CommitRangePicker />);
    await settle();
    await openPicker(view.container);
    const listbox = view.container.querySelector<HTMLDivElement>(
      "[aria-label='Commits, newest first']",
    )!;
    expect(view.container.querySelectorAll("[role=option]").length).toBeLessThan(40);
    act(() => {
      listbox.focus();
      listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    await settle();
    act(() => {
      listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(setCommitRange).toHaveBeenCalledWith({ start: "commit-0", end: "commit-0" });
    view.unmount();
  });

  it("Escape dismisses the popup without rolling back an already committed endpoint", async () => {
    setup();
    const view = mount(<CommitRangePicker />);
    await settle();
    await openPicker(view.container);
    clickText(view.container, "bbb");
    const trigger = view.container.querySelector<HTMLButtonElement>(
      ".commit-range-picker__trigger",
    )!;
    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => document.dispatchEvent(escapeEvent));
    await settle();
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(setCommitRange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    view.unmount();
  });
});
