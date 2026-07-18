// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type {
  IntentEnvelope,
  IntentOutcome,
  SessionIntent,
} from "@shared/pi-protocol/runtime-state.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useOverlayStore } from "../../stores/overlay-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { Composer } from "./Composer.js";

const SID = "session-a" as SessionId;
const SID_B = "session-b" as SessionId;
const WORKSPACE = "/tmp/ws";
const OWNER = { hostInstanceId: "11111111-1111-4111-8111-111111111111", sessionEpoch: 0 };

type Envelope = IntentEnvelope<SessionIntent>;

function mount(sessionId = SID): {
  container: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
  textarea: () => HTMLTextAreaElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => flushSync(() => root.render(<Composer sessionId={sessionId} />)));
  return {
    container,
    root,
    textarea: () => container.querySelector<HTMLTextAreaElement>("textarea")!,
    unmount: () => {
      act(() => flushSync(() => root.unmount()));
      container.remove();
    },
  };
}

function ComposerReplacement(): React.ReactElement {
  useEscapeClaim(true);
  return <textarea aria-label="Composer replacement" />;
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(textarea: HTMLTextAreaElement, value: string, init: KeyboardEventInit = {}): void {
  act(() =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init }),
    ),
  );
}

function pickedFile(name: string, type: string, path: string): File {
  const file = new File(["content"], name, { type });
  Object.defineProperty(file, "path", { value: path });
  return file;
}

function selectFiles(input: HTMLInputElement, files: File[]): void {
  act(() => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function dispatchFileDrag(
  target: HTMLElement,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  files: File[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"], dropEffect: "none" },
  });
  act(() => target.dispatchEvent(event));
  return event;
}

function outcomeFor(envelope: Envelope, patch: Partial<IntentOutcome> = {}): IntentOutcome {
  const base = {
    intentId: envelope.intentId,
    owner: OWNER,
    state: "completed" as const,
    ...patch,
  };
  switch (envelope.intent.kind) {
    case "submit":
      return {
        ...base,
        kind: "submit",
        result: { disposition: "consumed", editorRevision: envelope.intent.editorRevision },
      };
    case "manageQueue":
      return {
        ...base,
        kind: "manageQueue",
        result: { operation: envelope.intent.operation },
      };
    case "invokeCommand":
      return { ...base, kind: "invokeCommand", result: {} };
    case "compact":
      return { ...base, kind: "compact", result: {} };
    case "reload":
      return { ...base, kind: "reload", result: {} };
    case "export":
      return { ...base, kind: "export", result: { path: "/tmp/preview-export.html" } };
    case "runBash":
      return { ...base, kind: "runBash", result: { started: true } };
    case "rename":
      return { ...base, kind: "rename", result: { name: envelope.intent.name } };
    case "setModel":
      return {
        ...base,
        kind: "setModel",
        result: { provider: envelope.intent.provider, modelId: envelope.intent.modelId },
      };
    case "setThinking":
      return { ...base, kind: "setThinking", result: { level: envelope.intent.level } };
    case "interrupt":
      return { ...base, kind: "interrupt", result: { target: "editor", interrupted: true } };
    case "navigate":
      return { ...base, kind: "navigate", result: { targetId: envelope.intent.targetId } };
    case "refreshModels":
      return { ...base, kind: "refreshModels", result: { refreshed: true } };
    case "loginProvider":
      return { ...base, kind: "loginProvider", result: { authenticated: true } };
  }
}

function publishOutcome(envelope: Envelope, patch: Partial<IntentOutcome> = {}): void {
  act(() => {
    useSessionsStore.setState((state) => {
      const sessionId = envelope.sessionId as SessionId;
      const sessions = new Map(state.sessions);
      const session = sessions.get(sessionId)!;
      const prior = session.authorityProjection?.authoritativeSnapshot?.recentIntentOutcomes ?? [];
      sessions.set(sessionId, {
        ...session,
        authorityProjection: {
          ...session.authorityProjection,
          authoritativeSnapshot: {
            ...session.authorityProjection?.authoritativeSnapshot,
            recentIntentOutcomes: [...prior, outcomeFor(envelope, patch)],
          },
        } as never,
      });
      return { sessions };
    });
  });
}

function intentCalls(invoke: ReturnType<typeof vi.fn>): Envelope[] {
  return invoke.mock.calls
    .filter(([channel]) => channel === "session.dispatchIntent")
    .map(([, payload]) => payload as Envelope);
}

function installInvoke(invoke: ReturnType<typeof vi.fn>, autoOutcome = true): void {
  invoke.mockImplementation((channel: string, payload: unknown) => {
    if (channel === "session.editorPatch") {
      return Promise.resolve({
        accepted: true,
        revision: (payload as { revision: number }).revision,
      });
    }
    if (channel === "session.query") {
      const query = payload as { queryId: string; query: { type: string } };
      return Promise.resolve({
        queryId: query.queryId,
        owner: OWNER,
        queryType: query.query.type,
        response: { success: true, command: query.query.type, data: {} },
      });
    }
    if (channel === "session.dispatchIntent") {
      const envelope = payload as Envelope;
      if (autoOutcome) queueMicrotask(() => publishOutcome(envelope));
      return Promise.resolve({ status: "admitted", intentId: envelope.intentId, owner: OWNER });
    }
    return Promise.resolve({ success: true });
  });
}

function setSessionField(patch: Record<string, unknown>, sessionId = SID): void {
  const session = useSessionsStore.getState().sessions.get(sessionId)!;
  Object.assign(session, patch);
}

function patchSession(patch: Record<string, unknown>, sessionId = SID): void {
  act(() => {
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...sessions.get(sessionId)!, ...patch });
      return { sessions };
    });
  });
}

function followingAuthority(modelId = "model") {
  const cursor = { ...OWNER, transportSequence: 1, snapshotSequence: 1 };
  return {
    rendererGeneration: 1,
    publicationSequence: 0,
    owner: OWNER,
    semantic: { state: "following" as const, cursor },
    transcript: { state: "following" as const, cursor },
    extensionUi: { state: "following" as const, cursor },
    panels: new Map(),
    authoritativeSnapshot: {
      owner: OWNER,
      snapshotSequence: 1,
      capturedAt: Date.now(),
      sdk: {
        isStreaming: false,
        isIdle: true,
        isCompacting: false,
        isRetrying: false,
        retryAttempt: 0,
        isBashRunning: false,
      },
      activity: {},
      queues: {
        steering: [],
        followUp: [],
        steeringIntentIds: [],
        followUpIntentIds: [],
      },
      custody: [],
      editor: { revision: 0, text: "", attachments: [] },
      activeIntents: [],
      recentIntentOutcomes: [],
      recentObservedOperations: [],
      operationJournalLowWatermark: 0,
      operationJournalHighWatermark: 0,
      operationJournalTruncated: false,
      model: { id: modelId },
      thinkingLevel: "medium",
      catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
    },
  };
}

function setAuthorityAttachments(attachments: unknown[]): void {
  const session = useSessionsStore.getState().sessions.get(SID)!;
  const projection = session.authorityProjection!;
  setSessionField({
    editorAttachments: attachments,
    authorityProjection: {
      ...projection,
      authoritativeSnapshot: {
        ...projection.authoritativeSnapshot!,
        editor: { ...projection.authoritativeSnapshot!.editor, attachments },
      },
    },
  });
}

function authorityAttachResponse() {
  const projection = followingAuthority();
  const snapshot = projection.authoritativeSnapshot;
  const cursor = projection.semantic.cursor;
  return {
    status: "ready" as const,
    baseline: {
      sessionId: SID,
      rendererGeneration: projection.rendererGeneration,
      owner: OWNER,
      semantic: { sync: { state: "following", cursor }, snapshot },
      operationJournal: [],
      transcript: {
        sync: { state: "following", cursor },
        persistedHistoryCursor: null,
        liveTailCursor: null,
        overlapBoundary: null,
      },
      extensionUi: {
        sync: { state: "following", cursor },
        notifications: [],
        statuses: {},
        widgets: {},
        dialogs: [],
      },
      panels: [],
      restorations: [],

      publicationHighWatermark: 0,
    },
    replay: [],
  };
}

function suggestionCount(container: HTMLElement): number {
  return container.querySelectorAll(".composer__suggestion").length;
}

describe("Composer autocomplete and authority intents", () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useOverlayStore.setState({ count: 0 });
    useTreeStore.setState({
      open: false,
      sessionId: null,
      phase: "loading",
      errorMessage: null,
      nodes: [],
      leafId: null,
      filterMode: "default",
      search: "",
      selectedId: null,
      summarizeOnSwitch: false,
      foldedIds: new Set(),
      navigating: false,
    });
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: SID,
      workspaces: new Map(),
      activeWorkspacePath: WORKSPACE,
      diffComments: new Map(),
      sessionDrafts: new Map(),
      newSessionDrafts: new Map(),
      submissionDispositions: new Map(),
      composerFocusRequest: undefined,
    });
    useSessionsStore.getState().createSession(SID, WORKSPACE);
    setSessionField({
      status: "ready",
      availability: "available",
      currentModel: "model",
      hostInstanceId: OWNER.hostInstanceId,
      sessionEpoch: OWNER.sessionEpoch,
      editorRevision: 0,
      authorityProjection: followingAuthority(),
    });
    invoke = vi.fn();
    installInvoke(invoke);
    // @ts-expect-error test preload
    window.pivis = {
      invoke,
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? file.name,
    };
  });

  afterEach(async () => {
    await vi.waitFor(() => {
      for (const session of useSessionsStore.getState().sessions.values()) {
        expect(session.editorPatchPending).toBe(0);
      }
    });
    // @ts-expect-error test cleanup
    delete window.pivis;
    document.body.innerHTML = "";
  });

  it("keeps /tree invokable before initial authority attachment", async () => {
    setSessionField({ status: "starting", authorityProjection: undefined });
    const composer = mount();
    expect(composer.textarea().disabled).toBe(false);

    type(composer.textarea(), "/tree");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() =>
      expect(useTreeStore.getState()).toMatchObject({ open: true, sessionId: SID }),
    );
    expect(intentCalls(invoke)).toHaveLength(0);
    composer.unmount();
  });

  it.each(["compaction repair", "abort repair"])(
    "keeps /tree invokable during %s while runtime-backed controls stay fenced",
    async () => {
      const projection = followingAuthority();
      setSessionField({
        authorityProjection: {
          ...projection,
          semantic: {
            state: "synchronizing",
            lastCursor: projection.semantic.cursor,
            reason: "gap",
          },
          staleDiagnosticSnapshot: projection.authoritativeSnapshot,
          authoritativeSnapshot: undefined,
        },
      });
      const composer = mount();
      expect(composer.textarea().disabled).toBe(false);
      expect(
        composer.container.querySelector<HTMLButtonElement>(".composer__attach-btn")?.disabled,
      ).toBe(true);

      type(composer.textarea(), "/tree");
      key(composer.textarea(), "Enter");
      await vi.waitFor(() =>
        expect(useTreeStore.getState()).toMatchObject({ open: true, sessionId: SID }),
      );
      expect(composer.textarea().value).toBe("");
      expect(intentCalls(invoke)).toHaveLength(0);
      composer.unmount();
    },
  );

  it("serializes an authoritative editor clear after opening /tree", async () => {
    const composer = mount();
    type(composer.textarea(), "/tree");
    key(composer.textarea(), "Enter");

    await vi.waitFor(() => {
      const patches = invoke.mock.calls
        .filter(([channel]) => channel === "session.editorPatch")
        .map(([, payload]) => (payload as { text: string }).text);
      expect(patches).toContain("/tree");
      expect(patches.at(-1)).toBe("");
    });
    expect(composer.textarea().value).toBe("");
    composer.unmount();
  });

  it("rebases an unavailable /tree clear when authority recovers", async () => {
    const prior = followingAuthority();
    setSessionField({
      authorityProjection: {
        ...prior,
        semantic: { state: "synchronizing", lastCursor: prior.semantic.cursor, reason: "gap" },
        staleDiagnosticSnapshot: prior.authoritativeSnapshot,
        authoritativeSnapshot: undefined,
      },
    });
    const composer = mount();
    type(composer.textarea(), "/tree");
    key(composer.textarea(), "Enter");
    expect(composer.textarea().value).toBe("");
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.editorPatch")).toHaveLength(
      0,
    );

    const recovered = followingAuthority();
    recovered.authoritativeSnapshot.editor = { revision: 1, text: "/tree", attachments: [] };
    patchSession({
      editorRevision: 1,
      editorInjection: { text: "/tree", nonce: 100, revision: 1 },
      authorityProjection: recovered,
    });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "session.editorPatch",
        expect.objectContaining({ text: "" }),
      ),
    );
    expect(composer.textarea().value).toBe("");
    composer.unmount();
  });

  it("retains the /tree editor clear across runtime loss and recovery", async () => {
    let patchCount = 0;
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        patchCount++;
        if (patchCount === 2) {
          return Promise.resolve({
            accepted: false,
            rejection: "runtime_unavailable",
            revision: (payload as { baseRevision: number }).baseRevision,
            text: "/tree",
            attachments: [],
          });
        }
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
        });
      }
      if (channel === "session.query") {
        return Promise.resolve({ status: "unavailable", reason: "repairing" });
      }
      return Promise.resolve({ success: true });
    });
    const composer = mount();
    type(composer.textarea(), "/tree");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(patchCount).toBe(2));
    expect(composer.textarea().value).toBe("");

    const prior = followingAuthority();
    patchSession({
      authorityProjection: {
        ...prior,
        semantic: { state: "synchronizing", lastCursor: prior.semantic.cursor, reason: "gap" },
        staleDiagnosticSnapshot: prior.authoritativeSnapshot,
        authoritativeSnapshot: undefined,
      },
    });
    const recovered = followingAuthority();
    recovered.authoritativeSnapshot.editor = { revision: 1, text: "/tree", attachments: [] };
    patchSession({
      editorRevision: 1,
      editorInjection: { text: "/tree", nonce: 101, revision: 1 },
      authorityProjection: recovered,
    });

    await vi.waitFor(() => expect(patchCount).toBeGreaterThanOrEqual(3));
    const finalPatch = invoke.mock.calls
      .filter(([channel]) => channel === "session.editorPatch")
      .at(-1)?.[1] as { text: string };
    expect(finalPatch.text).toBe("");
    expect(composer.textarea().value).toBe("");
    composer.unmount();
  });

  it("preserves fenced local edits while rebasing them when authority returns", async () => {
    const projection = followingAuthority();
    setSessionField({
      authorityProjection: {
        ...projection,
        semantic: { state: "synchronizing", lastCursor: projection.semantic.cursor, reason: "gap" },
        staleDiagnosticSnapshot: projection.authoritativeSnapshot,
        authoritativeSnapshot: undefined,
      },
    });
    const composer = mount();
    type(composer.textarea(), "local fenced draft");

    const recovered = followingAuthority();
    recovered.authoritativeSnapshot.editor = {
      revision: 1,
      text: "host-side edit",
      attachments: [],
    };
    patchSession({
      editorRevision: 1,
      editorInjection: { text: "host-side edit", nonce: 99, revision: 1 },
      authorityProjection: recovered,
    });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "session.editorPatch",
        expect.objectContaining({ text: "local fenced draft" }),
      ),
    );
    expect(composer.textarea().value).toBe("local fenced draft");
    composer.unmount();
  });

  it("preserves attachment removal while authority is fenced and rebases the full payload", async () => {
    setAuthorityAttachments([{ kind: "file", name: "draft.txt", path: "/tmp/draft.txt" }]);
    const composer = mount();
    await vi.waitFor(() =>
      expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(
        1,
      ),
    );

    const prior = followingAuthority();
    prior.authoritativeSnapshot.editor.attachments = [
      { kind: "file", name: "draft.txt", path: "/tmp/draft.txt" },
    ] as never;
    patchSession({
      authorityProjection: {
        ...prior,
        semantic: { state: "synchronizing", lastCursor: prior.semantic.cursor, reason: "gap" },
        staleDiagnosticSnapshot: prior.authoritativeSnapshot,
        authoritativeSnapshot: undefined,
      },
    });
    const remove = composer.container.querySelector<HTMLButtonElement>(
      ".composer__attachment-item--file .composer__attachment-remove",
    );
    act(() => remove?.click());
    expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(0);

    const recovered = followingAuthority();
    recovered.authoritativeSnapshot.editor = {
      revision: 1,
      text: "",
      attachments: [{ kind: "file", name: "draft.txt", path: "/tmp/draft.txt" }] as never,
    };
    patchSession({ authorityProjection: recovered, editorRevision: 1 });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "session.editorPatch",
        expect.objectContaining({ attachments: [] }),
      ),
    );
    expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(0);
    composer.unmount();
  });

  it("keeps fenced session candidates isolated across a mounted session switch", async () => {
    const fencedA = followingAuthority();
    setSessionField({
      authorityProjection: {
        ...fencedA,
        semantic: { state: "synchronizing", lastCursor: fencedA.semantic.cursor, reason: "gap" },
        staleDiagnosticSnapshot: fencedA.authoritativeSnapshot,
        authoritativeSnapshot: undefined,
      },
    });
    useSessionsStore.getState().createSession(SID_B, WORKSPACE, "/tmp/session-b.jsonl");
    const fencedB = followingAuthority();
    setSessionField(
      {
        status: "ready",
        availability: "available",
        hostInstanceId: OWNER.hostInstanceId,
        sessionEpoch: OWNER.sessionEpoch,
        authorityProjection: {
          ...fencedB,
          semantic: {
            state: "synchronizing",
            lastCursor: fencedB.semantic.cursor,
            reason: "gap",
          },
          staleDiagnosticSnapshot: fencedB.authoritativeSnapshot,
          authoritativeSnapshot: undefined,
        },
      },
      SID_B,
    );

    const composer = mount(SID);
    type(composer.textarea(), "private A draft");
    const input = composer.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    selectFiles(input, [pickedFile("private.txt", "text/plain", "/tmp/private.txt")]);
    await vi.waitFor(() =>
      expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(
        1,
      ),
    );

    act(() => flushSync(() => composer.root.render(<Composer sessionId={SID_B} />)));
    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(0);

    const recoveredB = followingAuthority();
    patchSession({ authorityProjection: recoveredB }, SID_B);
    await Promise.resolve();
    expect(
      invoke.mock.calls.some(
        ([channel, payload]) =>
          channel === "session.editorPatch" &&
          ((payload as { text?: string }).text === "private A draft" ||
            JSON.stringify((payload as { attachments?: unknown }).attachments).includes(
              "private.txt",
            )),
      ),
    ).toBe(false);

    act(() => flushSync(() => composer.root.render(<Composer sessionId={SID} />)));
    expect(composer.textarea().value).toBe("private A draft");
    expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(1);
    const recoveredA = followingAuthority();
    patchSession({ authorityProjection: recoveredA }, SID);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "session.editorPatch",
        expect.objectContaining({
          text: "private A draft",
          attachments: expect.arrayContaining([expect.objectContaining({ name: "private.txt" })]),
        }),
      ),
    );
    composer.unmount();
  });

  it("shows slash suggestions, hides them on Escape, and re-shows them after typing", () => {
    const composer = mount();
    type(composer.textarea(), "/lo");
    expect(suggestionCount(composer.container)).toBeGreaterThan(0);
    key(composer.textarea(), "Escape");
    expect(suggestionCount(composer.container)).toBe(0);
    type(composer.textarea(), "/log");
    expect(suggestionCount(composer.container)).toBeGreaterThan(0);
    composer.unmount();
  });

  it("uses Alt+Enter to run a prompt after the current task", async () => {
    const mounted = mount();
    type(mounted.textarea(), "after this task");
    key(mounted.textarea(), "Enter", { altKey: true });

    await vi.waitFor(() => {
      const calls = intentCalls(invoke);
      expect(calls.at(-1)?.intent).toMatchObject({
        kind: "submit",
        text: "after this task",
        requestedMode: "followUp",
      });
    });
    mounted.unmount();
  });

  it("completes an extension command, patches it first, then dispatches an invokeCommand intent", async () => {
    setSessionField({
      commands: [{ name: "widget-on", description: "Open", source: "extension" }],
    });
    const composer = mount();
    type(composer.textarea(), "/wid");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;
    expect(envelope.intent).toMatchObject({ kind: "invokeCommand", text: "/widget-on" });
    const patches = invoke.mock.calls.filter(([channel]) => channel === "session.editorPatch");
    expect(
      (
        patches.find(([, p]) => (p as { text: string }).text === "/widget-on")?.[1] as {
          revision: number;
        }
      ).revision,
    ).toBe((envelope.intent as { editorRevision: number }).editorRevision);
    composer.unmount();
  });

  it("clears a new session's first prompt when its authoritative user echo promotes the session", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "first prompt");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;

    expect(composer.textarea().value).toBe("first prompt");
    act(() =>
      useSessionsStore.getState().applyEvent(SID, {
        type: "message_start",
        message: { role: "user", content: "first prompt" },
        queueIntentId: envelope.intentId,
      }),
    );

    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    expect(useSessionsStore.getState().sessions.get(SID)?.isNewPending).toBe(false);
    expect(useSessionsStore.getState().sessionDrafts.get(SID)).toBeUndefined();
    composer.unmount();
  });

  it("clears a new session's first direct prompt when its untagged user echo promotes it", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "first direct prompt");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));

    // Idle prompts are delivered directly, so Pi does not expose a queue
    // identity on their user echo. The exact echo still proves this untouched
    // first-session draft was delivered.
    act(() =>
      useSessionsStore.getState().applyEvent(SID, {
        type: "message_start",
        message: { role: "user", content: "first direct prompt" },
      }),
    );

    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    expect(useSessionsStore.getState().sessions.get(SID)?.isNewPending).toBe(false);
    expect(useSessionsStore.getState().sessionDrafts.get(SID)).toBeUndefined();
    composer.unmount();
  });

  it("preserves a newer draft when the first prompt echo promotes the session", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "first prompt");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;

    type(composer.textarea(), "newer draft");
    act(() =>
      useSessionsStore.getState().applyEvent(SID, {
        type: "message_start",
        message: { role: "user", content: "first prompt" },
        queueIntentId: envelope.intentId,
      }),
    );

    expect(composer.textarea().value).toBe("newer draft");
    expect(useSessionsStore.getState().sessionDrafts.get(SID)).toBe("newer draft");
    composer.unmount();
  });

  it("retires an ambiguously delivered first prompt when its delayed echo proves delivery", async () => {
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
        });
      }
      if (channel === "session.dispatchIntent") {
        const envelope = payload as Envelope;
        return Promise.resolve({
          status: "delivery_unknown",
          intentId: envelope.intentId,
          owner: OWNER,
        });
      }
      return Promise.resolve({ success: true });
    });
    const composer = mount();
    type(composer.textarea(), "maybe delivered");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;
    expect(composer.textarea().value).toBe("maybe delivered");

    act(() =>
      useSessionsStore.getState().applyEvent(SID, {
        type: "message_start",
        message: { role: "user", content: "maybe delivered" },
        queueIntentId: envelope.intentId,
      }),
    );

    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    expect(useSessionsStore.getState().sessionDrafts.get(SID) ?? "").toBe("");
    composer.unmount();
  });

  it("freezes the composer with a spinner from submit until acceptance clears it", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "hello");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;

    // In flight: input is frozen and reads as "sending", not unsubmitted text.
    expect(composer.textarea().disabled).toBe(true);
    expect(composer.textarea().value).toBe("hello");
    expect(composer.container.querySelector(".composer__pending-spinner")).not.toBeNull();

    act(() =>
      useSessionsStore.getState().applySubmissionDisposition(SID, {
        intentId: envelope.intentId,
        hostInstanceId: OWNER.hostInstanceId,
        sessionEpoch: OWNER.sessionEpoch,
        editorRevision: (envelope.intent as Extract<SessionIntent, { kind: "submit" }>)
          .editorRevision,
        disposition: "in_custody",
      }),
    );
    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    expect(composer.textarea().disabled).toBe(false);
    expect(composer.container.querySelector(".composer__pending-spinner")).toBeNull();
    composer.unmount();
  });

  it("re-enables the composer and keeps the prompt when dispatch is refused", async () => {
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        return Promise.resolve({
          accepted: true,
          revision: (payload as { revision: number }).revision,
        });
      }
      if (channel === "session.dispatchIntent") {
        const envelope = payload as Envelope;
        return Promise.resolve({
          status: "not_admitted",
          intentId: envelope.intentId,
          reason: "transitioning",
        });
      }
      return Promise.resolve({ success: true });
    });
    const composer = mount();
    type(composer.textarea(), "kept on refusal");
    key(composer.textarea(), "Enter");

    await vi.waitFor(() => expect(composer.textarea().disabled).toBe(false));
    expect(composer.textarea().value).toBe("kept on refusal");
    expect(composer.container.querySelector(".composer__pending-spinner")).toBeNull();
    composer.unmount();
  });

  it("denies prompt submission during compaction with a transient ring, not a toast", async () => {
    const projection = followingAuthority();
    projection.authoritativeSnapshot.activity = {
      compaction: { kind: "compaction", state: "active", attempt: 1 },
    } as never;
    setSessionField({ authorityProjection: projection });
    const composer = mount();
    type(composer.textarea(), "typed during compaction");
    key(composer.textarea(), "Enter");

    // No dispatch, no toast, typing stays enabled; the ring flashes and fades.
    expect(intentCalls(invoke)).toHaveLength(0);
    expect(composer.textarea().disabled).toBe(false);
    expect(composer.textarea().value).toBe("typed during compaction");
    expect(useSessionsStore.getState().sessions.get(SID)?.toasts ?? []).toHaveLength(0);
    expect(composer.container.querySelector(".composer__input-box--denied")).not.toBeNull();
    await vi.waitFor(
      () => expect(composer.container.querySelector(".composer__input-box--denied")).toBeNull(),
      { timeout: 2_000 },
    );
    composer.unmount();
  });

  it("clears an admitted prompt only after its matching consumed disposition", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "hello");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;
    expect(envelope.intent).toMatchObject({ kind: "submit", text: "hello" });

    // Admission alone is not a terminal authority outcome and retains custody.
    expect(composer.textarea().value).toBe("hello");
    act(() =>
      useSessionsStore.getState().applySubmissionDisposition(SID, {
        intentId: envelope.intentId,
        hostInstanceId: OWNER.hostInstanceId,
        sessionEpoch: OWNER.sessionEpoch,
        editorRevision: (envelope.intent as Extract<SessionIntent, { kind: "submit" }>)
          .editorRevision,
        disposition: "consumed",
      }),
    );
    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    composer.unmount();
  });

  it("does not re-seed an accepted prompt after its Composer unmounts", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "sent before switching away");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;
    expect(useSessionsStore.getState().newSessionDrafts.get(WORKSPACE)).toBe(
      "sent before switching away",
    );

    composer.unmount();
    act(() =>
      useSessionsStore.getState().applySubmissionDisposition(SID, {
        intentId: envelope.intentId,
        hostInstanceId: OWNER.hostInstanceId,
        sessionEpoch: OWNER.sessionEpoch,
        editorRevision: (envelope.intent as Extract<SessionIntent, { kind: "submit" }>)
          .editorRevision,
        disposition: "consumed",
      }),
    );
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);

    const remounted = mount();
    expect(remounted.textarea().value).toBe("");
    remounted.unmount();
  });

  it("retains a newer local prompt edit when its dispatched prompt is consumed", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "original");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;

    type(composer.textarea(), "newer local edit");
    act(() =>
      useSessionsStore.getState().applySubmissionDisposition(SID, {
        intentId: envelope.intentId,
        hostInstanceId: OWNER.hostInstanceId,
        sessionEpoch: OWNER.sessionEpoch,
        editorRevision: (envelope.intent as Extract<SessionIntent, { kind: "submit" }>)
          .editorRevision,
        disposition: "consumed",
      }),
    );
    await vi.waitFor(() => expect(composer.textarea().value).toBe("newer local edit"));
    composer.unmount();
  });

  it("clears an intent-shaped command once its receipt is admitted", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "/compact");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const envelope = intentCalls(invoke)[0]!;
    expect(envelope.intent).toEqual({ kind: "compact" });
    expect(composer.textarea().value).toBe("");
    publishOutcome(envelope);
    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    expect(invoke.mock.calls.some(([channel]) => channel === "session.legacyCommand")).toBe(false);
    composer.unmount();
  });

  it("uses session.query for read-only command flows without clearing input", async () => {
    const composer = mount();
    type(composer.textarea(), "/name");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([channel, payload]) =>
            channel === "session.query" &&
            (payload as { query: { type: string } }).query.type === "get_state",
        ),
      ).toBe(true),
    );
    expect(intentCalls(invoke)).toEqual([]);
    expect(composer.textarea().value).toBe("/name ");
    composer.unmount();
  });

  it("dispatches reload as an owner-bound intent and clears its workspace draft", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "/reload ");
    expect(useSessionsStore.getState().newSessionDrafts.get(WORKSPACE)).toBe("/reload ");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    expect(intentCalls(invoke)[0]!.intent).toEqual({
      kind: "reload",
      editorRevision: 1,
      editorText: "/reload ",
    });
    expect(composer.textarea().value).toBe("");
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);
    await vi.waitFor(() => {
      const patches = invoke.mock.calls
        .filter(([channel]) => channel === "session.editorPatch")
        .map(([, payload]) => (payload as { text: string }).text);
      expect(patches.at(-1)).toBe("");
    });
    publishOutcome(intentCalls(invoke)[0]!);
    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    composer.unmount();
  });

  it("waits for the editor patch before dispatching a command intent and preserves rejected editor text", async () => {
    let resolvePatch!: (value: unknown) => void;
    const patch = new Promise((resolve) => {
      resolvePatch = resolve;
    });
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") return patch;
      if (channel === "session.dispatchIntent")
        return Promise.resolve({
          status: "admitted",
          intentId: (payload as Envelope).intentId,
          owner: OWNER,
        });
      return Promise.resolve({ success: true });
    });
    const composer = mount();
    type(composer.textarea(), "/compact delayed");
    key(composer.textarea(), "Enter");
    await Promise.resolve();
    expect(intentCalls(invoke)).toEqual([]);
    await act(async () =>
      resolvePatch({
        accepted: false,
        revision: 1,
        text: "extension",
        attachments: [],
        conflictText: "/compact delayed",
      }),
    );
    await vi.waitFor(() =>
      expect(useSessionsStore.getState().sessions.get(SID)?.toasts.at(-1)?.message).toContain(
        "both versions",
      ),
    );
    expect(intentCalls(invoke)).toEqual([]);
    expect(composer.textarea().value).toBe("/compact delayed");
    composer.unmount();
  });

  it("silently fences queued patches when /new replaces their runtime owner", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    invoke.mockImplementation((channel: string) => {
      if (channel === "session.editorPatch") return first;
      return Promise.resolve({ success: true });
    });
    const composer = mount();
    type(composer.textarea(), "draft before new");
    type(composer.textarea(), "draft before new, still local");
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.filter(([channel]) => channel === "session.editorPatch"),
      ).toHaveLength(1),
    );
    await act(async () =>
      resolveFirst({
        accepted: false,
        revision: 0,
        text: "",
        attachments: [],
        rejection: "runtime_replaced",
      }),
    );
    await Promise.resolve();
    expect(composer.textarea().value).toBe("draft before new, still local");
    expect(useSessionsStore.getState().sessions.get(SID)?.toasts).toEqual([]);
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.editorPatch")).toHaveLength(
      1,
    );
    composer.unmount();
  });

  it("retries a failed editor transport only after a fresh runtime resync", async () => {
    let attempts = 0;
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "session.editorPatch") {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error("temporary transport failure"))
          : Promise.resolve({
              accepted: true,
              revision: (payload as { revision: number }).revision,
            });
      }
      if (channel === "session.authorityAttach") return Promise.resolve(authorityAttachResponse());
      if (channel === "session.dispatchIntent") {
        const envelope = payload as Envelope;
        queueMicrotask(() => publishOutcome(envelope));
        return Promise.resolve({ status: "admitted", intentId: envelope.intentId, owner: OWNER });
      }
      return Promise.resolve({ success: true });
    });
    const composer = mount();
    type(composer.textarea(), "/compact retry");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() =>
      expect(useSessionsStore.getState().sessions.get(SID)?.toasts.at(-1)?.message).toContain(
        "synchronization failed",
      ),
    );
    expect(intentCalls(invoke)).toEqual([]);
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    expect(invoke.mock.calls.some(([channel]) => channel === "session.authorityAttach")).toBe(true);
    composer.unmount();
  });

  it("keeps an admission-cleared command cleared when its terminal outcome fails", async () => {
    // A post-admission failure is a domain error (e.g. real Pi's "Nothing to
    // compact") that the user already sees in the transcript and toasts.
    // Re-injecting the command text would be noise, so the clear is final.
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "/compact");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    expect(composer.textarea().value).toBe("");
    publishOutcome(intentCalls(invoke)[0]!, { state: "failed", error: "Compaction failed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(composer.textarea().value).toBe("");
    expect(useSessionsStore.getState().sessionDrafts.get(SID) ?? "").toBe("");
    composer.unmount();
  });

  it("does not restore a failed admission-cleared command over intervening typing", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "/compact");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    expect(composer.textarea().value).toBe("");
    type(composer.textarea(), "newer typing");
    publishOutcome(intentCalls(invoke)[0]!, { state: "failed", error: "Compaction failed" });
    await Promise.resolve();
    expect(composer.textarea().value).toBe("newer typing");
    composer.unmount();
  });

  it("does not let an unmounted completion, stale owner, or unavailable runtime clear newer editor custody", async () => {
    installInvoke(invoke, false);
    const first = mount();
    type(first.textarea(), "/compact old");
    key(first.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    const old = intentCalls(invoke)[0]!;
    first.unmount();
    const second = mount();
    type(second.textarea(), "new draft after remount");
    publishOutcome(old);
    await Promise.resolve();
    expect(second.textarea().value).toBe("new draft after remount");
    type(second.textarea(), "/compact stale");
    key(second.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(2));
    act(() => setSessionField({ sessionEpoch: 1 }));
    publishOutcome(intentCalls(invoke)[1]!);
    await Promise.resolve();
    expect(second.textarea().value).toBe("");
    second.unmount();
  });

  it("preserves newer typing and extension injections when an older terminal outcome arrives", async () => {
    installInvoke(invoke, false);
    const composer = mount();
    type(composer.textarea(), "first prompt");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    type(composer.textarea(), "newer typing");
    publishOutcome(intentCalls(invoke)[0]!);
    await Promise.resolve();
    expect(composer.textarea().value).toBe("newer typing");
    act(() => useSessionsStore.getState().injectEditorText(SID, "/123.foo_bar"));
    await vi.waitFor(() => expect(composer.textarea().value).toBe("/123.foo_bar"));
    expect(composer.container.querySelectorAll(".composer__attachment-item")).toHaveLength(0);
    composer.unmount();
  });

  it("fences queued editor patches after a conflict until a new explicit edit", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel !== "session.editorPatch") return Promise.resolve({ success: true });
      return (payload as { revision: number }).revision === 1
        ? first
        : Promise.resolve({ accepted: true, revision: (payload as { revision: number }).revision });
    });
    const composer = mount();
    type(composer.textarea(), "local one");
    type(composer.textarea(), "local two");
    await vi.waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === "session.editorPatch")).toHaveLength(1),
    );
    await act(async () =>
      resolveFirst({
        accepted: false,
        revision: 1,
        text: "extension",
        attachments: [],
        conflictText: "local one",
      }),
    );
    expect(composer.textarea().value).toBe("local two");
    type(composer.textarea(), "explicitly reconciled");
    await vi.waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === "session.editorPatch")).toHaveLength(2),
    );
    expect(invoke.mock.calls.filter(([c]) => c === "session.editorPatch")[1]?.[1]).toMatchObject({
      baseRevision: 1,
      text: "explicitly reconciled",
    });
    composer.unmount();
  });

  it("submits dismissed literal slash text rather than its autocomplete completion", async () => {
    const composer = mount();
    type(composer.textarea(), "/log");
    key(composer.textarea(), "Escape");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    expect(intentCalls(invoke)[0]!.intent).toMatchObject({ kind: "submit", text: "/log" });
    composer.unmount();
  });

  it("rebases an empty initial injection to the exact pending draft without stealing focus", async () => {
    setSessionField({ status: "cold" });
    useSessionsStore.setState({ newSessionDrafts: new Map([[WORKSPACE, "exact restored draft"]]) });
    useSessionsStore.getState().injectEditorText(SID, "");
    patchSession({
      editorInjection: {
        ...useSessionsStore.getState().sessions.get(SID)!.editorInjection!,
        preserveRendererDraft: true,
      },
    });
    const escapeClaim = useOverlayStore.getState()._acquire();
    const search = document.createElement("input");
    search.setAttribute("aria-label", "Search sessions");
    document.body.appendChild(search);
    search.focus();
    const composer = mount();
    await vi.waitFor(() => expect(composer.textarea().value).toBe("exact restored draft"));
    patchSession({ status: "ready" });
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.filter(
          ([channel, payload]) =>
            channel === "session.editorPatch" &&
            (payload as { text?: string }).text === "exact restored draft",
        ),
      ).toHaveLength(1),
    );
    expect(composer.textarea().value).toBe("exact restored draft");
    expect(document.activeElement).toBe(search);
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "session.dispatchIntent"),
    ).toHaveLength(0);
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.submit")).toHaveLength(0);
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "session.unifiedSubmit"),
    ).toHaveLength(0);
    expect(
      invoke.mock.calls.find(
        ([channel, payload]) =>
          channel === "session.editorPatch" &&
          (payload as { text?: string }).text === "exact restored draft",
      )?.[1],
    ).toMatchObject({ text: "exact restored draft", attachments: [] });

    search.remove();
    document.body.focus();
    useOverlayStore.getState()._release(escapeClaim);
    await Promise.resolve();
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(composer.textarea());

    const externalRename = document.createElement("input");
    externalRename.setAttribute("aria-label", "Rename session");
    document.body.appendChild(externalRename);
    externalRename.focus();
    act(() => useSessionsStore.getState().injectEditorText(SID, "host edit wins"));
    await vi.waitFor(() => expect(composer.textarea().value).toBe("host edit wins"));
    expect(document.activeElement).toBe(externalRename);
    expect(
      invoke.mock.calls.filter(
        ([channel, payload]) =>
          channel === "session.editorPatch" &&
          (payload as { text?: string }).text === "exact restored draft",
      ),
    ).toHaveLength(1);
    externalRename.remove();
    composer.unmount();
  });

  it("honors an ordinary same-owner empty injection instead of reviving command text", async () => {
    useSessionsStore.setState({ newSessionDrafts: new Map([[WORKSPACE, "/completed-command"]]) });
    useSessionsStore.getState().injectEditorText(SID, "");

    const composer = mount();
    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    expect(useSessionsStore.getState().newSessionDrafts.get(WORKSPACE)).toBe("");
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.editorPatch")).toHaveLength(
      0,
    );
    composer.unmount();
  });

  it("focuses a cold saved-session Composer immediately for an explicit request", async () => {
    setSessionField({
      status: "cold",
      availability: "unavailable",
      authorityProjection: undefined,
      sessionFile: "/tmp/saved-session.jsonl",
      isNewPending: false,
      resumed: true,
    });
    const composer = mount();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    act(() => useSessionsStore.getState().requestComposerFocus(SID));
    await vi.waitFor(() => expect(document.activeElement).toBe(composer.textarea()));
    expect(useSessionsStore.getState().composerFocusRequest).toBeUndefined();

    type(composer.textarea(), "typed before authority");
    expect(composer.textarea().value).toBe("typed before authority");
    expect(useSessionsStore.getState().sessionDrafts.get(SID)).toBe("typed before authority");
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.editorPatch")).toHaveLength(
      0,
    );
    expect(intentCalls(invoke)).toHaveLength(0);
    button.remove();
    composer.unmount();
  });

  it("does not steal focus from an external input for an explicit focus request", async () => {
    setSessionField({
      status: "cold",
      availability: "unavailable",
      authorityProjection: undefined,
    });
    const composer = mount();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    act(() => useSessionsStore.getState().requestComposerFocus(SID));
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    input.remove();
    composer.unmount();
  });

  it("consumes a cold-session focus request without stealing through an overlay", async () => {
    setSessionField({
      status: "cold",
      availability: "unavailable",
      authorityProjection: undefined,
    });
    const claim = useOverlayStore.getState()._acquire();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const composer = mount();

    act(() => useSessionsStore.getState().requestComposerFocus(SID));
    await vi.waitFor(() =>
      expect(useSessionsStore.getState().composerFocusRequest).toBeUndefined(),
    );
    expect(document.activeElement).toBe(button);

    act(() => useOverlayStore.getState()._release(claim));
    await Promise.resolve();
    expect(document.activeElement).toBe(button);
    button.remove();
    composer.unmount();
  });

  it("autofocuses a pending-new Composer before initial authority", () => {
    setSessionField({
      status: "cold",
      availability: "unavailable",
      authorityProjection: undefined,
    });
    document.body.focus();
    const composer = mount();
    expect(document.activeElement).toBe(composer.textarea());
    composer.unmount();
  });

  it("restores focus when an Escape-claiming Composer replacement unmounts", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => flushSync(() => root.render(<ComposerReplacement />)));
    container.querySelector<HTMLTextAreaElement>("textarea")?.focus();

    act(() => flushSync(() => root.render(<Composer sessionId={SID} />)));
    expect(useOverlayStore.getState().count).toBe(0);
    expect(document.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>(".composer textarea"),
    );

    act(() => flushSync(() => root.unmount()));
    container.remove();
  });
});

describe("Composer attachments under authority outcomes", () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: SID,
      workspaces: new Map(),
      diffComments: new Map(),
      sessionDrafts: new Map(),
      newSessionDrafts: new Map(),
      submissionDispositions: new Map(),
      composerFocusRequest: undefined,
    });
    useSessionsStore.getState().createSession(SID, WORKSPACE);
    setSessionField({
      status: "ready",
      availability: "available",
      currentModel: "text-model",
      availableModels: [{ id: "text-model", name: "Text", input: ["text"] }],
      hostInstanceId: OWNER.hostInstanceId,
      sessionEpoch: 0,
      editorRevision: 0,
      authorityProjection: followingAuthority("text-model"),
    });
    invoke = vi.fn();
    installInvoke(invoke);
    // @ts-expect-error test preload
    window.pivis = {
      invoke,
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? file.name,
    };
  });

  afterEach(async () => {
    await vi.waitFor(() =>
      expect(useSessionsStore.getState().sessions.get(SID)?.editorPatchPending).toBe(0),
    );
    // @ts-expect-error test cleanup
    delete window.pivis;
    document.body.innerHTML = "";
  });

  it("keeps the file picker available for text-only models and downgrades image files once", () => {
    const composer = mount();
    const input = composer.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const button = composer.container.querySelector<HTMLButtonElement>(".composer__attach-btn")!;
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    act(() => button.click());
    expect(input.getAttribute("accept")).toBeNull();
    expect(click).toHaveBeenCalledOnce();
    type(composer.textarea(), "inspect");
    selectFiles(input, [pickedFile("diagram.png", "image/png", "/tmp/diagram.png")]);
    expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(1);
    expect(useSessionsStore.getState().sessions.get(SID)?.toasts.at(-1)?.message).toContain(
      "doesn't support image input",
    );
    composer.unmount();
  });

  it("stages operating-system file drops through the picker attachment pipeline", () => {
    const composer = mount();
    const dropTarget = composer.container.querySelector<HTMLElement>(".composer")!;
    const file = pickedFile("notes.txt", "text/plain", "/tmp/notes.txt");

    const dragEnter = dispatchFileDrag(dropTarget, "dragenter", [file]);
    expect(dragEnter.defaultPrevented).toBe(true);
    expect(composer.container.querySelector(".composer__file-drop")?.textContent).toContain(
      "Drop files to attach",
    );

    const drop = dispatchFileDrag(dropTarget, "drop", [file]);
    expect(drop.defaultPrevented).toBe(true);
    expect(composer.container.querySelector(".composer__file-drop")).toBeNull();
    expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(1);
    expect(
      composer.container.querySelector(".composer__file-attachment")?.getAttribute("title"),
    ).toBe("/tmp/notes.txt");
    composer.unmount();
  });

  it("keeps the file-drop overlay stable across nested drag enter/leave events", () => {
    const composer = mount();
    const dropTarget = composer.container.querySelector<HTMLElement>(".composer")!;
    const nestedTarget = composer.container.querySelector<HTMLElement>(".composer__input-box")!;
    const file = pickedFile("notes.txt", "text/plain", "/tmp/notes.txt");

    dispatchFileDrag(dropTarget, "dragenter", [file]);
    dispatchFileDrag(nestedTarget, "dragenter", [file]);
    expect(composer.container.querySelector(".composer__file-drop")).not.toBeNull();

    dispatchFileDrag(nestedTarget, "dragleave", [file]);
    expect(composer.container.querySelector(".composer__file-drop")).not.toBeNull();

    dispatchFileDrag(dropTarget, "dragleave", [file]);
    expect(composer.container.querySelector(".composer__file-drop")).toBeNull();
    composer.unmount();
  });

  it("consumes unavailable and submitting drops without staging or browser navigation", async () => {
    setSessionField({ status: "cold" });
    const unavailable = mount();
    const unavailableTarget = unavailable.container.querySelector<HTMLElement>(".composer")!;
    const file = pickedFile("notes.txt", "text/plain", "/tmp/notes.txt");

    expect(dispatchFileDrag(unavailableTarget, "dragover", [file]).defaultPrevented).toBe(true);
    expect(dispatchFileDrag(unavailableTarget, "drop", [file]).defaultPrevented).toBe(true);
    expect(unavailable.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(
      0,
    );
    expect(useSessionsStore.getState().sessions.get(SID)?.toasts.at(-1)?.message).toContain(
      "Wait for the session runtime",
    );
    unavailable.unmount();

    setSessionField({ status: "ready" });
    installInvoke(invoke, false);
    const submitting = mount();
    type(submitting.textarea(), "prompt in flight");
    key(submitting.textarea(), "Enter");
    await vi.waitFor(() => expect(submitting.textarea().disabled).toBe(true));
    const submittingTarget = submitting.container.querySelector<HTMLElement>(".composer")!;
    expect(dispatchFileDrag(submittingTarget, "dragover", [file]).defaultPrevented).toBe(true);
    expect(dispatchFileDrag(submittingTarget, "drop", [file]).defaultPrevented).toBe(true);
    expect(submitting.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(
      0,
    );
    expect(useSessionsStore.getState().sessions.get(SID)?.toasts.at(-1)?.message).toContain(
      "Wait for the current prompt",
    );
    submitting.unmount();
  });

  it("reserves the eight image slots across delayed concurrent drop batches", async () => {
    setSessionField({
      availableModels: [{ id: "text-model", name: "Image", input: ["text", "image"] }],
    });
    const readers: Array<{
      result: string | null;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      onabort: (() => void) | null;
    }> = [];
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(): void {
        readers.push(this);
      }
    }
    const original = globalThis.FileReader;
    vi.stubGlobal("FileReader", DeferredReader);
    try {
      const composer = mount();
      const dropTarget = composer.container.querySelector<HTMLElement>(".composer")!;
      const images = Array.from({ length: 12 }, (_, index) =>
        pickedFile(`image-${index}.png`, "image/png", `/tmp/image-${index}.png`),
      );

      dispatchFileDrag(dropTarget, "drop", images.slice(0, 6));
      dispatchFileDrag(dropTarget, "drop", images.slice(6));

      expect(readers).toHaveLength(8);
      expect(useSessionsStore.getState().sessions.get(SID)?.editorAttachmentReads).toBe(8);
      expect(useSessionsStore.getState().sessions.get(SID)?.toasts.at(-1)?.message).toContain(
        "max 8",
      );

      act(() => {
        for (const reader of readers) {
          reader.result = "data:image/png;base64,eA==";
          reader.onload?.();
        }
      });
      await vi.waitFor(() =>
        expect(composer.container.querySelectorAll(".composer__attachment-thumb")).toHaveLength(8),
      );
      expect(useSessionsStore.getState().sessions.get(SID)?.editorAttachments).toHaveLength(8);
      expect(useSessionsStore.getState().sessions.get(SID)?.editorAttachmentReads).toBe(0);
      composer.unmount();
    } finally {
      vi.stubGlobal("FileReader", original);
    }
  });

  it("releases reserved image slots after read errors and aborts", async () => {
    setSessionField({
      availableModels: [{ id: "text-model", name: "Image", input: ["text", "image"] }],
    });
    const readers: Array<{
      result: string | null;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      onabort: (() => void) | null;
    }> = [];
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(): void {
        readers.push(this);
      }
    }
    const original = globalThis.FileReader;
    vi.stubGlobal("FileReader", DeferredReader);
    try {
      const composer = mount();
      const dropTarget = composer.container.querySelector<HTMLElement>(".composer")!;
      const images = Array.from({ length: 10 }, (_, index) =>
        pickedFile(`retry-${index}.png`, "image/png", `/tmp/retry-${index}.png`),
      );
      dispatchFileDrag(dropTarget, "drop", images.slice(0, 8));
      expect(readers).toHaveLength(8);

      act(() => {
        readers[0]!.onerror?.();
        readers[1]!.onabort?.();
      });
      dispatchFileDrag(dropTarget, "drop", images.slice(8));
      expect(readers).toHaveLength(10);
      expect(useSessionsStore.getState().sessions.get(SID)?.editorAttachmentReads).toBe(8);

      act(() => {
        for (const reader of readers.slice(2)) {
          reader.result = "data:image/png;base64,eA==";
          reader.onload?.();
        }
      });
      await vi.waitFor(() =>
        expect(composer.container.querySelectorAll(".composer__attachment-thumb")).toHaveLength(8),
      );
      expect(useSessionsStore.getState().sessions.get(SID)?.editorAttachments).toHaveLength(8);
      expect(useSessionsStore.getState().sessions.get(SID)?.editorAttachmentReads).toBe(0);
      composer.unmount();
    } finally {
      vi.stubGlobal("FileReader", original);
    }
  });

  it("keeps file/image attachments staged across extension commands and clears each authority-confirmed context exactly once", async () => {
    setSessionField({
      availableModels: [{ id: "text-model", name: "Image", input: ["text", "image"] }],
      commands: [{ name: "widget-on", description: "Open", source: "extension" }],
    });
    setAuthorityAttachments([
      { kind: "file", name: "notes.txt", path: "/tmp/notes.txt" },
      {
        kind: "image",
        name: "diagram.png",
        path: "/tmp/diagram.png",
        dataUrl: "data:image/png;base64,eA==",
      },
    ]);
    useSessionsStore
      .getState()
      .setDiffComment(SID, { filePath: "a.ts", lineNumber: 1, lineText: "x", text: "Explain" });
    const composer = mount();
    await vi.waitFor(() =>
      expect(composer.container.querySelectorAll(".composer__attachment-item")).toHaveLength(3),
    );
    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SID)).toHaveLength(1);
    type(composer.textarea(), "/widget-on");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    expect(intentCalls(invoke)[0]!.intent).toMatchObject({
      kind: "invokeCommand",
      text: "/widget-on",
    });
    await vi.waitFor(() => expect(composer.textarea().value).toBe(""));
    expect(composer.container.querySelectorAll(".composer__attachment-item")).toHaveLength(2);
    // The invokeCommand terminal outcome clears the staged comment context,
    // while file/image editor custody remains for the ordinary prompt.
    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SID)).toEqual([]);
    type(composer.textarea(), "  /tmp/notes.txt is context");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(2));
    const prompt = intentCalls(invoke)[1]!.intent as Extract<SessionIntent, { kind: "submit" }>;
    expect(prompt.text).toContain("/tmp/notes.txt");
    expect(prompt.text).not.toContain("### User comments on the code");
    expect(prompt.images).toHaveLength(1);
    await vi.waitFor(() =>
      expect(composer.container.querySelectorAll(".composer__attachment-item")).toHaveLength(0),
    );
    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SID)).toEqual([]);
    composer.unmount();
  });

  it("submits image-only prompts and file paths as prompt intent payloads", async () => {
    setSessionField({
      availableModels: [{ id: "text-model", name: "Image", input: ["text", "image"] }],
    });
    setAuthorityAttachments([
      {
        kind: "image",
        name: "diagram.png",
        path: "/tmp/diagram.png",
        dataUrl: "data:image/png;base64,eA==",
      },
    ]);
    const composer = mount();
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    expect(intentCalls(invoke)[0]!.intent).toMatchObject({
      kind: "submit",
      text: "",
      images: [{ type: "image", data: "eA==", mimeType: "image/png" }],
    });
    composer.unmount();

    const files = mount();
    type(files.textarea(), " Please inspect");
    selectFiles(files.container.querySelector<HTMLInputElement>('input[type="file"]')!, [
      pickedFile("notes.txt", "text/plain", "/tmp/notes.txt"),
    ]);
    key(files.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(2));
    expect(intentCalls(invoke)[1]!.intent).toMatchObject({
      kind: "submit",
      text: "/tmp/notes.txt\n Please inspect",
    });
    files.unmount();
  });

  it("allows the same text again when its attachment payload changes and refuses submit during an image read", async () => {
    installInvoke(invoke, false);
    const acceptPending = async (envelope: Envelope): Promise<void> => {
      // Acceptance receipts end the "sending" freeze; the first submission's
      // terminal outcome is still pending, so the same-text dedupe key only
      // releases for a distinct payload.
      act(() =>
        useSessionsStore.getState().applySubmissionDisposition(SID, {
          intentId: envelope.intentId,
          hostInstanceId: OWNER.hostInstanceId,
          sessionEpoch: OWNER.sessionEpoch,
          editorRevision: (envelope.intent as Extract<SessionIntent, { kind: "submit" }>)
            .editorRevision,
          disposition: "in_custody",
        }),
      );
    };
    const composer = mount();
    type(composer.textarea(), "same text");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    await acceptPending(intentCalls(invoke)[0]!);
    await vi.waitFor(() => expect(composer.textarea().disabled).toBe(false));

    type(composer.textarea(), "same text");
    selectFiles(composer.container.querySelector<HTMLInputElement>('input[type="file"]')!, [
      pickedFile("second.txt", "text/plain", "/tmp/second.txt"),
    ]);
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(2));
    expect(intentCalls(invoke)[1]!.intent).toMatchObject({ text: "/tmp/second.txt\nsame text" });
    await acceptPending(intentCalls(invoke)[1]!);
    await vi.waitFor(() => expect(composer.textarea().disabled).toBe(false));

    type(composer.textarea(), "third prompt");
    useSessionsStore.getState().beginEditorAttachmentRead(SID);
    key(composer.textarea(), "Enter");
    await Promise.resolve();
    expect(intentCalls(invoke)).toHaveLength(2);
    expect(useSessionsStore.getState().sessions.get(SID)?.toasts.at(-1)?.message).toContain(
      "finish loading",
    );
    useSessionsStore.getState().endEditorAttachmentRead(SID);
    composer.unmount();
  });

  it("patches an image with text typed after reading started and discards it after session switch", async () => {
    setSessionField({
      availableModels: [{ id: "text-model", name: "Image", input: ["text", "image"] }],
    });
    let reader: { result: string | null; onload: (() => void) | null } | undefined;
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(): void {
        reader = this;
      }
    }
    const original = globalThis.FileReader;
    vi.stubGlobal("FileReader", DeferredReader);
    try {
      const composer = mount();
      type(composer.textarea(), "before");
      selectFiles(composer.container.querySelector<HTMLInputElement>('input[type="file"]')!, [
        pickedFile("diagram.png", "image/png", "/tmp/diagram.png"),
      ]);
      type(composer.textarea(), "newer typing");
      act(() => {
        if (!reader) throw new Error("reader not started");
        reader.result = "data:image/png;base64,eA==";
        reader.onload?.();
      });
      await vi.waitFor(() =>
        expect(
          invoke.mock.calls.filter(([c]) => c === "session.editorPatch").at(-1)?.[1],
        ).toMatchObject({
          text: "newer typing",
          attachments: [expect.objectContaining({ name: "diagram.png" })],
        }),
      );
      useSessionsStore.getState().createSession(SID_B, WORKSPACE);
      setSessionField(
        {
          status: "ready",
          availability: "available",
          currentModel: "text-model",
          hostInstanceId: "22222222-2222-4222-8222-222222222222",
          editorRevision: 0,
        },
        SID_B,
      );
      act(() => flushSync(() => composer.root.render(<Composer sessionId={SID_B} />)));
      composer.unmount();
    } finally {
      vi.stubGlobal("FileReader", original);
    }
  });

  it("discards a deferred image read after the Composer switches sessions", async () => {
    setSessionField({
      availableModels: [{ id: "text-model", name: "Image", input: ["text", "image"] }],
    });
    useSessionsStore.getState().createSession(SID_B, WORKSPACE);
    setSessionField(
      {
        status: "ready",
        availability: "available",
        currentModel: "text-model",
        hostInstanceId: "22222222-2222-4222-8222-222222222222",
        editorRevision: 0,
      },
      SID_B,
    );
    let reader: { result: string | null; onload: (() => void) | null } | undefined;
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL(): void {
        reader = this;
      }
    }
    const original = globalThis.FileReader;
    vi.stubGlobal("FileReader", DeferredReader);
    try {
      const composer = mount();
      selectFiles(composer.container.querySelector<HTMLInputElement>('input[type="file"]')!, [
        pickedFile("private.png", "image/png", "/tmp/private.png"),
      ]);
      act(() => flushSync(() => composer.root.render(<Composer sessionId={SID_B} />)));
      invoke.mockClear();
      act(() => {
        if (!reader) throw new Error("reader not started");
        reader.result = "data:image/png;base64,cHJpdmF0ZQ==";
        reader.onload?.();
      });
      await Promise.resolve();
      expect(
        invoke.mock.calls.filter(
          ([channel, payload]) =>
            channel === "session.editorPatch" &&
            (payload as { attachments?: unknown[] }).attachments?.length,
        ),
      ).toEqual([]);
      expect(useSessionsStore.getState().sessions.get(SID_B)?.editorAttachments).toEqual([]);
      expect(useSessionsStore.getState().sessions.get(SID)?.editorAttachmentReads).toBe(0);
      composer.unmount();
    } finally {
      vi.stubGlobal("FileReader", original);
    }
  });

  it("renders injected path-only editor text as file tiles and submits those paths", async () => {
    const composer = mount();
    act(() => useSessionsStore.getState().injectEditorText(SID, "/tmp/a.txt\n/tmp/b.txt"));
    await vi.waitFor(() =>
      expect(composer.container.querySelectorAll(".composer__attachment-item--file")).toHaveLength(
        2,
      ),
    );
    expect(composer.textarea().value).toBe("");
    key(composer.textarea(), "Enter");
    await vi.waitFor(() => expect(intentCalls(invoke)).toHaveLength(1));
    expect(intentCalls(invoke)[0]!.intent).toMatchObject({ text: "/tmp/a.txt\n/tmp/b.txt" });
    composer.unmount();
  });
});
