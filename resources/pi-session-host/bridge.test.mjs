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
    compact: vi.fn(async () => {}),
    getSessionStats: vi.fn(() => ({ tokens: { input: 1 } })),
    getLastAssistantText: vi.fn(() => "hi"),
    exportToHtml: vi.fn(async () => "/out.html"),
    getUserMessagesForForking: vi.fn(() => [{ entryId: "e1", text: "t" }]),
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
  const { handleCommand } = setupCommandBridge({
    runtime,
    session,
    uiContext: {},
    send,
    panelBridge,
  });
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
  return { session, runtime, send, panelBridge, run };
}

// ─── Wiring on setup ─────────────────────────────────────────────────────────

describe("setupCommandBridge — wiring", () => {
  it("subscribes to the session and registers rebind + before-invalidate", () => {
    const { session, runtime } = setup();
    expect(session.subscribe).toHaveBeenCalledTimes(1);
    expect(runtime.setRebindSession).toHaveBeenCalledTimes(1);
    expect(runtime.setBeforeSessionInvalidate).toHaveBeenCalledTimes(1);
  });

  it("forwards session events to main as {type:'event'}", () => {
    const { session, send } = setup();
    const subscriber = session.subscribe.mock.calls[0][0];
    subscriber({ type: "agent_start" });
    expect(send).toHaveBeenCalledWith({ type: "event", event: { type: "agent_start" } });
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
  it("get_state mirrors RpcSessionState (messageCount from messages.length)", async () => {
    const { run } = setup();
    const res = await run({ type: "get_state" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      thinkingLevel: "medium",
      sessionId: "sid-1",
      messageCount: 2,
      pendingMessageCount: 0,
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
