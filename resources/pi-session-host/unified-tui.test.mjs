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
 * passed pi's Theme singleton to `new Editor(tui, theme)`, but pi-tui's Editor
 * needs an `EditorTheme` ({ borderColor:(s)=>string, selectList }), so
 * `Editor.render()` threw `this.borderColor is not a function` on the first
 * render tick — the panel opened (Composer replaced) but produced no output and
 * could crash the host. No faked-output test can catch that.
 *
 * This test drives the REAL `createUIContext` → REAL pi-tui Editor render with
 * the REAL pi theme, and asserts the editor actually paints (panel_data frames
 * are produced). It needs a real pi install; when pi can't be resolved it
 * SKIPS (like the PI_E2E gate) rather than failing.
 */
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { importPi, importPiTui } from "./bootstrap.mjs";
import { buildEditorTheme } from "./editor-theme.mjs";
import { createUIContext } from "./ui-context.mjs";

// ── Locate a real pi binary (skip the suite if absent) ──────────────────────
function locatePiBin() {
  const candidates = [];
  if (process.env.PIVIS_TEST_PI_BIN) candidates.push(process.env.PIVIS_TEST_PI_BIN);
  try {
    candidates.push(execSync("command -v pi", { encoding: "utf8" }).trim());
  } catch {
    /* pi not on PATH */
  }
  candidates.push("/opt/homebrew/bin/pi", "/usr/local/bin/pi");
  for (const c of candidates) {
    if (c && existsSync(c)) {
      try {
        return realpathSync(c);
      } catch {
        /* dangling symlink */
      }
    }
  }
  return null;
}

const PI_BIN = locatePiBin();

// THEME_KEY mirrors bootstrap.mjs initHostTheme — read the global theme the
// way the host does, without a private import.
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// A capturing panel bridge: records the wire messages ensureUnifiedTui() emits,
// AND wires input routing so a test can feed keystrokes through the real
// HostTerminal (StdinBuffer + kitty negotiator) into the real TUI editor.
function makeCapturingBridge() {
  const messages = [];
  let counter = 0;
  // panelId -> { inputHandler }. hostTerminal.start() registers the dataHandler
  // (which runs the negotiator + StdinBuffer); feedInput() drives it so a test
  // can simulate xterm keystrokes / negotiation replies byte-for-byte.
  const handlers = new Map();
  return {
    messages,
    handlers,
    openPanel({ overlay, unified }) {
      const id = ++counter;
      handlers.set(id, { inputHandler: null, resizeHandler: null });
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
    feedInput(panelId, data) {
      const p = handlers.get(panelId);
      p?.inputHandler?.(data);
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

const describeOrSkip = PI_BIN ? describe : describe.skip;

describeOrSkip("unified-TUI host render (real pi-tui + pi theme)", () => {
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
    pi.initTheme();
    theme = globalThis[THEME_KEY] ?? globalThis[THEME_KEY_OLD];
    controllers = [];
  }

  function tuiModules() {
    return {
      TUI: piTui.TUI,
      KeybindingsManager: piTui.KeybindingsManager,
      TUI_KEYBINDINGS: piTui.TUI_KEYBINDINGS,
      Container: piTui.Container,
      Editor: piTui.Editor,
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
    // Document the bug: the raw pi theme singleton — what the host used to pass
    // straight into `new Editor(tui, theme)` — is NOT a valid EditorTheme.
    expect(typeof theme.borderColor).not.toBe("function");
  });

  it("a factory setWidget builds a real TUI whose Editor + widgets actually render (panel_data is produced)", async () => {
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
  async function buildKittyTui(modules = tuiModules()) {
    await setup();
    const bridge = makeCapturingBridge();
    const editorTheme = buildEditorTheme(pi, theme);
    const sent = [];
    const { context, unified } = createUIContext({
      theme,
      editorTheme,
      panelBridge: bridge,
      createDialog: async () => ({}),
      sendToMain: (m) => sent.push(m),
      tuiModules: modules,
    });
    controllers.push(unified);
    context.setWidget(
      "kitty-editor",
      () => ({ render: () => ["kitty TUI"], invalidate() {}, dispose() {} }),
      { placement: "belowEditor" },
    );
    const panelId = bridge.messages.find((m) => m.type === "panel_open").panelId;
    // Let the first render tick fire so the editor is fully wired.
    await new Promise((r) => setTimeout(r, 60));
    return { bridge, context, unified, panelId, sent };
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
    const { bridge, panelId, sent } = await buildKittyTui();
    bridge.feedInput(panelId, "abc");
    bridge.feedInput(panelId, "\r");
    await flushStdin();
    expect(sent.filter((m) => m.type === "unified_submit_request")).toHaveLength(1);
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

// Surface, at import time, why the suite skipped — so a CI run without pi
// doesn't look like silent green.
if (!PI_BIN) {
  // eslint-disable-next-line no-console
  console.warn(
    "[unified-tui.test] skipped: no pi binary found (set PIVIS_TEST_PI_BIN to run the host-render gate)",
  );
}
