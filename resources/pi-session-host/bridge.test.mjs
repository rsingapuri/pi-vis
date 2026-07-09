import { describe, expect, it, vi } from "vitest";
import { assertHostCapabilities, setupCommandBridge } from "./bridge.mjs";

// The bridge translates pi-vis wire commands → pi SDK method calls. It is plain
// .mjs (not type-checked against pi's .d.ts), so a wrong field name or argument
// shape slips past tsc AND every other test — exactly the failure class the
// Phase-1 capture effort was about. These tests pin the mapping with a fully
// faked AgentSession/runtime.

// ─── Fakes ─────────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return {
    // getters read by getState()
    model: { id: "claude-x", provider: "anthropic" },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
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
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(() => {}),
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
    modelRegistry: {
      getAvailable: vi.fn(async () => [
        { provider: "anthropic", id: "claude-x", name: "Claude X" },
      ]),
    },
    extensionRunner: { getRegisteredCommands: vi.fn(() => []) },
    resourceLoader: { getSkills: vi.fn(() => ({ skills: [] })) },
    sessionManager: { getLeafId: vi.fn(() => "leaf-9") },
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
function setup(sessionOverrides) {
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
  });
  const { handleCommand } = bridge;
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

  it("forwards session events and synthetic streaming_state in-band", () => {
    const { session, send } = setup();
    const subscriber = session.subscribe.mock.calls[0][0];
    session.isStreaming = true;
    subscriber({ type: "agent_start" });
    expect(send).toHaveBeenCalledWith({ type: "event", event: { type: "agent_start" } });
    expect(send).toHaveBeenCalledWith({
      type: "event",
      event: { type: "streaming_state", isStreaming: true },
    });
  });

  it("re-announces streaming state on rebind even when the value is unchanged", async () => {
    const { runtime, send } = setup();
    send.mockClear();
    const rebind = runtime.setRebindSession.mock.calls[0][0];
    const nextSession = makeSession({ isStreaming: false });
    await rebind(nextSession);
    expect(send).toHaveBeenCalledWith({
      type: "event",
      event: { type: "streaming_state", isStreaming: false },
    });
  });

  it("re-announces interrupt state on rebind even when the value is unchanged", async () => {
    const { runtime, send } = setup();
    send.mockClear();
    const rebind = runtime.setRebindSession.mock.calls[0][0];
    const nextSession = makeSession();
    await rebind(nextSession);
    expect(send).toHaveBeenCalledWith({
      type: "event",
      event: { type: "interrupt_state", interruptible: false },
    });
  });

  it("keeps synthetic streaming true across retry backoff", async () => {
    const { session, send, run } = setup();
    const subscriber = session.subscribe.mock.calls[0][0];
    session.isStreaming = true;
    subscriber({ type: "agent_start" });
    send.mockClear();

    subscriber({ type: "agent_end", willRetry: true });
    session.isStreaming = false;
    await new Promise((resolve) => setImmediate(resolve));

    expect(send).not.toHaveBeenCalledWith({
      type: "event",
      event: { type: "streaming_state", isStreaming: false },
    });
    const res = await run({ type: "get_state" });
    expect(res.data.isStreaming).toBe(true);
  });

  it("tracks prompt operations as interruptible until the prompt promise settles", async () => {
    let resolvePrompt;
    const promptPromise = new Promise((resolve) => {
      resolvePrompt = resolve;
    });
    const { session, send, run, interruptActiveOperation } = setup({
      prompt: vi.fn((_message, options) => {
        options.preflightResult(true);
        return promptPromise;
      }),
    });

    const res = await run({ type: "prompt", message: "/mcp" });
    expect(res.success).toBe(true);
    expect(send).toHaveBeenCalledWith({
      type: "event",
      event: { type: "interrupt_state", interruptible: true, operation: "agent" },
    });

    await interruptActiveOperation();
    expect(session.abort).toHaveBeenCalledTimes(1);

    resolvePrompt();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith({
      type: "event",
      event: { type: "interrupt_state", interruptible: false },
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

  it("set_model resolves the Model via the registry by provider+id", async () => {
    const { session, run } = setup();
    const res = await run({ type: "set_model", provider: "anthropic", modelId: "claude-x" });
    expect(session.setModel).toHaveBeenCalledWith({
      provider: "anthropic",
      id: "claude-x",
      name: "Claude X",
    });
    expect(res.success).toBe(true);
  });

  it("set_model resolves providerless models by id", async () => {
    const { session, run } = setup({
      modelRegistry: {
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
      modelRegistry: {
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
      modelRegistry: {
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
    // modelRegistry.getAvailable() must NOT be called when a scope is active.
    expect(session.modelRegistry.getAvailable).not.toHaveBeenCalled();
  });

  it("get_available_models returns all from registry when no scope is set", async () => {
    const { session, run } = setup();
    const res = await run({ type: "get_available_models" });
    expect(res.success).toBe(true);
    expect(session.modelRegistry.getAvailable).toHaveBeenCalled();
    expect(res.data.models).toEqual([{ provider: "anthropic", id: "claude-x", name: "Claude X" }]);
  });

  it("get_available_models honors saved settings scope when session scope is empty", async () => {
    // The SDK starts every session with scopedModels: [] and never resolves
    // settingsManager.getEnabledModels() into it (only pi's CLI main.js does).
    // So a SAVED scope (save_scoped_models) must still narrow the dropdown on
    // a fresh session via this settings fallback.
    const { session, run } = setup({
      modelRegistry: {
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
    expect(session.modelRegistry.getAvailable).toHaveBeenCalled();
    expect(res.data.models).toEqual([{ provider: "anthropic", id: "claude-x", name: "Claude X" }]);
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
      modelRegistry: { getAvailable: vi.fn(async () => all) },
      settingsManager: {
        setEnabledModels: vi.fn(),
        getEnabledModels: vi.fn(() => ["anthropic/claude-x", "openai/gpt-5"]),
      },
    });
    const res = await run({ type: "get_available_models" });
    expect(res.data.models).toEqual(all);
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

  it("throws when a getState getter is absent", () => {
    const session = makeSession();
    delete session.thinkingLevel;
    const runtime = makeRuntime(session);
    expect(() => assertHostCapabilities(session, runtime)).toThrow(/session\.thinkingLevel/);
  });
});
