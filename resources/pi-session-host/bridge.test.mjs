import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PI_COMMAND_POLICY } from "../../src/shared/pi-protocol/commands.ts";
import {
  AuthorityFrameSchema,
  TransitionBatchSchema,
} from "../../src/shared/pi-protocol/runtime-state.ts";
import { assertHostCapabilities, setupCommandBridge } from "./bridge.mjs";

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
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
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
      refresh: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      listCredentials: vi.fn(async () => []),
      getProvider: vi.fn(),
    },
    extensionRunner: {
      getCommand: vi.fn(() => undefined),
      getRegisteredCommands: vi.fn(() => []),
    },
    resourceLoader: { getSkills: vi.fn(() => ({ skills: [] })) },
    sessionManager: { getLeafId: vi.fn(() => "leaf-9"), getBranch: vi.fn(() => []) },
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
    ...bridgeOverrides,
  });
  const { handleCommand, handleSubmit, handleReload, dispatchIntent, bindExtensions } = bridge;
  let nextId = 0;
  const run = async (command) => {
    const id = `cmd-${++nextId}`;
    await handleCommand({ id, command });
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
    handleReload,
    dispatchIntent,
    bindExtensions,
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
    const { runtime } = setup(undefined, { cancelDialogs });

    runtime.setBeforeSessionInvalidate.mock.calls[0][0]();

    expect(cancelDialogs).toHaveBeenCalledTimes(1);
  });

  it("rejects extension-action reload against fresh active host getters", async () => {
    const { session, handleReload } = setup({ isIdle: false, isStreaming: true });

    await expect(handleReload()).rejects.toThrow("current response");

    expect(session.reload).not.toHaveBeenCalled();
  });

  it("cancels dialogs from the old extension generation during reload", async () => {
    const cancelDialogs = vi.fn();
    const { session, handleReload } = setup(undefined, { cancelDialogs });
    session.reload.mockImplementationOnce(async ({ beforeSessionStart }) => {
      await beforeSessionStart();
    });

    await handleReload();

    expect(cancelDialogs).toHaveBeenCalledTimes(1);
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
      editorRevision: 7,
      text: "/reload",
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

  it("preserves reload conflict custody instead of clearing the command text", async () => {
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

    expect(acceptEditorSubmission).not.toHaveBeenCalled();
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

  it("allows a command-context replacement to own its one active submission", async () => {
    const { session, runtime, handleSubmit, bindExtensions } = setup();
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
      options.preflightResult(true);
    });

    await expect(
      handleSubmit({
        submission: {
          intentId: "extension-owned-replacement",
          expectedHostId: "test-host",
          expectedEpoch: 0,
          editorRevision: 0,
          text: "/replace-from-extension",
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
      { sendControl, sendFrame },
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
      options.preflightResult(true);
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
    const { send, dispatchIntent } = setup({ modelRuntime }, { createProviderAuthSurface });

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
    await vi.waitFor(() => expect(surface.complete).toHaveBeenCalledTimes(1));
    const outcome = send.mock.calls
      .map(([message]) => message)
      .find(
        (message) =>
          message.type === "intent_outcome" && message.outcome.intentId === "login-provider",
      );
    expect(outcome.outcome).toMatchObject({
      state: "completed",
      result: { providerId: "project-dynamic", authType: "api_key" },
    });
    expect(JSON.stringify(outcome)).not.toContain("never-publish-this");
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
    const { session, runtime, send, dispatchIntent } = setup();
    session.prompt.mockImplementation(async (_text, options) => options.preflightResult(true));
    const intents = [
      ["interrupt", {}],
      [
        "submit",
        {
          editorRevision: 0,
          text: "hello",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        },
      ],
      [
        "manageQueue",
        { operation: "clear", expectedSteeringIntentIds: [], expectedFollowUpIntentIds: [] },
      ],
      ["compact", { instructions: "brief" }],
      ["runBash", { command: "pwd", excludeFromContext: true }],
      ["navigate", { targetId: "leaf-9", summarize: true }],
      ["setModel", { provider: "anthropic", modelId: "claude-x" }],
      ["setThinking", { level: "high" }],
      ["rename", { name: "Renamed" }],
      ["reload", {}],
      ["invokeCommand", { text: "/extension arg", editorRevision: 0 }],
    ];

    for (const [kind, payload] of intents) {
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
    }

    expect(session.compact).toHaveBeenCalledWith("brief");
    expect(session.executeBash).toHaveBeenCalledWith("pwd", undefined, {
      excludeFromContext: true,
    });
    expect(session.navigateTree).toHaveBeenCalledWith("leaf-9", { summarize: true });
    expect(session.setModel).toHaveBeenCalled();
    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(session.setSessionName).toHaveBeenCalledWith("Renamed");
    expect(session.reload).toHaveBeenCalledOnce();
    // Both text intents use the child public prompt/extension path; no
    // renderer-selected PiRpcCommand type enters this dispatch.
    expect(session.prompt).toHaveBeenCalledWith("/extension arg", expect.any(Object));
    expect(runtime.newSession).not.toHaveBeenCalled();
  });

  it("keeps intent ingress responsive while an intent-invoked compaction runs", async () => {
    let resolveCompact;
    const compact = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCompact = resolve;
        }),
    );
    const { session, send, dispatchIntent } = setup({ compact });
    session.prompt.mockImplementation(async (_text, options) => options.preflightResult(true));

    await expect(
      dispatchIntent(envelope("intent-compact-long", { kind: "compact" })),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(session.compact).toHaveBeenCalled());

    // A prompt dispatched mid-compaction must reach custody immediately —
    // never sit behind the whole compaction in the serialized scheduler.
    await expect(
      dispatchIntent(
        envelope("intent-mid-compaction", {
          kind: "submit",
          editorRevision: 0,
          text: "queued during compaction",
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
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
    const { dispatchIntent } = setup(
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
    const { session, runtime, dispatchIntent } = setup(undefined, { sendControl, sendFrame });
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

  it("maps app built-ins without falling through to prompt", async () => {
    const { session, dispatchIntent } = setup({
      sessionManager: {
        getLeafId: vi.fn(() => "leaf-9"),
        appendLabelChange: vi.fn(),
      },
      modelRuntime: {
        getAvailable: vi.fn(async () => [{ provider: "anthropic", id: "claude-x" }]),
        logout: vi.fn(async () => {}),
      },
    });
    const commands = [
      ["export", "/export /tmp/out.html"],
      ["models", "/models apply anthropic/claude-x"],
      ["logout", "/logout anthropic"],
      ["label", "/label entry-1 checkpoint"],
    ];
    for (const [id, text] of commands) {
      await expect(
        dispatchIntent(
          envelope(`builtin-${id}`, {
            kind: "invokeCommand",
            text,
            editorRevision: 0,
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

  it("leaves a template that shadows a builtin on Pi's prompt path", async () => {
    const { session, runtime, dispatchIntent } = setup({ promptTemplates: [{ name: "new" }] });
    session.prompt.mockImplementation(async (_text, options) => options.preflightResult(true));

    await dispatchIntent(
      envelope("template-new", { kind: "invokeCommand", text: "/new", editorRevision: 0 }),
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledWith("/new", expect.any(Object)));
    expect(runtime.newSession).not.toHaveBeenCalled();
  });

  it("deduplicates same-owner IDs, rejects conflicts and fences stale owners before Pi", async () => {
    const { session, dispatchIntent } = setup();
    session.executeBash.mockResolvedValue({ output: "ok" });
    const original = envelope("once", { kind: "runBash", command: "echo once" });

    await expect(dispatchIntent(original)).resolves.toMatchObject({ status: "admitted" });
    await expect(dispatchIntent(original)).resolves.toMatchObject({ status: "duplicate" });
    await expect(
      dispatchIntent(envelope("once", { kind: "runBash", command: "echo different" })),
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

  it("steer passes message + images and resolves success", async () => {
    const { session, run } = setup();
    const res = await run({ type: "steer", message: "go", images: [{ data: "x" }] });
    expect(session.steer).toHaveBeenCalledWith("go", [{ data: "x" }]);
    expect(res.success).toBe(true);
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

  it("replays non-persisted cache-miss notices with history anchors", async () => {
    const previous = {
      role: "assistant",
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
        getLeafId: vi.fn(() => "entry-2"),
        getBranch: vi.fn(() => [
          { id: "entry-1", type: "message", message: previous },
          { id: "entry-2", type: "message", message: current },
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
            afterEntryId: "entry-2",
            missedTokens: 30_000,
            missedCost: 0.3,
            idleMs: 6 * 60_000,
            modelChanged: false,
          },
        ],
      },
    });
  });

  it("compact passes the customInstructions STRING (not an object)", async () => {
    const { session, run } = setup();
    await run({ type: "compact", customInstructions: "be brief" });
    expect(session.compact).toHaveBeenCalledWith("be brief");
  });

  it("bash calls executeBash(command, undefined, {}) and returns the full result", async () => {
    const { session, run } = setup();
    const res = await run({ type: "bash", command: "ls" });
    expect(session.executeBash).toHaveBeenCalledWith("ls", undefined, {});
    expect(res.data).toMatchObject({ output: "ok", exitCode: 0 });
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
      options.preflightResult(true);
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
          options.preflightResult(true);
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

  it("prompt responds early via preflightResult(true) without awaiting the turn", async () => {
    const { session, run } = setup();
    // prompt() never resolves (a real turn is long-running); preflight fires.
    session.prompt.mockImplementationOnce((_msg, opts) => {
      opts.preflightResult(true);
      return new Promise(() => {}); // never settles
    });
    const res = await run({ type: "prompt", message: "hello" });
    expect(res.success).toBe(true);
    expect(session.prompt).toHaveBeenCalled();
  });

  it("prompt reports a rejected preflight as an error", async () => {
    const { session, run } = setup();
    session.prompt.mockImplementationOnce((_msg, opts) => {
      opts.preflightResult(false);
      return new Promise(() => {});
    });
    const res = await run({ type: "prompt", message: "hello" });
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
    expect(() => assertHostCapabilities(session, runtime)).not.toThrow();
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
    expect(() => assertHostCapabilities(session, runtime)).not.toThrow();
  });

  it("throws listing the missing method when pi renames a session method", () => {
    const session = makeSession();
    // Simulate a future pi that renamed executeBash.
    session.executeBash = undefined;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime)).toThrow(/session\.executeBash/);
  });

  it("throws when a runtime lifecycle method is missing", () => {
    const session = makeSession();
    const runtime = makeRuntime(session);
    runtime.setRebindSession = undefined;
    expect(() => assertHostCapabilities(session, runtime)).toThrow(/runtime\.setRebindSession/);
  });

  it("throws when the state authority command lookup is missing", () => {
    const session = makeSession();
    session.extensionRunner.getCommand = undefined;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime)).toThrow(
      /session\.extensionRunner\.getCommand/,
    );
  });

  it("throws when a getState getter is absent", () => {
    const session = makeSession();
    delete session.thinkingLevel;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime)).toThrow(/session\.thinkingLevel/);
  });
});
