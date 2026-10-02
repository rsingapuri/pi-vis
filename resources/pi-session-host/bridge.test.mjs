import fs from "node:fs";
import {
  CredentialSynchronizationError,
  resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PI_COMMAND_POLICY } from "../../src/shared/pi-protocol/commands.ts";
import {
  MARKDOWN_TRANSFORM_MAX_OUTPUT_BYTES,
  MARKDOWN_TRANSFORM_MAX_RESPONSE_BATCH_BYTES,
} from "../../src/shared/pi-protocol/markdown-transform.ts";
import {
  AuthorityAttachBaselineResponseSchema,
  AuthorityFrameSchema,
  TransitionBatchSchema,
} from "../../src/shared/pi-protocol/runtime-state.ts";
import { assertHostCapabilities, setupCommandBridge } from "./bridge.mjs";

const MODEL_SCOPE_PI = {
  CredentialSynchronizationError,
  resolveModelScopeWithDiagnostics,
  getShellConfig: vi.fn(() => ({ shell: "/bin/bash", args: ["-c"] })),
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The bridge translates pi-vis wire commands → pi SDK method calls. It is plain
// .mjs (not type-checked against pi's .d.ts), so a wrong field name or argument
// shape slips past tsc AND every other test — exactly the failure class the
// Phase-1 capture effort was about. These tests pin the mapping with a fully
// faked AgentSession/runtime.

it("has an explicit bridge branch for every classified command", () => {
  const source = fs.readFileSync(new URL("./bridge.mjs", import.meta.url), "utf8");
  for (const commandType of Object.keys(PI_COMMAND_POLICY)) {
    expect(source, `missing bridge case for ${commandType}`).toContain(`case "${commandType}"`);
  }
});

// ─── Fakes ─────────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return {
    // getters read by getState()
    model: { id: "claude-x", provider: "anthropic" },
    thinkingLevel: "medium",
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    retryAttempt: 0,
    isBashRunning: false,
    steeringMode: "off",
    followUpMode: "off",
    sessionFile: "/s/file.jsonl",
    sessionId: "sid-1",
    sessionName: "My session",
    autoCompactionEnabled: true,
    messages: [{ id: "m1" }, { id: "m2" }],
    pendingMessageCount: 0,
    promptTemplates: [],
    // methods
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn(),
    steer: vi.fn(async () => "queued"),
    followUp: vi.fn(async () => "queued"),
    abort: vi.fn(async () => {}),
    abortCompaction: vi.fn(),
    abortBranchSummary: vi.fn(),
    abortRetry: vi.fn(),
    clearQueue: vi.fn(() => ({})),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    setModel: vi.fn(async () => {}),
    cycleModel: vi.fn(async () => ({ model: { id: "next" }, thinkingLevel: "low" })),
    setThinkingLevel: vi.fn(() => {}),
    cycleThinkingLevel: vi.fn(() => "high"),
    setSteeringMode: vi.fn(() => {}),
    setFollowUpMode: vi.fn(() => {}),
    setAutoCompactionEnabled: vi.fn(() => {}),
    setAutoRetryEnabled: vi.fn(() => {}),
    executeBash: vi.fn(async () => ({ output: "ok", exitCode: 0, cancelled: false })),
    recordBashResult: vi.fn(),
    abortBash: vi.fn(() => {}),
    compact: vi.fn(async () => {}),
    getSessionStats: vi.fn(() => ({ tokens: { input: 1 } })),
    getLastAssistantText: vi.fn(() => "hi"),
    exportToHtml: vi.fn(async () => "/out.html"),
    getUserMessagesForForking: vi.fn(() => [{ entryId: "e1", text: "t" }]),
    getSteeringMessages: vi.fn(() => []),
    getFollowUpMessages: vi.fn(() => []),
    setSessionName: vi.fn(() => {}),
    bindExtensions: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    modelRuntime: {
      getAvailable: vi.fn(async () => [
        { provider: "anthropic", id: "claude-x", name: "Claude X" },
      ]),
      getModel: vi.fn(),
      refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
      logout: vi.fn(async () => {}),
      listCredentials: vi.fn(async () => []),
      getProvider: vi.fn(),
    },
    extensionRunner: {
      getCommand: vi.fn(() => undefined),
      getRegisteredCommands: vi.fn(() => []),
      hasHandlers: vi.fn(() => false),
      emitInput: vi.fn(async () => ({ action: "continue" })),
      emitUserBash: vi.fn(async () => undefined),
    },
    resourceLoader: { getSkills: vi.fn(() => ({ skills: [] })) },
    sessionManager: {
      getLeafId: vi.fn(() => "leaf-9"),
      getBranch: vi.fn(() => []),
      getCwd: vi.fn(() => "/work"),
      appendCustomEntry: vi.fn(),
    },
    settingsManager: { setEnabledModels: vi.fn(), getEnabledModels: vi.fn(() => undefined) },
    scopedModels: [],
    setScopedModels: vi.fn(),
    ...overrides,
  };
}

function makeRuntime(session) {
  return {
    session,
    newSession: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false, selectedText: "forked" })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    setRebindSession: vi.fn(),
    setBeforeSessionInvalidate: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeUiState(overrides = {}) {
  const readSourceEditor =
    overrides.editorSnapshot ?? (() => ({ revision: 0, text: "", attachments: [] }));
  let consumedEditor;
  const currentEditor = () => {
    const source = readSourceEditor();
    if (
      consumedEditor &&
      source.revision === consumedEditor.sourceRevision &&
      source.text === consumedEditor.sourceText
    ) {
      return consumedEditor.editor;
    }
    return source;
  };
  const consumeEditor = (request, consumeAttachments) => {
    const editor = currentEditor();
    if (request.editorRevision !== editor.revision) return false;
    if (request.inputKind === "slash_command" && request.text !== editor.text) return false;
    consumedEditor = {
      sourceRevision: editor.revision,
      sourceText: editor.text,
      editor: {
        ...editor,
        revision: editor.revision + 1,
        text: "",
        ...(consumeAttachments ? { attachments: [] } : {}),
      },
    };
    return true;
  };
  return {
    catalogSnapshot: () => ({}),
    applyEditorPatch: () => ({ accepted: false }),
    ...overrides,
    editorSnapshot: currentEditor,
    acceptEditorSubmission:
      overrides.acceptEditorSubmission ??
      ((request) => consumeEditor(request, request.inputKind === "ordinary")),
    acceptShellEditorSubmission:
      overrides.acceptShellEditorSubmission ??
      ((request) => {
        const editor = currentEditor();
        if (request.editorRevision !== editor.revision || request.editorText !== editor.text) {
          return false;
        }
        consumedEditor = {
          sourceRevision: editor.revision,
          sourceText: editor.text,
          editor: { ...editor, revision: editor.revision + 1, text: "" },
        };
        return true;
      }),
    publishShellEditorSubmission:
      overrides.publishShellEditorSubmission ??
      ((request) => {
        const editor = currentEditor();
        return editor.revision === request.editorRevision + 1 && editor.text === "";
      }),
    rollbackShellEditorSubmission:
      overrides.rollbackShellEditorSubmission ??
      ((request) => {
        if (request.surface === "unified") return true;
        const editor = currentEditor();
        if (editor.revision !== request.editorRevision + 1 || editor.text !== "") return false;
        consumedEditor = undefined;
        return true;
      }),
  };
}

function makeShellController(overrides = {}) {
  return {
    operations: { exec: vi.fn() },
    snapshot: vi.fn(() => ({
      cols: 80,
      rows: 8,
      interruptRequested: false,
      forceKillRequested: false,
      terminal: { alternateScreenSeen: false },
    })),
    writeInput: vi.fn(),
    resize: vi.fn(),
    interrupt: vi.fn(),
    forceKill: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

/** Build a bridge + a `send` spy; return helpers to drive commands. */
function setup(sessionOverrides, bridgeOverrides = {}) {
  const session = makeSession(sessionOverrides);
  const runtime = makeRuntime(session);
  const send = vi.fn();
  const panelBridge = { closeAll: vi.fn(() => false) };
  const bridge = setupCommandBridge({
    runtime,
    session,
    uiContext: {},
    send,
    panelBridge,
    pi: MODEL_SCOPE_PI,
    ...bridgeOverrides,
  });
  const {
    handleCommand,
    handleSubmit,
    handleEscape,
    handleReload,
    dispatchIntent,
    bindExtensions,
  } = bridge;
  let nextId = 0;
  const run = async (command, uiSurface) => {
    const id = `cmd-${++nextId}`;
    await handleCommand({ id, command, ...(uiSurface ? { uiSurface } : {}) });
    // Return the last response message for this id.
    const responses = send.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === "response" && m.id === id);
    return responses[responses.length - 1];
  };
  return {
    session,
    runtime,
    send,
    panelBridge,
    interruptActiveOperation: bridge.interruptActiveOperation,
    handleSubmit,
    handleEscape,
    handleReload,
    dispatchIntent,
    bindExtensions,
    requestAuthorityAttach: bridge.requestAuthorityAttach,
    sendShellInput: bridge.sendShellInput,
    resizeShell: bridge.resizeShell,
    acknowledgeShellReconstruction: bridge.acknowledgeShellReconstruction,
    setShellTransportBackpressure: bridge.setShellTransportBackpressure,
    signalShell: bridge.signalShell,
    retainedShellSnapshot: bridge.retainedShellSnapshot,
    authority: bridge.authority,
    run,
  };
}

// ─── Wiring on setup ─────────────────────────────────────────────────────────

describe("setupCommandBridge — wiring", () => {
  it("subscribes to the session and registers rebind + before-invalidate", () => {
    const { session, runtime } = setup();
    expect(session.subscribe).toHaveBeenCalledTimes(1);
    expect(runtime.setRebindSession).toHaveBeenCalledTimes(1);
    expect(runtime.setBeforeSessionInvalidate).toHaveBeenCalledTimes(1);
  });

  it("publishes extension runner errors on the authoritative transcript plane", async () => {
    const sendPresentation = vi.fn();
    const { session, bindExtensions, send } = setup(undefined, { sendPresentation });
    await bindExtensions(session);
    const bindings = session.bindExtensions.mock.calls[0][0];

    bindings.onError({
      extensionPath: "command:e2e-throw",
      event: "command",
      error: "e2e lifecycle command error",
    });

    expect(sendPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "transcript",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "extension_error",
              extensionPath: "command:e2e-throw",
              event: "command",
              error: "e2e lifecycle command error",
            }),
          ],
        }),
      }),
    );
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "event" }));
  });

  it("retires dialogs from the old extension generation at invalidation", () => {
    const cancelDialogs = vi.fn();
    const resetExtensionPresentation = vi.fn();
    const { runtime } = setup(undefined, {
      cancelDialogs,
      uiState: makeUiState({ resetExtensionPresentation }),
    });

    runtime.setBeforeSessionInvalidate.mock.calls[0][0]();

    expect(cancelDialogs).toHaveBeenCalledTimes(1);
    expect(resetExtensionPresentation).toHaveBeenCalledTimes(1);
  });

  it("rejects extension-action reload against fresh active host getters", async () => {
    const { session, handleReload } = setup({ isIdle: false, isStreaming: true });

    await expect(handleReload()).rejects.toThrow("current response");

    expect(session.reload).not.toHaveBeenCalled();
  });

  it("cancels dialogs from the old extension generation during reload", async () => {
    const cancelDialogs = vi.fn();
    const resetExtensionPresentation = vi.fn();
    const { session, handleReload } = setup(undefined, {
      cancelDialogs,
      uiState: makeUiState({ resetExtensionPresentation }),
    });
    session.reload.mockImplementationOnce(async ({ beforeSessionStart }) => {
      await beforeSessionStart();
    });

    await handleReload();

    expect(cancelDialogs).toHaveBeenCalledTimes(1);
    expect(resetExtensionPresentation).toHaveBeenCalledTimes(1);
  });

  it("uses the canonical source for both reload lock permits from a runtime pin", async () => {
    const requestTransitionPermit = vi.fn(async () => ({ allowed: true }));
    const { session, handleReload } = setup(
      { sessionFile: "/sessions/.pivis-session.runtime-pin" },
      {
        initialPresentedSessionFile: "/sessions/original.jsonl",
        requestTransitionPermit,
      },
    );
    session.reload.mockImplementationOnce(async ({ beforeSessionStart }) => {
      await beforeSessionStart();
    });

    await handleReload();

    expect(requestTransitionPermit).toHaveBeenCalledTimes(2);
    expect(requestTransitionPermit.mock.calls.map(([request]) => request.targetFile)).toEqual([
      "/sessions/original.jsonl",
      "/sessions/original.jsonl",
    ]);
  });

  it("clears reload command text in the successor editor baseline", async () => {
    const editor = {
      revision: 7,
      text: "/reload",
      attachments: [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }],
    };
    const acceptEditorSubmission = vi.fn((request) => {
      if (request.editorRevision !== editor.revision || request.text !== editor.text) return false;
      editor.revision++;
      editor.text = "";
      return true;
    });
    const sendControl = vi.fn();
    const { session, dispatchIntent } = setup(undefined, {
      sendControl,
      uiState: {
        catalogSnapshot: () => ({}),
        editorSnapshot: () => ({ ...editor, attachments: [...editor.attachments] }),
        acceptEditorSubmission,
        applyEditorPatch: vi.fn(),
      },
    });
    session.reload.mockImplementationOnce(async ({ beforeSessionStart }) => {
      await beforeSessionStart();
    });

    await expect(
      dispatchIntent({
        intentId: "reload-editor-command",
        expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
        intent: { kind: "reload", editorRevision: 7, editorText: "/reload" },
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(sendControl.mock.calls.some(([message]) => message.type === "transition_batch")).toBe(
        true,
      ),
    );

    expect(acceptEditorSubmission).toHaveBeenCalledWith({
      intentId: "reload-editor-command",
      editorRevision: 7,
      text: "/reload",
      inputKind: "slash_command",
    });
    expect(editor).toMatchObject({ text: "", attachments: [{ name: "notes.txt" }] });
    const batch = sendControl.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "transition_batch")?.batch;
    expect(batch?.terminalSnapshot.editor).toMatchObject({
      revision: 8,
      text: "",
      attachments: [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }],
    });
  });

  it("preserves an extension reload's unrelated editor draft", async () => {
    const editor = {
      revision: 4,
      text: "ordinary unsent draft",
      attachments: [{ kind: "file", name: "draft.txt", path: "/tmp/draft.txt" }],
    };
    const applyEditorPatch = vi.fn();
    const sendControl = vi.fn();
    const { session, handleReload } = setup(undefined, {
      sendControl,
      uiState: {
        catalogSnapshot: () => ({}),
        editorSnapshot: () => ({ ...editor, attachments: [...editor.attachments] }),
        acceptEditorSubmission: () => false,
        applyEditorPatch,
      },
    });
    session.reload.mockImplementationOnce(async ({ beforeSessionStart }) => {
      await beforeSessionStart();
    });

    await handleReload();

    expect(applyEditorPatch).not.toHaveBeenCalled();
    const batch = sendControl.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "transition_batch")?.batch;
    expect(batch?.terminalSnapshot.editor).toMatchObject(editor);
  });

  it("consumes reload command text while preserving independent conflict custody", async () => {
    const editor = {
      revision: 4,
      text: "/reload",
      attachments: [],
      conflictText: "newer draft",
      conflictAttachments: [{ kind: "file", name: "conflict.txt", path: "/tmp/conflict.txt" }],
    };
    const acceptEditorSubmission = vi.fn();
    const sendControl = vi.fn();
    const { session, dispatchIntent } = setup(undefined, {
      sendControl,
      uiState: {
        catalogSnapshot: () => ({}),
        editorSnapshot: () => ({
          ...editor,
          attachments: [...editor.attachments],
          conflictAttachments: [...editor.conflictAttachments],
        }),
        acceptEditorSubmission,
        applyEditorPatch: vi.fn(),
      },
    });
    session.reload.mockImplementationOnce(async ({ beforeSessionStart }) => {
      await beforeSessionStart();
    });

    await expect(
      dispatchIntent({
        intentId: "reload-editor-conflict",
        expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
        intent: { kind: "reload", editorRevision: 4, editorText: "/reload" },
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(sendControl.mock.calls.some(([message]) => message.type === "transition_batch")).toBe(
        true,
      ),
    );

    expect(acceptEditorSubmission).toHaveBeenCalledWith({
      intentId: "reload-editor-conflict",
      editorRevision: 4,
      text: "/reload",
      inputKind: "slash_command",
    });
    expect(editor).toMatchObject({
      conflictText: "newer draft",
      conflictAttachments: [{ name: "conflict.txt" }],
    });
  });

  it("preserves a newer retyped reload command", async () => {
    const editor = { revision: 8, text: "/reload ", attachments: [] };
    const acceptEditorSubmission = vi.fn();
    const sendControl = vi.fn();
    const { session, dispatchIntent } = setup(undefined, {
      sendControl,
      uiState: {
        catalogSnapshot: () => ({}),
        editorSnapshot: () => ({ ...editor }),
        acceptEditorSubmission,
        applyEditorPatch: vi.fn(),
      },
    });
    session.reload.mockImplementationOnce(async ({ beforeSessionStart }) => {
      await beforeSessionStart();
    });

    await expect(
      dispatchIntent({
        intentId: "reload-newer-editor-command",
        expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
        intent: { kind: "reload", editorRevision: 7, editorText: "/reload" },
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(sendControl.mock.calls.some(([message]) => message.type === "transition_batch")).toBe(
        true,
      ),
    );

    expect(acceptEditorSubmission).not.toHaveBeenCalled();
    const batch = sendControl.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "transition_batch")?.batch;
    expect(batch?.terminalSnapshot.editor).toMatchObject(editor);
  });

  it("routes extension replacement actions through transition fencing", async () => {
    const sendControl = vi.fn();
    const { session, runtime, bindExtensions } = setup(undefined, { sendControl });
    await bindExtensions(session);
    const actions = session.bindExtensions.mock.calls[0][0].commandContextActions;

    await actions.newSession({ parentSession: "/tmp/parent.jsonl" });

    expect(runtime.newSession).toHaveBeenCalledWith({ parentSession: "/tmp/parent.jsonl" });
    expect(sendControl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "transition_batch",
        batch: expect.objectContaining({ terminalSnapshot: expect.any(Object) }),
      }),
    );
  });

  it("canonicalizes a confined runtime pin before extension replacement actions", async () => {
    const runtimePin = "/sessions/.pivis-session-42-runtime.runtime-pin";
    const canonicalSessionFile = "/sessions/source.jsonl";
    const requestTransitionPermit = vi.fn(async () => ({ allowed: true }));
    const parentSetup = vi.fn();
    const parentWithSession = vi.fn();
    const newFixture = setup(
      { sessionFile: runtimePin },
      { initialPresentedSessionFile: canonicalSessionFile, requestTransitionPermit },
    );
    await newFixture.bindExtensions(newFixture.session);
    const newActions = newFixture.session.bindExtensions.mock.calls[0][0].commandContextActions;
    const newSuccessor = makeSession({
      sessionId: "canonical-new-successor",
      sessionFile: "/sessions/new-successor.jsonl",
    });
    newFixture.runtime.newSession.mockImplementationOnce(async () => {
      await newFixture.runtime.setRebindSession.mock.calls[0][0](newSuccessor);
      return { cancelled: false };
    });

    await newActions.newSession({
      parentSession: runtimePin,
      setup: parentSetup,
      withSession: parentWithSession,
    });

    expect(newFixture.runtime.newSession).toHaveBeenCalledWith({
      parentSession: canonicalSessionFile,
      setup: parentSetup,
      withSession: parentWithSession,
    });
    expect(JSON.stringify(requestTransitionPermit.mock.calls)).not.toContain(runtimePin);

    const switchPermits = vi.fn(async () => ({ allowed: true }));
    const switchFixture = setup(
      { sessionFile: runtimePin },
      { initialPresentedSessionFile: canonicalSessionFile, requestTransitionPermit: switchPermits },
    );
    await switchFixture.bindExtensions(switchFixture.session);
    const switchActions =
      switchFixture.session.bindExtensions.mock.calls[0][0].commandContextActions;
    const switchOptions = { withSession: vi.fn() };
    const switchSuccessor = makeSession({
      sessionId: "canonical-switch-successor",
      sessionFile: canonicalSessionFile,
    });
    switchFixture.runtime.switchSession.mockImplementationOnce(async () => {
      await switchFixture.runtime.setRebindSession.mock.calls[0][0](switchSuccessor);
      return { cancelled: false };
    });

    await switchActions.switchSession(runtimePin, switchOptions);

    expect(switchFixture.runtime.switchSession).toHaveBeenCalledWith(
      canonicalSessionFile,
      switchOptions,
    );
    expect(switchPermits).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phase: "prepare", targetFile: canonicalSessionFile }),
    );
    expect(switchPermits).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: "successor", targetFile: canonicalSessionFile }),
    );
    expect(JSON.stringify(switchPermits.mock.calls)).not.toContain(runtimePin);
  });

  it("allows a command-context replacement to own its one active submission", async () => {
    const { session, runtime, handleSubmit, bindExtensions } = setup(undefined, {
      uiState: makeUiState({
        editorSnapshot: () => ({
          revision: 0,
          text: "/replace-from-extension",
          attachments: [],
        }),
      }),
    });
    await bindExtensions(session);
    const actions = session.bindExtensions.mock.calls[0][0].commandContextActions;
    runtime.newSession.mockImplementationOnce(async () => {
      await runtime.setRebindSession.mock.calls[0][0](
        makeSession({ sessionId: "extension-replacement" }),
      );
      return { cancelled: false };
    });
    session.prompt.mockImplementation(async (_text, options) => {
      await actions.newSession();
      options.preflightResult("handled");
    });

    await expect(
      handleSubmit({
        submission: {
          intentId: "extension-owned-replacement",
          expectedHostId: "test-host",
          expectedEpoch: 0,
          editorRevision: 0,
          text: "/replace-from-extension",
          inputKind: "slash_command",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      }),
    ).resolves.toMatchObject({ disposition: "consumed", sessionEpoch: 0 });
    expect(runtime.newSession).toHaveBeenCalledTimes(1);
  });

  it("settles an extension-triggered replacement on its predecessor frame before following the successor", async () => {
    const sendControl = vi.fn();
    const sendFrame = vi.fn();
    const { session, runtime, dispatchIntent, bindExtensions } = setup(
      {
        extensionRunner: {
          getCommand: vi.fn((name) => (name === "replace" ? {} : undefined)),
          getRegisteredCommands: vi.fn(() => []),
        },
      },
      {
        sendControl,
        sendFrame,
        uiState: makeUiState({
          editorSnapshot: () => ({ revision: 0, text: "/replace", attachments: [] }),
        }),
      },
    );
    await bindExtensions(session);
    const actions = session.bindExtensions.mock.calls[0][0].commandContextActions;
    const successor = makeSession({ sessionId: "extension-successor" });
    runtime.newSession.mockImplementationOnce(async () => {
      await runtime.setRebindSession.mock.calls[0][0](successor);
      return { cancelled: false };
    });
    session.prompt.mockImplementation(async (_text, options) => {
      await actions.newSession();
      options.preflightResult("handled");
    });
    sendControl.mockClear();
    sendFrame.mockClear();

    await dispatchIntent({
      intentId: "extension-replacement-intent",
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "invokeCommand", text: "/replace", editorRevision: 0 },
    });
    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "extension-replacement-intent",
            owner: { hostInstanceId: "test-host", sessionEpoch: 0 },
            state: "completed",
          }),
        }),
      ),
    );

    expect(runtime.newSession).toHaveBeenCalledTimes(1);
    expect(sendFrame.mock.calls.map(([frame]) => frame).at(-1)).toMatchObject({
      owner: { hostInstanceId: "test-host", sessionEpoch: 1 },
      records: [],
    });
    const transitionBatch = sendControl.mock.calls
      .map(([payload]) => payload)
      .findLast((payload) => payload?.type === "transition_batch")?.batch;
    expect(TransitionBatchSchema.safeParse(transitionBatch).success).toBe(true);
  });

  it("retires extension-triggered replacement after post-invalidation failure", async () => {
    const { session, runtime, send, bindExtensions } = setup();
    await bindExtensions(session);
    const actions = session.bindExtensions.mock.calls[0][0].commandContextActions;
    runtime.newSession.mockImplementationOnce(async () => {
      runtime.setBeforeSessionInvalidate.mock.calls[0][0]();
      throw new Error("extension replacement failed");
    });

    await expect(actions.newSession()).rejects.toThrow("extension replacement failed");
    expect(send).toHaveBeenCalledWith({
      type: "fatal_transition_error",
      message: "extension replacement failed",
    });
  });

  it("waitForIdle observes the current public session getter", async () => {
    vi.useFakeTimers();
    try {
      const { session, bindExtensions } = setup({ isIdle: false, isStreaming: true });
      await bindExtensions(session);
      const actions = session.bindExtensions.mock.calls[0][0].commandContextActions;
      let settled = false;
      const pending = actions.waitForIdle().finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      session.isStreaming = false;
      session.isIdle = true;
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards raw session events without inferred state events", () => {
    const { session, send } = setup();
    const subscriber = session.subscribe.mock.calls[0][0];
    const event = { type: "agent_end", willRetry: true, opaque: { value: 1 } };
    subscriber(event);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "event", event });
  });

  it("honors Pi 0.80.4 showCacheMissNotices in SDK-host mode", () => {
    const previous = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-x",
      timestamp: 0,
      usage: { input: 10_000, cacheRead: 20_000, cacheWrite: 0 },
    };
    const { session, send } = setup({
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => undefined),
        getShowCacheMissNotices: vi.fn(() => true),
      },
      sessionManager: {
        getLeafId: vi.fn(() => "leaf-9"),
        getBranch: vi.fn(() => [{ type: "message", message: previous }]),
        // A later abandoned-branch entry must not become the previous request.
        getEntries: vi.fn(() => [
          { type: "message", message: previous },
          {
            type: "message",
            message: {
              ...previous,
              model: "abandoned-branch-model",
              timestamp: 5 * 60_000,
              usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ]),
      },
    });
    const subscriber = session.subscribe.mock.calls[0][0];
    subscriber({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-x",
        timestamp: 6 * 60_000,
        stopReason: "stop",
        usage: {
          input: 30_000,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.3, cacheRead: 0, cacheWrite: 0 },
        },
      },
    });

    expect(send).toHaveBeenCalledWith({
      type: "event",
      event: {
        type: "cache_miss_notice",
        noticeId: "cache-miss:360000:anthropic:claude-x:30000:0:0:0",
        missedTokens: 30_000,
        missedCost: 0.3,
        idleMs: 6 * 60_000,
        modelChanged: false,
      },
    });
    expect(session.sessionManager.getBranch).toHaveBeenCalledTimes(1);
    expect(session.sessionManager.getEntries).not.toHaveBeenCalled();
  });

  it("projects a live cache-warm usage entry when cache notices are enabled", () => {
    const usage = {
      input: 30_000,
      output: 1,
      cacheRead: 29_500,
      cacheWrite: 0,
      totalTokens: 59_501,
      cost: { input: 0.01, output: 0, cacheRead: 0.002, cacheWrite: 0, total: 0.012 },
    };
    const { session, send } = setup({
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => undefined),
        getShowCacheMissNotices: vi.fn(() => true),
      },
    });
    const subscriber = session.subscribe.mock.calls[0][0];

    subscriber({
      type: "entry_appended",
      entry: {
        type: "usage",
        id: "warm-1",
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude-x",
        note: "extension override",
        usage,
      },
    });

    expect(send).toHaveBeenCalledWith({
      type: "event",
      event: {
        type: "cache_warming_notice",
        noticeId: "cache-warm:warm-1",
        provider: "anthropic",
        model: "claude-x",
        note: "extension override",
        usage,
      },
    });
  });

  it("before-invalidate only emits panel_clear_all when a panel was open", () => {
    // closeAll() returns false → no panels → no spam.
    const { runtime, send } = setup();
    const beforeInvalidate = runtime.setBeforeSessionInvalidate.mock.calls[0][0];
    beforeInvalidate();
    expect(send).not.toHaveBeenCalledWith({ type: "panel_clear_all" });
  });
});

// ─── Command mapping ─────────────────────────────────────────────────────────

describe("setupCommandBridge — target intent dispatch", () => {
  it("refreshModels is an intent mutation with a bounded outcome", async () => {
    const { session, send, dispatchIntent } = setup();
    await expect(
      dispatchIntent({
        intentId: "refresh-models",
        expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
        intent: { kind: "refreshModels" },
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(session.modelRuntime.refresh).toHaveBeenCalledTimes(1));
    expect(session.modelRuntime.refresh).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "intent_outcome",
        outcome: expect.objectContaining({
          intentId: "refresh-models",
          kind: "refreshModels",
          state: "completed",
          result: { refreshed: true },
        }),
      }),
    );
  });

  it.each([
    ["an aborted refresh", { aborted: true, errors: new Map() }],
    [
      "provider refresh errors",
      {
        aborted: false,
        errors: new Map([["secret-provider", new Error("secret-provider-url-and-header")]]),
      },
    ],
  ])("does not publish success for %s or leak its details", async (_label, refreshResult) => {
    const refresh = vi.fn(async () => refreshResult);
    const { send, dispatchIntent } = setup({
      modelRuntime: { ...makeSession().modelRuntime, refresh },
    });
    await dispatchIntent({
      intentId: "failed-refresh",
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "refreshModels" },
    });

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "failed-refresh",
            kind: "refreshModels",
            state: "failed",
            error: "Model catalog refresh could not be completed",
          }),
        }),
      ),
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain("secret-provider");
    expect(JSON.stringify(send.mock.calls)).not.toContain("secret-provider-url-and-header");
  });

  it("sanitizes a rejected model refresh", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("secret-provider-refresh-url-and-header");
    });
    const { send, dispatchIntent } = setup({
      modelRuntime: { ...makeSession().modelRuntime, refresh },
    });
    await dispatchIntent({
      intentId: "rejected-refresh",
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "refreshModels" },
    });

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "rejected-refresh",
            state: "failed",
            error: "Model catalog refresh could not be completed",
          }),
        }),
      ),
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain("secret-provider-refresh-url-and-header");
  });

  it("lists dynamic runtime login methods and ambient auth without hardcoding providers", async () => {
    const modelRuntime = {
      ...makeSession().modelRuntime,
      getProviders: vi.fn(() => [
        {
          id: "project-dynamic",
          name: "Project Dynamic",
          auth: {
            oauth: { login: vi.fn() },
            apiKey: { login: vi.fn() },
          },
        },
        {
          id: "ambient-only",
          name: "Ambient Only",
          auth: { apiKey: {} },
        },
      ]),
      checkAuth: vi.fn(async (providerId) =>
        providerId === "project-dynamic" ? { type: "oauth", source: "OAuth" } : undefined,
      ),
      login: vi.fn(),
    };
    const { run } = setup({ modelRuntime });

    const result = await run({ type: "get_login_providers" });

    expect(result).toMatchObject({
      success: true,
      data: {
        native: true,
        providers: [
          {
            id: "project-dynamic",
            name: "Project Dynamic",
            configured: true,
            source: "OAuth",
            methods: ["oauth", "api_key"],
          },
        ],
      },
    });
  });

  it("runs public runtime login with an app-owned interaction and emits no credential", async () => {
    const login = vi.fn(async () => ({ type: "api_key", key: "never-publish-this" }));
    const getOrCreateDeviceId = vi.fn(() => "stable-device-id");
    const modelRuntime = {
      ...makeSession().modelRuntime,
      getProviders: vi.fn(() => [
        {
          id: "project-dynamic",
          name: "Project Dynamic",
          auth: { apiKey: { login: vi.fn() } },
        },
      ]),
      checkAuth: vi.fn(async () => undefined),
      login,
    };
    const surface = {
      interaction: { signal: new AbortController().signal, prompt: vi.fn(), notify: vi.fn() },
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const createProviderAuthSurface = vi.fn(() => surface);
    const { send, dispatchIntent } = setup(
      {
        modelRuntime,
        settingsManager: {
          setEnabledModels: vi.fn(),
          getEnabledModels: vi.fn(() => undefined),
          getOrCreateDeviceId,
        },
      },
      { createProviderAuthSurface },
    );

    await expect(
      dispatchIntent({
        intentId: "login-provider",
        expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
        intent: {
          kind: "loginProvider",
          providerId: "project-dynamic",
          authType: "api_key",
        },
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith("project-dynamic", "api_key", surface.interaction, {
      getDeviceId: expect.any(Function),
    });
    const loginOptions = login.mock.calls[0][3];
    expect(loginOptions.getDeviceId()).toBe("stable-device-id");
    expect(getOrCreateDeviceId).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(surface.complete).toHaveBeenCalledTimes(1));
    const outcome = send.mock.calls
      .map(([message]) => message)
      .find(
        (message) =>
          message.type === "intent_outcome" && message.outcome.intentId === "login-provider",
      );
    expect(outcome.outcome).toMatchObject({
      state: "completed",
      result: {
        providerId: "project-dynamic",
        authType: "api_key",
        synchronized: true,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("never-publish-this");
  });

  it("treats a committed credential with failed local synchronization as a safe warning", async () => {
    const credential = { type: "api_key", key: "never-publish-committed-key" };
    const login = vi.fn(async () => {
      throw new CredentialSynchronizationError("sync-warning", "login", credential, {
        cause: new Error("never-publish-provider-sync-detail"),
      });
    });
    const modelRuntime = {
      ...makeSession().modelRuntime,
      getProviders: vi.fn(() => [
        {
          id: "sync-warning",
          name: "Sync Warning",
          auth: { apiKey: { login: vi.fn() } },
        },
      ]),
      checkAuth: vi.fn(async () => undefined),
      login,
    };
    const surface = {
      interaction: { signal: new AbortController().signal, prompt: vi.fn(), notify: vi.fn() },
      complete: vi.fn(),
      warn: vi.fn(),
      fail: vi.fn(),
    };
    const { send, dispatchIntent } = setup(
      { modelRuntime },
      { createProviderAuthSurface: vi.fn(() => surface) },
    );

    await dispatchIntent({
      intentId: "committed-login",
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "loginProvider", providerId: "sync-warning", authType: "api_key" },
    });
    await vi.waitFor(() => expect(surface.warn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        send.mock.calls
          .map(([message]) => message)
          .some(
            (message) =>
              message.type === "intent_outcome" && message.outcome.intentId === "committed-login",
          ),
      ).toBe(true),
    );
    const outcome = send.mock.calls
      .map(([message]) => message)
      .find(
        (message) =>
          message.type === "intent_outcome" && message.outcome.intentId === "committed-login",
      );
    expect(outcome.outcome).toMatchObject({
      state: "completed",
      result: { providerId: "sync-warning", authType: "api_key", synchronized: false },
    });
    expect(surface.complete).not.toHaveBeenCalled();
    expect(surface.fail).not.toHaveBeenCalled();
    expect(JSON.stringify(send.mock.calls)).not.toContain("never-publish-committed-key");
    expect(JSON.stringify(send.mock.calls)).not.toContain("never-publish-provider-sync-detail");
  });

  it("aborts the active public login without publishing provider errors", async () => {
    const login = vi.fn(
      async (_providerId, _authType, interaction) =>
        new Promise((_resolve, reject) => {
          interaction.signal.addEventListener(
            "abort",
            () => reject(new Error("secret-provider-detail")),
            { once: true },
          );
        }),
    );
    const modelRuntime = {
      ...makeSession().modelRuntime,
      getProviders: vi.fn(() => [
        {
          id: "cancel-me",
          name: "Cancel Me",
          auth: { oauth: { login: vi.fn() } },
        },
      ]),
      checkAuth: vi.fn(async () => undefined),
      login,
    };
    const surface = {
      interaction: undefined,
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const createProviderAuthSurface = vi.fn((_name, _type, signal) => {
      surface.interaction = { signal, prompt: vi.fn(), notify: vi.fn() };
      return surface;
    });
    const { send, dispatchIntent, interruptActiveOperation } = setup(
      { modelRuntime },
      { createProviderAuthSurface },
    );
    await dispatchIntent({
      intentId: "cancel-login",
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "loginProvider", providerId: "cancel-me", authType: "oauth" },
    });
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1));

    await interruptActiveOperation();

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({ intentId: "cancel-login", state: "failed" }),
        }),
      ),
    );
    expect(surface.complete).toHaveBeenCalledTimes(1);
    expect(surface.fail).not.toHaveBeenCalled();
    expect(JSON.stringify(send.mock.calls)).not.toContain("secret-provider-detail");
  });

  it("revalidates trust and the selected login method before entering public login", async () => {
    const login = vi.fn();
    const modelRuntime = {
      ...makeSession().modelRuntime,
      getProviders: vi.fn(() => [{ id: "changed", name: "Changed", auth: { apiKey: {} } }]),
      checkAuth: vi.fn(async () => undefined),
      login,
    };
    const surfaceFactory = vi.fn();
    const denied = setup(
      {
        modelRuntime,
        settingsManager: { isProjectTrusted: vi.fn(() => false) },
      },
      { createProviderAuthSurface: surfaceFactory },
    );

    await denied.dispatchIntent({
      intentId: "untrusted-login",
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "loginProvider", providerId: "changed", authType: "api_key" },
    });
    await vi.waitFor(() =>
      expect(denied.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({ intentId: "untrusted-login", state: "failed" }),
        }),
      ),
    );

    const changed = setup({ modelRuntime }, { createProviderAuthSurface: surfaceFactory });
    await changed.dispatchIntent({
      intentId: "stale-login",
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "loginProvider", providerId: "changed", authType: "api_key" },
    });
    await vi.waitFor(() =>
      expect(changed.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({ intentId: "stale-login", state: "failed" }),
        }),
      ),
    );
    expect(login).not.toHaveBeenCalled();
    expect(surfaceFactory).not.toHaveBeenCalled();
  });
  function envelope(intentId, intent) {
    return {
      intentId,
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent,
    };
  }

  it("records admission separately from terminal outcomes for every child-owned intent kind", async () => {
    let editor = { revision: 0, text: "", attachments: [] };
    const shellController = makeShellController();
    const { session, runtime, send, dispatchIntent, authority } = setup(undefined, {
      createShellController: vi.fn(() => shellController),
      uiState: makeUiState({
        editorSnapshot: () => editor,
        acceptShellEditorSubmission: (request) => {
          if (request.editorRevision !== editor.revision || request.editorText !== editor.text) {
            return false;
          }
          editor = { ...editor, revision: editor.revision + 1, text: "" };
          return true;
        },
      }),
    });
    session.prompt.mockImplementation(async (_text, options) =>
      options.preflightResult(options.expandPromptTemplates ? "handled" : "started"),
    );
    const intents = [
      ["interrupt", {}],
      [
        "submit",
        {
          editorRevision: 0,
          text: "/tmp/notes.txt\n\nhello",
          inputKind: "ordinary",
          images: [{ type: "image", data: "bytes", mimeType: "image/png" }],
          requestedMode: "followUp",
          surface: "composer",
        },
      ],
      [
        "manageQueue",
        { operation: "clear", expectedSteeringIntentIds: [], expectedFollowUpIntentIds: [] },
      ],
      ["compact", { instructions: "brief" }],
      [
        "runBash",
        {
          command: "pwd",
          excludeFromContext: true,
          editorRevision: 0,
          editorText: "!!pwd",
        },
      ],
      ["setTrust", { optionLabel: "Trust this folder" }],
      ["navigate", { targetId: "leaf-9", summarize: true }],
      ["setModel", { provider: "anthropic", modelId: "claude-x" }],
      ["setThinking", { level: "high" }],
      ["rename", { name: "Renamed" }],
      ["reload", {}],
      ["invokeCommand", { text: "/extension arg", editorRevision: 1 }],
    ];

    for (const [kind, payload] of intents) {
      if (kind === "submit") editor = { ...editor, text: "hello" };
      else if (kind === "runBash") {
        editor = { ...editor, revision: payload.editorRevision, text: payload.editorText };
      } else if (kind === "invokeCommand") {
        editor = { ...editor, revision: payload.editorRevision, text: payload.text };
      }
      await expect(
        dispatchIntent(envelope(`intent-${kind}`, { kind, ...payload })),
      ).resolves.toEqual(
        expect.objectContaining({ status: "admitted", intentId: `intent-${kind}` }),
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "intent_outcome",
            outcome: expect.objectContaining({ intentId: `intent-${kind}`, kind }),
          }),
        ),
      );
      if (kind === "navigate") {
        expect(
          authority.acknowledgeNavigationPresentation(`intent-${kind}`, {
            hostInstanceId: "test-host",
            sessionEpoch: 0,
          }),
        ).toBe(true);
      }
    }

    expect(session.compact).toHaveBeenCalledWith("brief");
    expect(session.executeBash).toHaveBeenCalledWith("pwd", undefined, {
      id: "intent-runBash",
      excludeFromContext: true,
      operations: shellController.operations,
    });
    expect(session.navigateTree).toHaveBeenCalledWith("leaf-9", { summarize: true });
    expect(session.setModel).toHaveBeenCalled();
    expect(session.setThinkingLevel).toHaveBeenCalledWith("high", { persist: false });
    expect(session.setSessionName).toHaveBeenCalledWith("Renamed");
    expect(session.reload).toHaveBeenCalledOnce();
    // Both text intents use the child public prompt/extension path; no
    // renderer-selected PiRpcCommand type enters this dispatch.
    expect(session.prompt).toHaveBeenCalledWith(
      "/tmp/notes.txt\n\nhello",
      expect.objectContaining({
        images: [{ type: "image", data: "bytes", mimeType: "image/png" }],
        expandPromptTemplates: false,
      }),
    );
    expect(session.prompt).toHaveBeenCalledWith("/extension arg", expect.any(Object));
    expect(runtime.newSession).not.toHaveBeenCalled();
  });

  it("lets a pinned-Pi user_bash handler replace a Shell Turn result exactly once without a PTY", async () => {
    const replacement = {
      output: "extension replacement\n",
      exitCode: 23,
      cancelled: false,
      truncated: false,
    };
    const createShellController = vi.fn(() => makeShellController());
    const sendPresentation = vi.fn();
    const runWithInvocationSurface = vi.fn((_surface, operation) => operation());
    const { session, dispatchIntent } = setup(undefined, {
      createShellController,
      sendPresentation,
      runWithInvocationSurface,
      uiState: makeUiState({
        editorSnapshot: () => ({ revision: 0, text: "!!extension-result", attachments: [] }),
      }),
    });
    session.extensionRunner.emitUserBash.mockResolvedValue({ result: replacement });
    const request = envelope("extension-result", {
      kind: "runBash",
      command: "extension-result",
      excludeFromContext: true,
      editorRevision: 0,
      editorText: "!!extension-result",
    });

    await expect(dispatchIntent(request)).resolves.toMatchObject({ status: "admitted" });
    await expect(dispatchIntent(request)).resolves.toMatchObject({ status: "duplicate" });
    await vi.waitFor(() =>
      expect(session.recordBashResult).toHaveBeenCalledWith("extension-result", replacement, {
        excludeFromContext: true,
      }),
    );

    expect(session.recordBashResult).toHaveBeenCalledOnce();
    expect(runWithInvocationSurface).toHaveBeenCalledOnce();
    expect(runWithInvocationSurface).toHaveBeenCalledWith("composer", expect.any(Function));
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledWith({
      type: "user_bash",
      command: "extension-result",
      excludeFromContext: true,
      cwd: "/work",
    });
    expect(session.executeBash).not.toHaveBeenCalled();
    expect(createShellController).not.toHaveBeenCalled();
    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "pivis.shell_turn_start",
      expect.objectContaining({ executionId: "extension-result", pty: false }),
    );
    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "pivis.shell_turn_complete",
      expect.objectContaining({ executionId: "extension-result", exitCode: 23 }),
    );
    expect(sendPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "transcript",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "bash_execution_start",
              id: "extension-result",
              pty: false,
            }),
          ],
        }),
      }),
    );
    expect(sendPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "transcript",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "bash_execution_end",
              id: "extension-result",
              output: "extension replacement\n",
              exitCode: 23,
              pty: false,
            }),
          ],
        }),
      }),
    );
  });

  it("streams pinned-Pi user_bash replacement operations exactly once without constructing a PTY", async () => {
    const gate = deferred();
    const operations = { exec: vi.fn() };
    let listener;
    const executeBash = vi.fn((_command, _onChunk, options) => {
      listener?.({ type: "bash_execution_update", id: options.id, delta: "remote chunk\n" });
      return gate.promise;
    });
    const createShellController = vi.fn(() => makeShellController());
    const sendPresentation = vi.fn();
    const { session, dispatchIntent, requestAuthorityAttach } = setup(
      {
        subscribe: vi.fn((nextListener) => {
          listener = nextListener;
          return vi.fn();
        }),
        executeBash,
      },
      {
        createShellController,
        sendPresentation,
        uiState: makeUiState({
          editorSnapshot: () => ({ revision: 0, text: "!remote-command", attachments: [] }),
        }),
      },
    );
    session.extensionRunner.emitUserBash.mockResolvedValue({ operations });
    const request = envelope("extension-operations", {
      kind: "runBash",
      command: "remote-command",
      excludeFromContext: false,
      editorRevision: 0,
      editorText: "!remote-command",
    });

    await expect(dispatchIntent(request)).resolves.toMatchObject({ status: "admitted" });
    await expect(dispatchIntent(request)).resolves.toMatchObject({ status: "duplicate" });
    await vi.waitFor(() => expect(executeBash).toHaveBeenCalledOnce());
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledWith({
      type: "user_bash",
      command: "remote-command",
      excludeFromContext: false,
      cwd: "/work",
    });
    expect(executeBash).toHaveBeenCalledWith("remote-command", undefined, {
      id: "extension-operations",
      excludeFromContext: false,
      operations,
    });
    expect(createShellController).not.toHaveBeenCalled();
    expect(sendPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "transcript",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "bash_execution_start",
              id: "extension-operations",
              pty: false,
            }),
          ],
        }),
      }),
    );
    expect(sendPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "transcript",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "bash_execution_update",
              id: "extension-operations",
              delta: "remote chunk\n",
            }),
          ],
        }),
      }),
    );

    const attach = await requestAuthorityAttach(9);
    expect(AuthorityAttachBaselineResponseSchema.safeParse(attach)).toMatchObject({
      success: true,
    });
    expect(attach).toMatchObject({
      status: "ready",
      baseline: {
        semantic: {
          snapshot: {
            activity: {
              bash: {
                intentId: "extension-operations",
                pty: false,
              },
            },
          },
        },
        transcript: {
          currentShellTurn: {
            id: "extension-operations",
            command: "remote-command",
            pty: false,
            outputText: "remote chunk\n",
            outputThroughSequence: 1,
          },
        },
      },
    });

    gate.resolve({ output: "remote chunk\n", exitCode: 0, cancelled: false, truncated: false });
    await vi.waitFor(() =>
      expect(sendPresentation).toHaveBeenCalledWith(
        expect.objectContaining({
          plane: "transcript",
          payload: expect.objectContaining({
            entries: [
              expect.objectContaining({
                type: "bash_execution_end",
                id: "extension-operations",
                output: "remote chunk\n",
                pty: false,
              }),
            ],
          }),
        }),
      ),
    );
  });

  it("emits an unhandled pinned-Pi user_bash event once before using the existing PTY path", async () => {
    const gate = deferred();
    const controller = makeShellController();
    const createShellController = vi.fn(() => controller);
    const { session, dispatchIntent } = setup(
      { executeBash: vi.fn(() => gate.promise) },
      {
        createShellController,
        uiState: makeUiState({
          editorSnapshot: () => ({ revision: 0, text: "!local-command", attachments: [] }),
        }),
      },
    );
    const request = envelope("default-pty", {
      kind: "runBash",
      command: "local-command",
      excludeFromContext: false,
      editorRevision: 0,
      editorText: "!local-command",
    });

    await expect(dispatchIntent(request)).resolves.toMatchObject({ status: "admitted" });
    await expect(dispatchIntent(request)).resolves.toMatchObject({ status: "duplicate" });
    await vi.waitFor(() => expect(session.executeBash).toHaveBeenCalledOnce());
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledWith({
      type: "user_bash",
      command: "local-command",
      excludeFromContext: false,
      cwd: "/work",
    });
    expect(createShellController).toHaveBeenCalledOnce();
    expect(session.executeBash).toHaveBeenCalledWith("local-command", undefined, {
      id: "default-pty",
      excludeFromContext: false,
      operations: controller.operations,
    });

    gate.resolve({ output: "local\n", exitCode: 0, cancelled: false, truncated: false });
  });

  it("keeps ingress live and fences a delayed user_bash intent when Escape cancels preparation", async () => {
    const preparation = deferred();
    const createShellController = vi.fn(() => makeShellController());
    const acceptShellEditorSubmission = vi.fn(() => true);
    const { session, dispatchIntent, handleEscape } = setup(undefined, {
      createShellController,
      uiState: makeUiState({
        editorSnapshot: () => ({ revision: 0, text: "!delayed-command", attachments: [] }),
        acceptShellEditorSubmission,
      }),
    });
    session.extensionRunner.emitUserBash.mockImplementation(() => preparation.promise);
    const request = envelope("delayed-user-bash", {
      kind: "runBash",
      command: "delayed-command",
      excludeFromContext: false,
      editorRevision: 0,
      editorText: "!delayed-command",
    });

    const first = dispatchIntent(request);
    const duplicate = dispatchIntent(request);
    await vi.waitFor(() => expect(session.extensionRunner.emitUserBash).toHaveBeenCalledOnce());

    // The hook remains unresolved, but it no longer owns the serialized
    // ingress scheduler: an unrelated intent can execute and settle.
    await expect(
      dispatchIntent(envelope("refresh-during-user-bash", { kind: "refreshModels" })),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(session.modelRuntime.refresh).toHaveBeenCalledOnce());

    await expect(handleEscape("cancel-delayed-user-bash")).resolves.toMatchObject({
      disposition: "abort_requested",
      target: "bash",
    });
    await expect(first).resolves.toEqual({
      status: "not_admitted",
      intentId: "delayed-user-bash",
      reason: "cancelled",
    });
    await expect(duplicate).resolves.toEqual({
      status: "not_admitted",
      intentId: "delayed-user-bash",
      reason: "cancelled",
    });

    // A handler has no public AbortSignal, so it may reject late.
    // The host consumes that loser but must never start or persist its result.
    preparation.reject(new Error("late extension rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(createShellController).not.toHaveBeenCalled();
    expect(session.executeBash).not.toHaveBeenCalled();
    expect(session.recordBashResult).not.toHaveBeenCalled();
    expect(session.sessionManager.appendCustomEntry).not.toHaveBeenCalled();
    expect(acceptShellEditorSubmission).not.toHaveBeenCalled();
  });

  it("publishes the direct bash streaming lifecycle on the live transcript plane", async () => {
    const sendPresentation = vi.fn();
    const shellController = makeShellController();
    let listener;
    const { session, dispatchIntent } = setup(
      {
        subscribe: vi.fn((nextListener) => {
          listener = nextListener;
          return vi.fn();
        }),
        executeBash: vi.fn(async (_command, _onChunk, options) => {
          listener?.({ type: "bash_execution_update", id: options.id, delta: "hello\n" });
          return {
            output: "hello\n",
            exitCode: 0,
            cancelled: false,
            truncated: true,
            fullOutputPath: "/tmp/full-bash.log",
          };
        }),
      },
      {
        createShellController: vi.fn(() => shellController),
        sendPresentation,
        uiState: makeUiState({
          editorSnapshot: () => ({ revision: 0, text: "!!printf hello", attachments: [] }),
        }),
      },
    );

    await expect(
      dispatchIntent(
        envelope("visible-bash", {
          kind: "runBash",
          command: "printf hello",
          excludeFromContext: true,
          editorRevision: 0,
          editorText: "!!printf hello",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => {
      expect(sendPresentation).toHaveBeenCalledWith(
        expect.objectContaining({
          plane: "transcript",
          payload: expect.objectContaining({
            entries: [
              expect.objectContaining({
                type: "bash_execution_start",
                id: "visible-bash",
                command: "printf hello",
                excludeFromContext: true,
              }),
            ],
          }),
        }),
      );
      expect(sendPresentation).toHaveBeenCalledWith(
        expect.objectContaining({
          plane: "transcript",
          payload: expect.objectContaining({
            entries: [
              expect.objectContaining({
                type: "bash_execution_update",
                id: "visible-bash",
                delta: "hello\n",
              }),
            ],
          }),
        }),
      );
      expect(sendPresentation).toHaveBeenCalledWith(
        expect.objectContaining({
          plane: "transcript",
          payload: expect.objectContaining({
            entries: [
              expect.objectContaining({
                type: "bash_execution_end",
                id: "visible-bash",
                command: "printf hello",
                output: "hello\n",
                exitCode: 0,
                cancelled: false,
                truncated: true,
                fullOutputPath: "/tmp/full-bash.log",
                excludeFromContext: true,
              }),
            ],
          }),
        }),
      );
    });
    expect(session.executeBash).toHaveBeenCalledWith("printf hello", undefined, {
      id: "visible-bash",
      excludeFromContext: true,
      operations: shellController.operations,
    });
  });

  it("injects an interactive PTY through Pi's public BashOperations and fences its controls", async () => {
    const gate = deferred();
    const sendPresentation = vi.fn();
    let factoryOptions;
    const controllerState = {
      cols: 80,
      rows: 24,
      inputAcknowledgedThrough: 0,
      resizeRevision: 0,
      outputSequence: 1,
      inputReady: false,
      replay: {
        gap: false,
        truncated: false,
        chunks: [{ sequence: 1, data: "prompt> " }],
      },
      interruptRequested: false,
      forceKillRequested: false,
      terminal: { alternateScreenSeen: false },
    };
    const controller = {
      operations: { exec: vi.fn() },
      snapshot: vi.fn(() => structuredClone(controllerState)),
      reconstructionSnapshot: vi.fn(async () => ({
        keyframe: {
          ansi: "\u001b[2J\u001b[Hserialized prompt> ",
          throughSequence: 1,
          retainedScrollback: 0,
          availableScrollback: 2,
          truncated: true,
        },
        snapshot: {
          ...structuredClone(controllerState),
          replay: {
            afterSequence: 1,
            fromSequence: 2,
            throughSequence: 1,
            gap: false,
            truncated: false,
            chunks: [],
          },
        },
      })),
      writeInput: vi.fn(({ sequence }) => {
        controllerState.inputAcknowledgedThrough = sequence;
        return { accepted: true, acknowledgedThrough: sequence };
      }),
      resize: vi.fn(({ revision, cols, rows }) => {
        controllerState.resizeRevision = revision;
        controllerState.cols = cols;
        controllerState.rows = rows;
        return { accepted: true };
      }),
      interrupt: vi.fn(() => {
        if (controllerState.interruptRequested) {
          return { requested: false, alreadyRequested: true };
        }
        controllerState.interruptRequested = true;
        return { requested: true };
      }),
      forceKill: vi.fn(() => ({ requested: true })),
      setTransportBackpressured: vi.fn(),
      dispose: vi.fn(),
    };
    const createShellController = vi.fn((options) => {
      factoryOptions = options;
      return controller;
    });
    const executeBash = vi.fn((_command, _onChunk, options) => {
      factoryOptions.onRawData({ executionId: options.id, sequence: 1, data: "prompt> " });
      return gate.promise;
    });
    const stagedAttachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    const applyEditorPatch = vi.fn(() => ({ accepted: false }));
    const uiState = makeUiState({
      editorSnapshot: () => ({
        revision: 0,
        text: "!!read answer",
        attachments: stagedAttachments,
        conflictText: "newer local draft",
        conflictAttachments: [],
      }),
      applyEditorPatch,
    });
    const {
      session,
      dispatchIntent,
      requestAuthorityAttach,
      sendShellInput,
      resizeShell,
      acknowledgeShellReconstruction,
      setShellTransportBackpressure,
      signalShell,
      retainedShellSnapshot,
      authority,
    } = setup(
      {
        executeBash,
        sessionManager: {
          getLeafId: vi.fn(() => "leaf-9"),
          getBranch: vi.fn(() => []),
          getCwd: vi.fn(() => "/work"),
          appendCustomEntry: vi.fn(),
        },
        settingsManager: {
          setEnabledModels: vi.fn(),
          getEnabledModels: vi.fn(() => undefined),
          getShellPath: vi.fn(() => "/bin/zsh"),
        },
      },
      {
        createShellController,
        sendPresentation,
        uiState,
        pi: {
          ...MODEL_SCOPE_PI,
          getShellConfig: vi.fn(() => ({
            shell: "/bin/zsh",
            args: ["-c"],
            commandTransport: "argv",
          })),
        },
      },
    );

    const shellEnvelope = envelope("pty-bash", {
      kind: "runBash",
      command: "read answer",
      excludeFromContext: true,
      editorRevision: 0,
      editorText: "!!read answer",
    });
    await expect(dispatchIntent(shellEnvelope)).resolves.toMatchObject({ status: "admitted" });
    await expect(dispatchIntent(shellEnvelope)).resolves.toMatchObject({ status: "duplicate" });
    await vi.waitFor(() => expect(createShellController).toHaveBeenCalledOnce());
    expect(executeBash).toHaveBeenCalledOnce();
    expect(applyEditorPatch).not.toHaveBeenCalled();
    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "pivis.shell_turn_start",
      expect.objectContaining({
        executionId: "pty-bash",
        command: "read answer",
        excludeFromContext: true,
        pty: true,
      }),
    );
    expect(executeBash).toHaveBeenCalledWith("read answer", undefined, {
      id: "pty-bash",
      excludeFromContext: true,
      operations: controller.operations,
    });
    factoryOptions.onStateChange({ terminal: { activeBuffer: "alternate" } });
    expect(retainedShellSnapshot()).toMatchObject({
      id: "pty-bash",
      command: "read answer",
      cwd: "/work",
      mode: "fullscreen",
      ansi: "prompt> ",
      inputAcknowledgedThrough: 0,
      resizeRevision: 0,
    });
    expect(sendPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "transcript",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "bash_terminal_data",
              id: "pty-bash",
              data: "",
              mode: "fullscreen",
            }),
          ],
        }),
      }),
    );
    const attached = await requestAuthorityAttach(7);
    expect(attached).toMatchObject({
      status: "ready",
      baseline: {
        semantic: {
          snapshot: {
            editor: {
              revision: 1,
              text: "",
              attachments: stagedAttachments,
              conflictText: "newer local draft",
            },
            activity: {
              bash: {
                inputReady: false,
              },
            },
          },
        },
        transcript: {
          currentShellTurn: {
            id: "pty-bash",
            owner: { hostInstanceId: "test-host", sessionEpoch: 0 },
            ansi: "\u001b[2J\u001b[Hserialized prompt> ",
            reconstructionFenceToken: 1,
            outputThroughSequence: 1,
            replayTruncated: true,
          },
        },
      },
    });
    expect(controller.reconstructionSnapshot).toHaveBeenCalledOnce();
    expect(sendShellInput("other", 1, "secret")).toEqual({
      accepted: false,
      acknowledgedThrough: 0,
    });
    expect(sendShellInput("pty-bash", 1, "before-keyframe-ack")).toEqual({
      accepted: false,
      acknowledgedThrough: 0,
    });
    expect(resizeShell("pty-bash", 1, 100, 30)).toBe(false);
    expect(controller.resize).not.toHaveBeenCalled();
    expect(signalShell("pty-bash", "interrupt")).toBe(false);
    expect(controller.interrupt).not.toHaveBeenCalled();
    const firstFenceToken =
      attached.status === "ready"
        ? attached.baseline.transcript.currentShellTurn.reconstructionFenceToken
        : -1;
    expect(acknowledgeShellReconstruction("pty-bash", firstFenceToken, 2)).toBe(false);
    expect(acknowledgeShellReconstruction("pty-bash", firstFenceToken, 1)).toBe(false);
    expect(sendShellInput("pty-bash", 1, "still-bootstrapping")).toEqual({
      accepted: false,
      acknowledgedThrough: 0,
    });

    // A second attach at the same quiet output sequence installs a new host
    // fence. A delayed acknowledgement for the first keyframe must not release
    // this newer fence (the output sequence alone cannot distinguish them).
    const reattached = await requestAuthorityAttach(8);
    expect(reattached).toMatchObject({
      status: "ready",
      baseline: {
        transcript: {
          currentShellTurn: {
            id: "pty-bash",
            reconstructionFenceToken: 2,
            outputThroughSequence: 1,
          },
        },
      },
    });
    const secondFenceToken =
      reattached.status === "ready"
        ? reattached.baseline.transcript.currentShellTurn.reconstructionFenceToken
        : -1;
    expect(secondFenceToken).not.toBe(firstFenceToken);
    expect(controller.reconstructionSnapshot).toHaveBeenCalledTimes(2);
    controllerState.inputReady = true;
    factoryOptions.onStateChange({ inputReady: true, terminal: { activeBuffer: "alternate" } });
    expect(acknowledgeShellReconstruction("pty-bash", firstFenceToken, 1)).toBe(false);
    expect(sendShellInput("pty-bash", 1, "after-stale-ack")).toEqual({
      accepted: false,
      acknowledgedThrough: 0,
    });
    expect(acknowledgeShellReconstruction("pty-bash", secondFenceToken, 1)).toBe(true);
    expect(authority.semanticSnapshot().activity.bash).toMatchObject({
      pty: true,
      inputReady: true,
    });
    expect(sendShellInput("pty-bash", 1, "answer\r")).toEqual({
      accepted: true,
      acknowledgedThrough: 1,
    });
    expect(resizeShell("pty-bash", 1, 100, 30)).toBe(true);
    setShellTransportBackpressure(true);
    setShellTransportBackpressure(false);
    expect(controller.setTransportBackpressured.mock.calls).toEqual([[true], [false]]);
    expect(signalShell("pty-bash", "interrupt")).toBe(true);
    expect(signalShell("pty-bash", "interrupt")).toBe(true);
    expect(session.abortBash).toHaveBeenCalledOnce();
    expect(retainedShellSnapshot()).toMatchObject({
      id: "pty-bash",
      interruptRequestedAt: expect.any(Number),
    });

    gate.resolve({
      output: "prompt> answer\n",
      exitCode: 130,
      cancelled: false,
      truncated: false,
    });
    await vi.waitFor(() =>
      expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
        "pivis.shell_turn_complete",
        expect.objectContaining({
          executionId: "pty-bash",
          cancelled: true,
          normalization: "terminal_buffer",
        }),
      ),
    );
    expect(controller.dispose).toHaveBeenCalled();
    expect(retainedShellSnapshot()).toBeUndefined();
  });

  it("records an admitted PTY failure through Pi's public canonical Bash recorder", async () => {
    const sendPresentation = vi.fn();
    const controller = {
      operations: { exec: vi.fn() },
      snapshot: vi.fn(() => ({
        cols: 80,
        rows: 24,
        interruptRequested: false,
        forceKillRequested: false,
        terminal: { alternateScreenSeen: false },
      })),
      dispose: vi.fn(),
    };
    const failure = new Error("spawn exploded\u001b");
    const { session, dispatchIntent } = setup(
      {
        executeBash: vi.fn(() => {
          throw failure;
        }),
      },
      {
        createShellController: vi.fn(() => controller),
        sendPresentation,
        uiState: makeUiState({
          editorSnapshot: () => ({ revision: 0, text: "!!broken-command", attachments: [] }),
        }),
      },
    );

    await expect(
      dispatchIntent(
        envelope("failed-pty", {
          kind: "runBash",
          command: "broken-command",
          excludeFromContext: true,
          editorRevision: 0,
          editorText: "!!broken-command",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });

    await vi.waitFor(() =>
      expect(session.recordBashResult).toHaveBeenCalledWith(
        "broken-command",
        {
          output: "[Shell execution failed: spawn exploded]",
          cancelled: false,
          truncated: false,
        },
        { id: "failed-pty", excludeFromContext: true },
      ),
    );
    expect(sendPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "transcript",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "bash_execution_end",
              id: "failed-pty",
              output: "[Shell execution failed: spawn exploded]",
              errorMessage: "spawn exploded",
            }),
          ],
        }),
      }),
    );
    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "pivis.shell_turn_complete",
      expect.objectContaining({
        executionId: "failed-pty",
        endedAt: expect.any(Number),
        errorMessage: "spawn exploded",
        cancelled: false,
        truncated: false,
      }),
    );
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["PTY construction", "controller"],
    ["durable start persistence", "marker"],
  ])("rejects before admission when %s fails", async (_label, failurePoint) => {
    const controller = makeShellController();
    const createShellController =
      failurePoint === "controller"
        ? vi.fn(() => {
            throw new Error("native PTY unavailable");
          })
        : vi.fn(() => controller);
    const appendCustomEntry =
      failurePoint === "marker"
        ? vi.fn((type) => {
            if (type === "pivis.shell_turn_start") throw new Error("session write failed");
          })
        : vi.fn();
    const sendPresentation = vi.fn();
    const { session, dispatchIntent } = setup(
      {
        sessionManager: {
          getLeafId: vi.fn(() => "leaf-9"),
          getBranch: vi.fn(() => []),
          getCwd: vi.fn(() => "/work"),
          appendCustomEntry,
        },
      },
      {
        createShellController,
        sendPresentation,
        uiState: makeUiState({
          editorSnapshot: () => ({ revision: 0, text: "!pwd", attachments: [] }),
        }),
      },
    );

    await expect(
      dispatchIntent(
        envelope("pre-start-failure", {
          kind: "runBash",
          command: "pwd",
          excludeFromContext: false,
          editorRevision: 0,
          editorText: "!pwd",
        }),
      ),
    ).resolves.toEqual({
      status: "not_admitted",
      intentId: "pre-start-failure",
      reason: "transport_unavailable",
    });
    expect(session.executeBash).not.toHaveBeenCalled();
    expect(session.recordBashResult).not.toHaveBeenCalled();
    expect(sendPresentation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ type: "bash_execution_start" }),
          ]),
        }),
      }),
    );
    if (failurePoint === "marker") expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("revalidates and persists the exact selected trust option", async () => {
    const setMany = vi.fn();
    class ProjectTrustStore {
      setMany(updates) {
        setMany(updates);
      }

      getEntry() {
        return null;
      }
    }
    const pi = { ProjectTrustStore, hasTrustRequiringProjectResources: vi.fn(() => true) };
    const { send, dispatchIntent, run } = setup(
      {
        sessionManager: {
          getCwd: vi.fn(() => "/workspace/project"),
          getLeafId: vi.fn(() => "leaf-9"),
          getBranch: vi.fn(() => []),
        },
      },
      { pi, agentDir: "/agent", cwd: "/workspace/project" },
    );

    const state = await run({ type: "get_trust_state" });
    expect(state.data.currentOptions.map((option) => option.label)).toEqual([
      "Trust this folder",
      "Trust parent folder (/workspace)",
      "Do not trust",
    ]);

    await expect(
      dispatchIntent(
        envelope("trust-parent", {
          kind: "setTrust",
          optionLabel: "Trust parent folder (/workspace)",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "trust-parent",
            kind: "setTrust",
            state: "completed",
            result: { trusted: true, persisted: true },
          }),
        }),
      ),
    );
    expect(setMany).toHaveBeenCalledWith([
      { path: "/workspace", decision: true },
      { path: "/workspace/project", decision: null },
    ]);

    await expect(
      dispatchIntent(
        envelope("trust-session-only", {
          kind: "setTrust",
          optionLabel: "Trust for this session only",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "trust-session-only",
            kind: "setTrust",
            state: "failed",
          }),
        }),
      ),
    );
    expect(setMany).toHaveBeenCalledTimes(1);
  });

  it("keeps intent ingress responsive while an intent-invoked compaction runs", async () => {
    let resolveCompact;
    const compact = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCompact = resolve;
        }),
    );
    const { session, send, dispatchIntent } = setup(
      { compact },
      {
        uiState: makeUiState({
          editorSnapshot: () => ({
            revision: 0,
            text: "queued during compaction",
            attachments: [],
          }),
        }),
      },
    );
    session.prompt.mockImplementation(async (_text, options) => options.preflightResult("started"));

    await expect(
      dispatchIntent(envelope("intent-compact-long", { kind: "compact" })),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(session.compact).toHaveBeenCalled());

    // A prompt dispatched mid-compaction must reach custody immediately —
    // never sit behind the whole compaction in the serialized scheduler.
    const midCompactionReceipt = await dispatchIntent(
      envelope("intent-mid-compaction", {
        kind: "submit",
        editorRevision: 0,
        text: "queued during compaction",
        inputKind: "ordinary",
        images: [],
        requestedMode: "followUp",
        surface: "composer",
      }),
    );
    expect(midCompactionReceipt).toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "submission_disposition",
          result: expect.objectContaining({
            intentId: "intent-mid-compaction",
            disposition: "in_custody",
          }),
        }),
      ),
    );
    expect(session.prompt).not.toHaveBeenCalled();

    // Settling the compaction publishes its terminal outcome and drains the
    // held custody prefix into Pi's prompt path.
    resolveCompact();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "intent-compact-long",
            kind: "compact",
            state: "completed",
          }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(session.prompt).toHaveBeenCalledWith("queued during compaction", expect.any(Object)),
    );
  });

  it("rechecks SDK idle inside child execution before navigateTree", async () => {
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    const { session, send, dispatchIntent } = setup({ isIdle: false, navigateTree });

    await expect(
      dispatchIntent({
        intentId: "navigate-busy-child",
        expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
        intent: { kind: "navigate", targetId: "leaf-9" },
      }),
    ).resolves.toMatchObject({ status: "admitted" });

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "navigate-busy-child",
            kind: "navigate",
            state: "failed",
          }),
        }),
      ),
    );
    expect(session.navigateTree).not.toHaveBeenCalled();
  });

  it("publishes navigate intent post-state only after successful Pi navigation", async () => {
    const sendFrame = vi.fn();
    const branch = [
      { id: "root", type: "message", timestamp: 1 },
      { id: "leaf-9", type: "message", parentId: "root", timestamp: 2 },
    ];
    const navigateTree = vi
      .fn()
      .mockResolvedValueOnce({ cancelled: false, editorText: "restored draft", summaryEntry: {} })
      .mockResolvedValueOnce({ cancelled: true, editorText: "stale draft" });
    const getLeafId = vi.fn(() => "leaf-9");
    const getBranch = vi.fn(() => branch);
    const applyEditorPatch = vi.fn(() => ({ accepted: true }));
    const uiState = {
      catalogSnapshot: () => ({}),
      editorSnapshot: () => ({ revision: 7, text: "", attachments: [] }),
      acceptEditorSubmission: () => false,
      applyEditorPatch,
    };
    const { dispatchIntent, authority } = setup(
      { navigateTree, sessionManager: { getLeafId, getBranch } },
      { sendFrame, uiState },
    );
    const envelope = (intentId) => ({
      intentId,
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "navigate", targetId: "leaf-9", summarize: true },
    });

    await expect(dispatchIntent(envelope("navigate-success"))).resolves.toMatchObject({
      status: "admitted",
    });
    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "navigate-success",
            kind: "navigate",
            state: "completed",
            result: {
              targetId: "leaf-9",
              summarized: true,
              editorText: "restored draft",
              leafId: "leaf-9",
              branch,
            },
          }),
        }),
      ),
    );
    expect(getLeafId).toHaveBeenCalledOnce();
    expect(getBranch).toHaveBeenCalledOnce();
    expect(applyEditorPatch).toHaveBeenCalledWith({
      baseRevision: 7,
      revision: 8,
      text: "restored draft",
      attachments: [],
    });
    expect(
      authority.acknowledgeNavigationPresentation("navigate-success", {
        hostInstanceId: "test-host",
        sessionEpoch: 0,
      }),
    ).toBe(true);

    await expect(dispatchIntent(envelope("navigate-cancelled"))).resolves.toMatchObject({
      status: "admitted",
    });
    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: {
            intentId: "navigate-cancelled",
            owner: { hostInstanceId: "test-host", sessionEpoch: 0 },
            kind: "navigate",
            state: "cancelled",
            result: { targetId: "leaf-9" },
          },
        }),
      ),
    );
    expect(getLeafId).toHaveBeenCalledOnce();
    expect(getBranch).toHaveBeenCalledOnce();
    // Cancelled/aborted navigation never changes the host editor snapshot.
    expect(applyEditorPatch).toHaveBeenCalledOnce();
    expect(
      sendFrame.mock.calls
        .map(([frame]) => frame)
        .every((frame) => AuthorityFrameSchema.safeParse(frame).success),
    ).toBe(true);
  });

  it("preserves a draft patched while navigation is pending", async () => {
    let resolveNavigation;
    const navigation = new Promise((resolve) => {
      resolveNavigation = resolve;
    });
    const editor = { revision: 7, text: "", attachments: [] };
    const applyEditorPatch = vi.fn((patch) => {
      if (patch.baseRevision !== editor.revision || patch.revision <= editor.revision) {
        return { accepted: false, ...editor };
      }
      editor.revision = patch.revision;
      editor.text = patch.text;
      editor.attachments = patch.attachments;
      return { accepted: true, ...editor };
    });
    const uiState = {
      catalogSnapshot: () => ({}),
      editorSnapshot: () => ({ ...editor, attachments: [...editor.attachments] }),
      acceptEditorSubmission: () => false,
      applyEditorPatch,
    };
    const navigateTree = vi.fn(() => navigation);
    const sendFrame = vi.fn();
    const { dispatchIntent } = setup(
      {
        navigateTree,
        sessionManager: { getLeafId: vi.fn(() => null), getBranch: vi.fn(() => []) },
      },
      { uiState, sendFrame },
    );

    await expect(
      dispatchIntent({
        intentId: "delayed-navigation",
        expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
        intent: { kind: "navigate", targetId: "leaf-9" },
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(navigateTree).toHaveBeenCalledOnce());

    const newerAttachments = [{ kind: "file", path: "/tmp/newer.txt" }];
    expect(
      uiState.applyEditorPatch({
        baseRevision: 7,
        revision: 8,
        text: "newer draft",
        attachments: newerAttachments,
      }),
    ).toMatchObject({ accepted: true });
    resolveNavigation({ cancelled: false, editorText: "restored historical draft" });

    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({ intentId: "delayed-navigation", state: "completed" }),
        }),
      ),
    );
    expect(applyEditorPatch).toHaveBeenCalledOnce();
    expect(editor).toEqual({ revision: 8, text: "newer draft", attachments: newerAttachments });
  });

  it("does not clear a conflict draft that appears while navigation is pending", async () => {
    let resolveNavigation;
    const navigation = new Promise((resolve) => {
      resolveNavigation = resolve;
    });
    const editor = {
      revision: 7,
      text: "",
      attachments: [],
      conflictText: undefined,
      conflictAttachments: [],
    };
    const applyEditorPatch = vi.fn((patch) => {
      if (patch.baseRevision !== editor.revision || patch.revision <= editor.revision) {
        editor.conflictText = patch.text;
        editor.conflictAttachments = patch.attachments;
        return { accepted: false, ...editor };
      }
      editor.revision = patch.revision;
      editor.text = patch.text;
      editor.attachments = patch.attachments;
      editor.conflictText = undefined;
      editor.conflictAttachments = [];
      return { accepted: true, ...editor };
    });
    const uiState = {
      catalogSnapshot: () => ({}),
      editorSnapshot: () => ({
        ...editor,
        attachments: [...editor.attachments],
        conflictAttachments: [...editor.conflictAttachments],
      }),
      acceptEditorSubmission: () => false,
      applyEditorPatch,
    };
    const sendFrame = vi.fn();
    const navigateTree = vi.fn(() => navigation);
    const { dispatchIntent } = setup(
      {
        navigateTree,
        sessionManager: { getLeafId: vi.fn(() => null), getBranch: vi.fn(() => []) },
      },
      { uiState, sendFrame },
    );

    await dispatchIntent({
      intentId: "conflict-navigation",
      expectedOwner: { hostInstanceId: "test-host", sessionEpoch: 0 },
      intent: { kind: "navigate", targetId: "leaf-9" },
    });
    await vi.waitFor(() => expect(navigateTree).toHaveBeenCalledOnce());

    expect(
      uiState.applyEditorPatch({
        baseRevision: 6,
        revision: 8,
        text: "newer conflict draft",
        attachments: [],
      }),
    ).toMatchObject({ accepted: false });
    resolveNavigation({ cancelled: false, editorText: "restored historical draft" });

    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({ intentId: "conflict-navigation", state: "completed" }),
        }),
      ),
    );
    // The only call was the stale patch that created conflict custody; returned
    // navigation text is not allowed to erase that candidate.
    expect(applyEditorPatch).toHaveBeenCalledOnce();
    expect(editor).toMatchObject({
      revision: 7,
      text: "",
      conflictText: "newer conflict draft",
    });
  });

  it("runs replacement built-ins through runtime, emits one predecessor outcome, and follows with a valid successor frame", async () => {
    const sendControl = vi.fn();
    const sendFrame = vi.fn();
    const { session, runtime, dispatchIntent } = setup(undefined, {
      sendControl,
      sendFrame,
      uiState: makeUiState({
        editorSnapshot: () => ({ revision: 0, text: "/new", attachments: [] }),
      }),
    });
    const successor = makeSession({ sessionId: "successor", sessionFile: "/s/successor.jsonl" });
    runtime.newSession.mockImplementationOnce(async () => {
      await runtime.setRebindSession.mock.calls[0][0](successor);
      return { cancelled: false };
    });
    // Ignore the startup frame; this assertion is exclusively about /new.
    sendControl.mockClear();
    sendFrame.mockClear();

    await expect(
      dispatchIntent(
        envelope("replacement-intent", {
          kind: "invokeCommand",
          text: "/new",
          editorRevision: 0,
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "replacement-intent",
            owner: { hostInstanceId: "test-host", sessionEpoch: 0 },
            state: "completed",
          }),
        }),
      ),
    );

    expect(runtime.newSession).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
    const batch = sendControl.mock.calls.find(([message]) => message.type === "transition_batch")[0]
      .batch;
    expect(TransitionBatchSchema.safeParse(batch).success).toBe(true);
    const frames = sendFrame.mock.calls.map(([frame]) => frame);
    expect(frames.every((frame) => AuthorityFrameSchema.safeParse(frame).success)).toBe(true);
    expect(
      frames.filter((frame) => frame.records.some((r) => r.type === "intent_outcome")),
    ).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({
      owner: { hostInstanceId: "test-host", sessionEpoch: 1 },
      records: [],
      terminalSnapshot: { owner: { hostInstanceId: "test-host", sessionEpoch: 1 } },
    });
  });

  it("executes one typed fork picker continuation after source clear while ordinary slash remains editor-bound", async () => {
    const sendFrame = vi.fn();
    const runWithInvocationSurface = vi.fn((_surface, operation) => operation());
    const { session, runtime, dispatchIntent } = setup(undefined, {
      sendFrame,
      runWithInvocationSurface,
      uiState: makeUiState({
        editorSnapshot: () => ({ revision: 8, text: "", attachments: [] }),
      }),
    });
    const successor = makeSession({ sessionId: "forked", sessionFile: "/s/forked.jsonl" });
    runtime.fork.mockImplementationOnce(async () => {
      await runtime.setRebindSession.mock.calls[0][0](successor);
      return { cancelled: false };
    });

    await expect(
      dispatchIntent(
        envelope("stale-slash-fork", {
          kind: "invokeCommand",
          text: "/fork entry-7",
          editorRevision: 8,
        }),
      ),
    ).resolves.toMatchObject({ status: "not_admitted", reason: "stale_editor" });

    const continuation = envelope("picker-fork", {
      kind: "pickerAction",
      selection: { action: "fork", entryId: "entry-7" },
      surface: "composer",
    });
    const first = dispatchIntent(continuation);
    const duplicate = dispatchIntent(continuation);
    await expect(first).resolves.toMatchObject({ status: "admitted" });
    await expect(duplicate).resolves.toMatchObject({ status: "duplicate" });
    await vi.waitFor(() => expect(runtime.fork).toHaveBeenCalledOnce());
    expect(runtime.fork).toHaveBeenCalledWith("entry-7");
    expect(runWithInvocationSurface).toHaveBeenCalledWith("composer", expect.any(Function));
    expect(session.prompt).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "picker-fork",
            kind: "pickerAction",
            state: "completed",
            result: { action: "fork" },
          }),
        }),
      ),
    );
  });

  it("settles a cancelled fork picker continuation as terminally cancelled", async () => {
    const sendFrame = vi.fn();
    const { runtime, dispatchIntent } = setup(undefined, { sendFrame });
    runtime.fork.mockResolvedValueOnce({ cancelled: true });

    await expect(
      dispatchIntent(
        envelope("cancelled-picker-fork", {
          kind: "pickerAction",
          selection: { action: "fork", entryId: "entry-7" },
          surface: "composer",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });

    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "cancelled-picker-fork",
            kind: "pickerAction",
            state: "cancelled",
            result: { action: "fork" },
          }),
        }),
      ),
    );
  });

  it("keeps bounded picker continuations app-owned when discovered commands collide", async () => {
    const successor = makeSession({ sessionId: "forked", sessionFile: "/s/forked.jsonl" });
    const collidingCommand = { name: "fork" };
    const { session, runtime, dispatchIntent } = setup({
      extensionRunner: {
        ...makeSession().extensionRunner,
        getCommand: vi.fn((name) => (name === "fork" ? collidingCommand : undefined)),
      },
    });
    runtime.fork.mockImplementationOnce(async () => {
      await runtime.setRebindSession.mock.calls[0][0](successor);
      return { cancelled: false };
    });

    await expect(
      dispatchIntent(
        envelope("rebound-picker-fork", {
          kind: "pickerAction",
          selection: { action: "fork", entryId: "entry-7" },
          surface: "composer",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(runtime.fork).toHaveBeenCalledWith("entry-7"));
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("maps app built-ins without falling through to prompt", async () => {
    let editor = { revision: 0, text: "", attachments: [] };
    const { session, dispatchIntent } = setup(
      {
        sessionManager: {
          getLeafId: vi.fn(() => "leaf-9"),
          appendLabelChange: vi.fn(),
        },
        modelRuntime: {
          getAvailable: vi.fn(async () => [{ provider: "anthropic", id: "claude-x" }]),
          logout: vi.fn(async () => {}),
        },
      },
      { uiState: makeUiState({ editorSnapshot: () => editor }) },
    );
    const commands = [
      ["export", "/export /tmp/out.html"],
      ["models", "/models apply anthropic/claude-x"],
      ["logout", "/logout anthropic"],
      ["label", "/label entry-1 checkpoint"],
    ];
    for (const [index, [id, text]] of commands.entries()) {
      editor = { ...editor, revision: index, text };
      await expect(
        dispatchIntent(
          envelope(`builtin-${id}`, {
            kind: "invokeCommand",
            text,
            editorRevision: index,
          }),
        ),
      ).resolves.toMatchObject({ status: "admitted" });
    }
    await vi.waitFor(() => expect(session.sessionManager.appendLabelChange).toHaveBeenCalled());
    expect(session.exportToHtml).toHaveBeenCalledWith("/tmp/out.html");
    expect(session.setScopedModels).toHaveBeenCalledTimes(1);
    expect(session.modelRuntime.logout).toHaveBeenCalledWith("anthropic");
    expect(session.sessionManager.appendLabelChange).toHaveBeenCalledWith("entry-1", "checkpoint");
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("keeps model/thinking changes session-only unless the typed intent persists them", async () => {
    const model = { provider: "anthropic", id: "claude-x", name: "Claude X" };
    const { session, dispatchIntent } = setup({
      modelRuntime: { getAvailable: vi.fn(async () => [model]) },
    });

    for (const [id, intent] of [
      ["session-model", { kind: "setModel", provider: "anthropic", modelId: "claude-x" }],
      [
        "default-model",
        { kind: "setModel", provider: "anthropic", modelId: "claude-x", persist: true },
      ],
      ["session-thinking", { kind: "setThinking", level: "high" }],
      ["default-thinking", { kind: "setThinking", level: "max", persist: true }],
    ]) {
      await expect(dispatchIntent(envelope(id, intent))).resolves.toMatchObject({
        status: "admitted",
      });
    }
    await vi.waitFor(() => expect(session.setThinkingLevel).toHaveBeenCalledTimes(2));

    expect(session.setModel).toHaveBeenNthCalledWith(1, model, { persist: false });
    expect(session.setModel).toHaveBeenNthCalledWith(2, model, { persist: true });
    expect(session.setThinkingLevel).toHaveBeenNthCalledWith(1, "high", { persist: false });
    expect(session.setThinkingLevel).toHaveBeenNthCalledWith(2, "max", { persist: true });
  });

  it("round-trips model-scope patterns containing whitespace and commas", async () => {
    const enabledIds = ["anthropic/claude-x", "Old Claude, Model"];
    const text = `/models save --json ${JSON.stringify(enabledIds)}`;
    const { session, dispatchIntent } = setup(
      {
        modelRuntime: {
          getAvailable: vi.fn(async () => [{ provider: "anthropic", id: "claude-x" }]),
        },
      },
      {
        uiState: makeUiState({
          editorSnapshot: () => ({ revision: 0, text, attachments: [] }),
        }),
      },
    );

    await expect(
      dispatchIntent(
        envelope("encoded-model-scope", {
          kind: "invokeCommand",
          text,
          editorRevision: 0,
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(session.settingsManager.setEnabledModels).toHaveBeenCalledWith(enabledIds),
    );
    expect(session.setScopedModels).toHaveBeenCalledWith([]);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("maps scoped-model and logout picker selections through the live built-in resolver", async () => {
    const enabledIds = ["anthropic/claude-x", "Saved pattern, with spaces"];
    const runWithInvocationSurface = vi.fn((_surface, operation) => operation());
    const { session, dispatchIntent } = setup(
      {
        promptTemplates: [{ name: "models" }],
        resourceLoader: { getSkills: vi.fn(() => ({ skills: [{ name: "logout" }] })) },
        modelRuntime: {
          ...makeSession().modelRuntime,
          getAvailable: vi.fn(async () => [{ provider: "anthropic", id: "claude-x" }]),
          logout: vi.fn(async () => {}),
        },
      },
      { runWithInvocationSurface },
    );

    await expect(
      dispatchIntent(
        envelope("picker-model-scope", {
          kind: "pickerAction",
          selection: { action: "setScopedModels", enabledIds, persist: true },
          surface: "unified",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await expect(
      dispatchIntent(
        envelope("picker-logout", {
          kind: "pickerAction",
          selection: { action: "logoutProvider", providerId: "anthropic" },
          surface: "unified",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });

    await vi.waitFor(() =>
      expect(session.settingsManager.setEnabledModels).toHaveBeenCalledWith(enabledIds),
    );
    await vi.waitFor(() => expect(session.modelRuntime.logout).toHaveBeenCalledWith("anthropic"));
    expect(runWithInvocationSurface).toHaveBeenCalledTimes(2);
    expect(runWithInvocationSurface).toHaveBeenNthCalledWith(1, "unified", expect.any(Function));
    expect(runWithInvocationSurface).toHaveBeenNthCalledWith(2, "unified", expect.any(Function));
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("derives default export names from the canonical presented session file", async () => {
    const runtimePin = "/sessions/.pivis-session-42-runtime.runtime-pin";
    const canonicalSessionFile = "/sessions/canonical-source.jsonl";
    const { session, dispatchIntent, run } = setup(
      { sessionFile: runtimePin },
      { initialPresentedSessionFile: canonicalSessionFile },
    );

    await expect(
      dispatchIntent(
        envelope("canonical-export", {
          kind: "export",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(session.exportToHtml).toHaveBeenCalledWith("pi-session-canonical-source.html"),
    );

    session.exportToHtml.mockClear();
    await expect(run({ type: "export_html" })).resolves.toMatchObject({ success: true });
    expect(session.exportToHtml).toHaveBeenCalledWith("pi-session-canonical-source.html");
  });

  it("lists stored logout credentials through Pi's public model runtime", async () => {
    const { run } = setup({
      modelRuntime: {
        listCredentials: vi.fn(async () => [
          { providerId: "z-local", type: "api_key" },
          { providerId: "anthropic", type: "oauth" },
        ]),
        getProvider: vi.fn((providerId) =>
          providerId === "anthropic" ? { name: "Anthropic" } : undefined,
        ),
      },
    });

    await expect(run({ type: "get_logout_providers" })).resolves.toMatchObject({
      success: true,
      data: {
        providers: [
          { id: "anthropic", name: "Anthropic", authType: "oauth" },
          { id: "z-local", name: "z-local", authType: "api_key" },
        ],
      },
    });
  });

  it("adapts Pi 0.80.6's public model registry for selection and logout", async () => {
    const logout = vi.fn();
    const refresh = vi.fn();
    const model = { provider: "anthropic", id: "claude-x", name: "Claude X" };
    const { session, run } = setup({
      modelRuntime: undefined,
      modelRegistry: {
        getAvailable: vi.fn(() => [model]),
        find: vi.fn((provider, modelId) =>
          provider === model.provider && modelId === model.id ? model : undefined,
        ),
        refresh,
        getProviderDisplayName: vi.fn(() => "Anthropic"),
        authStorage: {
          logout,
          list: vi.fn(() => ["anthropic"]),
          get: vi.fn(() => ({ type: "oauth" })),
        },
      },
    });

    await expect(
      run({ type: "set_model", provider: "anthropic", modelId: "claude-x" }),
    ).resolves.toMatchObject({ success: true });
    expect(session.setModel).toHaveBeenCalledWith(model);
    await expect(run({ type: "get_logout_providers" })).resolves.toMatchObject({
      data: { providers: [{ id: "anthropic", name: "Anthropic", authType: "oauth" }] },
    });
    await expect(run({ type: "logout_provider", provider: "anthropic" })).resolves.toMatchObject({
      success: true,
    });
    expect(logout).toHaveBeenCalledWith("anthropic");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("treats a committed logout with failed local synchronization as success with a warning", async () => {
    const credential = { type: "oauth", access: "never-publish-removed-credential" };
    const logout = vi.fn(async () => {
      throw new CredentialSynchronizationError("anthropic", "logout", credential, {
        cause: new Error("never-publish-logout-sync-detail"),
      });
    });
    const notify = vi.fn();
    const { send, run } = setup(
      { modelRuntime: { ...makeSession().modelRuntime, logout } },
      { uiContext: { notify } },
    );

    await expect(run({ type: "logout_provider", provider: "anthropic" })).resolves.toMatchObject({
      success: true,
      data: { provider: "anthropic", synchronized: false },
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Credential removed"), "warning");
    expect(JSON.stringify(send.mock.calls)).not.toContain("never-publish-removed-credential");
    expect(JSON.stringify(send.mock.calls)).not.toContain("never-publish-logout-sync-detail");
  });

  it("sanitizes provider-native logout failures", async () => {
    const logout = vi.fn(async () => {
      throw new Error("never-publish-logout-url-header-secret");
    });
    const { send, run } = setup({
      modelRuntime: { ...makeSession().modelRuntime, logout },
    });

    await expect(run({ type: "logout_provider", provider: "anthropic" })).resolves.toMatchObject({
      success: false,
      error: "Credential could not be removed",
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain("never-publish-logout-url-header-secret");
  });

  it("keeps app-owned built-ins authoritative over colliding prompt templates", async () => {
    const { session, runtime, dispatchIntent } = setup(
      { promptTemplates: [{ name: "new" }] },
      {
        uiState: makeUiState({
          editorSnapshot: () => ({ revision: 0, text: "/new", attachments: [] }),
        }),
      },
    );
    const successor = makeSession({ sessionId: "new", sessionFile: "/s/new.jsonl" });
    runtime.newSession.mockImplementationOnce(async () => {
      await runtime.setRebindSession.mock.calls[0][0](successor);
      return { cancelled: false };
    });

    await dispatchIntent(
      envelope("template-new", { kind: "invokeCommand", text: "/new", editorRevision: 0 }),
    );
    await vi.waitFor(() => expect(runtime.newSession).toHaveBeenCalledOnce());
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("deduplicates same-owner IDs, rejects conflicts and fences stale owners before Pi", async () => {
    const { session, dispatchIntent } = setup(undefined, {
      createShellController: vi.fn(() => makeShellController()),
      uiState: makeUiState({
        editorSnapshot: () => ({ revision: 0, text: "!echo once", attachments: [] }),
      }),
    });
    session.executeBash.mockResolvedValue({ output: "ok" });
    const original = envelope("once", {
      kind: "runBash",
      command: "echo once",
      excludeFromContext: false,
      editorRevision: 0,
      editorText: "!echo once",
    });

    await expect(dispatchIntent(original)).resolves.toMatchObject({ status: "admitted" });
    await expect(dispatchIntent(original)).resolves.toMatchObject({ status: "duplicate" });
    await expect(
      dispatchIntent(
        envelope("once", {
          kind: "runBash",
          command: "echo different",
          excludeFromContext: false,
          editorRevision: 0,
          editorText: "!echo different",
        }),
      ),
    ).resolves.toMatchObject({ status: "not_admitted", reason: "invalid" });
    await expect(
      dispatchIntent({
        ...original,
        intentId: "old",
        expectedOwner: { hostInstanceId: "old", sessionEpoch: 0 },
      }),
    ).resolves.toMatchObject({ status: "not_admitted", reason: "stale_owner" });
    await vi.waitFor(() => expect(session.executeBash).toHaveBeenCalledTimes(1));
  });
});

describe("setupCommandBridge — command mapping", () => {
  it("get_state mirrors RpcSessionState (messageCount from messages.length) and queue arrays", async () => {
    const { run } = setup({
      getSteeringMessages: vi.fn(() => ["s1"]),
      getFollowUpMessages: vi.fn(() => ["f1"]),
    });
    const res = await run({ type: "get_state" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      thinkingLevel: "medium",
      sessionId: "sid-1",
      messageCount: 2,
      pendingMessageCount: 0,
      steering: ["s1"],
      followUp: ["f1"],
    });
  });

  it("hides an initial runtime-pin path but exposes a genuine rebound successor", async () => {
    const alias = "/sessions/.pivis-session.runtime-pin";
    const canonical = "/sessions/original.jsonl";
    const { runtime, run } = setup(
      {
        sessionFile: alias,
        getSessionStats: vi.fn(() => ({ sessionFile: alias, tokens: { input: 1 } })),
      },
      { initialPresentedSessionFile: canonical },
    );

    await expect(run({ type: "get_state" })).resolves.toMatchObject({
      success: true,
      data: { sessionFile: canonical },
    });
    await expect(run({ type: "get_session_stats" })).resolves.toMatchObject({
      success: true,
      data: { sessionFile: canonical },
    });

    const successor = makeSession({
      sessionId: "successor",
      sessionFile: "/sessions/successor.jsonl",
    });
    await runtime.setRebindSession.mock.calls[0][0](successor);

    await expect(run({ type: "get_state" })).resolves.toMatchObject({
      success: true,
      data: { sessionFile: "/sessions/successor.jsonl" },
    });
  });

  it("steer passes message + images and resolves success", async () => {
    const { session, run } = setup();
    const res = await run({ type: "steer", message: "go", images: [{ data: "x" }] });
    expect(session.steer).toHaveBeenCalledWith("go", [{ data: "x" }], { source: "rpc" });
    expect(res).toMatchObject({ success: true, data: { disposition: "queued" } });
  });

  it("follow_up passes the RPC source and returns Pi's handled disposition", async () => {
    const { session, run } = setup();
    session.followUp.mockResolvedValueOnce("handled");

    const res = await run({ type: "follow_up", message: "handled by hook", images: [] });

    expect(session.followUp).toHaveBeenCalledWith("handled by hook", [], { source: "rpc" });
    expect(res).toMatchObject({ success: true, data: { disposition: "handled" } });
  });

  it("set_model resolves the Model and immediately publishes its direct snapshot", async () => {
    const sendControl = vi.fn();
    const { session, run } = setup(undefined, { sendControl });
    session.setModel.mockImplementation((model) => {
      session.model = model;
    });
    const res = await run({ type: "set_model", provider: "anthropic", modelId: "claude-x" });
    expect(session.setModel).toHaveBeenCalledWith({
      provider: "anthropic",
      id: "claude-x",
      name: "Claude X",
    });
    expect(res.success).toBe(true);
    expect(sendControl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "snapshot",
        snapshot: expect.objectContaining({ model: expect.objectContaining({ id: "claude-x" }) }),
      }),
    );
  });

  it("maps cycle and explicit setting commands to their public AgentSession methods", async () => {
    const { session, run } = setup();
    await expect(run({ type: "cycle_model" })).resolves.toMatchObject({
      success: true,
      data: { model: { id: "next" }, thinkingLevel: "low" },
    });
    await expect(run({ type: "cycle_thinking_level" })).resolves.toMatchObject({
      success: true,
      data: { level: "high" },
    });
    await run({ type: "set_steering_mode", mode: "one-at-a-time" });
    await run({ type: "set_follow_up_mode", mode: "all" });
    await run({ type: "set_auto_compaction", enabled: false });
    await run({ type: "set_auto_retry", enabled: false });
    await run({ type: "abort_retry" });
    expect(session.cycleModel).toHaveBeenCalledOnce();
    expect(session.cycleThinkingLevel).toHaveBeenCalledOnce();
    expect(session.setSteeringMode).toHaveBeenCalledWith("one-at-a-time");
    expect(session.setFollowUpMode).toHaveBeenCalledWith("all");
    expect(session.setAutoCompactionEnabled).toHaveBeenCalledWith(false);
    expect(session.setAutoRetryEnabled).toHaveBeenCalledWith(false);
    expect(session.abortRetry).toHaveBeenCalledOnce();
  });

  it("get_messages returns the authoritative public session messages", async () => {
    const { run } = setup({ messages: [{ role: "user", content: "hello" }] });
    await expect(run({ type: "get_messages" })).resolves.toMatchObject({
      success: true,
      data: { messages: [{ role: "user", content: "hello" }] },
    });
  });

  it("set_model resolves providerless models by id", async () => {
    const { session, run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => [{ id: "local-model", name: "Local Model" }]),
      },
    });
    const res = await run({ type: "set_model", modelId: "local-model" });
    expect(session.setModel).toHaveBeenCalledWith({ id: "local-model", name: "Local Model" });
    expect(res.success).toBe(true);
  });

  it("set_model returns an error when the model is not found (no setModel call)", async () => {
    const { session, run } = setup();
    const res = await run({ type: "set_model", provider: "openai", modelId: "gpt" });
    expect(session.setModel).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Model not found/);
  });

  it("save_scoped_models persists patterns to settingsManager and applies to session", async () => {
    const { session, run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => [
          { provider: "anthropic", id: "claude-x", name: "Claude X" },
          { provider: "openai", id: "gpt-5", name: "GPT-5" },
        ]),
      },
    });
    // A proper subset (1 of 2) is persisted as patterns; == all clears.
    const res = await run({
      type: "save_scoped_models",
      enabledIds: ["anthropic/claude-x"],
    });
    expect(session.settingsManager.setEnabledModels).toHaveBeenCalledWith(["anthropic/claude-x"]);
    expect(session.setScopedModels).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it("save_scoped_models clears settings (undefined) when all are enabled", async () => {
    const { session, run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => [
          { provider: "anthropic", id: "claude-x", name: "Claude X" },
          { provider: "openai", id: "gpt-5", name: "GPT-5" },
        ]),
      },
    });
    // enabledIds === null → clear the settings filter (all enabled).
    const res = await run({ type: "save_scoped_models", enabledIds: null });
    expect(session.settingsManager.setEnabledModels).toHaveBeenCalledWith(undefined);
    expect(res.success).toBe(true);
  });

  it("preserves unavailable saved model patterns for display and removal", async () => {
    const available = [
      { provider: "anthropic", id: "claude-x", name: "Claude X" },
      { provider: "openai", id: "gpt-5", name: "GPT-5" },
    ];
    const { run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => available),
        refresh: vi.fn(async () => {}),
      },
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => ["anthropic/claude-x", "retired/model"]),
      },
    });

    await expect(run({ type: "get_scoped_models" })).resolves.toMatchObject({
      success: true,
      data: {
        models: available,
        enabledIds: ["anthropic/claude-x", "retired/model"],
      },
    });
  });

  it("keeps unavailable saved patterns visible behind a session-only scope", async () => {
    const available = [
      { provider: "anthropic", id: "claude-x", name: "Claude X" },
      { provider: "openai", id: "gpt-5", name: "GPT-5" },
    ];
    const { session, run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => available),
        refresh: vi.fn(async () => {}),
      },
      scopedModels: [{ model: available[1] }],
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => ["anthropic/claude-x", "retired/model"]),
      },
    });

    await expect(run({ type: "get_scoped_models" })).resolves.toMatchObject({
      success: true,
      data: {
        models: available,
        enabledIds: ["openai/gpt-5", "retired/model"],
      },
    });
    expect(session.modelRuntime.getAvailable).toHaveBeenCalled();
  });

  it("uses Pi's public resolver for partial names and only retains genuine no-match patterns", async () => {
    const available = [
      { provider: "anthropic", id: "claude-x", name: "Claude X" },
      { provider: "openai", id: "gpt-5", name: "GPT-5" },
    ];
    const { run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => available),
        refresh: vi.fn(async () => {}),
      },
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => ["Claude", "openai/gpt-5:extreme", "retired/model"]),
      },
    });

    await expect(run({ type: "get_scoped_models" })).resolves.toMatchObject({
      success: true,
      data: {
        models: available,
        enabledIds: ["anthropic/claude-x", "openai/gpt-5", "retired/model"],
      },
    });
  });

  it("passes the session's real ModelRuntime to Pi's public scope resolver", async () => {
    const resolver = vi.fn(resolveModelScopeWithDiagnostics);
    const { session, run } = setup(
      {
        settingsManager: {
          setEnabledModels: vi.fn(),
          getEnabledModels: vi.fn(() => ["anthropic/claude-x"]),
        },
      },
      { pi: { resolveModelScopeWithDiagnostics: resolver } },
    );

    await run({ type: "get_scoped_models" });

    expect(resolver).toHaveBeenCalledWith(["anthropic/claude-x"], session.modelRuntime);
  });

  it("persists an unavailable selection even when every available model is selected", async () => {
    const available = [
      { provider: "anthropic", id: "claude-x", name: "Claude X" },
      { provider: "openai", id: "gpt-5", name: "GPT-5" },
    ];
    const { session, run } = setup({
      modelRuntime: { getAvailable: vi.fn(async () => available) },
    });
    const enabledIds = ["anthropic/claude-x", "openai/gpt-5", "retired/model"];

    await expect(run({ type: "save_scoped_models", enabledIds })).resolves.toMatchObject({
      success: true,
    });
    expect(session.settingsManager.setEnabledModels).toHaveBeenCalledWith(enabledIds);
    // Unavailable persisted patterns must not make the live session treat
    // "all available" as a restrictive scope.
    expect(session.setScopedModels).toHaveBeenCalledWith([]);
  });

  it("get_available_models returns scoped subset when scopedModels is set", async () => {
    const { session, run } = setup();
    // Simulate pi's AgentSession after setScopedModels was applied: the
    // scoped entry's `.model` is the plain data object returned to /model.
    session.scopedModels = [
      {
        model: { provider: "anthropic", id: "claude-x", name: "Claude X" },
      },
    ];
    const res = await run({ type: "get_available_models" });
    expect(res.success).toBe(true);
    expect(res.data.models).toEqual([{ provider: "anthropic", id: "claude-x", name: "Claude X" }]);
    // modelRuntime.getAvailable() must NOT be called when a scope is active.
    expect(session.modelRuntime.getAvailable).not.toHaveBeenCalled();
  });

  it("get_available_models returns all from the model runtime when no scope is set", async () => {
    const { session, run } = setup();
    const res = await run({ type: "get_available_models" });
    expect(res.success).toBe(true);
    expect(session.modelRuntime.getAvailable).toHaveBeenCalled();
    expect(res.data.models).toEqual([{ provider: "anthropic", id: "claude-x", name: "Claude X" }]);
  });

  it("get_available_models honors saved settings scope when session scope is empty", async () => {
    // The SDK starts every session with scopedModels: [] and never resolves
    // settingsManager.getEnabledModels() into it (only pi's CLI main.js does).
    // So a SAVED scope (save_scoped_models) must still narrow the dropdown on
    // a fresh session via this settings fallback.
    const { session, run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => [
          { provider: "anthropic", id: "claude-x", name: "Claude X" },
          { provider: "openai", id: "gpt-5", name: "GPT-5" },
        ]),
      },
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => ["anthropic/claude-x"]),
      },
    });
    const res = await run({ type: "get_available_models" });
    expect(res.success).toBe(true);
    expect(session.modelRuntime.getAvailable).toHaveBeenCalled();
    expect(res.data.models).toEqual([{ provider: "anthropic", id: "claude-x", name: "Claude X" }]);
  });

  it("get_available_models preserves Pi's configured pattern order", async () => {
    const { run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => [
          { provider: "anthropic", id: "claude-x", name: "Claude X" },
          { provider: "openai", id: "gpt-5", name: "GPT-5" },
          { provider: "google", id: "gemini", name: "Gemini" },
        ]),
      },
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => ["openai/gpt-5", "anthropic/claude-x"]),
      },
    });

    await expect(run({ type: "get_available_models" })).resolves.toMatchObject({
      success: true,
      data: {
        models: [
          { provider: "openai", id: "gpt-5", name: "GPT-5" },
          { provider: "anthropic", id: "claude-x", name: "Claude X" },
        ],
      },
    });
  });

  it("strips Pi 0.80.6's :max suffix from saved model-scope patterns", async () => {
    const { run } = setup({
      modelRuntime: {
        getAvailable: vi.fn(async () => [
          { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { provider: "anthropic", id: "claude-x", name: "Claude X" },
        ]),
      },
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => ["openai/gpt-5.6-sol:max"]),
      },
    });
    const res = await run({ type: "get_available_models" });
    expect(res.data.models).toEqual([
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
  });

  it("get_available_models settings fallback is a no-op when patterns match everything", async () => {
    // resolveEnabledModelIds treats all-matching as "no scope" (null); the
    // dropdown fallback must do the same so saving "all" doesn't paradoxically
    // hide models that a pattern glob failed to expand.
    const all = [
      { provider: "anthropic", id: "claude-x", name: "Claude X" },
      { provider: "openai", id: "gpt-5", name: "GPT-5" },
    ];
    const { run } = setup({
      modelRuntime: { getAvailable: vi.fn(async () => all) },
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => ["anthropic/claude-x", "openai/gpt-5"]),
      },
    });
    const res = await run({ type: "get_available_models" });
    expect(res.data.models).toEqual(all);
  });
  it("renders Pi 0.80.4 custom entries through the registered entry renderer", async () => {
    const dispose = vi.fn();
    const render = vi.fn(() => ["\u001b[31mIndexed files: 17\u001b[0m"]);
    const renderer = vi.fn(() => ({ render, dispose }));
    const { run } = setup({
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getEntryRenderer: vi.fn(() => renderer),
      },
      sessionManager: {
        getLeafId: vi.fn(() => "leaf-9"),
        getEntry: vi.fn(() => ({
          id: "entry-1",
          type: "custom",
          customType: "status-card",
          data: { count: 17 },
        })),
      },
    });

    const res = await run({
      type: "render_entry",
      entryId: "entry-1",
      cols: 96,
      expanded: true,
    });

    expect(res).toMatchObject({
      success: true,
      data: { rendered: true, ansi: "\u001b[31mIndexed files: 17\u001b[0m" },
    });
    expect(renderer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "entry-1" }),
      { expanded: true },
      undefined,
    );
    expect(render).toHaveBeenCalledWith(96);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("hides custom entries when no registered renderer exists", async () => {
    const { run } = setup({
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getEntryRenderer: vi.fn(() => undefined),
      },
      sessionManager: {
        getLeafId: vi.fn(() => "leaf-9"),
        getEntry: vi.fn(() => ({ id: "entry-1", type: "custom", customType: "state" })),
      },
    });
    const res = await run({ type: "render_entry", entryId: "entry-1", cols: 80 });
    expect(res).toMatchObject({ success: true, data: { rendered: false } });
  });

  it("renders a unique public custom message through its registered message renderer", async () => {
    const message = {
      role: "custom",
      customType: "status-card",
      content: "Indexed files",
      display: true,
      details: { count: 17 },
      timestamp: 1_700_000_000_000,
    };
    const dispose = vi.fn();
    const render = vi.fn(() => ["\u001b[32mIndexed files: 17\u001b[0m"]);
    const renderer = vi.fn(() => ({ render, dispose }));
    const getMessageRenderer = vi.fn(() => renderer);
    const { run } = setup({
      messages: [
        { ...message, customType: "other-card" },
        message,
        { ...message, timestamp: message.timestamp + 1 },
      ],
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getMessageRenderer,
      },
      settingsManager: {
        getOutputPad: vi.fn(() => 3),
      },
    });

    const res = await run({
      type: "render_message",
      customType: "status-card",
      timestamp: message.timestamp,
      cols: 96,
      expanded: true,
    });

    expect(res).toMatchObject({
      success: true,
      data: { rendered: true, ansi: "\u001b[32mIndexed files: 17\u001b[0m" },
    });
    expect(getMessageRenderer).toHaveBeenCalledWith("status-card");
    expect(renderer).toHaveBeenCalledWith(message, { expanded: true, outputPad: 3 }, undefined);
    expect(render).toHaveBeenCalledWith(96);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("chains Pi 0.84 Markdown transformers with the public render context", async () => {
    const first = vi.fn(
      (markdown, context) =>
        `${markdown}|${context.messageType}:${context.isStreaming}:${context.availableWidth}`,
    );
    const failing = vi.fn(() => {
      throw new Error("extension bug");
    });
    const last = vi.fn((markdown) => `${markdown}|last`);
    const { run } = setup({
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getMarkdownTransformers: vi.fn(() => [first, failing, last]),
      },
    });

    await expect(
      run({
        type: "transform_markdown",
        items: [
          {
            requestId: "assistant-a",
            markdown: "before",
            messageType: "assistant",
            isStreaming: true,
            availableWidth: 96,
          },
          {
            requestId: "thinking-a",
            markdown: "thought",
            messageType: "assistant-thinking",
            isStreaming: false,
            availableWidth: 72,
          },
        ],
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        items: [
          { requestId: "assistant-a", markdown: "before|assistant:true:96|last" },
          {
            requestId: "thinking-a",
            markdown: "thought|assistant-thinking:false:72|last",
          },
        ],
      },
    });
    expect(first).toHaveBeenNthCalledWith(1, "before", {
      messageType: "assistant",
      isStreaming: true,
      availableWidth: 96,
    });
    expect(last).toHaveBeenNthCalledWith(1, "before|assistant:true:96", {
      messageType: "assistant",
      isStreaming: true,
      availableWidth: 96,
    });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("accepts the output byte boundary and rejects multibyte extension expansion", async () => {
    const exact = "🙂".repeat(MARKDOWN_TRANSFORM_MAX_OUTPUT_BYTES / 4);
    const accepted = setup({
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getMarkdownTransformers: vi.fn(() => [vi.fn(() => exact)]),
      },
    });
    await expect(
      accepted.run({
        type: "transform_markdown",
        items: [
          {
            requestId: "exact",
            markdown: "raw",
            messageType: "assistant",
            isStreaming: false,
            availableWidth: 80,
          },
        ],
      }),
    ).resolves.toMatchObject({ data: { items: [{ requestId: "exact", markdown: exact }] } });

    const oversized = `${exact}🙂`;
    const expanding = vi.fn(() => oversized);
    const safeTail = vi.fn((markdown) => `${markdown}|safe`);
    const rejected = setup({
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getMarkdownTransformers: vi.fn(() => [expanding, safeTail]),
      },
    });
    await expect(
      rejected.run({
        type: "transform_markdown",
        items: [
          {
            requestId: "oversized",
            markdown: "raw",
            messageType: "assistant-thinking",
            isStreaming: true,
            availableWidth: 72,
          },
        ],
      }),
    ).resolves.toMatchObject({
      data: { items: [{ requestId: "oversized", markdown: "raw|safe" }] },
    });
    expect(safeTail).toHaveBeenCalledWith("raw", {
      messageType: "assistant-thinking",
      isStreaming: true,
      availableWidth: 72,
    });
  });

  it("falls back atomically and stops extension expansion at the response byte bound", async () => {
    expect(MARKDOWN_TRANSFORM_MAX_RESPONSE_BATCH_BYTES).toBe(
      4 * MARKDOWN_TRANSFORM_MAX_OUTPUT_BYTES,
    );
    const expansion = "x".repeat(MARKDOWN_TRANSFORM_MAX_OUTPUT_BYTES);
    const transformer = vi.fn(() => expansion);
    const { run } = setup({
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getMarkdownTransformers: vi.fn(() => [transformer]),
      },
    });
    const items = Array.from({ length: 6 }, (_, index) => ({
      requestId: `aggregate-${index}`,
      markdown: `raw-${index}`,
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 80,
    }));

    const result = await run({ type: "transform_markdown", items });
    expect(result).toMatchObject({
      success: true,
      data: {
        items: items.map(({ requestId, markdown }) => ({ requestId, markdown })),
      },
    });
    expect(transformer.mock.calls.length).toBeLessThan(items.length);
  });

  it("returns renderer failures as ANSI data and still disposes the component", async () => {
    const message = {
      role: "custom",
      customType: "status-card",
      content: "Indexed files",
      display: true,
      timestamp: 1_700_000_000_000,
    };
    const dispose = vi.fn();
    const renderer = vi.fn(() => ({
      render: vi.fn(() => {
        throw new Error("render exploded");
      }),
      dispose,
    }));
    const { run } = setup({
      messages: [message],
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getMessageRenderer: vi.fn(() => renderer),
      },
    });

    const res = await run({
      type: "render_message",
      customType: "status-card",
      timestamp: message.timestamp,
      cols: 80,
    });

    expect(res).toMatchObject({
      success: true,
      data: {
        rendered: true,
        ansi: "[status-card] renderer failed: render exploded",
        error: true,
      },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("declines missing, ambiguous, and unregistered custom messages", async () => {
    const duplicate = {
      role: "custom",
      customType: "duplicate-card",
      content: "duplicate",
      display: true,
      timestamp: 1_700_000_000_000,
    };
    const getMessageRenderer = vi.fn(() => undefined);
    const { run } = setup({
      messages: [
        duplicate,
        { ...duplicate },
        { ...duplicate, customType: "unregistered-card", content: "unique" },
      ],
      extensionRunner: {
        getRegisteredCommands: vi.fn(() => []),
        getMessageRenderer,
      },
    });

    const missing = await run({
      type: "render_message",
      customType: "missing-card",
      timestamp: duplicate.timestamp,
      cols: 80,
    });
    const ambiguous = await run({
      type: "render_message",
      customType: "duplicate-card",
      timestamp: duplicate.timestamp,
      cols: 80,
    });
    const unregistered = await run({
      type: "render_message",
      customType: "unregistered-card",
      timestamp: duplicate.timestamp,
      cols: 80,
    });

    expect(missing).toMatchObject({ success: true, data: { rendered: false } });
    expect(ambiguous).toMatchObject({ success: true, data: { rendered: false } });
    expect(unregistered).toMatchObject({ success: true, data: { rendered: false } });
    expect(getMessageRenderer).toHaveBeenCalledOnce();
    expect(getMessageRenderer).toHaveBeenCalledWith("unregistered-card");
  });

  it("keeps a historical cache warm ordered after its synthetic cache miss", async () => {
    const previous = {
      role: "assistant",
      content: [{ type: "text", text: "previous response" }],
      provider: "anthropic",
      model: "claude-x",
      timestamp: 0,
      stopReason: "stop",
      usage: { input: 10_000, cacheRead: 20_000, cacheWrite: 0 },
    };
    const current = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-x",
      timestamp: 6 * 60_000,
      stopReason: "stop",
      usage: {
        input: 30_000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.3, cacheRead: 0, cacheWrite: 0 },
      },
    };
    const { run } = setup({
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => undefined),
        getShowCacheMissNotices: vi.fn(() => true),
      },
      sessionManager: {
        getLeafId: vi.fn(() => "warm-after-miss"),
        getBranch: vi.fn(() => [
          { id: "entry-1", type: "message", message: previous },
          { id: "entry-2", type: "message", message: current },
          {
            id: "warm-after-miss",
            type: "usage",
            kind: "cache_warm",
            provider: "anthropic",
            model: "claude-x",
            usage: {
              input: 30_000,
              output: 0,
              cacheRead: 30_000,
              cacheWrite: 0,
              totalTokens: 60_000,
              cost: { input: 0, output: 0, cacheRead: 0.03, cacheWrite: 0, total: 0.03 },
            },
          },
        ]),
      },
    });

    const res = await run({ type: "get_cache_miss_notices" });
    expect(res).toMatchObject({
      success: true,
      data: {
        notices: [
          {
            type: "cache_miss_notice",
            noticeId: "cache-miss:360000:anthropic:claude-x:30000:0:0:0",
            // The current assistant has no visible content in persisted
            // history, so the notice follows the last projected row.
            afterEntryId: "entry-1",
            missedTokens: 30_000,
            missedCost: 0.3,
            idleMs: 6 * 60_000,
            modelChanged: false,
          },
          {
            type: "cache_warming_notice",
            noticeId: "cache-warm:warm-after-miss",
            provider: "anthropic",
            model: "claude-x",
            afterEntryId: "cache-miss:360000:anthropic:claude-x:30000:0:0:0",
          },
        ],
      },
    });
  });

  it("replays persisted cache-warm usage with its preceding assistant anchor", async () => {
    const usage = {
      input: 30_000,
      output: 1,
      cacheRead: 29_500,
      cacheWrite: 0,
      totalTokens: 59_501,
      cost: { input: 0.01, output: 0, cacheRead: 0.002, cacheWrite: 0, total: 0.012 },
    };
    const { run } = setup({
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => undefined),
        getShowCacheMissNotices: vi.fn(() => true),
      },
      sessionManager: {
        getLeafId: vi.fn(() => "warm-1"),
        getBranch: vi.fn(() => [
          {
            id: "assistant-1",
            type: "message",
            message: {
              role: "assistant",
              provider: "anthropic",
              model: "claude-x",
              content: [{ type: "text", text: "ready" }],
              timestamp: 1,
              stopReason: "stop",
              usage: {
                input: 30_000,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 30_001,
                cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
              },
            },
          },
          {
            type: "usage",
            id: "warm-1",
            kind: "cache_warm",
            provider: "anthropic",
            model: "claude-x",
            usage,
          },
          {
            type: "usage",
            id: "warm-2",
            kind: "cache_warm",
            provider: "anthropic",
            model: "claude-x",
            note: "second refresh",
            usage,
          },
        ]),
      },
    });

    await expect(run({ type: "get_cache_miss_notices" })).resolves.toMatchObject({
      success: true,
      data: {
        notices: [
          {
            type: "cache_warming_notice",
            noticeId: "cache-warm:warm-1",
            provider: "anthropic",
            model: "claude-x",
            usage,
            afterEntryId: "assistant-1",
          },
          {
            type: "cache_warming_notice",
            noticeId: "cache-warm:warm-2",
            provider: "anthropic",
            model: "claude-x",
            note: "second refresh",
            usage,
            afterEntryId: "cache-warm:warm-1",
          },
        ],
      },
    });
  });

  it("anchors historical cache warms to every visible persisted entry in order", async () => {
    const usage = {
      input: 30_000,
      output: 0,
      cacheRead: 30_000,
      cacheWrite: 0,
      totalTokens: 60_000,
      cost: { input: 0, output: 0, cacheRead: 0.03, cacheWrite: 0, total: 0.03 },
    };
    const warm = (id) => ({
      id,
      type: "usage",
      kind: "cache_warm",
      provider: "anthropic",
      model: "claude-x",
      usage,
    });
    const { run } = setup({
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => undefined),
        getShowCacheMissNotices: vi.fn(() => true),
      },
      sessionManager: {
        getBranch: vi.fn(() => [
          {
            id: "assistant-1",
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "done" },
                { type: "toolCall", id: "call-1", name: "read", arguments: {} },
              ],
              provider: "anthropic",
              model: "claude-x",
              timestamp: 1,
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            id: "custom-visible",
            type: "custom_message",
            customType: "notice",
            display: true,
            content: "visible",
          },
          warm("warm-after-custom"),
          {
            id: "custom-hidden",
            type: "custom_message",
            customType: "notice",
            display: false,
            content: "hidden",
          },
          warm("warm-after-hidden"),
          {
            id: "compaction-1",
            type: "compaction",
            summary: "summary",
            firstKeptEntryId: "compaction-1",
            tokensBefore: 500,
          },
          warm("warm-after-compaction"),
          { id: "branch-1", type: "branch_summary", summary: "branch" },
          warm("warm-after-branch"),
          { id: "user-1", type: "message", message: { role: "user", content: "next" } },
          warm("warm-after-user"),
          {
            id: "custom-role-1",
            type: "message",
            message: { role: "custom", display: true, content: "custom role" },
          },
          warm("warm-after-custom-role"),
          { id: "custom-entry-1", type: "custom", customType: "extension-card", data: {} },
          warm("warm-after-custom-entry"),
          {
            id: "bash-1",
            type: "message",
            message: { role: "bashExecution", command: "pwd", output: "/tmp" },
          },
          {
            id: "tool-result-1",
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "read",
              content: [{ type: "text", text: "updated in place" }],
            },
          },
          warm("warm-after-tool-result"),
          {
            id: "standalone-result-1",
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "orphan-call",
              toolName: "read",
              content: [{ type: "text", text: "standalone" }],
            },
          },
          warm("warm-after-standalone-result"),
          {
            id: "error-with-text",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              stopReason: "error",
              errorMessage: "provider failed",
            },
          },
          warm("warm-after-text-error"),
          {
            id: "error-without-text",
            type: "message",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "provider failed immediately",
            },
          },
          warm("warm-after-empty-error"),
        ]),
      },
    });

    const response = await run({ type: "get_cache_miss_notices" });
    expect(
      response.data.notices.map(({ noticeId, afterEntryId }) => [noticeId, afterEntryId]),
    ).toEqual([
      ["cache-warm:warm-after-custom", "custom-visible"],
      ["cache-warm:warm-after-hidden", "cache-warm:warm-after-custom"],
      ["cache-warm:warm-after-compaction", "compaction-1"],
      ["cache-warm:warm-after-branch", "branch-1"],
      ["cache-warm:warm-after-user", "user-1"],
      ["cache-warm:warm-after-custom-role", "custom-role-1"],
      ["cache-warm:warm-after-custom-entry", "custom-entry-1"],
      ["cache-warm:warm-after-tool-result", "bash-1"],
      ["cache-warm:warm-after-standalone-result", "standalone-result-1"],
      ["cache-warm:warm-after-text-error", "error-with-text-error"],
      ["cache-warm:warm-after-empty-error", "error-without-text"],
    ]);
  });

  it("compact passes the customInstructions STRING (not an object)", async () => {
    const { session, run } = setup();
    await run({ type: "compact", customInstructions: "be brief" });
    expect(session.compact).toHaveBeenCalledWith("be brief");
  });

  it("bash passes its request id for streaming updates and returns the full result", async () => {
    const controller = makeShellController();
    const runWithInvocationSurface = vi.fn((_surface, operation) => operation());
    const { session, run } = setup(undefined, {
      createShellController: vi.fn(() => controller),
      runWithInvocationSurface,
    });
    const res = await run({ type: "bash", command: "ls" }, "unified");
    expect(session.executeBash).toHaveBeenCalledWith("ls", undefined, {
      id: "cmd-1",
      operations: controller.operations,
    });
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledWith({
      type: "user_bash",
      command: "ls",
      excludeFromContext: false,
      cwd: "/work",
    });
    expect(runWithInvocationSurface).toHaveBeenCalledOnce();
    expect(runWithInvocationSurface).toHaveBeenCalledWith("unified", expect.any(Function));
    expect(res.data).toMatchObject({ output: "ok", exitCode: 0 });
  });

  it("bash honors a pinned-Pi user_bash full result once without canonical duplication", async () => {
    const replacement = {
      output: "public replacement\n",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    };
    const createShellController = vi.fn(() => makeShellController());
    const { session, run } = setup(undefined, { createShellController });
    session.extensionRunner.emitUserBash.mockResolvedValue({ result: replacement });

    const response = await run({
      type: "bash",
      command: "public-result",
      excludeFromContext: true,
    });

    expect(response).toMatchObject({ success: true, data: replacement });
    expect(session.extensionRunner.emitUserBash).toHaveBeenCalledOnce();
    expect(session.recordBashResult).toHaveBeenCalledOnce();
    expect(session.recordBashResult).toHaveBeenCalledWith("public-result", replacement, {
      excludeFromContext: true,
    });
    expect(session.executeBash).not.toHaveBeenCalled();
    expect(createShellController).not.toHaveBeenCalled();
  });

  it("abort_bash fences a delayed legacy user_bash handler before execution", async () => {
    const preparation = deferred();
    const createShellController = vi.fn(() => makeShellController());
    const { session, run } = setup(undefined, { createShellController });
    session.extensionRunner.emitUserBash.mockImplementation(() => preparation.promise);

    const bashResponse = run({ type: "bash", command: "legacy-delayed" });
    await vi.waitFor(() => expect(session.extensionRunner.emitUserBash).toHaveBeenCalledOnce());
    await expect(run({ type: "abort_bash" })).resolves.toMatchObject({ success: true });
    await expect(bashResponse).resolves.toMatchObject({
      success: false,
      error: "Shell command was cancelled before it started",
    });

    preparation.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(createShellController).not.toHaveBeenCalled();
    expect(session.executeBash).not.toHaveBeenCalled();
    expect(session.recordBashResult).not.toHaveBeenCalled();
    expect(session.sessionManager.appendCustomEntry).not.toHaveBeenCalled();
  });

  it("refuses a second legacy non-PTY Shell Turn while operations remain active", async () => {
    const terminal = deferred();
    const operations = { exec: vi.fn() };
    const executeBash = vi.fn(() => terminal.promise);
    const { session, run } = setup({ executeBash });
    session.extensionRunner.emitUserBash.mockResolvedValue({ operations });

    const first = run({ type: "bash", command: "first-remote" });
    await vi.waitFor(() => expect(executeBash).toHaveBeenCalledOnce());
    await expect(run({ type: "bash", command: "second-remote" })).resolves.toMatchObject({
      success: false,
      error: "A Shell Turn is already running",
    });
    expect(executeBash).toHaveBeenCalledOnce();
    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledTimes(1);

    terminal.resolve({ output: "done\n", exitCode: 0, cancelled: false, truncated: false });
    await expect(first).resolves.toMatchObject({ success: true });
    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledTimes(2);
  });

  it("abort_bash calls abortBash and responds immediately", async () => {
    const { session, run } = setup();
    const res = await run({ type: "abort_bash" });
    expect(session.abortBash).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
  });

  it("new_session maps cancelled→success and reports cancelled in data", async () => {
    const { runtime, run } = setup();
    runtime.newSession.mockResolvedValueOnce({ cancelled: true });
    const res = await run({ type: "new_session" });
    expect(res.success).toBe(false);
    expect(res.data).toEqual({ cancelled: true });
  });

  it("rejects replacement while another host command is still active", async () => {
    let resolveModels;
    const models = new Promise((resolve) => {
      resolveModels = resolve;
    });
    const { session, runtime, run } = setup();
    session.modelRuntime.getAvailable.mockReturnValueOnce(models);
    const settingModel = run({ type: "set_model", provider: "anthropic", modelId: "claude-x" });
    await vi.waitFor(() => expect(session.modelRuntime.getAvailable).toHaveBeenCalled());

    await expect(run({ type: "new_session" })).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/current session work/i),
    });
    expect(runtime.newSession).not.toHaveBeenCalled();
    resolveModels([{ provider: "anthropic", id: "claude-x", name: "Claude X" }]);
    await expect(settingModel).resolves.toMatchObject({ success: true });
  });

  it("rejects ordinary commands while a replacement transition is active", async () => {
    let resolveReplacement;
    const replacementDone = new Promise((resolve) => {
      resolveReplacement = resolve;
    });
    const { runtime, run } = setup();
    runtime.newSession.mockReturnValueOnce(replacementDone);
    const replacing = run({ type: "new_session" });
    await vi.waitFor(() => expect(runtime.newSession).toHaveBeenCalled());

    await expect(run({ type: "get_state" })).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/replacement is in progress/i),
    });
    resolveReplacement({ cancelled: false });
    await expect(replacing).resolves.toMatchObject({ success: true });
  });

  it("rejects replacement while a consumed prompt promise is still active", async () => {
    let resolvePrompt;
    const promptDone = new Promise((resolve) => {
      resolvePrompt = resolve;
    });
    const { session, runtime, handleSubmit, run } = setup();
    session.prompt.mockImplementation((_text, options) => {
      session.isStreaming = true;
      session.isIdle = false;
      options.preflightResult("started");
      return promptDone;
    });
    await expect(
      handleSubmit({
        submission: {
          intentId: "active-before-replacement",
          expectedHostId: "test-host",
          expectedEpoch: 0,
          editorRevision: 0,
          text: "active",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      }),
    ).resolves.toMatchObject({ disposition: "consumed" });
    // Exercise the narrow boundary where Pi reports idle before the original
    // prompt promise's terminal settlement reaches the authority.
    session.isStreaming = false;
    session.isIdle = true;

    await expect(run({ type: "new_session" })).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/current session work/i),
    });
    expect(runtime.newSession).not.toHaveBeenCalled();
    resolvePrompt();
    await Promise.resolve();
  });

  it("gives initial extension binding the same correlated lifecycle UI lease", async () => {
    vi.useFakeTimers();
    try {
      let resolveUi;
      const uiDone = new Promise((resolve) => {
        resolveUi = resolve;
      });
      const lifecycleUiTracker = { track: (promise) => promise };
      const { session, bindExtensions } = setup(undefined, {
        initialBinding: true,
        lifecycleUiTracker,
      });
      session.bindExtensions.mockImplementationOnce(async () => {
        await lifecycleUiTracker.track(uiDone);
      });

      const pending = bindExtensions(session);
      await vi.advanceTimersByTimeAsync(120_000);
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveUi();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses lifecycle timeout only for a blocking UI promise opened by that lifecycle", async () => {
    vi.useFakeTimers();
    try {
      let resolveUi;
      const uiDone = new Promise((resolve) => {
        resolveUi = resolve;
      });
      const lifecycleUiTracker = { track: (promise) => promise };
      const { runtime, run } = setup(undefined, { lifecycleUiTracker });
      runtime.newSession.mockImplementationOnce(async () => {
        await lifecycleUiTracker.track(uiDone);
        return { cancelled: false };
      });

      const pending = run({ type: "new_session" });
      await vi.advanceTimersByTimeAsync(120_000);
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveUi();
      await expect(pending).resolves.toMatchObject({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an unrelated persistent panel pause lifecycle timeout", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise(() => {});
      const panelBridge = { closeAll: vi.fn(() => false), activeCount: 1 };
      const { runtime, run } = setup(undefined, { panelBridge });
      runtime.newSession.mockReturnValueOnce(never);

      const pending = run({ type: "new_session" });
      await vi.advanceTimersByTimeAsync(60_100);

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/lifecycle timed out/i),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires the host when replacement fails after Pi invalidates the old session", async () => {
    const { runtime, send, run } = setup();
    runtime.newSession.mockImplementationOnce(async () => {
      runtime.setBeforeSessionInvalidate.mock.calls[0][0]();
      throw new Error("replacement creation failed");
    });

    const res = await run({ type: "new_session" });

    expect(res.success).toBe(false);
    expect(send).toHaveBeenCalledWith({
      type: "fatal_transition_error",
      message: "replacement creation failed",
    });
  });

  it("clone uses sessionManager.getLeafId and forks at-position", async () => {
    const { session, runtime, run } = setup();
    const res = await run({ type: "clone" });
    expect(runtime.fork).toHaveBeenCalledWith("leaf-9", { position: "at" });
    expect(res.success).toBe(true);
    expect(session.sessionManager.getLeafId).toHaveBeenCalled();
  });

  it("clone errors when there is no leaf entry", async () => {
    const { session, runtime, run } = setup();
    session.sessionManager.getLeafId.mockReturnValueOnce(null);
    const res = await run({ type: "clone" });
    expect(runtime.fork).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no current entry/i);
  });

  it("runs authoritative submissions under their renderer invocation surface", async () => {
    const runWithInvocationSurface = vi.fn((_surface, fn) => fn());
    const { handleSubmit } = setup(undefined, { runWithInvocationSurface });

    const result = await handleSubmit({
      submission: {
        intentId: "surface-submit",
        expectedHostId: "test-host",
        expectedEpoch: 0,
        editorRevision: 0,
        text: "/custom-panel",
        images: [],
        requestedMode: "steer",
        surface: "composer",
      },
    });

    expect(result.disposition).toBe("consumed");
    expect(runWithInvocationSurface).toHaveBeenCalledWith("composer", expect.any(Function));
  });

  it("routes revision-matched submission custody into the host editor authority", async () => {
    const acceptEditorSubmission = vi.fn(() => true);
    const uiState = {
      catalogSnapshot: () => ({}),
      editorSnapshot: () => ({ revision: 3, text: "submitted", attachments: [] }),
      acceptEditorSubmission,
      applyEditorPatch: () => ({ accepted: false }),
    };
    const { handleSubmit } = setup(
      {
        prompt: vi.fn((_text, options) => {
          options.preflightResult("started");
          return Promise.resolve();
        }),
      },
      { uiState },
    );

    await expect(
      handleSubmit({
        submission: {
          intentId: "clear-editor",
          expectedHostId: "test-host",
          expectedEpoch: 0,
          editorRevision: 3,
          text: "submitted",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      }),
    ).resolves.toMatchObject({ disposition: "consumed" });
    expect(acceptEditorSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: "clear-editor", editorRevision: 3 }),
    );
  });

  it("observes a passive public input handler before Pi appends the queued prompt", async () => {
    let emitSessionEvent;
    const steering = [];
    let observedThis;
    const originalEmitInput = vi.fn(async function () {
      observedThis = this;
      return { action: "continue" };
    });
    const extensionRunner = {
      getCommand: vi.fn(() => undefined),
      getRegisteredCommands: vi.fn(() => []),
      hasHandlers: vi.fn((kind) => kind === "input"),
      emitInput: originalEmitInput,
    };
    const harness = setup(
      {
        isStreaming: true,
        isIdle: false,
        extensionRunner,
        subscribe: vi.fn((listener) => {
          emitSessionEvent = listener;
          return vi.fn();
        }),
        getSteeringMessages: vi.fn(() => steering),
        prompt: vi.fn(async (text, options) => {
          const inputResult = await extensionRunner.emitInput(
            text,
            options.images,
            "interactive",
            options.streamingBehavior,
          );
          expect(inputResult).toEqual({ action: "continue" });
          steering.push(text);
          emitSessionEvent({
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          });
          options.preflightResult("queued");
        }),
      },
      {
        uiState: makeUiState({
          editorSnapshot: () => ({
            revision: 6,
            text: "passive handler queue",
            attachments: [],
          }),
        }),
      },
    );

    await expect(
      harness.handleSubmit({
        submission: {
          intentId: "passive-handler-submit",
          expectedHostId: "test-host",
          expectedEpoch: 0,
          editorRevision: 6,
          text: "passive handler queue",
          inputKind: "ordinary",
          images: [],
          requestedMode: "steer",
          surface: "composer",
        },
      }),
    ).resolves.toMatchObject({ disposition: "consumed", queued: true });

    expect(originalEmitInput).toHaveBeenCalledWith(
      "passive handler queue",
      undefined,
      "interactive",
      "steer",
    );
    expect(observedThis).toBe(extensionRunner);
    expect(harness.authority.semanticSnapshot().queues).toMatchObject({
      steering: ["passive handler queue"],
      steeringIntentIds: ["passive-handler-submit"],
      management: {
        available: false,
        message: expect.stringContaining("Input hooks are active"),
        removableIntentIds: ["passive-handler-submit"],
      },
    });
  });

  it("does not let detached input-handler queue work claim the outer admission", async () => {
    let emitSessionEvent;
    const steering = [];
    const originalEmitInput = vi.fn((text) => {
      const result = Promise.resolve({ action: "continue" });
      void result.then(() => {
        // This job is born inside emitInput() but runs after its public result
        // has authorized the unchanged outer prompt. It must remain
        // extension-owned even though its text deliberately matches.
        queueMicrotask(() => {
          steering.push(text);
          emitSessionEvent({
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          });
        });
      });
      return result;
    });
    const extensionRunner = {
      getCommand: vi.fn(() => undefined),
      getRegisteredCommands: vi.fn(() => []),
      hasHandlers: vi.fn((kind) => kind === "input"),
      emitInput: originalEmitInput,
    };
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner,
      subscribe: vi.fn((listener) => {
        emitSessionEvent = listener;
        return vi.fn();
      }),
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn(async (text, options) => {
        await extensionRunner.emitInput(
          text,
          options.images,
          "interactive",
          options.streamingBehavior,
        );
        steering.push(text);
        emitSessionEvent({
          type: "queue_update",
          steering: [...steering],
          followUp: [],
        });
        options.preflightResult("queued");
      }),
    });

    await expect(
      harness.authority.submit({
        intentId: "outer-after-detached-handler-work",
        expectedHostId: "test-host",
        expectedEpoch: 0,
        editorRevision: 0,
        text: "same queued text",
        inputKind: "ordinary",
        images: [],
        requestedMode: "steer",
        surface: "composer",
      }),
    ).resolves.toMatchObject({ disposition: "consumed", queued: true });

    expect(originalEmitInput).toHaveBeenCalledOnce();
    expect(harness.authority.snapshot()).toMatchObject({
      steering: ["same queued text", "same queued text"],
      steeringIntentIds: [null, "outer-after-detached-handler-work"],
    });
  });

  it("reinstalls input observation after reload replacement and successor rebind", async () => {
    let emitSessionEvent;
    const steering = [];
    const initialEmitInput = vi.fn(async () => ({ action: "continue" }));
    const extensionRunner = {
      getCommand: vi.fn(() => undefined),
      getRegisteredCommands: vi.fn(() => []),
      hasHandlers: vi.fn((kind) => kind === "input"),
      emitInput: initialEmitInput,
    };
    let queuePrompt = false;
    const harness = setup({
      extensionRunner,
      subscribe: vi.fn((listener) => {
        emitSessionEvent = listener;
        return vi.fn();
      }),
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn(async (text, options) => {
        await extensionRunner.emitInput(
          text,
          options.images,
          "interactive",
          options.streamingBehavior,
        );
        if (queuePrompt) {
          steering.push(text);
          emitSessionEvent({
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          });
        }
        options.preflightResult(queuePrompt ? "queued" : "started");
      }),
    });
    const submit = (intentId, text, expectedEpoch) =>
      harness.authority.submit({
        intentId,
        expectedHostId: "test-host",
        expectedEpoch,
        editorRevision: 0,
        text,
        inputKind: "ordinary",
        images: [],
        requestedMode: "steer",
        surface: "composer",
      });

    await submit("prime-initial-runner", "prime observer", 0);
    expect(initialEmitInput).toHaveBeenCalledOnce();
    expect(extensionRunner.emitInput).not.toBe(initialEmitInput);
    await vi.waitFor(() => expect(harness.authority.hasActiveWork).toBe(false));

    const reloadedEmitInput = vi.fn(async () => ({ action: "continue" }));
    harness.session.reload.mockImplementationOnce(async ({ beforeSessionStart }) => {
      await beforeSessionStart();
      extensionRunner.emitInput = reloadedEmitInput;
    });
    await harness.handleReload();
    expect(harness.authority.sessionEpoch).toBe(1);
    harness.session.isStreaming = true;
    harness.session.isIdle = false;
    queuePrompt = true;

    await submit("after-reload-runner-swap", "queued after reload", 1);
    expect(reloadedEmitInput).toHaveBeenCalledOnce();
    expect(extensionRunner.emitInput).not.toBe(reloadedEmitInput);
    expect(harness.authority.snapshot()).toMatchObject({
      steering: ["queued after reload"],
      steeringIntentIds: ["after-reload-runner-swap"],
    });
    await vi.waitFor(() => expect(harness.authority.hasActiveWork).toBe(false));

    let emitSuccessorEvent;
    const successorSteering = [];
    const successorEmitInput = vi.fn(async () => ({ action: "continue" }));
    const successorRunner = {
      getCommand: vi.fn(() => undefined),
      getRegisteredCommands: vi.fn(() => []),
      hasHandlers: vi.fn((kind) => kind === "input"),
      emitInput: successorEmitInput,
    };
    const successor = makeSession({
      sessionId: "input-observer-successor",
      isStreaming: true,
      isIdle: false,
      extensionRunner: successorRunner,
      subscribe: vi.fn((listener) => {
        emitSuccessorEvent = listener;
        return vi.fn();
      }),
      getSteeringMessages: vi.fn(() => successorSteering),
      prompt: vi.fn(async (text, options) => {
        await successorRunner.emitInput(
          text,
          options.images,
          "interactive",
          options.streamingBehavior,
        );
        successorSteering.push(text);
        emitSuccessorEvent({
          type: "queue_update",
          steering: [...successorSteering],
          followUp: [],
        });
        options.preflightResult("queued");
      }),
    });
    await harness.runtime.setRebindSession.mock.calls[0][0](successor);
    expect(harness.authority.sessionEpoch).toBe(2);

    await submit("after-successor-rebind", "queued after rebind", 2);
    expect(successorEmitInput).toHaveBeenCalledOnce();
    expect(successorRunner.emitInput).not.toBe(successorEmitInput);
    expect(harness.authority.snapshot()).toMatchObject({
      steering: ["queued after rebind"],
      steeringIntentIds: ["after-successor-rebind"],
    });
  });

  it("propagates prompt admission context to synchronous Pi queue updates", async () => {
    const queueAppend = deferred();
    let emitSessionEvent;
    let steering = [];
    const extensionRunner = {
      getCommand: vi.fn(() => undefined),
      getRegisteredCommands: vi.fn(() => []),
      hasHandlers: vi.fn(() => false),
    };
    const { handleSubmit, handleEscape, send } = setup(
      {
        isStreaming: true,
        isIdle: false,
        extensionRunner,
        subscribe: vi.fn((listener) => {
          emitSessionEvent = listener;
          return vi.fn();
        }),
        getSteeringMessages: vi.fn(() => steering),
        clearQueue: vi.fn(() => {
          const cleared = [...steering];
          steering = [];
          emitSessionEvent({ type: "queue_update", steering: [], followUp: [] });
          return { steering: cleared, followUp: [] };
        }),
        prompt: vi.fn(async (text, options) => {
          steering.push(text);
          emitSessionEvent({
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          });
          await queueAppend.promise;
          options.preflightResult("queued");
        }),
      },
      {
        uiState: makeUiState({
          editorSnapshot: () => ({
            revision: 4,
            text: "bridge appended",
            attachments: [],
          }),
        }),
      },
    );
    const pending = handleSubmit({
      submission: {
        intentId: "bridge-admission",
        expectedHostId: "test-host",
        expectedEpoch: 0,
        editorRevision: 4,
        text: "bridge appended",
        inputKind: "ordinary",
        images: [],
        requestedMode: "steer",
        surface: "composer",
      },
    });
    await vi.waitFor(() => expect(steering).toEqual(["bridge appended"]));

    const escaped = await handleEscape("bridge-escape");
    await expect(pending).resolves.toMatchObject({ disposition: "outcome_unknown" });
    expect(
      send.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "queue_restoration"),
    ).toEqual([
      expect.objectContaining({
        restorationId: escaped.restorationId,
        steering: ["bridge appended"],
        clearedIntentIds: ["bridge-admission"],
        certainty: "unknown",
      }),
    ]);

    queueAppend.resolve();
  });

  it.each(["handled", "queued", "started"])(
    "prompt reports the %s disposition without awaiting later work",
    async (disposition) => {
      const { session, run } = setup();
      // prompt() may retain later cleanup/turn work after the accepted path is
      // known; the bridge must answer from Pi's exact disposition callback.
      session.prompt.mockImplementationOnce((_msg, opts) => {
        opts.preflightResult(disposition);
        return new Promise(() => {}); // never settles
      });
      const res = await run({ type: "prompt", message: "hello" });
      expect(res).toMatchObject({ success: true, data: { disposition } });
      expect(session.prompt).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({ source: "rpc" }),
      );
    },
  );

  it("prompt reports a rejection before preflight as an error", async () => {
    const { session, run, send } = setup();
    session.prompt.mockRejectedValueOnce(new Error("Prompt rejected before acceptance"));
    await run({ type: "prompt", message: "hello" });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "response",
          success: false,
          error: "Prompt rejected before acceptance",
        }),
      ),
    );
    const res = send.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "response" && message.success === false);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rejected/i);
  });

  it("an unknown command type yields a structured error response", async () => {
    const { run } = setup();
    const res = await run({ type: "totally_made_up" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unknown command type/);
  });

  it("a throwing handler is caught and reported as a failed response", async () => {
    const { session, run } = setup();
    session.steer.mockRejectedValueOnce(new Error("boom"));
    const res = await run({ type: "steer", message: "x" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("boom");
  });
});

// ─── Capability self-check ───────────────────────────────────────────────────

describe("conversation-tree commands (get_tree / navigate_tree / set_label)", () => {
  it("get_tree returns the sessionManager's nodes (flattened) + the current leafId", async () => {
    // The bridge FLATTENS pi's nested getTree() output into a parentId-keyed
    // list before sending — the recursive nesting (depth = longest message
    // chain) blows Electron's contextBridge 1000-level limit on long sessions.
    // The flat list mirrors the nested structure exactly, just depth-bounded.
    const fakeTree = [
      {
        entry: { id: "u1", type: "message", timestamp: "t1" },
        children: [
          {
            entry: { id: "u2", type: "message", timestamp: "t2" },
            children: [],
            label: "after-fork",
          },
        ],
      },
    ];
    const { run } = setup({
      sessionManager: {
        getLeafId: vi.fn(() => "u2"),
        getTree: vi.fn(() => fakeTree),
        appendLabelChange: vi.fn(() => "label-1"),
      },
    });
    const res = await run({ type: "get_tree" });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      nodes: [
        {
          entry: { id: "u1", type: "message", timestamp: "t1" },
          parentId: undefined,
          label: undefined,
          labelTimestamp: undefined,
        },
        {
          entry: { id: "u2", type: "message", timestamp: "t2" },
          parentId: "u1",
          label: "after-fork",
          labelTimestamp: undefined,
        },
      ],
      leafId: "u2",
    });
  });

  it("get_tree returns leafId: null when the session is in its pre-leaf state", async () => {
    const { run } = setup({
      sessionManager: {
        getLeafId: vi.fn(() => null),
        getTree: vi.fn(() => []),
      },
    });
    const res = await run({ type: "get_tree" });
    expect(res.data).toEqual({ nodes: [], leafId: null });
  });

  it("get_tree with missing getTree/getLeafId returns data.unsupported (capability gap, not a thrown error)", async () => {
    // Older pi (or a build without the tree surface) lacks
    // sessionManager.getTree. The bridge must NOT throw a TypeError (which
    // the outer try/catch would flatten into a generic success:false and the
    // renderer couldn't distinguish from a transient). Instead it returns a
    // structured `unsupported` flag so the renderer maps it to the permanent
    // "unsupported" phase and everything else to retryable "error".
    const { run } = setup({ sessionManager: {} });
    const res = await run({ type: "get_tree" });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ unsupported: true, nodes: [], leafId: null });
  });

  it("navigate_tree calls session.navigateTree with target + options", async () => {
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    const { session, run } = setup({
      navigateTree,
      sessionManager: {
        getLeafId: vi.fn(() => "new-leaf"),
        getBranch: vi.fn(() => [{ id: "u1", type: "message" }]),
      },
    });
    const res = await run({
      type: "navigate_tree",
      targetId: "u2",
      summarize: true,
      label: "alt-approach",
    });
    expect(session.navigateTree).toHaveBeenCalledWith("u2", {
      summarize: true,
      label: "alt-approach",
    });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      cancelled: false,
      editorText: undefined,
      aborted: undefined,
      leafId: "new-leaf",
      branch: [{ id: "u1", type: "message" }],
    });
  });

  it("navigate_tree returns editorText when pi supplies one (user-message target)", async () => {
    const { run } = setup({
      navigateTree: vi.fn(async () => ({
        cancelled: false,
        editorText: "the first message",
      })),
      sessionManager: {
        getLeafId: vi.fn(() => "u1"),
        getBranch: vi.fn(() => [{ id: "u1", type: "message", message: { role: "user" } }]),
      },
    });
    const res = await run({ type: "navigate_tree", targetId: "u1" });
    expect(res.data?.editorText).toBe("the first message");
  });

  it("navigate_tree with cancelled=true omits leafId/branch (review S3: no post-nav state)", async () => {
    const { run } = setup({
      navigateTree: vi.fn(async () => ({ cancelled: true })),
      sessionManager: {
        getLeafId: vi.fn(() => "old-leaf"),
        getBranch: vi.fn(() => []),
      },
    });
    const res = await run({ type: "navigate_tree", targetId: "x" });
    expect(res.success).toBe(true);
    expect(res.data?.cancelled).toBe(true);
    expect(res.data?.leafId).toBeUndefined();
    expect(res.data?.branch).toBeUndefined();
  });

  it("set_label forwards targetId + label to appendLabelChange (sync)", async () => {
    const appendLabelChange = vi.fn(() => "label-entry-1");
    const { run } = setup({
      sessionManager: {
        getLeafId: vi.fn(() => "leaf-1"),
        appendLabelChange,
      },
    });
    const res = await run({ type: "set_label", targetId: "u3", label: "checkpoint" });
    expect(appendLabelChange).toHaveBeenCalledWith("u3", "checkpoint");
    expect(res.success).toBe(true);
  });

  it("set_label with no label argument clears the label (undefined forwarded)", async () => {
    const appendLabelChange = vi.fn(() => "label-entry-1");
    const { run } = setup({
      sessionManager: {
        getLeafId: vi.fn(() => "leaf-1"),
        appendLabelChange,
      },
    });
    await run({ type: "set_label", targetId: "u3" });
    expect(appendLabelChange).toHaveBeenCalledWith("u3", undefined);
  });

  it("navigate_tree degrades gracefully when the SDK lacks session.navigateTree (per-command, NOT host-wide)", async () => {
    // Old pi version: session.navigateTree is undefined. The bridge's outer
    // try/catch must turn this into success:false (so the renderer can show
    // the friendly "requires SDK host" state) without killing the host —
    // panels must continue to work.
    const { session, run } = setup();
    session.navigateTree = undefined;
    const res = await run({ type: "navigate_tree", targetId: "x" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/navigateTree|not a function/);
  });

  it("get_tree degrades gracefully when the SDK lacks session.sessionManager.getTree (review B3)", async () => {
    // Old pi version: getTree is missing. The bridge returns a structured
    // `unsupported` flag (NOT a thrown TypeError / success:false) so the
    // renderer can distinguish a genuine capability gap from a transient
    // failure. Panels remain enabled.
    const { session, run } = setup();
    session.sessionManager = { getLeafId: vi.fn(() => null) };
    const res = await run({ type: "get_tree" });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ unsupported: true, nodes: [], leafId: null });
  });
});

describe("assertHostCapabilities", () => {
  it("passes for a complete session + runtime", () => {
    const session = makeSession();
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime, MODEL_SCOPE_PI)).not.toThrow();
  });

  it("passes with Pi 0.80.6's complete public model registry", () => {
    const session = makeSession({
      modelRuntime: undefined,
      modelRegistry: {
        getAvailable: vi.fn(() => []),
        find: vi.fn(),
        refresh: vi.fn(),
        authStorage: {
          logout: vi.fn(),
          list: vi.fn(() => []),
          get: vi.fn(),
        },
      },
    });
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime, MODEL_SCOPE_PI)).not.toThrow();
  });

  it("throws listing the missing method when pi renames a session method", () => {
    const session = makeSession();
    // Simulate a future pi that renamed executeBash.
    session.executeBash = undefined;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime, MODEL_SCOPE_PI)).toThrow(
      /session\.executeBash/,
    );
  });

  it.each([
    "cycleModel",
    "cycleThinkingLevel",
    "setSteeringMode",
    "setFollowUpMode",
    "setScopedModels",
    "setAutoCompactionEnabled",
    "setAutoRetryEnabled",
  ])("gates the bridge method session.%s", (method) => {
    const session = makeSession();
    session[method] = undefined;
    expect(() => assertHostCapabilities(session, makeRuntime(session), MODEL_SCOPE_PI)).toThrow(
      `session.${method}`,
    );
  });

  it("throws when Pi's canonical Bash failure recorder is missing", () => {
    const session = makeSession();
    session.recordBashResult = undefined;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime, MODEL_SCOPE_PI)).toThrow(
      /session\.recordBashResult/,
    );
  });

  it("throws when Pi's public user_bash emitter is missing", () => {
    const session = makeSession();
    session.extensionRunner.emitUserBash = undefined;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime, MODEL_SCOPE_PI)).toThrow(
      /session\.extensionRunner\.emitUserBash/,
    );
  });

  it("throws when a runtime lifecycle method is missing", () => {
    const session = makeSession();
    const runtime = makeRuntime(session);
    runtime.setRebindSession = undefined;
    expect(() => assertHostCapabilities(session, runtime, MODEL_SCOPE_PI)).toThrow(
      /runtime\.setRebindSession/,
    );
  });

  it("throws when the state authority command lookup is missing", () => {
    const session = makeSession();
    session.extensionRunner.getCommand = undefined;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime, MODEL_SCOPE_PI)).toThrow(
      /session\.extensionRunner\.getCommand/,
    );
  });

  it("throws when a getState getter is absent", () => {
    const session = makeSession();
    delete session.thinkingLevel;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime, MODEL_SCOPE_PI)).toThrow(
      /session\.thinkingLevel/,
    );
  });

  it("throws when Pi's public model-scope resolver is missing", () => {
    const session = makeSession();
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime, {})).toThrow(
      /pi\.resolveModelScopeWithDiagnostics/,
    );
  });
});
