// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { Composer } from "./Composer.js";

const SESSION_A = "session-a" as SessionId;
const WORKSPACE = "/tmp/ws";

function setField<T extends object>(obj: T, patch: Partial<T>): void {
  Object.assign(obj as T, patch);
}

function mountComposer(): {
  unmount: () => void;
  textarea: () => HTMLTextAreaElement;
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => {
      root.render(<Composer sessionId={SESSION_A} />);
    });
  });
  return {
    root,
    container,
    unmount: () => {
      act(() => {
        flushSync(() => {
          root.unmount();
        });
      });
      document.body.removeChild(container);
    },
    textarea: () => container.querySelector<HTMLTextAreaElement>("textarea")!,
  };
}

function setValueAndDispatch(el: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
      ?.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keyDown(
  el: HTMLTextAreaElement,
  key: string,
  opts: KeyboardEventInit = {},
): KeyboardEvent {
  let ev!: KeyboardEvent;
  act(() => {
    ev = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    el.dispatchEvent(ev);
  });
  return ev;
}

function pickedFile(name: string, type: string, path: string): File {
  const file = new File(["content"], name, { type });
  Object.defineProperty(file, "path", { value: path });
  return file;
}

function dispatchFiles(input: HTMLInputElement, files: File[]): void {
  act(() => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Composer autocomplete — A1, A2, A3", () => {
  let invokeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: SESSION_A,
      workspaces: new Map(),
      activeWorkspacePath: WORKSPACE,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    const s = useSessionsStore.getState().sessions.get(SESSION_A)!;
    // Live + has a model so the no-model guard doesn't bail sends.
    setField(s, { status: "ready", currentModel: "claude-3.5-sonnet" });
    invokeSpy = vi.fn().mockImplementation((_channel: string, payload: unknown) => {
      const p = payload as { command?: { type: string } };
      if (p?.command?.type === "prompt") return Promise.resolve({ success: true });
      return Promise.resolve({ success: true });
    });
    // @ts-expect-error stubbing preload bridge
    globalThis.window.pivis = {
      invoke: invokeSpy,
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? file.name,
    };
  });

  afterEach(() => {
    // @ts-expect-error cleanup
    delete globalThis.window.pivis;
  });

  function suggestionCount(container: HTMLElement): number {
    return container.querySelectorAll(".composer__suggestion").length;
  }

  it("A1: typing /lo shows suggestions; ESC hides them (A2)", () => {
    const { container, textarea } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "/lo");
    // suggestions render (login, logout, … all built-ins starting with "lo")
    expect(suggestionCount(container)).toBeGreaterThan(0);

    // ESC hides them
    keyDown(ta, "Escape");
    expect(suggestionCount(container)).toBe(0);
  });

  it("A3: after dismissal, typing more re-shows suggestions", () => {
    const { container, textarea } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "/lo");
    expect(suggestionCount(container)).toBeGreaterThan(0);
    keyDown(ta, "Escape");
    expect(suggestionCount(container)).toBe(0);
    setValueAndDispatch(ta, "/log");
    expect(suggestionCount(container)).toBeGreaterThan(0);
  });

  it("after dismissing visible /log suggestions, Enter submits literal /log (not /login )", () => {
    const { container, textarea } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "/log");
    expect(suggestionCount(container)).toBeGreaterThan(0);
    // ESC dismisses the suggestions (text stays "/log")
    keyDown(ta, "Escape");
    expect(suggestionCount(container)).toBe(0);

    // Enter submits the literal text. The prompt command message must be
    // "/log" — NOT an applied completion like "/login ".
    invokeSpy.mockClear();
    keyDown(ta, "Enter");
    const calls = invokeSpy.mock.calls.filter(
      (c) => (c[1] as { command?: { type: string } }).command?.type === "prompt",
    );
    expect(calls.length).toBe(1);
    const payload = calls[0]![1] as { command: { message: string } };
    expect(payload.command.message).toBe("/log");
  });
});

describe("Composer file attachments", () => {
  let invokeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: SESSION_A,
      workspaces: new Map(),
      activeWorkspacePath: WORKSPACE,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    const s = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(s, {
      status: "ready",
      currentModel: "text-model",
      availableModels: [{ id: "text-model", name: "Text Model", input: ["text"] }],
    });
    invokeSpy = vi.fn().mockResolvedValue({ success: true });
    // @ts-expect-error stubbing preload bridge
    globalThis.window.pivis = {
      invoke: invokeSpy,
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? file.name,
    };
  });

  afterEach(() => {
    // @ts-expect-error cleanup
    delete globalThis.window.pivis;
  });

  it("keeps the picker available for text-only models", () => {
    const { container, unmount } = mountComposer();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const button = container.querySelector<HTMLButtonElement>(".composer__attach-btn")!;
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => undefined);

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(input.getAttribute("accept")).toBeNull();
    expect(button.title).toBe("Attach files");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.toasts).toEqual([]);
    unmount();
  });

  it("falls back to image file paths with one warning when the model lacks image support", () => {
    const { container, textarea, unmount } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "Please inspect");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    dispatchFiles(input, [pickedFile("diagram.png", "image/png", "/tmp/diagram.png")]);

    expect(textarea().value).toBe("Please inspect\n/tmp/diagram.png");
    expect(container.querySelectorAll(".composer__attachment-item").length).toBe(0);
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe("warning");
    expect(toasts[0]?.message).toContain("doesn't support image input");
    unmount();
  });
});
