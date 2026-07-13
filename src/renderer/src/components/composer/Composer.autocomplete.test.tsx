// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { Composer } from "./Composer.js";

const SID = "session-a" as SessionId;
const OWNER = { hostInstanceId: "11111111-1111-4111-8111-111111111111", sessionEpoch: 0 };

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => root.render(<Composer sessionId={SID} />));
  });
  return {
    textarea: () => container.querySelector<HTMLTextAreaElement>("textarea")!,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
function type(textarea: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function enter(textarea: HTMLTextAreaElement) {
  act(() =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
}
function publishOutcome(intentId: string) {
  act(() => {
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      const session = sessions.get(SID)!;
      sessions.set(SID, {
        ...session,
        authorityProjection: {
          ...session.authorityProjection!,
          authoritativeSnapshot: {
            recentIntentOutcomes: [
              {
                intentId,
                owner: OWNER,
                kind: "submit",
                state: "completed",
                result: { disposition: "consumed", editorRevision: 1 },
              },
            ],
          } as never,
        },
      });
      return { sessions };
    });
  });
}

describe("Composer authority intent dispatch", () => {
  let invoke: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: SID, workspaces: new Map() });
    useSessionsStore.getState().createSession(SID, "/tmp/ws");
    const session = useSessionsStore.getState().sessions.get(SID)!;
    Object.assign(session, {
      status: "ready",
      availability: "available",
      currentModel: "model",
      hostInstanceId: OWNER.hostInstanceId,
      sessionEpoch: OWNER.sessionEpoch,
      editorRevision: 0,
    });
    invoke = vi.fn((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch")
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
        });
      return Promise.resolve(undefined);
    });
    // @ts-expect-error test preload
    window.pivis = { invoke, getPathForFile: (file: File) => file.name };
  });
  afterEach(() => {
    // @ts-expect-error test cleanup
    delete window.pivis;
  });

  it("keeps editor custody after an admitted receipt until the authority frame arrives", async () => {
    let admit!: (value: unknown) => void;
    const receipt = new Promise((resolve) => {
      admit = resolve;
    });
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch")
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
        });
      if (channel === "session.dispatchIntent") return receipt;
      return Promise.resolve(undefined);
    });
    const composer = mount();
    type(composer.textarea(), "hello");
    enter(composer.textarea());
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([channel]) => channel === "session.dispatchIntent")).toBe(
        true,
      ),
    );
    const envelope = invoke.mock.calls.find(
      ([channel]) => channel === "session.dispatchIntent",
    )?.[1] as { intentId: string; intent: { kind: string } };
    expect(envelope.intent).toMatchObject({ kind: "submit", text: "hello" });
    expect(invoke.mock.calls.some(([channel]) => channel === "session.submit")).toBe(false);

    await act(async () => {
      admit({ status: "admitted", intentId: envelope.intentId, owner: OWNER });
    });
    expect(composer.textarea().value).toBe("hello");

    publishOutcome(envelope.intentId);
    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    composer.unmount();
  });

  it("uses invokeCommand intent for discovered extension slash text", async () => {
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SID, {
        ...sessions.get(SID)!,
        commands: [{ name: "extension", source: "extension", description: "x" }],
      });
      return { sessions };
    });
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch")
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
        });
      if (channel === "session.dispatchIntent")
        return Promise.resolve({
          status: "delivery_unknown",
          intentId: (payload as { intentId: string }).intentId,
          owner: OWNER,
        });
      return Promise.resolve(undefined);
    });
    const composer = mount();
    type(composer.textarea(), "/extension");
    enter(composer.textarea());
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([channel]) => channel === "session.dispatchIntent")).toBe(
        true,
      ),
    );
    const envelope = invoke.mock.calls.find(
      ([channel]) => channel === "session.dispatchIntent",
    )?.[1] as { intent: unknown };
    expect(envelope.intent).toMatchObject({ kind: "invokeCommand", text: "/extension" });
    expect(composer.textarea().value).toBe("/extension");
    composer.unmount();
  });
});
