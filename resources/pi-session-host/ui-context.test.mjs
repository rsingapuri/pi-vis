import * as fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { applyTuiRuntimeSettings, createDialogResolver, createUIContext } from "./ui-context.mjs";

// The host's ExtensionUIContext must hand extensions the SAME return values pi's
// own uiContext does, or extension menu code breaks. The canonical contract
// (verified against pi-mcp-adapter + pi-subagents usage):
//   select → string  (the chosen option) | undefined (cancel)
//   confirm → boolean
//   input  → string | undefined (cancel)
//   editor → string | undefined (cancel)
// The bug this guards: createDialog resolves with the raw ExtensionUiResponse
// object ({type,id,value}), so the host was returning the OBJECT. pi-subagents
// does `choice.startsWith("Running agents (")` → TypeError on an object → the
// `/agents` handler dies before opening any submenu (e.g. Settings).

/** Build a uiContext whose createDialog resolves with a fixed wire response. */
function ctxWithDialog(response) {
  return createUIContext({
    theme: { fg: () => "" },
    panelBridge: {},
    createDialog: vi.fn(async () => response),
    sendToMain: vi.fn(),
    tuiModules: {},
  }).context;
}

describe("createDialogResolver", () => {
  it("assigns unique ids to same-method dialogs created in the same tick", async () => {
    const sent = [];
    const resolver = createDialogResolver((msg) => sent.push(msg));

    const first = resolver.createDialog("select", "First");
    const second = resolver.createDialog("select", "Second");

    expect(sent).toHaveLength(2);
    expect(sent[0].id).not.toBe(sent[1].id);

    resolver.resolve({ type: "extension_ui_response", id: sent[1].id, value: "second" });
    resolver.resolve({ type: "extension_ui_response", id: sent[0].id, value: "first" });

    await expect(first).resolves.toMatchObject({ value: "first" });
    await expect(second).resolves.toMatchObject({ value: "second" });
  });

  it("keeps one provider-auth surface while resolving secret prompts without replaying values", async () => {
    const sent = [];
    const acknowledged = [];
    const controller = new AbortController();
    const resolver = createDialogResolver(
      (message) => sent.push(message),
      (operationId) => acknowledged.push(operationId),
    );
    const surface = resolver.createProviderAuthSurface(
      "Dynamic Provider",
      "api_key",
      controller.signal,
      () => controller.abort(),
    );

    surface.interaction.notify({ type: "progress", message: "Preparing" });
    const prompt = surface.interaction.prompt({
      type: "secret",
      message: "API key",
      placeholder: "sk-…",
    });
    const current = resolver.pendingSnapshot(3)[0].request;
    expect(current).toMatchObject({
      method: "providerAuth",
      phase: "prompt",
      promptType: "secret",
      prompt: "API key",
    });

    resolver.resolve({ type: "extension_ui_response", id: current.id, value: "secret-value" });
    await expect(prompt).resolves.toBe("secret-value");
    const snapshot = resolver.pendingSnapshot(3);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].request.phase).toBe("waiting");
    expect(JSON.stringify(snapshot)).not.toContain("secret-value");
    expect(acknowledged).toContain(current.operationId);

    surface.complete();
    expect(resolver.pendingCount).toBe(0);
    expect(acknowledged).toContain(current.id);
  });

  it("keeps a committed-login synchronization warning visible without retaining credentials", () => {
    const controller = new AbortController();
    const resolver = createDialogResolver(() => {});
    const surface = resolver.createProviderAuthSurface(
      "Dynamic Provider",
      "api_key",
      controller.signal,
      () => controller.abort(),
    );

    surface.warn();

    const snapshot = resolver.pendingSnapshot()[0].request;
    expect(snapshot).toMatchObject({
      method: "providerAuth",
      phase: "warning",
      message: expect.stringContaining("Sign-in was saved"),
    });
    expect(snapshot).not.toHaveProperty("credential");
    expect(snapshot).not.toHaveProperty("error");
    expect(resolver.pendingCount).toBe(1);
  });

  it("keeps OAuth launch details on a subsequent manual-code prompt revision", async () => {
    const sent = [];
    const controller = new AbortController();
    const resolver = createDialogResolver((message) => sent.push(message));
    const surface = resolver.createProviderAuthSurface(
      "OpenRouter",
      "oauth",
      controller.signal,
      () => controller.abort(),
    );
    const authUrl =
      "https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A49152%2Foauth%2Fcallback";
    const instructions =
      "Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.";

    surface.interaction.notify({ type: "auth_url", url: authUrl, instructions });
    const oauthRequest = resolver.pendingSnapshot()[0].request;
    expect(oauthRequest).toMatchObject({
      method: "providerAuth",
      phase: "oauth",
      authUrl,
      message: instructions,
    });

    const prompt = surface.interaction.prompt({
      type: "manual_code",
      message:
        "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
      placeholder: "http://127.0.0.1:49152/oauth/callback",
    });
    const promptRequest = resolver.pendingSnapshot()[0].request;
    expect(promptRequest).toMatchObject({
      id: oauthRequest.id,
      method: "providerAuth",
      phase: "prompt",
      promptType: "manual_code",
      prompt:
        "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
      placeholder: "http://127.0.0.1:49152/oauth/callback",
      authUrl,
      message: instructions,
    });
    expect(promptRequest.operationId).not.toBe(oauthRequest.operationId);

    resolver.resolve({
      type: "extension_ui_response",
      id: promptRequest.id,
      operationId: promptRequest.operationId,
      value: "http://127.0.0.1:49152/oauth/callback?code=manual-code",
    });
    await expect(prompt).resolves.toContain("code=manual-code");
    expect(JSON.stringify(resolver.pendingSnapshot())).not.toContain("manual-code");

    surface.complete();
    expect(resolver.pendingCount).toBe(0);
  });

  it("supports Anthropic copy-code select → auth-url → manual-code without retaining responses", async () => {
    const sent = [];
    const acknowledged = [];
    const controller = new AbortController();
    const resolver = createDialogResolver(
      (message) => sent.push(message),
      (operationId) => acknowledged.push(operationId),
    );
    const surface = resolver.createProviderAuthSurface(
      "Anthropic",
      "oauth",
      controller.signal,
      () => controller.abort(),
    );

    const loginMethod = surface.interaction.prompt({
      type: "select",
      message: "Choose how to sign in",
      options: [
        { id: "browser", label: "Browser login", description: "Open a browser" },
        { id: "copy_code", label: "Copy code login", description: "Use a headless flow" },
      ],
    });
    const selectRequest = resolver.pendingSnapshot()[0].request;
    expect(selectRequest).toMatchObject({
      method: "providerAuth",
      providerName: "Anthropic",
      phase: "prompt",
      promptType: "select",
      options: [
        { id: "browser", label: "Browser login", description: "Open a browser" },
        { id: "copy_code", label: "Copy code login", description: "Use a headless flow" },
      ],
    });

    resolver.resolve({
      type: "extension_ui_response",
      id: selectRequest.id,
      operationId: selectRequest.operationId,
      value: "copy_code",
    });
    await expect(loginMethod).resolves.toBe("copy_code");
    expect(JSON.stringify(resolver.pendingSnapshot())).not.toContain("copy_code");

    const authUrl = "https://claude.ai/oauth/authorize?state=anthropic-state";
    surface.interaction.notify({
      type: "auth_url",
      url: authUrl,
      instructions: "Open this URL on any device, then paste the code here.",
    });
    const oauthRequest = resolver.pendingSnapshot()[0].request;
    expect(oauthRequest).toMatchObject({
      id: selectRequest.id,
      method: "providerAuth",
      phase: "oauth",
      authUrl,
    });
    expect(oauthRequest.operationId).not.toBe(selectRequest.operationId);

    const manualCode = surface.interaction.prompt({
      type: "manual_code",
      message: "Paste the authorization code",
      placeholder: "code#state",
    });
    const codeRequest = resolver.pendingSnapshot()[0].request;
    expect(codeRequest).toMatchObject({
      id: selectRequest.id,
      phase: "prompt",
      promptType: "manual_code",
      placeholder: "code#state",
      authUrl,
    });
    expect(codeRequest.operationId).not.toBe(oauthRequest.operationId);

    const credential = "anthropic-code#anthropic-state";
    resolver.resolve({
      type: "extension_ui_response",
      id: codeRequest.id,
      operationId: codeRequest.operationId,
      value: credential,
    });
    await expect(manualCode).resolves.toBe(credential);
    expect(JSON.stringify(resolver.pendingSnapshot())).not.toContain(credential);
    expect(JSON.stringify(sent)).not.toContain(credential);
    expect(acknowledged).toEqual(
      expect.arrayContaining([selectRequest.operationId, codeRequest.operationId]),
    );

    surface.complete();
    expect(resolver.pendingCount).toBe(0);
  });

  it("cancels an Anthropic copy-code manual prompt without accepting stale revisions", async () => {
    const sent = [];
    const acknowledged = [];
    const controller = new AbortController();
    const onCancel = vi.fn(() => controller.abort());
    const resolver = createDialogResolver(
      (message) => sent.push(message),
      (operationId) => acknowledged.push(operationId),
    );
    const surface = resolver.createProviderAuthSurface(
      "Anthropic",
      "oauth",
      controller.signal,
      onCancel,
    );

    const loginMethod = surface.interaction.prompt({
      type: "select",
      message: "Choose how to sign in",
      options: [
        { id: "browser", label: "Browser login" },
        { id: "copy_code", label: "Copy code login" },
      ],
    });
    const selectRequest = resolver.pendingSnapshot()[0].request;
    resolver.resolve({
      type: "extension_ui_response",
      id: selectRequest.id,
      operationId: selectRequest.operationId,
      value: "copy_code",
    });
    await expect(loginMethod).resolves.toBe("copy_code");

    surface.interaction.notify({
      type: "auth_url",
      url: "https://claude.ai/oauth/authorize?state=cancel-state",
    });
    const oauthRequest = resolver.pendingSnapshot()[0].request;
    const manualCode = surface.interaction.prompt({
      type: "manual_code",
      message: "Paste the authorization code",
    });
    const codeRequest = resolver.pendingSnapshot()[0].request;

    resolver.resolve({
      type: "extension_ui_response",
      id: codeRequest.id,
      operationId: oauthRequest.operationId,
      value: "stale-secret#cancel-state",
    });
    expect(resolver.pendingSnapshot()[0].request.operationId).toBe(codeRequest.operationId);
    expect(JSON.stringify(resolver.pendingSnapshot())).not.toContain("stale-secret");

    resolver.resolve({
      type: "extension_ui_response",
      id: codeRequest.id,
      operationId: codeRequest.operationId,
      cancelled: true,
    });
    await expect(manualCode).rejects.toThrow("Login cancelled");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(resolver.pendingCount).toBe(0);
    expect(JSON.stringify(sent)).not.toContain("stale-secret");
    expect(acknowledged).toContain(oauthRequest.operationId);
  });

  it("cancels a provider-auth surface and its pending prompt once", async () => {
    const sent = [];
    const controller = new AbortController();
    const onCancel = vi.fn(() => controller.abort());
    const resolver = createDialogResolver((message) => sent.push(message));
    const surface = resolver.createProviderAuthSurface(
      "Dynamic Provider",
      "oauth",
      controller.signal,
      onCancel,
    );
    const prompt = surface.interaction.prompt({ type: "manual_code", message: "Paste code" });
    const request = resolver.pendingSnapshot()[0].request;

    resolver.resolve({ type: "extension_ui_response", id: request.id, cancelled: true });
    await expect(prompt).rejects.toThrow("Login cancelled");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(resolver.pendingCount).toBe(0);
  });

  it("offers Radius MCP setup without turning dismissal into a failed login", async () => {
    const controller = new AbortController();
    const onCancel = vi.fn(() => controller.abort());
    const resolver = createDialogResolver(() => {});
    const surface = resolver.createProviderAuthSurface(
      "Radius",
      "oauth",
      controller.signal,
      onCancel,
    );
    const confirmation = surface.confirmRadiusMcp("/agent/mcp.json");
    const request = resolver.pendingSnapshot()[0].request;

    expect(request).toMatchObject({
      method: "providerAuth",
      phase: "prompt",
      promptType: "select",
      prompt: "Configure Radius MCP in /agent/mcp.json?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    });
    resolver.resolve({
      type: "extension_ui_response",
      id: request.id,
      operationId: request.operationId,
      cancelled: true,
    });

    await expect(confirmation).resolves.toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(resolver.pendingSnapshot()[0].request.phase).toBe("waiting");
    surface.complete();
    expect(resolver.pendingCount).toBe(0);
  });
});

describe("uiContext dialog return-value contract", () => {
  it("select returns the chosen option STRING (not the response object)", async () => {
    const ui = ctxWithDialog({ type: "extension_ui_response", id: "s1", value: "Settings" });
    const choice = await ui.select("Agents", ["Settings"]);
    expect(choice).toBe("Settings");
    // The exact thing pi-subagents does — must not throw on the result.
    expect(typeof choice.startsWith).toBe("function");
  });

  it("select returns undefined on cancel (pi-mcp-adapter checks === undefined)", async () => {
    const ui = ctxWithDialog({ type: "extension_ui_response", id: "s1", cancelled: true });
    expect(await ui.select("Agents", ["a"])).toBeUndefined();
  });

  it("confirm returns a boolean true on confirm, false on cancel", async () => {
    expect(
      await ctxWithDialog({ type: "extension_ui_response", id: "c", confirmed: true }).confirm(
        "ok?",
      ),
    ).toBe(true);
    expect(
      await ctxWithDialog({ type: "extension_ui_response", id: "c", cancelled: true }).confirm(
        "ok?",
      ),
    ).toBe(false);
  });

  it("input returns the typed string, or undefined on cancel", async () => {
    expect(
      await ctxWithDialog({ type: "extension_ui_response", id: "i", value: "42" }).input("n"),
    ).toBe("42");
    expect(
      await ctxWithDialog({ type: "extension_ui_response", id: "i", cancelled: true }).input("n"),
    ).toBeUndefined();
  });

  it("editor returns the edited string, or undefined on cancel", async () => {
    expect(
      await ctxWithDialog({ type: "extension_ui_response", id: "e", value: "body" }).editor("t"),
    ).toBe("body");
    expect(
      await ctxWithDialog({ type: "extension_ui_response", id: "e", cancelled: true }).editor("t"),
    ).toBeUndefined();
  });

  it("registers dialog custody with the lifecycle UI tracker", async () => {
    const trackBlockingUi = vi.fn((promise) => promise);
    const ui = createUIContext({
      theme: {},
      panelBridge: {},
      createDialog: vi.fn(async () => ({ value: "tracked" })),
      sendToMain: vi.fn(),
      trackBlockingUi,
      tuiModules: {},
    }).context;

    await expect(ui.input("Tracked")).resolves.toBe("tracked");
    expect(trackBlockingUi).toHaveBeenCalledTimes(1);
  });

  it("passes the right method + args through to createDialog", async () => {
    const createDialog = vi.fn(async () => ({ value: "x" }));
    const ui = createUIContext({
      theme: {},
      panelBridge: {},
      createDialog,
      sendToMain: vi.fn(),
      tuiModules: {},
    }).context;
    await ui.select("Pick", ["x", "y"], { timeout: 5 });
    expect(createDialog).toHaveBeenCalledWith("select", "Pick", {
      options: ["x", "y"],
      opts: { timeout: 5 },
    });
  });
});

describe("uiContext fire-and-forget + no-op methods", () => {
  it("notify/setStatus/setTitle/setWidget route to sendToMain without throwing", () => {
    const sendToMain = vi.fn();
    const ui = createUIContext({
      theme: {},
      panelBridge: {},
      createDialog: vi.fn(),
      sendToMain,
      tuiModules: {},
    }).context;
    ui.notify("hi", "info");
    ui.setStatus("k", "v");
    ui.setTitle("T");
    ui.setWidget("w", ["line"]);
    expect(sendToMain).toHaveBeenCalledTimes(4);
    expect(sendToMain.mock.calls[0][0]).toMatchObject({ method: "notify", message: "hi" });
  });

  it("TUI-only methods are safe no-ops (must not throw)", () => {
    const ui = createUIContext({
      theme: {},
      panelBridge: {},
      createDialog: vi.fn(),
      sendToMain: vi.fn(),
      tuiModules: {},
    }).context;
    expect(() => {
      ui.setFooter(() => {});
      ui.setHeader(() => {});
      ui.setWorkingIndicator({});
      ui.setEditorComponent(() => {});
      ui.getToolsExpanded();
      const dispose = ui.onTerminalInput(() => {});
      dispose();
    }).not.toThrow();
  });
});

// ─── Unified-TUI harness ──────────────────────────────────────────────────────
//
// Fakes for the pi-tui modules. ensureUnifiedTui() builds a main-screen
// TUI/Editor/layout from these; we capture the instances and control
// KeybindingsManager.matches so the submit/clipboard/paste logic can be driven
// deterministically without a real pi-tui render loop.

/** A 1×1 PNG (base64) so resolveClipboardImage writes valid bytes to a temp file. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeHarness(tuiModuleOverrides = {}, tuiConfig = {}) {
  const sendToMain = vi.fn();
  let panelCounter = 0;
  const panelBridge = {
    openPanel: vi.fn(() => ++panelCounter),
    closePanel: vi.fn(),
    setPanelMode: vi.fn(),
    setInputHandler: vi.fn(),
    clearInputHandler: vi.fn(),
    setInputFence: vi.fn(),
    clearInputFence: vi.fn(),
    writePanel: vi.fn(),
    setResizeHandler: vi.fn(),
    setCanceller: vi.fn(),
    cancel: vi.fn(),
  };

  const tuis = [];
  class FakeTuiMainScreen {
    constructor(terminal, showHardwareCursor, logDirectory) {
      this.terminal = terminal;
      this.showHardwareCursor = showHardwareCursor;
      this.logDirectory = logDirectory;
      this.clearOnShrink = undefined;
      this.children = [];
      this.inputListeners = new Set();
      this.stopped = false;
      this.overlayShown = null;
      this.focused = null;
      tuis.push(this);
    }
    start() {}
    stop() {
      this.stopped = true;
    }
    requestRender() {}
    setClearOnShrink(enabled) {
      this.clearOnShrink = enabled;
    }
    setFocus(c) {
      this.focused = c;
    }
    addInputListener(h) {
      this.inputListeners.add(h);
      return () => this.inputListeners.delete(h);
    }
    showOverlay(c) {
      this.overlayShown = c;
      return {
        hide: () => {
          this.overlayShown = null;
        },
        setHidden() {},
        isHidden() {
          return false;
        },
        focus() {},
        unfocus() {},
        isFocused() {
          return false;
        },
      };
    }
    hideOverlay() {
      this.overlayShown = null;
    }
  }

  class FakeContainer {
    constructor() {
      this.children = [];
    }
    addChild(c) {
      this.children.push(c);
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
    }
  }

  // A single shared editor instance (ensureUnifiedTui creates exactly one).
  const editor = {
    onSubmit: null,
    setText: vi.fn(),
    getText: vi.fn(() => ""),
    getExpandedText: vi.fn(() => ""),
    insertTextAtCursor: vi.fn(),
    handleInput: vi.fn(),
    dispose: vi.fn(),
  };
  const Editor = vi.fn(() => editor);

  const matches = vi.fn(() => false);
  const KeybindingsManager = vi.fn(() => ({ matches }));

  const tuiModules = {
    TuiMainScreen: FakeTuiMainScreen,
    Container: FakeContainer,
    Editor,
    KeybindingsManager,
    TUI_KEYBINDINGS: {},
    visibleWidth: (text) => text.length,
    truncateToWidth: (text, width, ellipsis = "...") =>
      text.length <= width
        ? text
        : `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis.slice(0, width)}`,
    ...tuiModuleOverrides,
  };

  const bundle = createUIContext({
    theme: { fg: () => "" },
    panelBridge,
    createDialog: vi.fn(),
    sendToMain,
    tuiModules,
    tuiConfig,
  });

  return {
    bundle,
    context: bundle.context,
    unified: bundle.unified,
    sendToMain,
    panelBridge,
    get tui() {
      return tuis[tuis.length - 1];
    },
    editor,
    setKbMatches: (fn) => {
      matches.mockImplementation(fn);
    },
  };
}

/** A factory returning a disposable widget component, like fleet-list does. */
function makeFactory(label = "widget") {
  const component = { render: () => [label], dispose: vi.fn(), invalidate: vi.fn() };
  const factory = vi.fn(() => component);
  factory.component = component;
  return factory;
}

function renderedWidgetLines(container) {
  return container.children.flatMap((component) => component.render(80));
}

/** Pull the id from the most recent unified_submit_request sendToMain call. */
function lastSubmitId(sendToMain) {
  return lastSubmitRequest(sendToMain).id;
}

/** Pull the most recent unified_submit_request sent to main. */
function lastSubmitRequest(sendToMain) {
  const reqs = sendToMain.mock.calls
    .map((c) => c[0])
    .filter((m) => m.type === "unified_submit_request");
  return reqs[reqs.length - 1];
}

/** Pull the id from the most recent clipboard_read_image_request sendToMain call. */
function lastClipboardId(sendToMain) {
  const reqs = sendToMain.mock.calls
    .map((c) => c[0])
    .filter((m) => m.type === "clipboard_read_image_request");
  return reqs[reqs.length - 1].id;
}

describe("unified TUI: terminal paint publication", () => {
  it("publishes a synchronous frame and cursor-position tail as one panel delta", async () => {
    const h = makeHarness();
    h.context.setWidget("roster", makeFactory("fleet"), { placement: "belowEditor" });

    h.tui.terminal.write("frame-with-trailing-blanks\r\n\r\n");
    h.tui.terminal.write("\x1b[2A\x1b[1G");
    h.tui.terminal.hideCursor();

    // A logical pi-tui paint is not observable halfway through, while its
    // hardware cursor still sits on the final blank row.
    expect(h.panelBridge.writePanel).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(h.panelBridge.writePanel).toHaveBeenCalledTimes(1);
    expect(h.panelBridge.writePanel).toHaveBeenCalledWith(
      1,
      "frame-with-trailing-blanks\r\n\r\n\x1b[2A\x1b[1G\x1b[?25l",
    );

    // Independent turns remain independent publications.
    h.tui.terminal.write("later-frame");
    await Promise.resolve();
    expect(h.panelBridge.writePanel).toHaveBeenLastCalledWith(1, "later-frame");
    expect(h.panelBridge.writePanel).toHaveBeenCalledTimes(2);
  });
});

describe("pi-tui 0.85 explicit main-screen configuration", () => {
  it("refreshes public settings and terminal capability overrides on every runtime bind", () => {
    const piTui = { setCapabilityOverrides: vi.fn() };
    const tuiConfig = {};
    const firstSettings = {
      getShowHardwareCursor: vi.fn(() => true),
      getClearOnShrink: vi.fn(() => false),
      getTerminalCapabilityOverrides: vi.fn(() => ({ images: "kitty" })),
    };
    const secondSettings = {
      getShowHardwareCursor: vi.fn(() => false),
      getClearOnShrink: vi.fn(() => true),
      getTerminalCapabilityOverrides: vi.fn(() => ({ images: undefined })),
    };

    expect(applyTuiRuntimeSettings(piTui, firstSettings, "/agent/one", tuiConfig)).toBe(tuiConfig);
    expect(tuiConfig).toEqual({
      showHardwareCursor: true,
      clearOnShrink: false,
      logDirectory: "/agent/one",
    });
    expect(piTui.setCapabilityOverrides).toHaveBeenLastCalledWith({ images: "kitty" });

    applyTuiRuntimeSettings(piTui, secondSettings, "/agent/two", tuiConfig);
    expect(tuiConfig).toEqual({
      showHardwareCursor: false,
      clearOnShrink: true,
      logDirectory: "/agent/two",
    });
    expect(piTui.setCapabilityOverrides).toHaveBeenLastCalledWith({ images: undefined });
    expect(piTui.setCapabilityOverrides).toHaveBeenCalledTimes(2);
  });

  it("applies cursor, log, and shrink settings at the unified construction site", () => {
    const h = makeHarness(
      {},
      {
        showHardwareCursor: true,
        clearOnShrink: true,
        logDirectory: "/tmp/pivis-tui-logs",
      },
    );

    h.context.setWidget("configured", makeFactory());

    expect(h.tui.showHardwareCursor).toBe(true);
    expect(h.tui.logDirectory).toBe("/tmp/pivis-tui-logs");
    expect(h.tui.clearOnShrink).toBe(true);
  });

  it("applies cursor, log, and shrink settings at the standalone custom construction site", async () => {
    const h = makeHarness(
      {},
      {
        showHardwareCursor: false,
        clearOnShrink: true,
        logDirectory: "/tmp/pivis-standalone-tui-logs",
      },
    );
    let done;
    const custom = h.context.custom((_tui, _theme, _keybindings, finish) => {
      done = finish;
      return { render: () => [], dispose() {} };
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.tui.showHardwareCursor).toBe(false);
    expect(h.tui.logDirectory).toBe("/tmp/pivis-standalone-tui-logs");
    expect(h.tui.clearOnShrink).toBe(true);

    done(undefined);
    await custom;
  });
});

describe("unified TUI: setWidget factory routing", () => {
  it("a factory setWidget opens a unified panel and adds the component below the editor", () => {
    const h = makeHarness();
    const factory = makeFactory("fleet");
    h.context.setWidget("roster", factory, { placement: "belowEditor" });

    expect(h.panelBridge.openPanel).toHaveBeenCalledWith({ overlay: false, unified: true });
    expect(factory).toHaveBeenCalledWith(h.tui, expect.anything());
    // layout: [widgetAbove, editorContainer, widgetBelow]
    const below = h.tui.children[2];
    expect(renderedWidgetLines(below)).toContain("fleet");
    // the editor is focused
    expect(h.tui.focused).toBe(h.editor);
    // NOT routed through the static-string setWidget path
    expect(h.sendToMain).not.toHaveBeenCalledWith(expect.objectContaining({ method: "setWidget" }));
  });

  it("default placement (no options) matches pi and is aboveEditor", () => {
    const h = makeHarness();
    const factory = makeFactory();
    h.context.setWidget("k", factory);
    expect(renderedWidgetLines(h.tui.children[0])).toContain("widget");
    expect(renderedWidgetLines(h.tui.children[2])).not.toContain("widget");
  });

  it("placement: aboveEditor puts the component above the editor", () => {
    const h = makeHarness();
    const factory = makeFactory("agent");
    h.context.setWidget("agent", factory, { placement: "aboveEditor" });
    expect(renderedWidgetLines(h.tui.children[0])).toContain("agent");
  });

  it("replacing a factory widget for the same key disposes the old component and adds the new one", () => {
    const h = makeHarness();
    const f1 = makeFactory("v1");
    h.context.setWidget("k", f1);
    const f2 = makeFactory("v2");
    h.context.setWidget("k", f2);

    expect(f1.component.dispose).toHaveBeenCalled();
    const above = h.tui.children[0];
    expect(renderedWidgetLines(above)).toContain("v2");
    expect(renderedWidgetLines(above)).not.toContain("v1");
  });

  it("a throwing first factory closes the otherwise-empty unified panel", () => {
    const h = makeHarness();
    const error = new Error("factory exploded");

    expect(() =>
      h.context.setWidget("broken", () => {
        throw error;
      }),
    ).toThrow(error);

    expect(h.tui.stopped).toBe(true);
    expect(h.panelBridge.closePanel).toHaveBeenCalledWith(
      h.panelBridge.openPanel.mock.results[0].value,
    );
  });

  it("a throwing replacement preserves the prior factory component", () => {
    const h = makeHarness();
    const prior = makeFactory("prior");
    h.context.setWidget("k", prior);

    expect(() =>
      h.context.setWidget("k", () => {
        throw new Error("replacement exploded");
      }),
    ).toThrow("replacement exploded");

    expect(prior.component.dispose).not.toHaveBeenCalled();
    expect(renderedWidgetLines(h.tui.children[0])).toContain("prior");
    expect(h.tui.stopped).toBe(false);
    expect(h.panelBridge.closePanel).not.toHaveBeenCalled();
  });

  it("rejects an invalid factory result before replacing the prior component", () => {
    const h = makeHarness();
    const prior = makeFactory("prior");
    h.context.setWidget("k", prior);

    expect(() => h.context.setWidget("k", () => ({ invalidate() {} }))).toThrow("without render()");

    expect(prior.component.dispose).not.toHaveBeenCalled();
    expect(renderedWidgetLines(h.tui.children[0])).toContain("prior");
  });

  it("observes a rejected async factory before rejecting its malformed result", async () => {
    const h = makeHarness();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const factoryFailure = Promise.reject(new Error("async factory exploded"));

      expect(() => h.context.setWidget("async-factory", () => factoryFailure)).toThrow(
        "without render()",
      );

      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(
        h.bundle.state
          .catalogSnapshot()
          .capabilityDiagnostics.some((message) => message.includes("async factory exploded")),
      ).toBe(true);
      expect(h.tui.stopped).toBe(true);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("best-effort disposes an invalid result and fences all descendant widget writes", async () => {
    const h = makeHarness();
    const prior = makeFactory("prior");
    h.context.setWidget("k", prior);
    const disposeFailure = Promise.reject(new Error("invalid result cleanup exploded"));
    const invalid = {
      dispose: vi.fn(() => {
        h.context.setWidget("cross-key-sync", ["stale sync"]);
        queueMicrotask(() => h.context.setWidget("cross-key-async", ["stale async"]));
        return disposeFailure;
      }),
    };

    expect(() => h.context.setWidget("k", () => invalid)).toThrow("without render()");
    await new Promise((resolve) => setImmediate(resolve));

    expect(invalid.dispose).toHaveBeenCalledTimes(1);
    expect(prior.component.dispose).not.toHaveBeenCalled();
    expect(renderedWidgetLines(h.tui.children[0])).toContain("prior");
    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("cross-key-sync");
    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("cross-key-async");
    expect(h.sendToMain).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "setWidget",
        widgetKey: expect.stringMatching(/^cross-key-/),
      }),
    );
    expect(
      h.bundle.state
        .catalogSnapshot()
        .capabilityDiagnostics.some((message) =>
          message.includes("invalid result cleanup exploded"),
        ),
    ).toBe(true);
  });

  it("reads placement before opening or mutating either widget representation", () => {
    const hostileOptions = Object.defineProperty({}, "placement", {
      get() {
        throw new Error("placement exploded");
      },
    });

    const initial = makeHarness();
    const factory = makeFactory("never constructed");
    expect(() => initial.context.setWidget("k", factory, hostileOptions)).toThrow(
      "placement exploded",
    );
    expect(factory).not.toHaveBeenCalled();
    expect(initial.panelBridge.openPanel).not.toHaveBeenCalled();

    const replacement = makeHarness();
    const prior = makeFactory("prior");
    replacement.context.setWidget("k", prior);
    replacement.sendToMain.mockClear();
    expect(() => replacement.context.setWidget("k", ["static"], hostileOptions)).toThrow(
      "placement exploded",
    );
    expect(prior.component.dispose).not.toHaveBeenCalled();
    expect(renderedWidgetLines(replacement.tui.children[0])).toContain("prior");
    expect(replacement.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("k");
    expect(replacement.sendToMain).not.toHaveBeenCalled();
  });

  it("contains render failures behind a visible fallback and reports only once", () => {
    const h = makeHarness();
    h.context.setWidget("broken", () => ({
      render() {
        throw new Error("paint exploded");
      },
    }));
    const installed = h.tui.children[0].children[0];

    expect(() => installed.render(80)).not.toThrow();
    expect(installed.render(80)[0]).toContain('Extension widget "broken" render failed');
    expect(
      h.sendToMain.mock.calls.filter(
        ([message]) => message.method === "notify" && message.message.includes("paint exploded"),
      ),
    ).toHaveLength(1);
    expect(h.bundle.state.catalogSnapshot().capabilityDiagnostics[0]).toContain("paint exploded");
  });

  it("observes rejected promises returned by every synchronous component hook", async () => {
    const h = makeHarness();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const renderFailure = Promise.reject(new Error("async paint exploded"));
      const invalidateFailure = Promise.reject(new Error("async invalidate exploded"));
      const disposeFailure = Promise.reject(new Error("async dispose exploded"));
      h.context.setWidget("async", () => ({
        render: () => renderFailure,
        invalidate: () => invalidateFailure,
        dispose: () => disposeFailure,
      }));
      const installed = h.tui.children[0].children[0];

      expect(installed.render(80)[0]).toContain('Extension widget "async" render failed');
      installed.invalidate();
      h.context.setWidget("async", undefined);

      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      const diagnostics = h.bundle.state.catalogSnapshot().capabilityDiagnostics;
      expect(diagnostics.some((message) => message.includes("render() must return"))).toBe(true);
      expect(diagnostics.some((message) => message.includes("async invalidate exploded"))).toBe(
        true,
      );
      expect(diagnostics.some((message) => message.includes("async dispose exploded"))).toBe(true);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("contains malformed render output instead of passing it into pi-tui", () => {
    const h = makeHarness();
    h.context.setWidget("malformed", () => ({ render: () => ["valid", 42] }));
    const installed = h.tui.children[0].children[0];

    expect(installed.render(80)).toEqual([expect.stringContaining('Extension widget "malformed"')]);
    expect(
      h.sendToMain.mock.calls.some(
        ([message]) =>
          message.method === "notify" &&
          message.message.includes("render() must return an array of strings"),
      ),
    ).toBe(true);
  });

  it.each([
    ["carriage return", "first\rsecond"],
    ["newline", "first\nsecond"],
  ])("contains an embedded %s behind one safe fallback row", (_label, line) => {
    const h = makeHarness();
    h.context.setWidget("multiline", () => ({ render: () => [line] }));
    const installed = h.tui.children[0].children[0];

    const rendered = installed.render(80);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).not.toMatch(/[\r\n]/);
    expect(rendered[0]).toContain('Extension widget "multiline" render failed');
    expect(
      h.sendToMain.mock.calls.some(
        ([message]) =>
          message.method === "notify" &&
          message.message.includes("contains an embedded line break"),
      ),
    ).toBe(true);
  });

  it("clips valid output at a transient tiny width without reporting an extension failure", () => {
    const h = makeHarness();
    const fullLine = "x".repeat(200);
    h.context.setWidget("wide", () => ({ render: () => [fullLine] }));
    const installed = h.tui.children[0].children[0];

    const [clipped] = installed.render(2);
    expect(clipped).toBe("x…");
    expect(installed.render(240)).toEqual([fullLine]);
    expect(
      h.sendToMain.mock.calls.some(
        ([message]) => message.method === "notify" && message.message.includes("render failed"),
      ),
    ).toBe(false);
    expect(h.bundle.state.catalogSnapshot().capabilityDiagnostics).toEqual([]);
  });

  it("preserves ANSI through width normalization and enforces the helper postcondition", () => {
    const red = "\u001b[31m";
    const reset = "\u001b[0m";
    const visibleWidth = (text) => [...stripVTControlCharacters(text)].length;
    const ansiAwareTruncate = (text, width, ellipsis = "") => {
      const plain = stripVTControlCharacters(text);
      if (plain.length <= width) return text;
      return `${red}${plain.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}${reset}`;
    };
    const h = makeHarness({ visibleWidth, truncateToWidth: ansiAwareTruncate });
    const fullLine = `${red}factory widget content${reset}`;
    h.context.setWidget("ansi", () => ({ render: () => [fullLine] }));
    const installed = h.tui.children[0].children[0];

    const [clipped] = installed.render(2);
    expect(visibleWidth(clipped)).toBeLessThanOrEqual(2);
    expect(clipped.startsWith(red)).toBe(true);
    expect(clipped.endsWith(reset)).toBe(true);
    expect(installed.render(80)).toEqual([fullLine]);
    expect(h.sendToMain).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "notify", notifyType: "error" }),
    );

    const brokenHelper = makeHarness({
      visibleWidth,
      truncateToWidth: (text) => text,
    });
    brokenHelper.context.setWidget("bad-helper", () => ({ render: () => [fullLine] }));
    const [safelyBounded] = brokenHelper.tui.children[0].children[0].render(2);
    expect(visibleWidth(safelyBounded)).toBeLessThanOrEqual(2);
    expect(brokenHelper.sendToMain).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "notify", notifyType: "error" }),
    );
  });

  it("keeps exactly one presentation when a key switches static → factory", () => {
    const h = makeHarness();
    h.context.setWidget("k", ["static"]);
    const factory = makeFactory("factory");

    h.context.setWidget("k", factory);

    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("k");
    expect(renderedWidgetLines(h.tui.children[0])).toContain("factory");
    expect(h.sendToMain).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "setWidget", widgetKey: "k", widgetLines: undefined }),
    );
  });

  it("keeps exactly one presentation when a key switches factory → static", () => {
    const h = makeHarness();
    const factory = makeFactory("factory");
    h.context.setWidget("k", factory);
    const tui = h.tui;

    h.context.setWidget("k", ["static"]);

    expect(factory.component.dispose).toHaveBeenCalledTimes(1);
    expect(tui.stopped).toBe(true);
    expect(h.bundle.state.catalogSnapshot().widgets.k).toEqual(["static"]);
    expect(h.sendToMain).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "setWidget",
        widgetKey: "k",
        widgetLines: ["static"],
        widgetPlacement: "aboveEditor",
      }),
    );
  });

  it("does not dispose a component factory that returns the same instance again", () => {
    const h = makeHarness();
    const component = { render: () => ["stable"], dispose: vi.fn() };
    const factory = () => component;
    h.context.setWidget("k", factory);

    h.context.setWidget("k", factory, { placement: "belowEditor" });

    expect(component.dispose).not.toHaveBeenCalled();
    expect(renderedWidgetLines(h.tui.children[2])).toContain("stable");
    expect(renderedWidgetLines(h.tui.children[0])).not.toContain("stable");
  });

  it("disposes a source shared by different keys only after its final owner leaves", () => {
    const h = makeHarness();
    const source = { render: () => ["shared"], dispose: vi.fn() };
    const factory = () => source;
    h.context.setWidget("a", factory);
    h.context.setWidget("b", factory);
    const above = h.tui.children[0];

    h.context.setWidget("a", undefined);
    expect(source.dispose).not.toHaveBeenCalled();
    expect(renderedWidgetLines(above)).toEqual(["shared"]);

    h.context.setWidget("b", undefined);
    expect(source.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared source alive while temporary key leases churn", () => {
    const h = makeHarness();
    const source = { render: () => ["shared"], dispose: vi.fn() };
    const factory = () => source;
    h.context.setWidget("anchor", factory);

    for (const key of ["temporary-a", "temporary-b", "temporary-c"]) {
      h.context.setWidget(key, factory);
      h.context.setWidget(key, undefined);
      expect(source.dispose).not.toHaveBeenCalled();
    }

    h.context.setWidget("anchor", undefined);
    expect(source.dispose).toHaveBeenCalledTimes(1);
  });

  it("fences same- and cross-key writes scheduled by a retiring component", async () => {
    const h = makeHarness();
    const replacement = makeFactory("replacement");
    const retired = {
      render: () => ["retired"],
      dispose: vi.fn(() => {
        h.context.setWidget("k", ["stale synchronous write"]);
        h.context.setWidget("other-sync", ["stale cross-key synchronous write"]);
        setTimeout(() => {
          h.context.setWidget("other-timer", ["stale cross-key timer write"]);
        }, 0);
        return Promise.resolve().then(() => {
          h.context.setWidget("k", ["stale asynchronous write"]);
          h.context.setWidget("other-async", ["stale cross-key asynchronous write"]);
        });
      }),
    };
    h.context.setWidget("k", () => retired);

    h.context.setWidget("k", replacement);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));

    expect(retired.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.component.dispose).not.toHaveBeenCalled();
    expect(renderedWidgetLines(h.tui.children[0])).toContain("replacement");
    expect(h.tui.stopped).toBe(false);
    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("k");
    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("other-sync");
    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("other-async");
    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("other-timer");
    expect(h.sendToMain).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "setWidget",
        widgetKey: expect.stringMatching(/^(k|other-)/),
        widgetLines: expect.any(Array),
      }),
    );
  });

  it("tombstones the Unified generation and fences whole-TUI teardown callbacks", async () => {
    const h = makeHarness();
    const source = {
      render: () => ["widget"],
      dispose: vi.fn(() => h.unified.dispose()),
    };
    h.editor.dispose.mockImplementation(() => {
      h.context.setWidget("editor-dispose-sync", ["stale sync"]);
      queueMicrotask(() => h.context.setWidget("editor-dispose-async", ["stale async"]));
    });
    h.context.setWidget("k", () => source);
    const panelId = h.panelBridge.openPanel.mock.results[0].value;

    h.unified.dispose();
    await new Promise((resolve) => setImmediate(resolve));

    expect(source.dispose).toHaveBeenCalledTimes(1);
    expect(h.editor.dispose).toHaveBeenCalledTimes(1);
    expect(h.panelBridge.closePanel).toHaveBeenCalledTimes(1);
    expect(h.panelBridge.closePanel).toHaveBeenCalledWith(panelId);
    expect(h.panelBridge.openPanel).toHaveBeenCalledTimes(1);
    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("editor-dispose-sync");
    expect(h.bundle.state.catalogSnapshot().widgets).not.toHaveProperty("editor-dispose-async");
  });

  it("a static string[] widget still uses the sendToMain path (no unified TUI)", () => {
    const h = makeHarness();
    h.context.setWidget("lines", ["a", "b"], { placement: "belowEditor" });
    expect(h.sendToMain).toHaveBeenCalledWith(
      expect.objectContaining({ method: "setWidget", widgetLines: ["a", "b"] }),
    );
    expect(h.panelBridge.openPanel).not.toHaveBeenCalled();
  });

  it("setWidget(key, undefined) removes the widget and, when no retention roots remain, tears the unified TUI down", () => {
    const h = makeHarness();
    const f = makeFactory();
    h.context.setWidget("k", f);
    const tui = h.tui;
    const panelId = h.panelBridge.openPanel.mock.results[0].value;

    h.context.setWidget("k", undefined);

    expect(f.component.dispose).toHaveBeenCalled();
    expect(tui.stopped).toBe(true);
    expect(h.panelBridge.closePanel).toHaveBeenCalledWith(panelId);
  });

  it("setWidget(key, undefined) keeps an editor-only unified TUI alive when unsent text exists", () => {
    const h = makeHarness();
    const f = makeFactory();
    h.context.setWidget("k", f);
    const tui = h.tui;
    h.editor.getExpandedText.mockReturnValue("draft in progress");

    h.context.setWidget("k", undefined);

    expect(f.component.dispose).toHaveBeenCalled();
    expect(tui.stopped).toBe(false);
    expect(h.panelBridge.closePanel).not.toHaveBeenCalled();
  });

  it("a draft-held editor-only unified TUI closes once the user deletes the draft", async () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const tui = h.tui;
    const panelId = h.panelBridge.openPanel.mock.results[0].value;
    h.editor.getExpandedText.mockReturnValue("draft");
    h.context.setWidget("k", undefined);
    expect(tui.stopped).toBe(false);

    h.editor.getExpandedText.mockReturnValue("");
    for (const listener of tui.inputListeners) listener("\b");
    await Promise.resolve();

    expect(tui.stopped).toBe(true);
    expect(h.panelBridge.closePanel).toHaveBeenCalledWith(panelId);
  });

  it("setEditorText('') closes a draft-held widgetless unified TUI", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const tui = h.tui;
    const panelId = h.panelBridge.openPanel.mock.results[0].value;
    h.editor.getExpandedText.mockReturnValue("draft");
    h.context.setWidget("k", undefined);
    expect(tui.stopped).toBe(false);

    h.editor.getExpandedText.mockReturnValue("");
    h.context.setEditorText("");

    expect(h.editor.setText).toHaveBeenCalledWith("");
    expect(tui.stopped).toBe(true);
    expect(h.panelBridge.closePanel).toHaveBeenCalledWith(panelId);
  });

  it("accepted slash-command custody clears the unified editor and closes its widgetless TUI", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const tui = h.tui;
    const panelId = h.panelBridge.openPanel.mock.results[0].value;
    h.editor.getExpandedText.mockReturnValue("/finished-command");
    h.context.setWidget("k", undefined);
    expect(tui.stopped).toBe(false);

    h.editor.getExpandedText.mockReturnValue("");
    expect(
      h.bundle.state.acceptEditorSubmission({ editorRevision: 0, text: "/finished-command" }),
    ).toBe(true);

    expect(h.editor.setText).toHaveBeenCalledWith("");
    expect(tui.stopped).toBe(true);
    expect(h.panelBridge.closePanel).toHaveBeenCalledWith(panelId);
  });

  it("an accepted renderer patch that clears the final draft closes a widgetless unified TUI", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const tui = h.tui;
    const panelId = h.panelBridge.openPanel.mock.results[0].value;
    h.editor.getExpandedText.mockReturnValue("draft");
    h.context.setWidget("k", undefined);
    expect(tui.stopped).toBe(false);

    h.editor.getExpandedText.mockReturnValue("");
    expect(
      h.bundle.state.applyEditorPatch({ baseRevision: 0, revision: 1, text: "" }),
    ).toMatchObject({ accepted: true, revision: 1 });

    expect(tui.stopped).toBe(true);
    expect(h.panelBridge.closePanel).toHaveBeenCalledWith(panelId);
  });

  it("a pending unified submit retains the TUI after the last widget is removed until the submit resolves", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const tui = h.tui;
    const panelId = h.panelBridge.openPanel.mock.results[0].value;
    h.editor.getExpandedText.mockReturnValue("");

    h.editor.onSubmit("send me");
    h.context.setWidget("k", undefined);

    expect(tui.stopped).toBe(false);
    expect(h.panelBridge.closePanel).not.toHaveBeenCalled();

    h.unified.resolveSubmit(lastSubmitId(h.sendToMain), { ok: true });

    expect(tui.stopped).toBe(true);
    expect(h.panelBridge.closePanel).toHaveBeenCalledWith(panelId);
  });

  it("a failed/bailed pending submit never restores text and releases a widgetless TUI", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const tui = h.tui;
    h.editor.getExpandedText.mockReturnValue("");
    h.editor.getText.mockReturnValue("");

    h.editor.onSubmit("retry me");
    h.context.setWidget("k", undefined);
    expect(tui.stopped).toBe(false);

    h.unified.resolveSubmit(lastSubmitId(h.sendToMain), { ok: false, bailed: true });

    expect(h.editor.setText).not.toHaveBeenCalledWith("retry me");
    expect(tui.stopped).toBe(true);
    expect(h.panelBridge.closePanel).toHaveBeenCalled();
  });

  it("a new factory widget registered while draft-held prevents close after submit", () => {
    const h = makeHarness();
    const first = makeFactory("first");
    h.context.setWidget("first", first);
    const tui = h.tui;
    h.editor.getExpandedText.mockReturnValue("draft");
    h.context.setWidget("first", undefined);
    expect(tui.stopped).toBe(false);

    const second = makeFactory("second");
    h.context.setWidget("second", second);
    h.editor.getExpandedText.mockReturnValue("");
    h.editor.onSubmit("draft");
    h.unified.resolveSubmit(lastSubmitId(h.sendToMain), { ok: true });

    expect(second.component.dispose).not.toHaveBeenCalled();
    expect(tui.stopped).toBe(false);
    expect(h.panelBridge.closePanel).not.toHaveBeenCalled();
  });
});

describe("unified TUI: irreversible submit presentation", () => {
  it("commits the clear immediately and preserves concurrent typing as the current draft", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());

    h.editor.onSubmit("submitted draft");
    const id = lastSubmitId(h.sendToMain);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 1,
      text: "",
    });

    expect(
      h.bundle.state.applyEditorPatch({ baseRevision: 1, revision: 2, text: "new local text" }),
    ).toMatchObject({ accepted: true, revision: 2 });
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "new local text",
    });

    h.editor.getText.mockReturnValue("new local text");
    h.unified.resolveSubmit(id, { ok: false, bailed: true });
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "new local text",
    });
    expect(h.bundle.state.editorSnapshot().conflictText).toBeUndefined();
  });

  it("replicates unsent attachments with revisioned editor patches", () => {
    const h = makeHarness();
    const attachments = [
      {
        kind: "image",
        name: "diagram.png",
        path: "/tmp/diagram.png",
        dataUrl: "data:image/png;base64,x",
      },
    ];

    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "draft",
        attachments,
      }),
    ).toMatchObject({ accepted: true, attachments });
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 1,
      text: "draft",
      attachments,
    });
  });

  it("clears slash command text while preserving authoritative attachments", () => {
    const h = makeHarness();
    const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "/widget-on",
        attachments,
      }),
    ).toMatchObject({ accepted: true });

    expect(
      h.bundle.state.acceptEditorSubmission({
        editorRevision: 1,
        text: "/widget-on",
        inputKind: "slash_command",
      }),
    ).toBe(true);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "",
      attachments,
    });
  });

  it("Unified slash and Shell clears preserve staged attachments and every conflict", () => {
    for (const source of ["/widget-on", "!pwd"]) {
      const h = makeHarness();
      h.context.setWidget("k", makeFactory());
      const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
      expect(
        h.bundle.state.applyEditorPatch({
          baseRevision: 0,
          revision: 1,
          text: source,
          attachments,
        }),
      ).toMatchObject({ accepted: true });
      expect(
        h.bundle.state.applyEditorPatch({
          baseRevision: 0,
          revision: 1,
          text: "newer conflict",
          attachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
          alternateConflictText: "alternate conflict",
          additionalConflictCandidates: [{ text: "third conflict", attachments: [] }],
        }),
      ).toMatchObject({ accepted: false });

      h.editor.onSubmit(source);

      expect(h.bundle.state.editorSnapshot()).toMatchObject({
        revision: 2,
        text: "",
        attachments,
        conflictText: "newer conflict",
        alternateConflictText: "alternate conflict",
        additionalConflictCandidates: [{ text: "third conflict", attachments: [] }],
      });
      expect(lastSubmitRequest(h.sendToMain).editorAttachments).toEqual(attachments);
    }
  });

  it("an ordinary Unified clear consumes its attachments but preserves independent conflicts", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "primary prompt",
        attachments: [{ kind: "file", name: "primary.txt", path: "/tmp/primary.txt" }],
      }),
    ).toMatchObject({ accepted: true });
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "newer independent draft",
        attachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
      }),
    ).toMatchObject({ accepted: false });

    h.editor.onSubmit("primary prompt");

    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "",
      attachments: [],
      conflictText: "newer independent draft",
      conflictAttachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
    });
  });

  it("atomically consumes only an exact Shell Turn draft and preserves staged context", () => {
    const h = makeHarness();
    const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "!!read answer",
        attachments,
      }),
    ).toMatchObject({ accepted: true });
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "newer local draft",
        attachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
        alternateConflictText: "alternate draft",
        alternateConflictAttachments: [],
        additionalConflictCandidates: [
          {
            text: "third draft",
            attachments: [{ kind: "file", name: "third.txt", path: "/tmp/third.txt" }],
          },
        ],
      }),
    ).toMatchObject({ accepted: false });

    expect(
      h.bundle.state.acceptShellEditorSubmission({
        intentId: "shell-1",
        editorRevision: 1,
        editorText: "!!different",
      }),
    ).toBe(false);
    expect(
      h.bundle.state.acceptShellEditorSubmission({
        intentId: "shell-1",
        editorRevision: 1,
        editorText: "!!read answer",
      }),
    ).toBe(true);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "",
      attachments,
      conflictText: "newer local draft",
      conflictAttachments: [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }],
      alternateConflictText: "alternate draft",
      additionalConflictCandidates: [
        {
          text: "third draft",
          attachments: [{ kind: "file", name: "third.txt", path: "/tmp/third.txt" }],
        },
      ],
    });
  });

  it("clears attachments for ordinary input whose transported text starts with a file path", () => {
    const h = makeHarness();
    const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "Explain these notes",
        attachments,
      }),
    ).toMatchObject({ accepted: true });

    expect(
      h.bundle.state.acceptEditorSubmission({
        editorRevision: 1,
        text: "/tmp/notes.txt\n\nExplain these notes",
        inputKind: "ordinary",
      }),
    ).toBe(true);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "",
      attachments: [],
    });
  });

  it("rejects an explicit classification that disagrees with authoritative editor text", () => {
    const h = makeHarness();
    const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "/extension",
        attachments,
      }),
    ).toMatchObject({ accepted: true });

    expect(
      h.bundle.state.acceptEditorSubmission({
        editorRevision: 1,
        text: "/extension",
        inputKind: "ordinary",
      }),
    ).toBe(false);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 1,
      text: "/extension",
      attachments,
    });
  });

  it("accepts transformed ordinary unified input against its pending raw editor text", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "Explain these notes",
        attachments,
      }),
    ).toMatchObject({ accepted: true });

    h.editor.onSubmit("Explain these notes");
    const request = lastSubmitRequest(h.sendToMain);
    expect(request).toMatchObject({
      editorRevision: 1,
      editorAttachments: attachments,
    });
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "",
      attachments: [],
    });
    expect(
      h.bundle.state.acceptEditorSubmission({
        intentId: request.submissionIntentId,
        editorRevision: 1,
        text: "/tmp/notes.txt\n\nExplain these notes",
        inputKind: "ordinary",
      }),
    ).toBe(true);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "",
      attachments: [],
    });
  });

  it("exact-binds a pending Unified slash command before acknowledgement", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.onSubmit("/safe");
    const request = lastSubmitRequest(h.sendToMain);

    expect(
      h.bundle.state.acceptEditorSubmission({
        intentId: request.submissionIntentId,
        editorRevision: request.editorRevision,
        text: "/different-effect",
        inputKind: "slash_command",
        surface: "unified",
      }),
    ).toBe(false);
    expect(
      h.bundle.state.acceptEditorSubmission({
        intentId: request.submissionIntentId,
        editorRevision: request.editorRevision,
        text: "/safe",
        inputKind: "slash_command",
        surface: "unified",
      }),
    ).toBe(true);
  });

  it("acknowledges two rapid pending sources without clearing or masking a newer draft", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "first prompt",
        attachments,
      }),
    ).toMatchObject({ accepted: true });

    h.editor.onSubmit("first prompt");
    const first = lastSubmitRequest(h.sendToMain);
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 2,
        revision: 3,
        text: "Explain these notes",
        attachments,
      }),
    ).toMatchObject({ accepted: true, revision: 3 });
    h.editor.onSubmit("Explain these notes");
    const second = lastSubmitRequest(h.sendToMain);
    expect(first.editorRevision).toBe(1);
    expect(second.editorRevision).toBe(3);

    const newerAttachments = [{ kind: "file", name: "newer.txt", path: "/tmp/newer.txt" }];
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 4,
        revision: 5,
        text: "newer unsent draft",
        attachments: newerAttachments,
      }),
    ).toMatchObject({ accepted: true, revision: 5 });

    expect(
      h.bundle.state.acceptEditorSubmission({
        intentId: first.submissionIntentId,
        editorRevision: 1,
        text: "first prompt with transformed diff comments",
        inputKind: "ordinary",
      }),
    ).toBe(true);

    expect(
      h.bundle.state.acceptEditorSubmission({
        intentId: second.submissionIntentId,
        editorRevision: 3,
        text: "/tmp/notes.txt\n\nExplain these notes",
        inputKind: "ordinary",
      }),
    ).toBe(true);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 5,
      text: "newer unsent draft",
      attachments: newerAttachments,
    });

    // Stale replies retire only their source custody, in either order.
    h.unified.resolveSubmit(second.id, { ok: true });
    h.unified.resolveSubmit(first.id, { ok: false, bailed: true });
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 5,
      text: "newer unsent draft",
      attachments: newerAttachments,
    });
  });

  it("keeps the authoritative clear when custody later succeeds", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.onSubmit("accepted draft");
    expect(h.bundle.state.editorSnapshot()).toMatchObject({ revision: 1, text: "" });

    h.unified.resolveSubmit(lastSubmitId(h.sendToMain), { ok: true });
    expect(h.bundle.state.editorSnapshot()).toMatchObject({ revision: 1, text: "" });
  });

  it("consumes a pending unified reload command while preserving staged attachments", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "/reload",
        attachments,
      }),
    ).toMatchObject({ accepted: true });

    h.editor.onSubmit("/reload");
    expect(h.bundle.state.editorSnapshot()).toMatchObject({ revision: 2, text: "", attachments });
    expect(h.bundle.state.acceptEditorSubmission({ editorRevision: 1, text: "/reload" })).toBe(
      true,
    );
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "",
      attachments,
    });
  });
});

describe("extension presentation lifecycle", () => {
  it("keeps non-widget cleanup effects during ordinary in-generation disposal", async () => {
    const h = makeHarness();
    const factory = makeFactory();
    factory.component.dispose.mockImplementation(async () => {
      await Promise.resolve();
      h.context.setStatus("ordinary-status", undefined);
      h.context.setTitle(undefined);
      h.context.notify("ordinary cleanup completed", "info");
    });
    h.context.setStatus("ordinary-status", "active");
    h.context.setTitle("ordinary title");
    h.context.setWidget("ordinary", factory);

    h.context.setWidget("ordinary", undefined);
    await Promise.resolve();

    expect(h.bundle.state.catalogSnapshot()).toMatchObject({
      statuses: {},
      notifications: [expect.objectContaining({ message: "ordinary cleanup completed" })],
    });
    expect(h.bundle.state.catalogSnapshot()).not.toHaveProperty("title");
  });

  it("clears retiring-generation presentation while preserving session-owned history and editor custody", async () => {
    const h = makeHarness();
    const handler = vi.fn();
    const lateHandler = vi.fn();
    const factory = makeFactory();
    factory.component.dispose.mockImplementation(async () => {
      await Promise.resolve();
      h.context.notify("teardown notification", "warning");
      h.context.setStatus("teardown-status", "must not escape");
      h.context.setTitle("teardown title");
      h.context.setWorkingMessage("teardown working message");
      h.context.setWorkingVisible(true);
      h.context.setHiddenThinkingLabel("teardown thinking label");
      h.context.setToolsExpanded(false);
      h.context.setEditorText("teardown draft");
      h.context.onTerminalInput(lateHandler);
    });
    h.context.notify("keep this notification", "info");
    h.bundle.state.addCapabilityDiagnostic("keep this diagnostic");
    h.context.setStatus("old-status", "old value");
    h.context.setWidget("old-widget", ["old value"]);
    h.context.setTitle("old title");
    h.context.setWorkingMessage("old working message");
    h.context.setWorkingVisible(false);
    h.context.setHiddenThinkingLabel("old thinking label");
    h.context.setToolsExpanded(true);
    h.context.onTerminalInput(handler);
    h.context.setWidget("factory", factory);
    expect(
      h.bundle.state.applyEditorPatch({ baseRevision: 0, revision: 1, text: "keep this draft" }),
    ).toMatchObject({ accepted: true });

    h.bundle.state.resetExtensionPresentation();
    await Promise.resolve();

    expect(h.bundle.state.catalogSnapshot()).toMatchObject({
      notifications: [expect.objectContaining({ message: "keep this notification" })],
      capabilityDiagnostics: ["keep this diagnostic"],
      statuses: {},
      widgets: {},
      toolsExpanded: true,
    });
    expect(h.bundle.state.catalogSnapshot()).not.toHaveProperty("title");
    expect(h.bundle.state.catalogSnapshot()).not.toHaveProperty("workingMessage");
    expect(h.bundle.state.catalogSnapshot()).not.toHaveProperty("workingVisible");
    expect(h.bundle.state.catalogSnapshot()).not.toHaveProperty("hiddenThinkingLabel");
    expect(h.bundle.state.editorSnapshot()).toMatchObject({ text: "keep this draft" });
    expect(h.tui.inputListeners.has(handler)).toBe(false);
    expect(h.tui.stopped).toBe(true);
    expect(factory.component.dispose).toHaveBeenCalledTimes(1);
    expect(h.panelBridge.closePanel).toHaveBeenCalledTimes(1);

    h.context.setWidget("successor", makeFactory("successor"));
    expect(h.tui.inputListeners.has(lateHandler)).toBe(false);
  });
});

describe("unified TUI: onTerminalInput (pre-editor input chain)", () => {
  it("buffers a handler until the first factory widget, then attaches it; unsubscribe detaches", () => {
    const h = makeHarness();
    const handler = vi.fn();
    expect(h.tui).toBeUndefined(); // no setWidget yet

    const unsub = h.context.onTerminalInput(handler);
    h.context.setWidget("k", makeFactory());
    expect(h.tui.inputListeners.has(handler)).toBe(true);

    unsub();
    expect(h.tui.inputListeners.has(handler)).toBe(false);
  });

  it("re-attaches the same handler after an in-generation TUI teardown and recreate", () => {
    const h = makeHarness();
    const handler = vi.fn();
    h.context.onTerminalInput(handler);

    h.context.setWidget("k", makeFactory()); // TUI #1
    const tui1 = h.tui;
    expect(tui1.inputListeners.has(handler)).toBe(true);

    h.context.setWidget("k", undefined); // teardown TUI #1
    h.context.setWidget("k", makeFactory()); // TUI #2 (recreate)
    const tui2 = h.tui;

    expect(tui2).not.toBe(tui1);
    expect(tui2.inputListeners.has(handler)).toBe(true);
  });

  it("buffers multiple handlers and attaches all (Set semantics, registration order)", () => {
    const h = makeHarness();
    const h1 = vi.fn();
    const h2 = vi.fn();
    h.context.onTerminalInput(h1);
    h.context.onTerminalInput(h2);
    h.context.setWidget("k", makeFactory());

    expect(h.tui.inputListeners.has(h1)).toBe(true);
    expect(h.tui.inputListeners.has(h2)).toBe(true);
  });
});

describe("unified TUI: editor submit + guard settlement", () => {
  it("onSubmit sends the authoritative editor revision with the text", async () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.getExpandedText.mockReturnValue("hello world");
    for (const listener of h.tui.inputListeners) listener("d");
    await Promise.resolve();

    h.editor.onSubmit("hello world");

    expect(h.sendToMain).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "unified_submit_request",
        text: "hello world",
        editorRevision: 1,
        submissionIntentId: expect.any(String),
      }),
    );
  });

  it("onSubmit sends a unified_submit_request carrying the text", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.onSubmit("hello world");
    expect(h.sendToMain).toHaveBeenCalledWith(
      expect.objectContaining({ type: "unified_submit_request", text: "hello world" }),
    );
  });

  it("ok:true leaves the editor untouched", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.onSubmit("hello");
    h.unified.resolveSubmit(lastSubmitId(h.sendToMain), { ok: true });
    expect(h.editor.setText).not.toHaveBeenCalled();
  });

  it("ok:false + bailed never restores the submitted source into an empty editor", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.getText.mockReturnValue(""); // pi cleared it; user hasn't typed since
    h.editor.onSubmit("my prompt");
    h.unified.resolveSubmit(lastSubmitId(h.sendToMain), { ok: false, bailed: true });
    expect(h.editor.setText).not.toHaveBeenCalledWith("my prompt");
    expect(h.bundle.state.editorSnapshot()).toMatchObject({ revision: 1, text: "" });
  });

  it("ok:false + bailed does NOT restore when the user typed during the round-trip (new text wins)", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.onSubmit("my prompt");
    h.editor.getText.mockReturnValue("new typing"); // user typed after submit
    h.unified.resolveSubmit(lastSubmitId(h.sendToMain), { ok: false, bailed: true });
    expect(h.editor.setText).not.toHaveBeenCalled();
  });

  it("preserves dispatch custody through renderer loss without restoring presentation on bail", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.onSubmit("reload-safe prompt");
    const id = lastSubmitId(h.sendToMain);

    h.unified.dispose({ preservePendingSubmits: true });
    expect(h.bundle.state.pendingUnifiedSubmissions()).toEqual([
      {
        id,
        text: "reload-safe prompt",
        revision: 0,
        attachments: [],
        submissionIntentId: expect.any(String),
      },
    ]);
    h.unified.resolveSubmit(id, { ok: false, bailed: true });

    expect(h.bundle.state.editorSnapshot()).toMatchObject({ revision: 1, text: "" });
  });

  it("a resolveSubmit for an id cleared by explicit dispose is a no-op (late reply after teardown)", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.editor.onSubmit("x");
    const id = lastSubmitId(h.sendToMain);
    h.unified.dispose(); // explicit teardown clears pendingSubmits

    expect(() => h.unified.resolveSubmit(id, { ok: false, bailed: true })).not.toThrow();
    expect(h.editor.setText).not.toHaveBeenCalled();
  });
});

describe("unified TUI: clipboard image paste (input-listener driven)", () => {
  it("the paste key is consumed and fires a clipboard_read_image_request", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.setKbMatches((_data, action) => action === "app.clipboard.pasteImage");

    const results = [...h.tui.inputListeners].map((l) => l("\x1bv"));
    expect(h.sendToMain).toHaveBeenCalledWith(
      expect.objectContaining({ type: "clipboard_read_image_request" }),
    );
    // the paste listener consumes the keystroke (so the editor never sees it)
    expect(results).toContainEqual({ consume: true });
  });

  it("a non-paste key is not consumed and fires no clipboard request", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.setKbMatches(() => false);

    const results = [...h.tui.inputListeners].map((l) => l("a"));
    expect(h.sendToMain).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "clipboard_read_image_request" }),
    );
    expect(results.every((r) => r === undefined)).toBe(true);
  });

  it("resolveClipboardImage writes a temp file and inserts its path (pi parity)", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.setKbMatches((_data, action) => action === "app.clipboard.pasteImage");
    for (const l of h.tui.inputListeners) l("\x1bv");

    const id = lastClipboardId(h.sendToMain);
    expect(h.unified.resolveClipboardImage(id, { bytes: PNG_1X1, mimeType: "image/png" })).toBe(
      true,
    );

    expect(h.editor.insertTextAtCursor).toHaveBeenCalledTimes(1);
    const inserted = h.editor.insertTextAtCursor.mock.calls[0][0];
    expect(inserted).toMatch(/pi-vis-clipboard-.*\.png$/);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({ revision: 1, text: inserted });
    // clean up the real temp file the resolver wrote to os.tmpdir()
    try {
      fs.unlinkSync(inserted);
    } catch {
      /* already gone */
    }
  });

  it("preserves a clipboard image separately when the editor changed during the read", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.setKbMatches((_data, action) => action === "app.clipboard.pasteImage");
    for (const l of h.tui.inputListeners) l("\x1bv");
    const id = lastClipboardId(h.sendToMain);
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "newer draft",
        attachments: [],
      }),
    ).toMatchObject({ accepted: true });

    h.unified.resolveClipboardImage(id, { bytes: PNG_1X1, mimeType: "image/png" });

    expect(h.editor.insertTextAtCursor).not.toHaveBeenCalled();
    const snapshot = h.bundle.state.editorSnapshot();
    expect(snapshot).toMatchObject({
      revision: 2,
      text: "newer draft",
      conflictText: expect.stringMatching(/pi-vis-clipboard-.*\.png$/),
      attachments: [expect.objectContaining({ kind: "file", path: expect.any(String) })],
    });
    expect(h.bundle.state.catalogSnapshot().notifications).toContainEqual(
      expect.objectContaining({ type: "warning" }),
    );
    try {
      fs.unlinkSync(snapshot.attachments[0].path);
    } catch {
      /* already gone */
    }
  });

  it("an empty clipboard reply inserts nothing", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.setKbMatches((_data, action) => action === "app.clipboard.pasteImage");
    for (const l of h.tui.inputListeners) l("\x1bv");
    const id = lastClipboardId(h.sendToMain);

    expect(h.unified.resolveClipboardImage(id, { bytes: undefined, mimeType: undefined })).toBe(
      false,
    );
    expect(h.editor.insertTextAtCursor).not.toHaveBeenCalled();
  });

  it("preserves a clipboard reply that arrives after its TUI generation retired", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.setKbMatches((_data, action) => action === "app.clipboard.pasteImage");
    for (const l of h.tui.inputListeners) l("\x1bv");
    const id = lastClipboardId(h.sendToMain);
    h.context.setWidget("k", undefined);

    h.unified.resolveClipboardImage(id, { bytes: PNG_1X1, mimeType: "image/png" });

    expect(h.editor.insertTextAtCursor).not.toHaveBeenCalled();
    const snapshot = h.bundle.state.editorSnapshot();
    expect(snapshot).toMatchObject({
      revision: 1,
      conflictText: expect.stringMatching(/pi-vis-clipboard-.*\.png$/),
      attachments: [expect.objectContaining({ path: expect.any(String) })],
    });
    try {
      fs.unlinkSync(snapshot.attachments[0].path);
    } catch {
      /* already gone */
    }
  });
});

describe("unified TUI: custom() reuse vs standalone", () => {
  it("custom() reuses the unified TUI as an overlay (no second panel/xterm)", async () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory()); // unified TUI exists
    const overlayComponent = { render: () => ["overlay"], dispose: vi.fn() };
    let doneFn;
    const factory = vi.fn((_tui, _theme, _kb, done) => {
      doneFn = done;
      return overlayComponent;
    });

    const promise = h.context.custom(factory, {});
    await Promise.resolve();
    await Promise.resolve();

    // factory received the SAME tui as the unified panel
    expect(factory.mock.calls[0][0]).toBe(h.tui);
    // overlay shown on that tui, and no extra panel was opened
    expect(h.tui.overlayShown).toBe(overlayComponent);
    expect(h.panelBridge.openPanel).toHaveBeenCalledTimes(1); // only the unified panel

    doneFn(); // settle the custom() promise
    await promise;
  });

  it("composer-origin custom() opens a standalone panel even when the unified TUI exists", async () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory()); // unified TUI exists
    const unifiedTui = h.tui;
    let doneFn;
    const factory = vi.fn((_tui, _theme, _kb, done) => {
      doneFn = done;
      return { render: () => [], dispose: vi.fn() };
    });

    const promise = h.bundle.runWithInvocationSurface("composer", () =>
      h.context.custom(factory, {}),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(h.panelBridge.openPanel).toHaveBeenCalledTimes(2); // unified + standalone custom panel
    expect(factory.mock.calls[0][0]).not.toBe(unifiedTui);
    expect(unifiedTui.overlayShown).toBeNull();

    doneFn(undefined);
    await promise;
    expect(h.tui.stopped).toBe(true); // the standalone TUI stopped; unified stayed separate
    expect(unifiedTui.stopped).toBe(false);
  });

  it("custom() done() hides the overlay but does NOT stop the shared TUI", async () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    let doneFn;
    const factory = vi.fn((_tui, _theme, _kb, done) => {
      doneFn = done;
      return { render: () => [], dispose: vi.fn() };
    });

    const promise = h.context.custom(factory, {});
    await Promise.resolve();
    await Promise.resolve();

    expect(h.tui.stopped).toBe(false);
    expect(h.tui.overlayShown).not.toBeNull();
    doneFn("result");
    await promise;

    expect(h.tui.overlayShown).toBeNull(); // overlay hidden
    expect(h.tui.stopped).toBe(false); // shared TUI still alive
  });

  it("custom() standalone (no unified TUI) opens its OWN panel and stops its OWN TUI on done()", async () => {
    const h = makeHarness();
    let doneFn;
    const factory = vi.fn((_tui, _theme, _kb, done) => {
      doneFn = done;
      return { render: () => [], dispose: vi.fn() };
    });

    const promise = h.context.custom(factory, {});
    await Promise.resolve();
    await Promise.resolve();

    expect(h.panelBridge.openPanel).toHaveBeenCalledWith(
      expect.objectContaining({ overlay: false }),
    );
    const standaloneTui = h.tui;
    doneFn(undefined);
    await promise;

    expect(standaloneTui.stopped).toBe(true);
  });
});

describe("unified TUI: editor bridges", () => {
  it("getEditorText returns '' with no TUI, else the editor's expanded text", () => {
    const h = makeHarness();
    expect(h.context.getEditorText()).toBe("");
    h.context.setWidget("k", makeFactory());
    h.editor.getExpandedText.mockReturnValue("expanded!");
    expect(h.context.getEditorText()).toBe("expanded!");
  });

  it("clears only a revision-matched editor after submission custody is acknowledged", () => {
    const h = makeHarness();
    h.context.setEditorText("submitted");

    expect(
      h.bundle.state.acceptEditorSubmission({
        intentId: "accepted",
        editorRevision: 1,
        text: "submitted",
      }),
    ).toBe(true);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "",
      attachments: [],
    });

    h.context.setEditorText("new typing");
    expect(
      h.bundle.state.acceptEditorSubmission({
        intentId: "stale",
        editorRevision: 2,
        text: "submitted",
      }),
    ).toBe(false);
    expect(h.bundle.state.editorSnapshot()).toMatchObject({ revision: 3, text: "new typing" });
  });

  it("setEditorText writes to the unified editor when present, else falls back to sendToMain", () => {
    const h = makeHarness();
    h.context.setEditorText("fallback"); // no TUI yet
    expect(h.sendToMain).toHaveBeenCalledWith(
      expect.objectContaining({ method: "set_editor_text", text: "fallback" }),
    );

    h.context.setWidget("k", makeFactory());
    h.context.setEditorText("direct");
    expect(h.editor.setText).toHaveBeenCalledWith("direct");
  });

  it("pasteToEditor revision-replicates text when the native Composer is active", () => {
    const h = makeHarness();
    h.context.pasteToEditor("hi");

    expect(h.editor.handleInput).not.toHaveBeenCalled();
    expect(h.bundle.state.editorSnapshot()).toMatchObject({ revision: 1, text: "hi" });
    expect(h.sendToMain).toHaveBeenCalledWith(
      expect.objectContaining({ method: "set_editor_text", text: "hi" }),
    );
    expect(
      h.bundle.state.applyEditorPatch({
        baseRevision: 0,
        revision: 1,
        text: "newer local draft",
        attachments: [],
      }),
    ).toMatchObject({
      accepted: false,
      revision: 1,
      text: "hi",
      conflictText: "newer local draft",
    });
  });

  it("setEditorText preserves an attachment-only rejected local conflict", () => {
    const h = makeHarness();
    h.bundle.state.applyEditorPatch({
      baseRevision: 0,
      revision: 1,
      text: "extension original",
      attachments: [],
    });
    h.bundle.state.applyEditorPatch({
      baseRevision: 0,
      revision: 2,
      text: "",
      attachments: [{ kind: "file", name: "local.txt" }],
    });

    h.context.setEditorText("extension replacement");

    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "extension replacement",
      conflictText: "",
      conflictAttachments: [{ kind: "file", name: "local.txt" }],
    });
  });

  it("pasteToEditor preserves an attachment-only rejected local conflict", () => {
    const h = makeHarness();
    h.bundle.state.applyEditorPatch({
      baseRevision: 0,
      revision: 1,
      text: "extension original",
      attachments: [],
    });
    h.bundle.state.applyEditorPatch({
      baseRevision: 0,
      revision: 2,
      text: "",
      attachments: [{ kind: "file", name: "local.txt" }],
    });

    h.context.pasteToEditor(" pasted");

    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      revision: 2,
      text: "extension original pasted",
      conflictText: "",
      conflictAttachments: [{ kind: "file", name: "local.txt" }],
    });
  });

  it("retains every deduplicated recovery conflict candidate", () => {
    const h = makeHarness();
    h.bundle.state.applyEditorPatch({
      baseRevision: 0,
      revision: 1,
      text: "authority",
      attachments: [],
    });
    h.bundle.state.applyEditorPatch({
      baseRevision: 0,
      revision: 2,
      text: "primary",
      attachments: [{ kind: "file", name: "primary.txt" }],
      alternateConflictText: "alternate",
      alternateConflictAttachments: [{ kind: "file", name: "alternate.txt" }],
      additionalConflictCandidates: [
        {
          text: "additional",
          attachments: [{ kind: "file", name: "additional.txt" }],
        },
      ],
    });

    expect(h.bundle.state.editorSnapshot()).toMatchObject({
      text: "authority",
      conflictText: "primary",
      conflictAttachments: [{ kind: "file", name: "primary.txt" }],
      alternateConflictText: "alternate",
      alternateConflictAttachments: [{ kind: "file", name: "alternate.txt" }],
      additionalConflictCandidates: [
        {
          text: "additional",
          attachments: [{ kind: "file", name: "additional.txt" }],
        },
      ],
    });
  });

  it("pasteToEditor feeds the editor a bracketed-paste sequence when a TUI exists", () => {
    const h = makeHarness();
    h.context.setWidget("k", makeFactory());
    h.context.pasteToEditor("pasted");
    expect(h.editor.handleInput).toHaveBeenCalledWith("\x1b[200~pasted\x1b[201~");
  });
});
