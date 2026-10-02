import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCurrentSystemMessage } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  createPiBuiltinExtensions,
  createSessionRuntimeOptionsResolver,
  createSessionRuntimeOverrideResolver,
  createTranscriptToolRestorationExtension,
  resolvePiDependency,
  resolveSessionRuntimeOptions,
  resolveSessionRuntimeOverrides,
  resolveTranscriptToolLoadout,
} from "./bootstrap.mjs";

describe("createPiBuiltinExtensions", () => {
  it("injects every Pi 1.0 built-in with CLI-equivalent settings semantics", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const llamaFactory = () => {};
    const llama = Object.freeze({ name: "llama.cpp", factory: llamaFactory, builtin: true });

    const extensions = createPiBuiltinExtensions(pi, llama);

    expect(extensions.map(({ name }) => name)).toEqual([
      "llama.cpp",
      "codemode",
      "tool-search",
      "mcp",
    ]);
    expect(extensions[0]).toBe(llama);
    for (const extension of extensions) {
      expect(extension).toMatchObject({ builtin: true, factory: expect.any(Function) });
      expect(Object.isFrozen(extension)).toBe(true);
    }
    expect(extensions.slice(1)).toEqual([
      expect.objectContaining({ name: "codemode", replaceable: true }),
      expect.objectContaining({ name: "tool-search", replaceable: true }),
      expect.objectContaining({ name: "mcp", replaceable: true }),
    ]);
    expect(Object.isFrozen(extensions)).toBe(true);
  });

  it("fails closed when the pinned public SDK omits a required built-in", () => {
    expect(() =>
      createPiBuiltinExtensions(
        {
          createCodemodeExtension: () => () => {},
          createToolSearchExtension: () => () => {},
        },
        undefined,
      ),
    ).toThrow(/missing the mcp built-in extension creator/);
  });
});

describe("transcript tool restoration", () => {
  const tool = (name, exposure = "direct") => ({ name, exposure });
  const managerWithMessages = (messages) => ({
    buildSessionContext: () => ({ messages }),
  });

  function makeExtensionApi(initialTools, initialActive, { acceptActive } = {}) {
    const handlers = new Map();
    let tools = [...initialTools];
    let active = [...initialActive];
    let setActiveCalls = 0;
    return {
      api: {
        getAllTools: () => tools,
        getActiveTools: () => active,
        setActiveTools: (names) => {
          setActiveCalls += 1;
          active = acceptActive ? names.filter(acceptActive) : [...names];
        },
        on: (event, handler) => handlers.set(event, handler),
      },
      emit: (event, value = {}) => handlers.get(event)?.(value, {}),
      getActive: () => active,
      getSetActiveCalls: () => setActiveCalls,
      setActive: (names) => {
        active = [...names];
      },
      setTools: (next) => {
        tools = [...next];
      },
    };
  }

  it("projects the current loadout without resurrecting stale prior-system tools", () => {
    const sessionManager = managerWithMessages([
      {
        role: "system",
        content: "",
        toolsAdded: [tool("read"), tool("tool_search")],
      },
      {
        role: "user",
        content: [],
        toolsRemoved: [tool("read")],
      },
      {
        role: "system",
        content: "",
        toolsRemoved: [tool("read")],
        toolsAdded: [tool("mcp__server__echo", "deferred")],
      },
    ]);

    const messages = sessionManager.buildSessionContext().messages;
    const publicCurrent = getCurrentSystemMessage(messages);
    expect(resolveTranscriptToolLoadout(sessionManager)).toEqual([
      "tool_search",
      "mcp__server__echo",
    ]);
    expect(resolveTranscriptToolLoadout(sessionManager)).toEqual(
      publicCurrent?.toolsAdded?.map((entry) => entry.name) ?? [],
    );
    expect(resolveTranscriptToolLoadout(managerWithMessages([{ role: "user", content: [] }]))).toBe(
      undefined,
    );
    expect(
      resolveTranscriptToolLoadout(
        managerWithMessages([{ role: "system", content: "", timestamp: 0 }]),
      ),
    ).toEqual([]);
  });

  it("restores connected tools immediately and adds a deferred tool before the next request", () => {
    const sessionManager = managerWithMessages([
      {
        role: "system",
        content: "",
        toolsAdded: [tool("read"), tool("mcp__server__echo", "deferred")],
      },
    ]);
    const fixture = makeExtensionApi(
      [tool("read"), tool("new-default"), tool("hidden", "hidden")],
      ["read", "new-default"],
    );
    createTranscriptToolRestorationExtension(sessionManager)(fixture.api);

    fixture.emit("session_start");
    expect(fixture.getActive()).toEqual(["read"]);

    fixture.setActive(["read", "additive-user-tool"]);
    fixture.setTools([
      tool("read"),
      tool("additive-user-tool"),
      tool("mcp__server__echo", "deferred"),
    ]);
    fixture.emit("before_agent_start");
    expect(fixture.getActive()).toEqual(["read", "additive-user-tool", "mcp__server__echo"]);
  });

  it("cancels pending restoration when a transcript-restored active tool is removed", () => {
    const sessionManager = managerWithMessages([
      {
        role: "system",
        content: "",
        toolsAdded: [tool("read"), tool("mcp__server__echo", "deferred")],
      },
    ]);
    const fixture = makeExtensionApi([tool("read")], ["read"]);
    createTranscriptToolRestorationExtension(sessionManager)(fixture.api);
    fixture.emit("session_start");

    fixture.setActive([]);
    fixture.setTools([tool("read"), tool("mcp__server__echo", "deferred")]);
    fixture.emit("before_agent_start");
    expect(fixture.getActive()).toEqual([]);
  });

  it("does not resurrect a deferred tool that reconnects after the first prompt boundary", () => {
    const sessionManager = managerWithMessages([
      {
        role: "system",
        content: "",
        toolsAdded: [tool("read"), tool("mcp__server__late", "deferred")],
      },
    ]);
    const fixture = makeExtensionApi([tool("read")], ["read"]);
    createTranscriptToolRestorationExtension(sessionManager)(fixture.api);
    fixture.emit("session_start", { reason: "resume" });

    fixture.emit("before_agent_start");
    expect(fixture.getActive()).toEqual(["read"]);

    fixture.setTools([tool("read"), tool("mcp__server__late", "deferred")]);
    fixture.emit("before_agent_start");
    expect(fixture.getActive()).toEqual(["read"]);
  });

  it("keeps pending deferred tools when policy rejects another requested tool", () => {
    const sessionManager = managerWithMessages([
      {
        role: "system",
        content: "",
        toolsAdded: [tool("allowed"), tool("excluded"), tool("mcp__server__echo", "deferred")],
      },
    ]);
    const fixture = makeExtensionApi([tool("allowed"), tool("excluded")], [], {
      acceptActive: (name) => name !== "excluded",
    });
    createTranscriptToolRestorationExtension(sessionManager)(fixture.api);

    fixture.emit("session_start", { reason: "resume" });
    expect(fixture.getActive()).toEqual(["allowed"]);

    fixture.setTools([tool("allowed"), tool("excluded"), tool("mcp__server__echo", "deferred")]);
    fixture.emit("before_agent_start");
    expect(fixture.getActive()).toEqual(["allowed", "mcp__server__echo"]);
  });

  it("leaves Pi's native active and pending loadout untouched on reload", () => {
    const sessionManager = managerWithMessages([
      {
        role: "system",
        content: "",
        toolsAdded: [tool("transcript-tool")],
      },
    ]);
    const fixture = makeExtensionApi(
      [tool("transcript-tool"), tool("new-default")],
      ["new-default"],
    );
    createTranscriptToolRestorationExtension(sessionManager)(fixture.api);

    fixture.emit("session_start", { reason: "reload" });
    expect(fixture.getActive()).toEqual(["new-default"]);
    expect(fixture.getSetActiveCalls()).toBe(0);

    fixture.emit("before_agent_start");
    expect(fixture.getActive()).toEqual(["new-default"]);
  });
});

/**
 * resolvePiDependency must find pi's deps in BOTH real-world layouts:
 *  - nested: pi-coding-agent/node_modules/<dep> (npm global/dev install,
 *    produced by pi's npm-shrinkwrap), and
 *  - hoisted: an ancestor node_modules/<dep> (electron-builder flattens the
 *    shrinkwrapped tree to the app's top-level node_modules at package time).
 * The nested-only version of this function broke every SDK-host start in the
 * packaged app (`npm run dist`) while `npm run dev` kept working.
 */
describe("resolvePiDependency", () => {
  let tmp;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function makePiInstall({ nestedDeps, hoistedDeps }) {
    // realpath: resolvePiDependency canonicalizes via realpathSync(piPath),
    // and macOS tmpdirs live behind the /var → /private/var symlink.
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pivis-bootstrap-")));
    const pkgDir = path.join(tmp, "node_modules", "@earendil-works", "pi-coding-agent");
    const cli = path.join(pkgDir, "dist", "cli.js");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, "// fake pi cli\n");
    for (const dep of nestedDeps) {
      const depFile = path.join(pkgDir, "node_modules", dep);
      mkdirSync(path.dirname(depFile), { recursive: true });
      writeFileSync(depFile, "// dep\n");
    }
    for (const dep of hoistedDeps) {
      const depFile = path.join(tmp, "node_modules", dep);
      mkdirSync(path.dirname(depFile), { recursive: true });
      writeFileSync(depFile, "// dep\n");
    }
    return { cli, pkgDir };
  }

  it("prefers the nested install (npm global/dev layout)", () => {
    const dep = path.join("@earendil-works", "pi-tui", "dist", "index.js");
    const { cli, pkgDir } = makePiInstall({ nestedDeps: [dep], hoistedDeps: [dep] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(pkgDir, "node_modules", dep));
  });

  it("falls back to a hoisted ancestor node_modules (packaged-app layout)", () => {
    const dep = path.join("undici", "index.js");
    const { cli } = makePiInstall({ nestedDeps: [], hoistedDeps: [dep] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(tmp, "node_modules", dep));
  });

  it("returns the nested path when the dep exists nowhere, so errors name the miss", () => {
    const dep = path.join("undici", "index.js");
    const { cli, pkgDir } = makePiInstall({ nestedDeps: [], hoistedDeps: [] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(pkgDir, "node_modules", dep));
  });
});

describe("resolveSessionRuntimeOverrides", () => {
  it("reads model and thinking metadata from a real zero-message Pi session", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessionRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pivis-session-model-")));
    try {
      const sessionDir = path.join(sessionRoot, "sessions");
      const sessionFile = path.join(sessionDir, "empty-session.jsonl");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(sessionFile, "");
      const created = SessionManager.open(sessionFile, sessionDir, sessionRoot);
      created.appendModelChange("provider-a", "model-a");
      created.appendThinkingLevelChange("high");
      const sessionManager = SessionManager.open(sessionFile, sessionDir);
      expect(sessionManager.buildSessionContext().messages).toEqual([]);

      const storedModel = { provider: "provider-a", id: "model-a" };
      expect(
        resolveSessionRuntimeOverrides(sessionManager, {
          getModel: () => storedModel,
          hasConfiguredAuth: () => true,
        }),
      ).toEqual({ model: storedModel, thinkingLevel: "high" });
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("preserves explicit model and thinking metadata on an empty active branch", () => {
    const storedModel = { provider: "provider-a", id: "model-a" };
    const sessionManager = {
      buildSessionContext: () => ({
        messages: [],
        model: { provider: "provider-a", modelId: "model-a" },
        thinkingLevel: "high",
      }),
      getBranch: () => [
        { type: "model_change", provider: "provider-a", modelId: "model-a" },
        { type: "thinking_level_change", thinkingLevel: "high" },
      ],
    };
    const modelRuntime = {
      getModel: (provider, modelId) =>
        provider === "provider-a" && modelId === "model-a" ? storedModel : undefined,
      hasConfiguredAuth: (provider) => provider === "provider-a",
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, modelRuntime, {
        model: { provider: "provider-b", modelId: "model-b" },
        thinkingLevel: "minimal",
      }),
    ).toEqual({
      model: storedModel,
      thinkingLevel: "high",
    });
  });

  it("uses the same-session authoritative selection when the branch has no metadata", () => {
    const resumedModel = { provider: "provider-a", id: "model-a" };
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    };
    const modelRuntime = {
      getModel: (provider, modelId) =>
        provider === "provider-a" && modelId === "model-a" ? resumedModel : undefined,
      hasConfiguredAuth: (provider) => provider === "provider-a",
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, modelRuntime, {
        model: { provider: "provider-a", modelId: "model-a" },
        thinkingLevel: "xhigh",
      }),
    ).toEqual({
      model: resumedModel,
      thinkingLevel: "xhigh",
    });
  });

  it("never carries an initial resume checkpoint through the reusable runtime factory", () => {
    const resumedModel = { provider: "provider-a", id: "model-a" };
    const metadataFreeSession = () => ({
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    });
    const modelRuntime = {
      getModel: (provider, modelId) =>
        provider === "provider-a" && modelId === "model-a" ? resumedModel : undefined,
      hasConfiguredAuth: (provider) => provider === "provider-a",
    };
    const resolveOverrides = createSessionRuntimeOverrideResolver({
      model: { provider: "provider-a", modelId: "model-a" },
      thinkingLevel: "xhigh",
    });

    expect(resolveOverrides(metadataFreeSession(), modelRuntime)).toEqual({
      model: resumedModel,
      thinkingLevel: "xhigh",
    });
    // Pi reuses this same factory closure for both /new and /resume. Neither
    // successor may inherit the checkpoint that belonged to the initial A.
    expect(resolveOverrides(metadataFreeSession(), modelRuntime)).toEqual({});
    expect(resolveOverrides(metadataFreeSession(), modelRuntime)).toEqual({});
  });

  it("ignores malformed same-session fallback values", () => {
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    };
    const modelRuntime = {
      getModel: () => {
        throw new Error("invalid fallback models must not be resolved");
      },
      hasConfiguredAuth: () => {
        throw new Error("invalid fallback models must not inspect auth");
      },
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, modelRuntime, {
        model: { provider: "", modelId: "model-a" },
        thinkingLevel: "extreme",
      }),
    ).toEqual({});
  });

  it("keeps a known no-model checkpoint distinct without resolving a model", () => {
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    };
    const modelRuntime = {
      getModel: () => {
        throw new Error("a null model checkpoint must not resolve a model");
      },
      hasConfiguredAuth: () => {
        throw new Error("a null model checkpoint must not inspect auth");
      },
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, modelRuntime, {
        model: null,
        thinkingLevel: "low",
      }),
    ).toEqual({ thinkingLevel: "low" });
  });

  it("leaves brand-new sessions on Pi's settings defaults", () => {
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    };
    const modelRuntime = {
      getModel: () => {
        throw new Error("new sessions must not resolve a stored model");
      },
      hasConfiguredAuth: () => {
        throw new Error("new sessions must not inspect stored-model auth");
      },
    };

    expect(resolveSessionRuntimeOverrides(sessionManager, modelRuntime)).toEqual({});
  });

  it("keeps Pi's model fallback when the stored model is unavailable or unauthenticated", () => {
    const sessionManager = {
      buildSessionContext: () => ({
        messages: [],
        model: { provider: "provider-a", modelId: "missing" },
        thinkingLevel: "low",
      }),
      getBranch: () => [{ type: "thinking_level_change", thinkingLevel: "low" }],
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, {
        getModel: () => undefined,
        hasConfiguredAuth: () => true,
      }),
    ).toEqual({ thinkingLevel: "low" });

    expect(
      resolveSessionRuntimeOverrides(sessionManager, {
        getModel: () => ({ provider: "provider-a", id: "missing" }),
        hasConfiguredAuth: () => false,
      }),
    ).toEqual({ thinkingLevel: "low" });
  });
});

describe("resolveSessionRuntimeOptions", () => {
  const modelA = { provider: "provider-a", id: "model-a" };
  const modelB = { provider: "provider-b", id: "model-b" };
  const modelC = { provider: "provider-c", id: "model-c" };

  function sessionManager({
    messages = [],
    model = null,
    thinkingLevel = "off",
    branch = [],
  } = {}) {
    return {
      buildSessionContext: () => ({ messages, model, thinkingLevel }),
      getBranch: () => branch,
    };
  }

  function settings({ enabledModels, defaultProvider, defaultModel } = {}) {
    return {
      getEnabledModels: () => enabledModels,
      getDefaultProvider: () => defaultProvider,
      getDefaultModel: () => defaultModel,
    };
  }

  function modelRuntime(models = [modelA, modelB, modelC]) {
    return {
      getModel: (provider, modelId) =>
        models.find((model) => model.provider === provider && model.id === modelId),
      hasConfiguredAuth: () => true,
    };
  }

  it("resolves saved scope and chooses the saved default when it is in scope", async () => {
    const scopedModels = [
      { model: modelA, thinkingLevel: "high" },
      { model: modelB, thinkingLevel: "low" },
    ];
    const diagnostic = {
      type: "warning",
      code: "no-match",
      message: "No models match pattern missing",
      pattern: "missing",
    };
    const calls = [];
    const runtime = modelRuntime();
    const result = await resolveSessionRuntimeOptions({
      sessionManager: sessionManager(),
      settingsManager: settings({
        enabledModels: ["provider-a/model-a:high", "provider-b/model-b:low"],
        defaultProvider: "provider-b",
        defaultModel: "model-b",
      }),
      modelRuntime: runtime,
      resolveModelScopeWithDiagnostics: async (patterns, receivedRuntime) => {
        calls.push({ patterns, receivedRuntime });
        return { scopedModels, diagnostics: [diagnostic] };
      },
    });

    expect(calls).toEqual([
      {
        patterns: ["provider-a/model-a:high", "provider-b/model-b:low"],
        receivedRuntime: runtime,
      },
    ]);
    expect(result).toEqual({
      sessionOptions: { scopedModels, model: modelB, thinkingLevel: "low" },
      diagnostics: [diagnostic],
    });
  });

  it("chooses the first scoped model and keeps a configured all-model scope intact", async () => {
    const scopedModels = [{ model: modelA, thinkingLevel: "high" }, { model: modelB }];
    const result = await resolveSessionRuntimeOptions({
      sessionManager: sessionManager(),
      settingsManager: settings({
        enabledModels: ["provider-*/*"],
        defaultProvider: "provider-c",
        defaultModel: "model-c",
      }),
      modelRuntime: modelRuntime(),
      resolveModelScopeWithDiagnostics: async () => ({ scopedModels, diagnostics: [] }),
    });

    expect(result.sessionOptions).toEqual({
      scopedModels,
      model: modelA,
      thinkingLevel: "high",
    });
  });

  it("passes an empty scope without invoking the resolver when no setting exists", async () => {
    let called = false;
    const result = await resolveSessionRuntimeOptions({
      sessionManager: sessionManager(),
      settingsManager: settings(),
      modelRuntime: modelRuntime(),
      resolveModelScopeWithDiagnostics: async () => {
        called = true;
        throw new Error("an absent scope must not be resolved");
      },
    });

    expect(called).toBe(false);
    expect(result).toEqual({ sessionOptions: { scopedModels: [] }, diagnostics: [] });
  });

  it("reports a no-match scope without forcing an initial model", async () => {
    const diagnostics = [
      {
        type: "warning",
        code: "no-match",
        message: 'No models match pattern "missing"',
        pattern: "missing",
      },
    ];
    const result = await resolveSessionRuntimeOptions({
      sessionManager: sessionManager(),
      settingsManager: settings({ enabledModels: ["missing"] }),
      modelRuntime: modelRuntime(),
      resolveModelScopeWithDiagnostics: async () => ({ scopedModels: [], diagnostics }),
    });

    expect(result).toEqual({ sessionOptions: { scopedModels: [] }, diagnostics });
  });

  it("passes scope to continuing sessions without replacing their restored model selection", async () => {
    const scopedModels = [{ model: modelA }];
    const result = await resolveSessionRuntimeOptions({
      sessionManager: sessionManager({ messages: [{ role: "user" }] }),
      settingsManager: settings({ enabledModels: ["provider-a/model-a"] }),
      modelRuntime: modelRuntime(),
      resolveModelScopeWithDiagnostics: async () => ({ scopedModels, diagnostics: [] }),
    });

    expect(result.sessionOptions).toEqual({ scopedModels });
  });

  it("keeps zero-message persisted model and thinking metadata ahead of scope defaults", async () => {
    const scopedModels = [{ model: modelA, thinkingLevel: "high" }];
    const result = await resolveSessionRuntimeOptions({
      sessionManager: sessionManager({
        model: { provider: "provider-c", modelId: "model-c" },
        thinkingLevel: "xhigh",
        branch: [
          { type: "model_change", provider: "provider-c", modelId: "model-c" },
          { type: "thinking_level_change", thinkingLevel: "xhigh" },
        ],
      }),
      settingsManager: settings({ enabledModels: ["provider-a/model-a:high"] }),
      modelRuntime: modelRuntime(),
      resolveModelScopeWithDiagnostics: async () => ({ scopedModels, diagnostics: [] }),
    });

    expect(result.sessionOptions).toEqual({
      scopedModels,
      model: modelC,
      thinkingLevel: "xhigh",
    });
  });

  it("lets a null resume model use saved scope while retaining resume thinking", async () => {
    const scopedModels = [{ model: modelA, thinkingLevel: "high" }];
    const result = await resolveSessionRuntimeOptions({
      sessionManager: sessionManager(),
      settingsManager: settings({ enabledModels: ["provider-a/model-a:high"] }),
      modelRuntime: modelRuntime(),
      resolveModelScopeWithDiagnostics: async () => ({ scopedModels, diagnostics: [] }),
      runtimeResumeState: { model: null, thinkingLevel: "low" },
    });

    expect(result).toEqual({
      sessionOptions: { scopedModels, model: modelA, thinkingLevel: "low" },
      diagnostics: [],
    });
  });

  it("consumes resume selection once while resolving saved scope for every factory run", async () => {
    const scopedModels = [{ model: modelA, thinkingLevel: "high" }];
    let scopeCalls = 0;
    const resolveOptions = createSessionRuntimeOptionsResolver(
      async () => {
        scopeCalls += 1;
        return { scopedModels, diagnostics: [] };
      },
      {
        model: { provider: "provider-b", modelId: "model-b" },
        thinkingLevel: "low",
      },
    );
    const runtime = modelRuntime();
    const configuredSettings = settings({ enabledModels: ["provider-a/model-a:high"] });

    await expect(resolveOptions(sessionManager(), configuredSettings, runtime)).resolves.toEqual({
      sessionOptions: { scopedModels, model: modelB, thinkingLevel: "low" },
      diagnostics: [],
    });
    await expect(resolveOptions(sessionManager(), configuredSettings, runtime)).resolves.toEqual({
      sessionOptions: { scopedModels, model: modelA, thinkingLevel: "high" },
      diagnostics: [],
    });
    expect(scopeCalls).toBe(2);
  });
});
