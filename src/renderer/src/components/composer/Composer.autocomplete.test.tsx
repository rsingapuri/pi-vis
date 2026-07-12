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
const SESSION_B = "session-b" as SessionId;
const WORKSPACE = "/tmp/ws";
const HOST_ID = "11111111-1111-4111-8111-111111111111";

function installSuccessfulInvoke(invokeSpy: ReturnType<typeof vi.fn>): void {
  invokeSpy.mockImplementation((channel: string, payload: unknown) => {
    if (channel === "session.editorPatch") {
      const revision = (payload as { revision: number }).revision;
      return Promise.resolve({ accepted: true, revision, text: "" });
    }
    if (channel === "session.submit") {
      const submission = (payload as { submission: { intentId: string; editorRevision: number } })
        .submission;
      return Promise.resolve({
        intentId: submission.intentId,
        hostInstanceId: HOST_ID,
        sessionEpoch: 0,
        editorRevision: submission.editorRevision,
        disposition: "consumed",
      });
    }
    return Promise.resolve({ success: true });
  });
}

function submittedTexts(invokeSpy: ReturnType<typeof vi.fn>): string[] {
  return invokeSpy.mock.calls
    .filter(([channel]) => channel === "session.submit")
    .map(([, payload]) => (payload as { submission: { text: string } }).submission.text);
}

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
    setField(s, {
      status: "ready",
      availability: "available",
      currentModel: "claude-3.5-sonnet",
      hostInstanceId: HOST_ID,
      sessionEpoch: 0,
      editorRevision: 0,
    });
    invokeSpy = vi.fn();
    installSuccessfulInvoke(invokeSpy);
    // @ts-expect-error stubbing preload bridge
    globalThis.window.pivis = {
      invoke: invokeSpy,
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? file.name,
    };
  });

  afterEach(async () => {
    await vi.waitFor(() => {
      for (const session of useSessionsStore.getState().sessions.values()) {
        expect(session.editorPatchPending).toBe(0);
      }
    });
    // @ts-expect-error cleanup
    delete globalThis.window.pivis;
  });

  function suggestionCount(container: HTMLElement): number {
    return container.querySelectorAll(".composer__suggestion").length;
  }

  it("disables submission controls while runtime availability is transitioning", () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(session, { availability: "transitioning" });
    const { container, textarea, unmount } = mountComposer();

    expect(textarea().disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".composer__attach-btn")?.disabled).toBe(
      true,
    );
    unmount();
  });

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

  it("synchronizes an Enter-completed extension command before submitting it", async () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(session, {
      commands: [
        {
          name: "widget-on",
          description: "Open widget",
          source: "extension",
        },
      ],
    });
    const { container, textarea } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "/wid");
    expect(suggestionCount(container)).toBe(1);

    keyDown(ta, "Enter");

    await vi.waitFor(() => expect(submittedTexts(invokeSpy)).toEqual(["/widget-on"]));
    const patches = invokeSpy.mock.calls
      .filter(([channel]) => channel === "session.editorPatch")
      .map(([, payload]) => payload as { revision: number; text: string });
    const completedPatch = patches.find((patch) => patch.text === "/widget-on");
    const submission = invokeSpy.mock.calls.find(
      ([channel]) => channel === "session.submit",
    )?.[1] as {
      submission: { editorRevision: number };
    };
    expect(completedPatch).toBeDefined();
    expect(submission.submission.editorRevision).toBe(completedPatch?.revision);
  });

  it("clears /compact locally and in the authoritative editor after dispatch", async () => {
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/compact");

    keyDown(textarea(), "Enter");

    await vi.waitFor(() => {
      expect(
        invokeSpy.mock.calls.some(
          ([channel, payload]) =>
            channel === "session.sendCommand" &&
            (payload as { command?: { type?: string } }).command?.type === "compact",
        ),
      ).toBe(true);
      const commandPayload = invokeSpy.mock.calls.find(
        ([channel]) => channel === "session.sendCommand",
      )?.[1];
      expect(commandPayload).toMatchObject({
        expectedHostInstanceId: HOST_ID,
        expectedSessionEpoch: 0,
      });
      expect(textarea().value).toBe("");
      const patches = invokeSpy.mock.calls.filter(([channel]) => channel === "session.editorPatch");
      expect(patches.at(-1)?.[1]).toMatchObject({ text: "", attachments: [] });
    });
    unmount();
  });

  it("clears /reload against its correlated successor epoch", async () => {
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      if (channel === "session.reload") {
        return Promise.resolve({
          success: true,
          disposition: "completed",
          successorIdentity: { hostInstanceId: HOST_ID, sessionEpoch: 1 },
        });
      }
      if (channel === "session.runtimeResync") {
        useSessionsStore.setState((state) => {
          const sessions = new Map(state.sessions);
          sessions.set(SESSION_A, {
            ...sessions.get(SESSION_A)!,
            availability: "available",
            status: "ready",
            sessionEpoch: 1,
          });
          return { sessions };
        });
        return Promise.resolve({
          availability: "available",
          hostInstanceId: HOST_ID,
          sessionEpoch: 1,
          receivedAt: Date.now(),
        });
      }
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/reload");
    keyDown(textarea(), "Enter");

    await vi.waitFor(() => expect(textarea().value).toBe(""));
    const reloadPayload = invokeSpy.mock.calls.find(
      ([channel]) => channel === "session.reload",
    )?.[1];
    expect(reloadPayload).toMatchObject({
      sessionId: SESSION_A,
      request: {
        requestId: expect.any(String),
        intentId: expect.any(String),
        expectedHostInstanceId: HOST_ID,
        expectedSessionEpoch: 0,
        sourceText: "/reload",
      },
    });
    const patches = invokeSpy.mock.calls.filter(([channel]) => channel === "session.editorPatch");
    expect(patches.at(-1)?.[1]).toMatchObject({
      expectedHostInstanceId: HOST_ID,
      expectedSessionEpoch: 1,
      text: "",
    });
    unmount();
  });

  it("waits for the command editor patch before dispatching /compact", async () => {
    let resolveFirstPatch!: (value: unknown) => void;
    const firstPatch = new Promise((resolve) => {
      resolveFirstPatch = resolve;
    });
    let patchCount = 0;
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        patchCount++;
        if (patchCount === 1) return firstPatch;
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/compact");
    keyDown(textarea(), "Enter");
    await Promise.resolve();
    expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.sendCommand")).toBe(false);

    await act(async () => {
      resolveFirstPatch({ accepted: true, revision: 1, text: "/compact", attachments: [] });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.sendCommand")).toBe(
        true,
      );
      expect(textarea().value).toBe("");
    });
    unmount();
  });

  it("does not dispatch command text after its editor patch is rejected", async () => {
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: false,
          revision: (payload as { revision: number }).revision,
          text: "extension-owned editor",
          attachments: [],
          conflictText: (payload as { text: string }).text,
        });
      }
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/compact rejected");
    keyDown(textarea(), "Enter");

    await vi.waitFor(() =>
      expect(useSessionsStore.getState().sessions.get(SESSION_A)?.toasts.at(-1)?.message).toContain(
        "both versions",
      ),
    );
    expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.sendCommand")).toBe(false);
    expect(textarea().value).toBe("/compact rejected");
    unmount();
  });

  it("retries a transient editor transport failure before unchanged command dispatch", async () => {
    let patchAttempt = 0;
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.runtimeResync") {
        return Promise.resolve({
          availability: "available",
          hostInstanceId: HOST_ID,
          sessionEpoch: 0,
          receivedAt: Date.now(),
          snapshot: {
            hostInstanceId: HOST_ID,
            sessionEpoch: 0,
            snapshotSequence: 1,
            capturedAt: Date.now(),
            isStreaming: false,
            isIdle: true,
            isCompacting: false,
            isRetrying: false,
            retryAttempt: 0,
            isBashRunning: false,
            model: { id: "claude-3.5-sonnet" },
            thinkingLevel: "medium",
            sessionId: SESSION_A,
            pendingMessageCount: 0,
            steering: [],
            followUp: [],
            hostFacts: {
              submitting: false,
              actualCompaction: false,
              navigation: false,
              pendingDialogs: 0,
              custodyCount: 0,
            },
            catalog: {
              notifications: [],
              statuses: {},
              widgets: {},
              capabilityDiagnostics: [],
            },
            editor: { revision: 0, text: "/compact retry", attachments: [] },
          },
        });
      }
      if (channel === "session.editorPatch") {
        patchAttempt++;
        if (patchAttempt === 1) return Promise.reject(new Error("temporary transport failure"));
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/compact retry");
    keyDown(textarea(), "Enter");
    await vi.waitFor(() =>
      expect(useSessionsStore.getState().sessions.get(SESSION_A)?.toasts.at(-1)?.message).toContain(
        "synchronization failed",
      ),
    );
    expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.sendCommand")).toBe(false);

    keyDown(textarea(), "Enter");
    await vi.waitFor(() => {
      expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.sendCommand")).toBe(
        true,
      );
      expect(textarea().value).toBe("");
    });
    unmount();
  });

  it("clears a recognized /compact command after a surfaced operation failure", async () => {
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      if (channel === "session.sendCommand") {
        return Promise.resolve({ success: false, error: "Compaction failed" });
      }
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/compact");

    keyDown(textarea(), "Enter");

    await vi.waitFor(() => {
      expect(useSessionsStore.getState().sessions.get(SESSION_A)?.toasts.at(-1)?.message).toBe(
        "Compaction failed",
      );
    });
    await vi.waitFor(() => expect(textarea().value).toBe(""));
    const patches = invokeSpy.mock.calls.filter(([channel]) => channel === "session.editorPatch");
    expect(patches.at(-1)?.[1]).toMatchObject({ text: "", attachments: [] });
    unmount();
  });

  it("does not let an unmounted command completion clear a remounted draft", async () => {
    let resolveCommand!: (value: unknown) => void;
    const commandResult = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      if (channel === "session.sendCommand") return commandResult;
      return Promise.resolve({ success: true });
    });
    const first = mountComposer();
    setValueAndDispatch(first.textarea(), "/compact delayed");
    keyDown(first.textarea(), "Enter");
    await vi.waitFor(() =>
      expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.sendCommand")).toBe(
        true,
      ),
    );
    first.unmount();

    const second = mountComposer();
    setValueAndDispatch(second.textarea(), "new draft after remount");
    await act(async () => {
      resolveCommand({ success: true });
      await Promise.resolve();
    });

    expect(second.textarea().value).toBe("new draft after remount");
    const patches = invokeSpy.mock.calls
      .filter(([channel]) => channel === "session.editorPatch")
      .map(([, payload]) => payload as { text: string });
    expect(patches.at(-1)?.text).toBe("new draft after remount");
    expect(patches.some((patch) => patch.text === "")).toBe(false);
    second.unmount();
  });

  it("does not let an old command response clear a replacement session epoch", async () => {
    let resolveCommand!: (value: unknown) => void;
    const commandResult = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      if (channel === "session.sendCommand") return commandResult;
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/compact old epoch");
    keyDown(textarea(), "Enter");
    await vi.waitFor(() =>
      expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.sendCommand")).toBe(
        true,
      ),
    );

    act(() => {
      useSessionsStore.setState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(SESSION_A, { ...sessions.get(SESSION_A)!, sessionEpoch: 1 });
        return { sessions };
      });
    });
    await act(async () => {
      resolveCommand({ success: true });
      await Promise.resolve();
    });

    expect(textarea().value).toBe("/compact old epoch");
    const patches = invokeSpy.mock.calls
      .filter(([channel]) => channel === "session.editorPatch")
      .map(([, payload]) => payload as { text: string });
    expect(patches.some((patch) => patch.text === "")).toBe(false);
    unmount();
  });

  it("does not clear a command when its runtime becomes unavailable before response", async () => {
    let resolveCommand!: (value: unknown) => void;
    const commandResult = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      if (channel === "session.sendCommand") return commandResult;
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/compact unavailable");
    keyDown(textarea(), "Enter");
    await vi.waitFor(() =>
      expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.sendCommand")).toBe(
        true,
      ),
    );

    act(() => {
      useSessionsStore.setState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(SESSION_A, { ...sessions.get(SESSION_A)!, availability: "unavailable" });
        return { sessions };
      });
    });
    await act(async () => {
      resolveCommand({ success: false, error: "Host exited" });
      await Promise.resolve();
    });

    expect(textarea().value).toBe("/compact unavailable");
    const patches = invokeSpy.mock.calls
      .filter(([channel]) => channel === "session.editorPatch")
      .map(([, payload]) => payload as { text: string });
    expect(patches.some((patch) => patch.text === "")).toBe(false);
    unmount();
  });

  it("clears an accepted extension command after the host advances editor revision", async () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(session, {
      commands: [{ name: "widget-on", description: "Open widget", source: "extension" }],
    });
    let resolveSubmit!: (value: unknown) => void;
    const submitResult = new Promise((resolve) => {
      resolveSubmit = resolve;
    });
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      if (channel === "session.submit") return submitResult;
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/widget-on");
    keyDown(textarea(), "Enter");
    await vi.waitFor(() =>
      expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.submit")).toBe(true),
    );
    const submission = invokeSpy.mock.calls.find(
      ([channel]) => channel === "session.submit",
    )?.[1] as { submission: { intentId: string; editorRevision: number } };

    act(() => {
      useSessionsStore.setState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(SESSION_A, {
          ...sessions.get(SESSION_A)!,
          editorRevision: submission.submission.editorRevision + 1,
        });
        return { sessions };
      });
    });
    await act(async () => {
      resolveSubmit({
        intentId: submission.submission.intentId,
        hostInstanceId: HOST_ID,
        sessionEpoch: 0,
        editorRevision: submission.submission.editorRevision,
        disposition: "consumed",
      });
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(textarea().value).toBe(""));
    unmount();
  });

  it("preserves a same-payload extension injection after submission acceptance", async () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(session, {
      commands: [{ name: "keep", description: "Keep editor", source: "extension" }],
    });
    let resolveSubmit!: (value: unknown) => void;
    const submitResult = new Promise((resolve) => {
      resolveSubmit = resolve;
    });
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      if (channel === "session.submit") return submitResult;
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "/keep");
    keyDown(textarea(), "Enter");
    await vi.waitFor(() =>
      expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.submit")).toBe(true),
    );
    const submission = invokeSpy.mock.calls.find(
      ([channel]) => channel === "session.submit",
    )?.[1] as { submission: { intentId: string; editorRevision: number } };

    act(() => {
      useSessionsStore.setState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(SESSION_A, {
          ...sessions.get(SESSION_A)!,
          editorRevision: submission.submission.editorRevision + 2,
          editorInjection: {
            text: "/keep",
            nonce: 99_001,
            revision: submission.submission.editorRevision + 2,
          },
        });
        return { sessions };
      });
    });
    await vi.waitFor(() => expect(textarea().value).toBe("/keep"));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorInjection?.nonce).toBe(
      99_001,
    );
    await act(async () => {
      resolveSubmit({
        intentId: submission.submission.intentId,
        hostInstanceId: HOST_ID,
        sessionEpoch: 0,
        editorRevision: submission.submission.editorRevision,
        disposition: "consumed",
      });
      await Promise.resolve();
    });

    expect(textarea().value).toBe("/keep");
    unmount();
  });

  it("keeps an injected unknown slash command as text instead of a file tile", async () => {
    const { container, textarea, unmount } = mountComposer();

    act(() => {
      useSessionsStore.getState().injectEditorText(SESSION_A, "/123.foo_bar");
    });

    await vi.waitFor(() => expect(textarea().value).toBe("/123.foo_bar"));
    expect(container.querySelectorAll(".composer__attachment")).toHaveLength(0);
    unmount();
  });

  it("preserves newer typing while an accepted submission is settling", async () => {
    let resolveSubmit!: (value: unknown) => void;
    const submitResult = new Promise((resolve) => {
      resolveSubmit = resolve;
    });
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
          text: (payload as { text: string }).text,
          attachments: [],
        });
      }
      if (channel === "session.submit") return submitResult;
      return Promise.resolve({ success: true });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "first prompt");
    keyDown(textarea(), "Enter");
    await vi.waitFor(() =>
      expect(invokeSpy.mock.calls.some(([channel]) => channel === "session.submit")).toBe(true),
    );
    const submission = invokeSpy.mock.calls.find(
      ([channel]) => channel === "session.submit",
    )?.[1] as { submission: { intentId: string; editorRevision: number } };
    setValueAndDispatch(textarea(), "newer typing");

    await act(async () => {
      resolveSubmit({
        intentId: submission.submission.intentId,
        hostInstanceId: HOST_ID,
        sessionEpoch: 0,
        editorRevision: submission.submission.editorRevision,
        disposition: "consumed",
      });
      await Promise.resolve();
    });

    expect(textarea().value).toBe("newer typing");
    unmount();

    const remounted = mountComposer();
    expect(remounted.textarea().value).toBe("newer typing");
    remounted.unmount();
  });

  it("fences already-queued editor patches after an extension conflict", async () => {
    let resolveFirst!: (value: {
      accepted: boolean;
      revision: number;
      text: string;
      attachments: unknown[];
      conflictText: string;
    }) => void;
    const firstResult = new Promise<{
      accepted: boolean;
      revision: number;
      text: string;
      attachments: unknown[];
      conflictText: string;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel !== "session.editorPatch") return Promise.resolve({ success: true });
      const patch = payload as { revision: number; text: string };
      if (patch.revision === 1) return firstResult;
      return Promise.resolve({
        accepted: true,
        revision: patch.revision,
        text: patch.text,
        attachments: [],
      });
    });
    const { textarea, unmount } = mountComposer();
    setValueAndDispatch(textarea(), "local one");
    setValueAndDispatch(textarea(), "local two");
    await vi.waitFor(() =>
      expect(
        invokeSpy.mock.calls.filter(([channel]) => channel === "session.editorPatch"),
      ).toHaveLength(1),
    );

    await act(async () => {
      resolveFirst({
        accepted: false,
        revision: 1,
        text: "extension text",
        attachments: [],
        conflictText: "local one",
      });
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        invokeSpy.mock.calls.filter(([channel]) => channel === "session.editorPatch"),
      ).toHaveLength(1),
    );
    expect(textarea().value).toBe("local two");

    setValueAndDispatch(textarea(), "explicitly reconciled");
    await vi.waitFor(() => {
      const patches = invokeSpy.mock.calls.filter(([channel]) => channel === "session.editorPatch");
      expect(patches).toHaveLength(2);
      expect(patches[1]?.[1]).toMatchObject({
        baseRevision: 1,
        revision: 2,
        text: "explicitly reconciled",
      });
    });
    unmount();
  });

  it("after dismissing visible /log suggestions, Enter submits literal /log (not /login )", async () => {
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
    await vi.waitFor(() => expect(submittedTexts(invokeSpy)).toEqual(["/log"]));
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
      diffComments: new Map(),
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    const s = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(s, {
      status: "ready",
      availability: "available",
      currentModel: "text-model",
      availableModels: [{ id: "text-model", name: "Text Model", input: ["text"] }],
      hostInstanceId: HOST_ID,
      sessionEpoch: 0,
      editorRevision: 0,
    });
    invokeSpy = vi.fn();
    installSuccessfulInvoke(invokeSpy);
    // @ts-expect-error stubbing preload bridge
    globalThis.window.pivis = {
      invoke: invokeSpy,
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? file.name,
    };
  });

  afterEach(async () => {
    await vi.waitFor(() => {
      for (const session of useSessionsStore.getState().sessions.values()) {
        expect(session.editorPatchPending).toBe(0);
      }
    });
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

  it("keeps comments and attachments staged across extension slash commands", async () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(session, {
      availableModels: [{ id: "text-model", name: "Image Model", input: ["text", "image"] }],
      commands: [{ name: "widget-on", description: "Open widget", source: "extension" }],
      editorAttachments: [
        { kind: "file", name: "notes.txt", path: "/tmp/notes.txt" },
        {
          kind: "image",
          name: "diagram.png",
          path: "/tmp/diagram.png",
          dataUrl: "data:image/png;base64,eA==",
        },
      ],
    });
    useSessionsStore.getState().setDiffComment(SESSION_A, {
      filePath: "src/a.ts",
      lineNumber: 7,
      lineText: "return value;",
      text: "Explain this return.",
    });
    const { container, textarea, unmount } = mountComposer();
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".composer__attachment-item")).toHaveLength(3),
    );

    setValueAndDispatch(textarea(), "/widget-on");
    keyDown(textarea(), "Enter");

    await vi.waitFor(() => expect(submittedTexts(invokeSpy)).toEqual(["/widget-on"]));
    const slashSubmission = invokeSpy.mock.calls.find(
      ([channel]) => channel === "session.submit",
    )?.[1] as { submission: { text: string; images: unknown[] } };
    expect(slashSubmission.submission.images).toEqual([]);
    await vi.waitFor(() => expect(textarea().value).toBe(""));
    expect(container.querySelectorAll(".composer__attachment-item")).toHaveLength(3);
    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A)).toHaveLength(1);
    expect(
      invokeSpy.mock.calls.some(
        ([channel, payload]) =>
          channel === "session.editorPatch" &&
          (payload as { text?: string }).text === "" &&
          (payload as { attachments?: unknown[] }).attachments?.length === 0,
      ),
    ).toBe(false);

    setValueAndDispatch(textarea(), "  /tmp/notes.txt is context, not a command");
    keyDown(textarea(), "Enter");
    await vi.waitFor(() => expect(submittedTexts(invokeSpy)).toHaveLength(2));
    const promptSubmission = invokeSpy.mock.calls.filter(
      ([channel]) => channel === "session.submit",
    )[1]?.[1] as { submission: { text: string; images: unknown[] } };
    expect(promptSubmission.submission.text).toContain("/tmp/notes.txt");
    expect(promptSubmission.submission.text).toContain("### User comments on the code");
    expect(promptSubmission.submission.text).toContain(
      "  /tmp/notes.txt is context, not a command",
    );
    expect(promptSubmission.submission.images).toHaveLength(1);
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".composer__attachment-item")).toHaveLength(0),
    );
    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A)).toEqual([]);
    unmount();
  });

  it("submits and consumes an image-only ordinary prompt", async () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(session, {
      availableModels: [{ id: "text-model", name: "Image Model", input: ["text", "image"] }],
      editorAttachments: [
        {
          kind: "image",
          name: "diagram.png",
          path: "/tmp/diagram.png",
          dataUrl: "data:image/png;base64,eA==",
        },
      ],
    });
    const { container, textarea, unmount } = mountComposer();
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".composer__attachment-item")).toHaveLength(1),
    );

    keyDown(textarea(), "Enter");

    await vi.waitFor(() => expect(submittedTexts(invokeSpy)).toEqual([""]));
    const submission = invokeSpy.mock.calls.find(
      ([channel]) => channel === "session.submit",
    )?.[1] as { submission: { images: Array<{ data: string; mimeType: string }> } } | undefined;
    expect(submission?.submission.images).toEqual([
      { type: "image", data: "eA==", mimeType: "image/png" },
    ]);
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".composer__attachment-item")).toHaveLength(0),
    );
    unmount();
  });

  it("shows non-image files as tiles and sends their paths with the prompt", async () => {
    const { container, textarea, unmount } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "Please inspect");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    dispatchFiles(input, [pickedFile("notes.txt", "text/plain", "/tmp/notes.txt")]);

    expect(textarea().value).toBe("Please inspect");
    expect(container.querySelectorAll(".composer__attachment-item--file").length).toBe(1);

    keyDown(ta, "Enter");
    await vi.waitFor(() =>
      expect(submittedTexts(invokeSpy)).toEqual(["/tmp/notes.txt\nPlease inspect"]),
    );
    unmount();
  });

  it("submits same text again when the effective attachment payload changes", async () => {
    let resolveFirstSubmission!: (value: unknown) => void;
    const firstSubmission = new Promise((resolve) => {
      resolveFirstSubmission = resolve;
    });
    let submissionCount = 0;
    invokeSpy.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        const revision = (payload as { revision: number }).revision;
        return Promise.resolve({ accepted: true, revision, text: "" });
      }
      if (channel === "session.submit") {
        submissionCount++;
        const submission = (
          payload as {
            submission: { intentId: string; editorRevision: number };
          }
        ).submission;
        const result = {
          intentId: submission.intentId,
          hostInstanceId: HOST_ID,
          sessionEpoch: 0,
          editorRevision: submission.editorRevision,
          disposition: "consumed",
        };
        return submissionCount === 1 ? firstSubmission : Promise.resolve(result);
      }
      return Promise.resolve({ success: true });
    });
    const { container, textarea, unmount } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "same text");

    keyDown(ta, "Enter");
    await vi.waitFor(() => expect(submittedTexts(invokeSpy)).toEqual(["same text"]));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    dispatchFiles(input, [pickedFile("second.txt", "text/plain", "/tmp/second.txt")]);
    keyDown(ta, "Enter");

    await vi.waitFor(() =>
      expect(submittedTexts(invokeSpy)).toEqual(["same text", "/tmp/second.txt\nsame text"]),
    );
    resolveFirstSubmission({
      intentId: "first",
      hostInstanceId: HOST_ID,
      sessionEpoch: 0,
      editorRevision: 1,
      disposition: "consumed",
    });
    await Promise.resolve();
    unmount();
  });

  it("does not submit while an asynchronous image read owns attachment custody", async () => {
    const { textarea, unmount } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "wait for image");
    useSessionsStore.getState().beginEditorAttachmentRead(SESSION_A);

    keyDown(ta, "Enter");
    await Promise.resolve();
    expect(submittedTexts(invokeSpy)).toEqual([]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.toasts.at(-1)?.message).toContain(
      "finish loading",
    );

    useSessionsStore.getState().endEditorAttachmentRead(SESSION_A);
    keyDown(ta, "Enter");
    await vi.waitFor(() => expect(submittedTexts(invokeSpy)).toEqual(["wait for image"]));
    unmount();
  });

  it("patches a loaded image with text typed after the read began", async () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(session, {
      availableModels: [{ id: "text-model", name: "Image Model", input: ["text", "image"] }],
    });
    let deferredReader:
      | {
          result: string | null;
          onload: (() => void) | null;
        }
      | undefined;
    class DeferredFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(): void {
        deferredReader = this;
      }
    }
    const originalFileReader = globalThis.FileReader;
    vi.stubGlobal("FileReader", DeferredFileReader);
    try {
      const { container, textarea, unmount } = mountComposer();
      setValueAndDispatch(textarea(), "before");
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      dispatchFiles(input, [pickedFile("diagram.png", "image/png", "/tmp/diagram.png")]);
      setValueAndDispatch(textarea(), "newer typing");

      act(() => {
        if (!deferredReader) throw new Error("FileReader was not started");
        deferredReader.result = "data:image/png;base64,eA==";
        deferredReader.onload?.();
      });

      await vi.waitFor(() => {
        const patches = invokeSpy.mock.calls.filter(
          ([channel]) => channel === "session.editorPatch",
        );
        expect(patches.at(-1)?.[1]).toMatchObject({
          text: "newer typing",
          attachments: [expect.objectContaining({ kind: "image", name: "diagram.png" })],
        });
      });
      expect(textarea().value).toBe("newer typing");
      unmount();
    } finally {
      vi.stubGlobal("FileReader", originalFileReader);
    }
  });

  it("discards a deferred image read after the Composer switches sessions", async () => {
    const sessionA = useSessionsStore.getState().sessions.get(SESSION_A)!;
    setField(sessionA, {
      availableModels: [{ id: "text-model", name: "Image Model", input: ["text", "image"] }],
    });
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE, "/tmp/b.jsonl");
    const sessionB = useSessionsStore.getState().sessions.get(SESSION_B)!;
    setField(sessionB, {
      status: "ready",
      availability: "available",
      currentModel: "text-model",
      availableModels: [{ id: "text-model", name: "Image Model", input: ["text", "image"] }],
      hostInstanceId: "22222222-2222-4222-8222-222222222222",
      editorRevision: 0,
    });
    let deferredReader:
      | {
          result: string | null;
          onload: (() => void) | null;
        }
      | undefined;
    class DeferredFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(): void {
        deferredReader = this;
      }
    }
    const originalFileReader = globalThis.FileReader;
    vi.stubGlobal("FileReader", DeferredFileReader);
    try {
      const mounted = mountComposer();
      const input = mounted.container.querySelector<HTMLInputElement>('input[type="file"]')!;
      dispatchFiles(input, [pickedFile("private.png", "image/png", "/tmp/private.png")]);
      act(() => {
        flushSync(() => {
          mounted.root.render(<Composer sessionId={SESSION_B} />);
        });
      });
      invokeSpy.mockClear();

      act(() => {
        if (!deferredReader) throw new Error("FileReader was not started");
        deferredReader.result = "data:image/png;base64,cHJpdmF0ZQ==";
        deferredReader.onload?.();
      });
      await Promise.resolve();

      expect(
        invokeSpy.mock.calls.filter(
          ([channel, payload]) =>
            channel === "session.editorPatch" &&
            (payload as { attachments?: unknown[] }).attachments?.length,
        ),
      ).toEqual([]);
      expect(useSessionsStore.getState().sessions.get(SESSION_B)?.editorAttachments).toEqual([]);
      expect(mounted.container.querySelectorAll(".composer__attachment-item")).toHaveLength(0);
      expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorAttachmentReads).toBe(0);
      mounted.unmount();
    } finally {
      vi.stubGlobal("FileReader", originalFileReader);
    }
  });

  it("keeps file paths on their own line when prompt starts with whitespace", async () => {
    const { container, textarea, unmount } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, " Please inspect");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    dispatchFiles(input, [pickedFile("notes.txt", "text/plain", "/tmp/notes.txt")]);

    keyDown(ta, "Enter");
    await vi.waitFor(() =>
      expect(submittedTexts(invokeSpy)).toEqual(["/tmp/notes.txt\n Please inspect"]),
    );
    unmount();
  });

  it("renders injected file-path-only editor text as file tiles", async () => {
    const { container, textarea, unmount } = mountComposer();

    act(() => {
      useSessionsStore.getState().injectEditorText(SESSION_A, "/tmp/a.txt\n/tmp/b.txt");
    });

    expect(textarea().value).toBe("");
    expect(container.querySelectorAll(".composer__attachment-item--file").length).toBe(2);

    keyDown(textarea(), "Enter");
    await vi.waitFor(() => expect(submittedTexts(invokeSpy)).toEqual(["/tmp/a.txt\n/tmp/b.txt"]));
    unmount();
  });

  it("falls back to image file tiles with one warning when the model lacks image support", () => {
    const { container, textarea, unmount } = mountComposer();
    const ta = textarea();
    setValueAndDispatch(ta, "Please inspect");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    dispatchFiles(input, [pickedFile("diagram.png", "image/png", "/tmp/diagram.png")]);

    expect(textarea().value).toBe("Please inspect");
    expect(container.querySelectorAll(".composer__attachment-item--file").length).toBe(1);
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe("warning");
    expect(toasts[0]?.message).toContain("doesn't support image input");
    unmount();
  });
});
