/**
 * Unified-TUI host-render integration test — the regression gate for the
 * "factory setWidget opens a panel that never paints" class of bug.
 *
 * WHY THIS LAYER EXISTS
 * ─────────────────────
 * The other two unified-panel tests fake the host's ANSI output:
 *   - tests/render/unified-panel.spec.mts (preview stub) and
 *   - tests/e2e/unified-panel.spec.mts (fake-unified-host.mjs)
 * both emit canned `panel_open{unified}` + `panel_data`. They prove the
 * renderer pipeline (store reducer → UnifiedTuiHost → xterm) works, but they
 * NEVER run resources/pi-session-host/ui-context.mjs's `ensureUnifiedTui()` —
 * the code that builds a REAL pi-tui `TUI` (Editor + widget Containers) and
 * relies on pi's theme. That is exactly where the original bug lived: the host
 * passed pi's full Theme to `new Editor(tui, theme)`, but pi-tui's Editor
 * needs an `EditorTheme` ({ borderColor:(s)=>string, selectList }), so
 * `Editor.render()` threw `this.borderColor is not a function` on the first
 * render tick — the panel opened (Composer replaced) but produced no output and
 * could crash the host. No faked-output test can catch that.
 *
 * This test drives the REAL `createUIContext` → REAL pi-tui Editor render with
 * the REAL pi theme, and asserts the editor actually paints (panel_data frames
 * are produced). It always uses the repository-pinned runtime that the app
 * ships; a missing install is a failed compatibility gate, not a skip.
 */
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importPi, importPiTui, initHostTheme } from "./bootstrap.mjs";
import { buildEditorTheme } from "./editor-theme.mjs";
import { createUIContext } from "./ui-context.mjs";

const PINNED_PI_VERSION = "1.0.0";
const REPOSITORY_PINNED_PI_CLI = fileURLToPath(
  new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);

function resolvePinnedPiCli() {
  const override = process.env.PIVIS_TEST_PINNED_PI_CLI;
  const candidate = override?.trim() || REPOSITORY_PINNED_PI_CLI;
  if (!existsSync(candidate)) {
    throw new Error(
      `Pinned Pi CLI not found at ${candidate}; install repository dependencies or set PIVIS_TEST_PINNED_PI_CLI`,
    );
  }
  return realpathSync(candidate);
}

const PI_BIN = resolvePinnedPiCli();

// A capturing panel bridge: records the wire messages ensureUnifiedTui() emits,
// AND wires input routing so a test can feed keystrokes through the real
// HostTerminal (StdinBuffer + kitty negotiator) into the real TUI editor.
function makeCapturingBridge() {
  const messages = [];
  let counter = 0;
  // panelId -> { inputHandler, inputFence }. hostTerminal.start() registers both
  // the dataHandler and the renderer-generation parser fence
  // (which runs the negotiator + StdinBuffer); feedInput() drives it so a test
  // can simulate xterm keystrokes / negotiation replies byte-for-byte.
  const handlers = new Map();
  return {
    messages,
    handlers,
    openPanel({ overlay, unified }) {
      const id = ++counter;
      handlers.set(id, { inputHandler: null, inputFence: null, resizeHandler: null });
      messages.push({ type: "panel_open", panelId: id, overlay, unified });
      return id;
    },
    writePanel(panelId, data) {
      messages.push({ type: "panel_data", panelId, data });
    },
    closePanel(panelId) {
      messages.push({ type: "panel_close", panelId });
    },
    setPanelMode(panelId, mode) {
      messages.push({ type: "panel_mode", panelId, mode });
    },
    setInputHandler(panelId, handler) {
      const p = handlers.get(panelId);
      if (p) p.inputHandler = handler;
    },
    clearInputHandler(panelId) {
      const p = handlers.get(panelId);
      if (p) p.inputHandler = null;
    },
    setInputFence(panelId, fence) {
      const p = handlers.get(panelId);
      if (p) p.inputFence = fence;
    },
    clearInputFence(panelId) {
      const p = handlers.get(panelId);
      if (p) p.inputFence = null;
    },
    feedInput(panelId, data) {
      const p = handlers.get(panelId);
      p?.inputHandler?.(data);
    },
    fenceAll() {
      for (const p of handlers.values()) p.inputFence?.();
    },
    setResizeHandler(panelId, handler) {
      const p = handlers.get(panelId);
      if (p) p.resizeHandler = handler;
    },
    clearResizeHandler(panelId) {
      const p = handlers.get(panelId);
      if (p) p.resizeHandler = null;
    },
    // Drive a panel resize the way the renderer does (force=true on remount).
    resize(panelId, cols, rows, force = false) {
      const p = handlers.get(panelId);
      p?.resizeHandler?.(cols, rows, force);
    },
    setCanceller() {},
    cancel() {},
    closeAll() {
      return false;
    },
  };
}

describe("unified-TUI host render (repository-pinned pi-tui + pi theme)", () => {
  let pi;
  let piTui;
  let theme;
  let controllers;

  afterEach(() => {
    // Tear down any TUI we created so its render timer doesn't outlive the test.
    for (const c of controllers ?? []) {
      try {
        c.dispose();
      } catch {
        /* already disposed */
      }
    }
    controllers = [];
  });

  async function setup() {
    pi = await importPi(PI_BIN);
    piTui = await importPiTui(PI_BIN);
    expect(pi.VERSION).toBe(PINNED_PI_VERSION);
    expect(typeof piTui.TuiMainScreen).toBe("function");
    theme = initHostTheme(pi);
    controllers = [];
  }

  function tuiModules() {
    return {
      TuiMainScreen: piTui.TuiMainScreen,
      KeybindingsManager: piTui.KeybindingsManager,
      TUI_KEYBINDINGS: piTui.TUI_KEYBINDINGS,
      Container: piTui.Container,
      Editor: piTui.Editor,
      truncateToWidth: piTui.truncateToWidth,
      visibleWidth: piTui.visibleWidth,
      // Kitty keyboard protocol exports (pi-tui public index). Their presence is
      // what enables negotiation in createUIContext (feature-detected). The I9
      // case builds a modules object WITHOUT these to prove graceful fallback.
      setKittyProtocolActive: piTui.setKittyProtocolActive,
      StdinBuffer: piTui.StdinBuffer,
      isKeyRelease: piTui.isKeyRelease,
    };
  }

  it("the EditorTheme the host builds satisfies pi-tui's Editor contract (the raw theme does NOT)", async () => {
    await setup();
    const editorTheme = buildEditorTheme(pi, theme);
    // The load-bearing invariant pi-tui's Editor depends on.
    expect(typeof editorTheme.borderColor).toBe("function");
    expect(() => editorTheme.borderColor("─")).not.toThrow();
    // Document the bug: the raw full pi Theme — what the host used to pass
    // straight into `new Editor(tui, theme)` — is NOT a valid EditorTheme.
    expect(typeof theme.borderColor).not.toBe("function");
  });

  it("a factory setWidget builds a real TUI whose Editor + widgets actually render (panel_data is produced)", async () => {
    await setup();
    const bridge = makeCapturingBridge();
    const editorTheme = buildEditorTheme(pi, theme);

    const bundle = createUIContext({
      theme,
      editorTheme,
      panelBridge: bridge,
      createDialog: async () => ({}),
      sendToMain: () => {},
      tuiModules: tuiModules(),
    });
    const { context, unified } = bundle;
    controllers.push(unified);

    // A fleet-list-shaped factory: returns a pi-tui component (render → string[]).
    context.setWidget(
      "fleet-list",
      () => ({
        render: () => ["▸ Fleet (2 agents)", "  ● swift-otter   running"],
        invalidate() {},
        dispose() {},
      }),
      { placement: "belowEditor" },
    );

    // A unified panel must have opened.
    const open = bridge.messages.find((m) => m.type === "panel_open");
    expect(open, "ensureUnifiedTui must open a unified panel").toBeTruthy();
    expect(open.unified).toBe(true);

    // Let pi-tui's render loop tick. With the BAD theme this throws inside the
    // render timer (no frames); with the fix it paints repeatedly.
    await new Promise((r) => setTimeout(r, 350));

    const frames = bridge.messages.filter((m) => m.type === "panel_data");
    expect(frames.length, "the Editor + widgets must render at least one frame").toBeGreaterThan(0);

    // The widget content the factory produced must reach the panel output —
    // proves the whole composite tree (widgetBelow + editor) rendered, not just
    // a blank screen-clear.
    const painted = frames.map((f) => f.data).join("");
    expect(painted).toContain("Fleet");
  });

  it("publishes a trailing-blank frame together with its final editor cursor position", async () => {
    await setup();
    const bridge = makeCapturingBridge();
    const bundle = createUIContext({
      theme,
      editorTheme: buildEditorTheme(pi, theme),
      panelBridge: bridge,
      createDialog: async () => ({}),
      sendToMain: () => {},
      tuiModules: tuiModules(),
    });
    const { context, unified } = bundle;
    controllers.push(unified);

    context.setWidget(
      "trailing-blank",
      () => ({ render: () => ["TRAILING BLANK PAINT", "", ""] }),
      { placement: "belowEditor" },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const paint = bridge.messages.find(
      (message) => message.type === "panel_data" && message.data.includes("TRAILING BLANK PAINT"),
    );
    expect(paint, "the trailing-blank widget must paint").toBeTruthy();
    const synchronizedEnd = paint.data.indexOf("\x1b[?2026l");
    expect(synchronizedEnd).toBeGreaterThanOrEqual(0);
    expect(
      paint.data.slice(synchronizedEnd + "\x1b[?2026l".length),
      "the renderer must not receive the frame before pi-tui moves the cursor back to the editor",
    ).toMatch(/\[\d+A.*\[\d+G/);
  });

  it("contains a throwing extension render and remains able to paint a healthy replacement", async () => {
    await setup();
    const bridge = makeCapturingBridge();
    const notifications = [];
    const { context, unified } = createUIContext({
      theme,
      editorTheme: buildEditorTheme(pi, theme),
      panelBridge: bridge,
      createDialog: async () => ({}),
      sendToMain: (message) => notifications.push(message),
      tuiModules: tuiModules(),
    });
    controllers.push(unified);

    context.setWidget("unstable", () => ({
      render() {
        throw new Error("extension paint exploded");
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const failedPaint = bridge.messages
      .filter((message) => message.type === "panel_data")
      .map((message) => message.data)
      .join("");
    expect(failedPaint).toContain('Extension widget "unstable" render failed');
    expect(
      notifications.filter(
        (message) =>
          message.method === "notify" && message.message.includes("extension paint exploded"),
      ),
    ).toHaveLength(1);

    const replacementStart = bridge.messages.length;
    context.setWidget("unstable", () => ({ render: () => ["healthy replacement"] }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const replacementPaint = bridge.messages
      .slice(replacementStart)
      .filter((message) => message.type === "panel_data")
      .map((message) => message.data)
      .join("");
    expect(replacementPaint).toContain("healthy replacement");
  });

  it("custom() overlay on the unified TUI emits panel_mode viewport→content (the wiggle fix)", async () => {
    await setup();
    const bridge = makeCapturingBridge();
    const editorTheme = buildEditorTheme(pi, theme);

    const { context, unified } = createUIContext({
      theme,
      editorTheme,
      panelBridge: bridge,
      createDialog: async () => ({}),
      sendToMain: () => {},
      tuiModules: tuiModules(),
    });
    controllers.push(unified);

    // Build the unified TUI so custom() takes the REUSE path (overlay on the
    // shared TUI) — the path the pi-subagents "inspect" box exercises.
    context.setWidget(
      "fleet-list",
      () => ({ render: () => ["▸ Fleet"], invalidate() {}, dispose() {} }),
      { placement: "belowEditor" },
    );

    // Open a custom() overlay (the inspector box). Capture done() to close it.
    let closeOverlay;
    const overlay = context.custom((_tui, _theme, _kb, done) => {
      closeOverlay = done;
      return {
        render: () => ["┌─ inspect ─┐", "│ agent     │", "└───────────┘"],
        invalidate() {},
        dispose() {},
      };
    }, {});

    // showOverlay runs after the factory promise resolves — let it tick.
    await new Promise((r) => setTimeout(r, 50));
    const modesWhileOpen = bridge.messages.filter((m) => m.type === "panel_mode");
    expect(
      modesWhileOpen.some((m) => m.mode === "viewport"),
      "showing the overlay must pin the renderer to viewport mode",
    ).toBe(true);

    // Close the overlay → the renderer must be released back to content mode.
    closeOverlay(undefined);
    await overlay;
    const modes = bridge.messages.filter((m) => m.type === "panel_mode");
    expect(modes[modes.length - 1].mode, "closing the overlay must restore content mode").toBe(
      "content",
    );
  });

  // ── Kitty keyboard protocol ────────────────────────────────────────────
  // The unified TUI is NOT a pty: it renders pi-tui into the renderer's xterm
  // over the panel wire. For Shift+Enter to be distinguishable from Enter the
  // host performs the kitty handshake (byte-for-byte parity with pi's
  // ProcessTerminal) over panel_data/panel_input. These prove the host half:
  // the handshake writes, xterm's replies are filtered, kitty decode activates,
  // and the editor sees the right keys. The renderer half (xterm 6.1 emitting
  // CSI-u) is covered by the e2e + render suites.

  /** Build a fresh unified TUI wired to a functional capturing bridge. */
  async function buildKittyTui(modules) {
    await setup();
    const activeModules = modules ?? tuiModules();
    const bridge = makeCapturingBridge();
    const editorTheme = buildEditorTheme(pi, theme);
    const sent = [];
    const bundle = createUIContext({
      theme,
      editorTheme,
      panelBridge: bridge,
      createDialog: async () => ({}),
      sendToMain: (m) => sent.push(m),
      tuiModules: activeModules,
    });
    const { context, unified } = bundle;
    controllers.push(unified);
    context.setWidget(
      "kitty-editor",
      () => ({ render: () => ["kitty TUI"], invalidate() {}, dispose() {} }),
      { placement: "belowEditor" },
    );
    const panelId = bridge.messages.find((m) => m.type === "panel_open").panelId;
    // Let the first render tick fire so the editor is fully wired.
    await new Promise((r) => setTimeout(r, 60));
    return { bridge, context, state: bundle.state, unified, panelId, sent };
  }

  /** StdinBuffer may buffer an incomplete tail; flush anything pending. */
  async function flushStdin() {
    await new Promise((r) => setTimeout(r, 30));
  }

  it("start() writes the kitty handshake over the panel wire (bracketed paste + push + query + DA)", async () => {
    const { bridge } = await buildKittyTui();
    const written = bridge.messages
      .filter((m) => m.type === "panel_data")
      .map((m) => m.data)
      .join("");
    expect(written).toContain("\x1b[?2004h"); // bracketed paste
    expect(written).toContain("\x1b[>7u"); // push flags
    expect(written).toContain("\x1b[?u"); // query current flags
    expect(written).toContain("\x1b[c"); // DA sentinel
  });

  it("a nonzero kitty reply activates decode and NEVER leaks to the editor", async () => {
    const { bridge, panelId, context } = await buildKittyTui();
    // Reset pi-tui's module global first so this is a clean observation.
    piTui.setKittyProtocolActive(false);
    bridge.feedInput(panelId, "\x1b[?7u");
    await flushStdin();
    expect(piTui.isKittyProtocolActive(), "nonzero kitty reply must activate decode").toBe(true);
    // The reply must not reach the editor as literal text.
    expect(context.getEditorText()).toBe("");
  });

  it("Shift+Enter (CSI-u) inserts a newline and NEVER submits", async () => {
    const { bridge, panelId, context, sent } = await buildKittyTui();
    bridge.feedInput(panelId, "\x1b[?7u"); // activate kitty
    bridge.feedInput(panelId, "\x1b[13;2u"); // Shift+Enter
    await flushStdin();
    expect(context.getEditorText()).toContain("\n");
    expect(
      sent.filter((m) => m.type === "unified_submit_request"),
      "Shift+Enter must not submit",
    ).toHaveLength(0);
  });

  it("plain Enter emits exactly one submit", async () => {
    const { bridge, panelId, sent, state } = await buildKittyTui();
    state.applyEditorPatch({
      baseRevision: -1,
      revision: 1,
      text: "conflicting primary",
      attachments: [],
      alternateConflictText: "alternate",
      alternateConflictAttachments: [],
      additionalConflictCandidates: [{ text: "third", attachments: [] }],
    });
    bridge.feedInput(panelId, "abc");
    // This is the host.mjs ordering: the mirror microtask observes the Editor
    // before the acknowledgement samples its lightweight checkpoint.
    await Promise.resolve();
    expect(state.panelInputEditorCheckpoint()).toMatchObject({
      revision: 1,
      text: "abc",
      clearedConflicts: true,
    });
    expect(state.editorSnapshot()).not.toHaveProperty("conflictText");
    expect(state.panelInputEditorCheckpoint()).toMatchObject({
      revision: 1,
      text: "abc",
      clearedConflicts: false,
    });
    bridge.feedInput(panelId, "\r");
    await Promise.resolve();
    expect(state.panelInputEditorCheckpoint()).toMatchObject({
      revision: 2,
      text: "",
      clearedConflicts: false,
    });
    await flushStdin();
    expect(sent.filter((m) => m.type === "unified_submit_request")).toHaveLength(1);
    expect(sent.find((m) => m.type === "unified_submit_request")?.postClearEditor).toMatchObject({
      revision: 2,
      text: "",
    });
  });

  it("keeps input live while an older submit is unsettled and never restores it on bail", async () => {
    const { bridge, panelId, context, unified, sent } = await buildKittyTui();
    bridge.feedInput(panelId, "first prompt");
    bridge.feedInput(panelId, "\r");
    await flushStdin();
    const first = sent.find((message) => message.type === "unified_submit_request");
    expect(first).toMatchObject({ text: "first prompt", editorRevision: 0 });

    bridge.feedInput(panelId, "newer draft");
    await flushStdin();
    expect(context.getEditorText()).toBe("newer draft");
    unified.resolveSubmit(first.id, { ok: false, bailed: true });
    expect(context.getEditorText()).toBe("newer draft");

    bridge.feedInput(panelId, "\r");
    await flushStdin();
    const requests = sent.filter((message) => message.type === "unified_submit_request");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ text: "newer draft" });
    expect(requests[1].editorRevision).toBeGreaterThan(first.editorRevision);
  });

  it("a press+release Enter cycle emits exactly ONE submit (flag 2 release events are filtered)", async () => {
    const { bridge, panelId, sent } = await buildKittyTui();
    bridge.feedInput(panelId, "\x1b[?7u");
    bridge.feedInput(panelId, "\r"); // press (xterm sends legacy \r under kitty)
    bridge.feedInput(panelId, "\x1b[13;1:3u"); // release
    await flushStdin();
    expect(sent.filter((m) => m.type === "unified_submit_request")).toHaveLength(1);
  });

  it("a bracketed multiline paste inserts the lines and NEVER submits", async () => {
    const { bridge, panelId, context, sent } = await buildKittyTui();
    bridge.feedInput(panelId, "\x1b[200~line1\nline2\nline3\x1b[201~");
    await flushStdin();
    const text = context.getEditorText();
    expect(text).toContain("line1");
    expect(text).toContain("line2");
    expect(text).toContain("line3");
    expect(
      sent.filter((m) => m.type === "unified_submit_request"),
      "a paste must never submit on a newline",
    ).toHaveLength(0);
  });

  it("a renderer detach drops incomplete paste and delayed escape state before successor input", async () => {
    const { bridge, panelId, context, sent } = await buildKittyTui();
    const observed = [];
    const unsubscribe = context.onTerminalInput((data) => {
      observed.push(data);
    });

    // The paste terminator can be lost with the predecessor renderer. Without
    // the fence, StdinBuffer remains in pasteMode forever and absorbs all input
    // from the successor renderer.
    bridge.feedInput(panelId, "\x1b[200~predecessor paste");
    bridge.fenceAll();
    bridge.feedInput(panelId, "successor");
    await flushStdin();
    expect(context.getEditorText()).toBe("successor");

    // Bare Escape has a delayed StdinBuffer flush. It must not mutate the TUI
    // after detach or reach an extension input listener in the next generation.
    const observedBeforeEscape = observed.length;
    bridge.feedInput(panelId, "\x1b");
    bridge.fenceAll();
    await flushStdin();
    expect(observed).toHaveLength(observedBeforeEscape);

    // Once StdinBuffer times out an incomplete negotiation prefix, the
    // negotiator owns a separate 150ms delayed flush. The same detach fence
    // must cancel that second-stage predecessor timer as well.
    bridge.feedInput(panelId, "\x1b[?");
    await flushStdin();
    bridge.fenceAll();
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(observed).toHaveLength(observedBeforeEscape);

    bridge.feedInput(panelId, "\r");
    await flushStdin();
    expect(sent.filter((message) => message.type === "unified_submit_request")).toHaveLength(1);
    expect(sent.find((message) => message.type === "unified_submit_request")?.text).toBe(
      "successor",
    );
    unsubscribe();
  });

  it("a forced resize re-pushes the handshake (kitty survives an xterm remount)", async () => {
    const { bridge, panelId } = await buildKittyTui();
    const before = bridge.messages.filter((m) => m.type === "panel_data").length;
    bridge.resize(panelId, 90, 30, true); // force = remount
    await flushStdin();
    const written = bridge.messages
      .slice(before)
      .filter((m) => m.type === "panel_data")
      .map((m) => m.data)
      .join("");
    expect(written, "a force-resize must re-write the handshake").toContain("\x1b[>7u");
  });

  it("an old pi-tui without the kitty exports performs NO negotiation and still works (I9)", async () => {
    // Strip the kitty exports entirely — feature detection must yield a null gate.
    const stripped = tuiModules();
    delete stripped.setKittyProtocolActive;
    delete stripped.StdinBuffer;
    delete stripped.isKeyRelease;
    const { bridge, panelId, sent } = await buildKittyTui(stripped);
    const written = bridge.messages
      .filter((m) => m.type === "panel_data")
      .map((m) => m.data)
      .join("");
    expect(written, "no kitty exports ⇒ no negotiation bytes").not.toContain("\x1b[>7u");
    // Typing + Enter still work (plain pass-through).
    bridge.feedInput(panelId, "hi");
    bridge.feedInput(panelId, "\r");
    await flushStdin();
    expect(sent.filter((m) => m.type === "unified_submit_request")).toHaveLength(1);
  });

  it("a bare \n with kitty active is reinterpreted as shift+enter (newline), documenting the legacy mapping", async () => {
    const { bridge, panelId, context, sent } = await buildKittyTui();
    bridge.feedInput(panelId, "\x1b[?7u"); // activate kitty → keys.js reinterprets bare \n
    // Flush the reply first so kitty is active before the bare newline arrives.
    await flushStdin();
    const before = context.getEditorText();
    bridge.feedInput(panelId, "\n");
    await flushStdin();
    // Pin the documented behavior: bare \n under kitty-active maps to a newline
    // (shift+enter), NOT a submit. This is the reinterpretation the risk note
    // asked us to audit and pin.
    expect(context.getEditorText(), "bare \n must insert a newline, not submit").not.toBe(before);
    expect(
      sent.filter((m) => m.type === "unified_submit_request"),
      "bare \n under kitty must not submit",
    ).toHaveLength(0);
  });

  it("two custom() panels negotiate kitty independently; closing one keeps decode for the other (I12)", async () => {
    // Each standalone custom() panel gets its OWN HostTerminal + negotiator,
    // but they SHARE the refcounted gate. This proves closing panel A does NOT
    // disable kitty decode for panel B (the refcount invariant).
    await setup();
    const bridge = makeCapturingBridge();
    const editorTheme = buildEditorTheme(pi, theme);
    const { context } = createUIContext({
      theme,
      editorTheme,
      panelBridge: bridge,
      createDialog: async () => ({}),
      sendToMain: () => {},
      tuiModules: tuiModules(),
    });
    piTui.setKittyProtocolActive(false);

    // A factory that captures its `done` so the test can close each panel.
    const dones = [];
    const factoryCapturingDone = (_t, _th, _kb, done) => {
      dones.push(done);
      return { render: () => ["custom panel"], invalidate() {}, dispose() {} };
    };

    // Open two standalone custom panels (no unified TUI ⇒ standalone path).
    const p1 = context.custom(factoryCapturingDone, {});
    const p2 = context.custom(factoryCapturingDone, {});
    await new Promise((r) => setTimeout(r, 80));

    // Two panels opened, each with its own handshake push.
    const opens = bridge.messages.filter((m) => m.type === "panel_open");
    expect(opens, "two custom panels must open").toHaveLength(2);
    const written = bridge.messages
      .filter((m) => m.type === "panel_data")
      .map((m) => m.data)
      .join("");
    // Each panel pushed the handshake once.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is the CSI introducer — counting kitty push bytes
    expect(written.match(/\x1b\[>7u/g), "each panel pushes the handshake").toHaveLength(2);

    // Panel A negotiates kitty → gate activates.
    bridge.feedInput(opens[0].panelId, "\x1b[?7u");
    await flushStdin();
    expect(piTui.isKittyProtocolActive(), "panel A activates kitty").toBe(true);

    // Panel B negotiates kitty → gate stays active (refcount 2).
    bridge.feedInput(opens[1].panelId, "\x1b[?7u");
    await flushStdin();
    expect(piTui.isKittyProtocolActive(), "panel B keeps kitty active").toBe(true);

    // Close panel A → kitty must STILL be active (panel B needs it). This is I12.
    dones[0](undefined);
    await p1;
    await flushStdin();
    expect(
      piTui.isKittyProtocolActive(),
      "closing panel A must NOT disable kitty for panel B",
    ).toBe(true);

    // Close panel B → refcount hits 0 → kitty deactivated (cleanup, I13).
    dones[1](undefined);
    await p2;
    await flushStdin();
    expect(piTui.isKittyProtocolActive(), "closing the last panel deactivates kitty").toBe(false);
  });
});
