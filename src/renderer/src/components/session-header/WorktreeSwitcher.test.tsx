// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "../../stores/diff-store.js";
import { type SessionViewState, useSessionsStore } from "../../stores/sessions-store.js";
import { createTranscriptState } from "../../stores/transcript.js";
import { WorktreeSwitcher } from "./WorktreeSwitcher.js";

const sessionId = "worktree-switcher-session" as SessionId;

type Invoke = (channel: string, args?: unknown) => Promise<unknown>;

function authorityProjection(
  isIdle: boolean,
  state: "following" | "synchronizing" = "following",
): SessionViewState["authorityProjection"] {
  const owner = { hostInstanceId: "host-worktree-switcher", sessionEpoch: 1 };
  const cursor = { ...owner, transportSequence: 1, snapshotSequence: 1 };
  return {
    semantic:
      state === "following"
        ? { state: "following", cursor }
        : { state: "synchronizing", lastCursor: cursor, reason: "test_gap" },
    authoritativeSnapshot: {
      owner,
      sdk: { isIdle },
    },
  } as SessionViewState["authorityProjection"];
}

function setSession(overrides: Partial<SessionViewState> = {}): void {
  const session = {
    sessionId,
    workspacePath: "/tmp/project",
    sessionFile: "/tmp/sessions/resumed.jsonl",
    status: "ready",
    availability: "available",
    runtimeSnapshot: { isIdle: true },
    authorityProjection: authorityProjection(true),
    transcript: createTranscriptState(),
    hasTreeHistory: true,
    hostInstanceId: "host-worktree-switcher",
    sessionEpoch: 1,
    editorRevision: 0,
    turnErrored: false,
    pendingDialogs: [],
    statusSegments: new Map(),
    widgets: new Map(),
    toasts: [],
    availableModels: [],
    commands: [],
    resumed: true,
    modelInitialized: true,
    ...overrides,
  } as unknown as SessionViewState;
  useSessionsStore.setState({ sessions: new Map([[sessionId, session]]) });
}

function installInvoke(handler?: Invoke): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(
    handler ??
      (async (channel: string) => {
        if (channel === "settings.get") return { diffIncludeRemoteBranches: false };
        if (channel === "git.branches") {
          return {
            kind: "ok",
            current: "main",
            branches: [{ name: "main", current: true, remote: false }],
          };
        }
        return { ok: true };
      }),
  );
  (globalThis.window as unknown as { pivis: unknown }).pivis = {
    invoke,
    on: vi.fn(() => () => {}),
  };
  return invoke;
}

function mount(node: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => root.render(node));
  });
  return {
    container,
    unmount: () => {
      act(() => flushSync(() => root.unmount()));
      container.remove();
    },
  };
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    (element as HTMLElement).click();
  });
}

function fillInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("HTMLInputElement value setter unavailable");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("WorktreeSwitcher", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    installInvoke();
    useDiffStore.setState({
      open: false,
      sessionId: null,
      editSession: null,
      commentEditorFiles: new Set(),
    });
  });

  afterEach(() => {
    useSessionsStore.setState({ sessions: new Map() });
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("labels historical workspace and existing-worktree sessions", () => {
    setSession({ hasTreeHistory: false, sessionFile: undefined });
    const pending = mount(<WorktreeSwitcher sessionId={sessionId} />);
    expect(pending.container.querySelector("[data-testid='worktree-switcher-trigger']")).toBeNull();
    pending.unmount();

    setSession({ hasTreeHistory: false });
    const headerOnly = mount(<WorktreeSwitcher sessionId={sessionId} />);
    expect(
      headerOnly.container.querySelector("[data-testid='worktree-switcher-trigger']"),
    ).toBeTruthy();
    headerOnly.unmount();

    setSession();
    const first = mount(<WorktreeSwitcher sessionId={sessionId} />);
    expect(
      first.container.querySelector("[data-testid='worktree-switcher-trigger']")?.textContent,
    ).toContain("Workspace");
    first.unmount();

    setSession({
      worktreePath: "/tmp/project-worktrees/swift-otter",
      worktreeName: "swift-otter",
      worktreeBranch: "feature/swift-otter",
      worktreeFromBase: "main",
    });
    const second = mount(<WorktreeSwitcher sessionId={sessionId} />);
    expect(
      second.container.querySelector("[data-testid='worktree-switcher-trigger']")?.textContent,
    ).toContain("swift-otter");
    second.unmount();
  });

  it("offers creation and attachment when the session is still in Workspace", () => {
    setSession();
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    click(container.querySelector("[data-testid='worktree-switcher-trigger']")!);

    expect(container.querySelector("[role='dialog']")?.textContent).toContain("Workspace");
    expect(buttonWithText(container, "New worktree").getAttribute("aria-pressed")).toBe("true");
    expect(buttonWithText(container, "Existing")).toBeTruthy();
    expect(container.querySelector("[aria-label='Choose worktree base branch']")).toBeNull();
    expect(container.querySelector(".worktree-switcher__helper")).toBeNull();
    unmount();
  });

  it.each([
    ["reports active work", authorityProjection(false)],
    ["is fenced", authorityProjection(true, "synchronizing")],
  ])(
    "does not let a compatibility-idle snapshot override authority that %s",
    (_label, projection) => {
      setSession({ authorityProjection: projection });
      const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
      click(container.querySelector("[data-testid='worktree-switcher-trigger']")!);

      expect(buttonWithText(container, "Create & switch").disabled).toBe(true);
      expect(container.querySelector(".worktree-switcher__blocked")?.textContent).toContain(
        "Wait for the current turn to finish.",
      );
      unmount();
    },
  );

  it("creates from the current checkout without accepting a renderer-selected base", async () => {
    setSession();
    const invoke = installInvoke(async (channel: string) => {
      if (channel === "session.createWorktree") {
        return {
          ok: true,
          worktreePath: "/tmp/project-worktrees/current-head",
          branch: "pi-vis-current-head",
          name: "current-head",
          base: "main",
        };
      }
      return { ok: true };
    });
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    click(container.querySelector("[data-testid='worktree-switcher-trigger']")!);

    await act(async () => {
      buttonWithText(container, "Create & switch").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("session.createWorktree", {
      sessionId,
      fromCurrentCheckout: true,
    });
    expect(useSessionsStore.getState().sessions.get(sessionId)).toMatchObject({
      worktreePath: "/tmp/project-worktrees/current-head",
      worktreeBranch: "pi-vis-current-head",
    });
    unmount();
  });

  it("keeps path copying as a distinct action in the popup", async () => {
    setSession();
    const invoke = installInvoke();
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    click(container.querySelector("[data-testid='worktree-switcher-trigger']")!);
    const copy = container.querySelector<HTMLButtonElement>("[aria-label='Copy worktree path']");
    expect(copy).toBeTruthy();

    await act(async () => {
      copy!.click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("clipboard.writeText", { text: "/tmp/project" });
    unmount();
  });

  it("attaches authoritatively, updates identity, and closes on success", async () => {
    setSession();
    const invoke = installInvoke(async (channel: string) => {
      if (channel === "settings.get") return { diffIncludeRemoteBranches: false };
      if (channel === "git.branches") return { kind: "ok", current: "main", branches: [] };
      if (channel === "session.attachWorktree") {
        return {
          ok: true,
          worktreePath: "/tmp/other-worktree",
          branch: "feature/other",
          name: "other-worktree",
          base: "feature/other",
        };
      }
      return { ok: true };
    });
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    click(container.querySelector("[data-testid='worktree-switcher-trigger']")!);
    click(buttonWithText(container, "Existing"));
    const input = container.querySelector<HTMLInputElement>(
      "[aria-label='Worktree directory path']",
    )!;
    fillInput(input, "/tmp/other-worktree/subdirectory");

    await act(async () => {
      buttonWithText(container, "Switch worktree").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("session.attachWorktree", {
      sessionId,
      path: "/tmp/other-worktree/subdirectory",
    });
    expect(useSessionsStore.getState().sessions.get(sessionId)).toMatchObject({
      worktreePath: "/tmp/other-worktree",
      worktreeBranch: "feature/other",
      worktreeName: "other-worktree",
    });
    expect(container.querySelector("[role='dialog']")).toBeNull();
    unmount();
  });

  it("returns a linked-worktree session to Workspace", async () => {
    setSession({
      worktreePath: "/tmp/project-worktrees/current",
      worktreeName: "current",
      worktreeBranch: "feature/current",
      worktreeFromBase: "main",
    });
    const invoke = installInvoke(async (channel: string) => {
      if (channel === "session.attachWorktree") return { ok: true, workspace: true };
      return { ok: true };
    });
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    click(container.querySelector("[data-testid='worktree-switcher-trigger']")!);
    click(buttonWithText(container, "Existing"));
    fillInput(
      container.querySelector<HTMLInputElement>("[aria-label='Worktree directory path']")!,
      "/tmp/project",
    );

    await act(async () => {
      buttonWithText(container, "Switch worktree").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("session.attachWorktree", {
      sessionId,
      path: "/tmp/project",
    });
    expect(useSessionsStore.getState().sessions.get(sessionId)).toMatchObject({
      worktreePath: undefined,
      worktreeBranch: undefined,
      worktreeName: undefined,
    });
    expect(
      container.querySelector("[data-testid='worktree-switcher-trigger']")?.textContent,
    ).toContain("Workspace");
    unmount();
  });

  it("does not switch while the diff viewer owns an unsaved draft", async () => {
    setSession();
    const invoke = installInvoke();
    useDiffStore.setState({
      open: true,
      sessionId,
      commentEditorFiles: new Set(["draft.ts"]),
    });
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    click(container.querySelector("[data-testid='worktree-switcher-trigger']")!);

    await act(async () => {
      buttonWithText(container, "Create & switch").click();
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalledWith("session.createWorktree", expect.anything());
    expect(container.querySelector("[role='alert']")?.textContent).toContain("open diff draft");
    unmount();
  });

  it("keeps the popup open with a durable inline failure", async () => {
    setSession();
    installInvoke(async (channel: string) => {
      if (channel === "settings.get") return { diffIncludeRemoteBranches: false };
      if (channel === "git.branches") return { kind: "ok", current: "main", branches: [] };
      if (channel === "session.attachWorktree") {
        return { ok: false, error: "That directory belongs to another repository." };
      }
      return { ok: true };
    });
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    click(container.querySelector("[data-testid='worktree-switcher-trigger']")!);
    click(buttonWithText(container, "Existing"));
    const input = container.querySelector<HTMLInputElement>(
      "[aria-label='Worktree directory path']",
    )!;
    fillInput(input, "/tmp/wrong-repo");

    await act(async () => {
      buttonWithText(container, "Switch worktree").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[role='dialog']")).toBeTruthy();
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "belongs to another repository",
    );
    unmount();
  });

  it("cannot be dismissed while pending and preserves a later failure across reopen", async () => {
    setSession();
    let resolveOperation!: (value: { ok: false; error: string }) => void;
    installInvoke(async (channel: string) => {
      if (channel === "session.createWorktree") {
        return new Promise((resolve) => {
          resolveOperation = resolve;
        });
      }
      return { ok: true };
    });
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='worktree-switcher-trigger']",
    )!;
    click(trigger);
    act(() => buttonWithText(container, "Create & switch").click());
    await act(async () => Promise.resolve());

    expect(buttonWithText(container, "Cancel").disabled).toBe(true);
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    click(trigger);
    expect(container.querySelector("[role='dialog']")).toBeTruthy();

    await act(async () => {
      resolveOperation({ ok: false, error: "Recover the checkout at /tmp/recovery-worktree." });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "/tmp/recovery-worktree",
    );
    click(buttonWithText(container, "Cancel"));
    expect(container.querySelector("[role='dialog']")).toBeNull();
    click(trigger);
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "/tmp/recovery-worktree",
    );
    unmount();
  });

  it("owns bare Escape, restores trigger focus, and does not leak it", async () => {
    setSession();
    const { container, unmount } = mount(<WorktreeSwitcher sessionId={sessionId} />);
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='worktree-switcher-trigger']",
    )!;
    click(trigger);
    await act(async () => Promise.resolve());
    expect(document.activeElement?.textContent).toContain("New worktree");
    const leaked = vi.fn();
    window.addEventListener("keydown", leaked);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    act(() => window.dispatchEvent(event));
    await act(async () => Promise.resolve());

    expect(event.defaultPrevented).toBe(true);
    expect(leaked).not.toHaveBeenCalled();
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    window.removeEventListener("keydown", leaked);
    unmount();
  });
});
