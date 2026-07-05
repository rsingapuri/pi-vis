/**
 * pi-session-host: ExtensionUIContext implementation (mode:"tui").
 *
 * Provides the full ~30-method interface that extensions use.
 *
 * Working methods (pi-vis renders these):
 *   select, confirm, input, editor → dialogs (routed to main process)
 *   notify, setStatus, setWidget, setTitle, setEditorText → fire-and-forget
 *
 * TUI-only methods (safe no-ops — must not throw):
 *   setFooter, setHeader, onTerminalInput, setWorkingIndicator,
 *   setEditorComponent, addAutocompleteProvider, setWorkingMessage,
 *   setWorkingVisible, setHiddenThinkingLabel, pasteToEditor,
 *   getEditorText, getEditorComponent, getToolsExpanded, setToolsExpanded
 *
 * custom() → the panel bridge (writes ANSI to main process)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Dialog resolver (promise-based, one-at-a-time) ───────────────────────────

export function createDialogResolver(sendToMain) {
  // P3-b: queue outstanding dialogs by id (not a single-slot) so a second
  // dialog overlapping the first can't silently overwrite its resolver.
  // Trust resolution is serial today (init is a serial await chain), so this
  // is hardening — but the single-slot was a latent hang if pi ever issues
  // concurrent selects. The id comes from createDialog's `${method}_${Date.now()}`
  // and is echoed back inside the ExtensionUiResponse (response.id), so resolve
  // matches the right promise regardless of completion order.
  /** @type {Map<string, { resolve: (r: unknown) => void }>} */
  const pending = new Map();

  const resolve = (response) => {
    const id = response?.id;
    // Match by id; fall back to the single in-flight dialog if absent (defensive).
    const d = id ? pending.get(id) : pending.size ? [...pending.values()][0] : null;
    if (!d) return;
    if (id) pending.delete(id);
    else pending.clear();
    d.resolve(response);
  };

  let nextDialogId = 0;

  const createDialog = (method, title, { message, options, placeholder, prefill, opts } = {}) => {
    return new Promise((resolveFn) => {
      const id = `${method}_${Date.now()}_${++nextDialogId}`;
      pending.set(id, { resolve: resolveFn });
      sendToMain({
        type: "extension_ui_request",
        id,
        method,
        title,
        ...(message !== undefined ? { message } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(prefill !== undefined ? { prefill } : {}),
        ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
      });
    });
  };

  return { resolve, createDialog };
}

// ─── Main uiContext factory ───────────────────────────────────────────────────

/**
 * Create a full ExtensionUIContext for mode:"tui".
 *
 * @param {object} deps
 * @param {object} deps.theme - pi's theme singleton (from initHostTheme)
 * @param {object} deps.panelBridge - { openPanel, writePanel, closePanel } for custom()
 * @param {function} deps.createDialog - (method, title, opts) => Promise
 * @param {function} deps.sendToMain - sends messages to the Electron main process
 * @param {object} deps.tuiModules - { TUI, KeybindingsManager, TUI_KEYBINDINGS } from pi-tui
 */
export function createUIContext({
  theme,
  editorTheme,
  panelBridge,
  createDialog,
  sendToMain,
  tuiModules,
}) {
  const { TUI, KeybindingsManager, TUI_KEYBINDINGS, Container, Editor } = tuiModules;
  const invocationSurface = new AsyncLocalStorage();

  const runWithInvocationSurface = (surface, fn) => {
    if (surface !== "composer" && surface !== "unified") return fn();
    return invocationSurface.run(surface, fn);
  };

  // pi-tui's base `Editor` expects an `EditorTheme` ({ borderColor:(s)=>string,
  // selectList }), NOT pi's full Theme singleton. Passing the singleton makes
  // `Editor.render()` throw `this.borderColor is not a function` on the FIRST
  // render tick — the unified TUI then never paints (and the throw in pi-tui's
  // render timer can take the host down). pi builds this exact object via its
  // (non-exported) getEditorTheme(); host.mjs reconstructs it from pi's PUBLIC
  // surface (theme.fg + getSelectListTheme) and passes it as `editorTheme`.
  // Fall back to a minimal identity adapter so a missing dep degrades to an
  // unstyled-but-working editor instead of a crash.
  const resolvedEditorTheme = editorTheme ?? {
    borderColor: (s) => s,
    selectList: undefined,
  };

  // Keybindings for the unified TUI. Only app.clipboard.pasteImage is
  // included — it is matched by the paste input-listener in ensureUnifiedTui().
  // app.clear (Ctrl+C) and app.interrupt (Escape) are DELIBERATELY OMITTED:
  // they are dispatched by pi's PRIVATE CustomEditor (an interactive-mode
  // internal the host cannot import — host-imports.test.ts forbids reaching
  // into pi's compiled modes tree), and the public base Editor used here
  // ignores app.* actions entirely. The base Editor already handles
  // Ctrl+C-with-selection as copy and leaves a bare Ctrl+C alone; Escape
  // cancels autocomplete via the editor's own tui.* bindings.
  const UNIFIED_KEYBINDINGS = {
    ...TUI_KEYBINDINGS,
    "app.clipboard.pasteImage": {
      defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v",
    },
  };

  // ─── Unified TUI state (one per uiContext) ────────────────────────────────────────

  let unifiedTuiState = null;

  // Pending unified-submit snapshots: id → submitted text (restored on a guard
  // bail). Plain text, not a {snapshot,resolve} object — submit is fire-and-
  // forget (the renderer reports the outcome asynchronously via host.mjs).
  const pendingSubmits = new Map();

  // Pending clipboard-image read ids. Fire-and-forget; tracked so a late reply
  // arriving after teardown is a no-op rather than a phantom editor insert.
  const pendingClipboardReads = new Set();

  // onTerminalInput handlers live host-side, decoupled from TUI lifetime so a
  // /reload-induced TUI recreate re-attaches them to the fresh TUI. Each entry
  // is { handler, unsubscribe }.
  const terminalInputHandlers = new Set();

  // ─── Unified TUI lifecycle ─────────────────────────────────────────────────────

  function ensureUnifiedTui() {
    if (unifiedTuiState) return;

    const panelId = panelBridge.openPanel({ overlay: false, unified: true });
    const hostTerminal = createHostTerminal(panelId, panelBridge);
    const tui = new TUI(hostTerminal);
    // Local manager used ONLY by the paste input-listener below to detect the
    // paste-image key. Not installed globally — the base Editor keeps using
    // pi-tui's default keybindings for its own tui.* handling.
    const pasteKeybindings = new KeybindingsManager(UNIFIED_KEYBINDINGS);
    tui.start();

    // Build layout: [widgetAbove, editorContainer, widgetBelow]
    const widgetAbove = new Container();
    const editorContainer = new Container();
    const widgetBelow = new Container();

    const editor = new Editor(tui, resolvedEditorTheme);
    editorContainer.addChild(editor);

    // Set TUI children to reproduce pi's two-container layout
    tui.children = [widgetAbove, editorContainer, widgetBelow];
    tui.setFocus(editor);

    // Re-attach every onTerminalInput handler registered before/around this
    // TUI's lifetime. addInputListener returns the unsubscribe we hold for a
    // clean detach on the next recreate/dispose.
    for (const entry of terminalInputHandlers) {
      entry.unsubscribe = tui.addInputListener(entry.handler);
    }

    // Wire resize handler. `force` is sent by UnifiedTuiHost when its xterm
    // remounts after a session/view switch: the renderer intentionally starts
    // from a clean terminal, so the host must discard pi-tui's differential
    // render state and send a complete repaint instead of a cursor-relative
    // diff against the old, now-disposed xterm.
    panelBridge.setResizeHandler(panelId, (cols, rows, force) => {
      hostTerminal.resize(cols, rows);
      tui.requestRender(force === true);
    });

    // Store state
    unifiedTuiState = {
      tui,
      editor,
      widgetAbove,
      widgetBelow,
      panelId,
      components: new Map(),
      widgetFactories: new Map(),
    };

    // Editor submit → ask the renderer to run the shared submit pipeline, then
    // report the outcome so a guard bail can restore the text. Pi's
    // Editor.submitValue() clears the editor synchronously BEFORE invoking
    // onSubmit, so the editor is already empty by the time this fires; the text
    // captured here is what gets restored on bail.
    editor.onSubmit = (text) => {
      const id = crypto.randomUUID();
      pendingSubmits.set(id, text);
      sendToMain({ type: "unified_submit_request", id, text });
    };

    // Clipboard image paste (Ctrl+V / Alt+V). pi wires this on its PRIVATE
    // CustomEditor (onPasteImage + app.clipboard.pasteImage), which the host
    // cannot import. The public base Editor has no paste-image handling, so we
    // drive it through the input-listener chain: this listener runs BEFORE the
    // focused editor (tui.handleInput iterates inputListeners first) and
    // consumes the key. The clipboard read is an async round-trip to the main
    // process; the temp-file path is inserted when it resolves (fire-and-forget
    // — parity with pi, whose onPasteImage is also unawaited).
    tui.addInputListener((data) => {
      if (!pasteKeybindings.matches(data, "app.clipboard.pasteImage")) return;
      const id = crypto.randomUUID();
      pendingClipboardReads.add(id);
      sendToMain({ type: "clipboard_read_image_request", id });
      return { consume: true };
    });
  }

  // ─── Unified-TUI submit/clipboard resolution ─────────────────────────────────────
  // Called by host.mjs when the main process replies to a unified_submit or
  // clipboard_read_image request. Exposed via the returned `unified` bundle
  // (NOT globalThis) so the wiring is explicit and unit-testable in isolation.

  function resolveUnifiedSubmit(id, result) {
    const snapshot = pendingSubmits.get(id);
    if (snapshot === undefined) return;
    pendingSubmits.delete(id);

    const { ok, bailed } = result;
    // On a guard bail, restore the prompt ONLY if the editor is still empty.
    // Pi cleared it synchronously in submitValue; if it's still empty the user
    // hasn't typed since, so the restore is lossless. If they DID type during
    // the round-trip, their new text wins — restoring would clobber it.
    if (!ok && bailed) {
      const editor = unifiedTuiState?.editor;
      if (editor && editor.getText() === "") {
        editor.setText(snapshot);
        unifiedTuiState.tui.requestRender();
      }
    }
  }

  function resolveClipboardImage(id, result) {
    if (!pendingClipboardReads.has(id)) return;
    pendingClipboardReads.delete(id);

    const { bytes, mimeType } = result;
    if (!bytes) return; // empty clipboard → nothing to insert

    const editor = unifiedTuiState?.editor;
    if (!editor) return; // TUI torn down between request and reply

    const extMap = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
    const ext = extMap[mimeType] || "png";
    // NOTE: temp files are not actively reaped (parity with pi's own TUI paste,
    // which also leaves them for the OS to reclaim from tmpdir). Bounded by
    // paste frequency and the LLM reading the path before tmpdir rotates.
    const tmpPath = path.join(os.tmpdir(), `pi-vis-clipboard-${id}.${ext}`);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(bytes, "base64"));
      editor.insertTextAtCursor(tmpPath);
      unifiedTuiState.tui.requestRender();
    } catch {
      /* best-effort — a failed write/insert must not crash the editor */
    }
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────────

  function disposeUnifiedTui() {
    if (!unifiedTuiState) return;
    const { tui, editor, panelId, components } = unifiedTuiState;

    // Detach onTerminalInput handlers from this TUI instance. They stay
    // registered (terminalInputHandlers) and re-attach to a fresh TUI if a
    // later setWidget factory recreates one; nilling the unsubscribe avoids a
    // stale detach on a disposed TUI.
    for (const entry of terminalInputHandlers) {
      try {
        entry.unsubscribe?.();
      } catch {
        /* unsubscribe already invalidated by tui.stop() */
      }
      entry.unsubscribe = null;
    }

    try {
      tui.stop();
    } catch {
      /* already stopped */
    }

    // Dispose widget components + the editor. The layout Containers
    // (widgetAbove/editorContainer/widgetBelow) are structural — pi-tui's
    // Container has no dispose(), so they need no explicit teardown.
    for (const { component } of components.values()) {
      try {
        component.dispose?.();
      } catch {
        /* ignore */
      }
    }
    try {
      editor.dispose?.();
    } catch {
      /* ignore */
    }

    // Drop in-flight submit/clipboard round-trips so a late main-process reply
    // after teardown is a no-op (the editor it would write to is gone).
    pendingSubmits.clear();
    pendingClipboardReads.clear();

    panelBridge.closePanel(panelId);
    unifiedTuiState = null;
  }

  const context = {
    // ── Dialogs (blocking — pi-vis renders UI) ──
    //
    // createDialog resolves with the raw ExtensionUiResponse wire object
    // ({type,id,value} | {confirmed} | {cancelled}). pi's ExtensionUIContext
    // contract, however, hands extensions UNWRAPPED values — a chosen string,
    // a boolean, or undefined on cancel. Returning the raw object instead made
    // extensions that compare the result (`choice === "Settings"`,
    // `choice.startsWith(...)`) throw or silently mismatch — e.g. pi-subagents
    // `/agents → Settings` died on `choice.startsWith` before opening the menu.
    // Unwrap here so the host is indistinguishable from pi's own uiContext.
    select: async (title, options, opts) => {
      const r = await createDialog("select", title, { options, opts });
      return r?.cancelled ? undefined : r?.value;
    },
    confirm: async (title, message, opts) => {
      const r = await createDialog("confirm", title, { message, opts });
      return r?.confirmed === true; // cancel / anything else → false
    },
    input: async (title, placeholder, opts) => {
      const r = await createDialog("input", title, { placeholder, opts });
      return r?.cancelled ? undefined : r?.value;
    },
    editor: async (title, prefill) => {
      const r = await createDialog("editor", title, { prefill });
      return r?.cancelled ? undefined : r?.value;
    },

    // ── Fire-and-forget notifications ──
    notify: (message, notifyType) => {
      sendToMain({
        type: "extension_ui_request",
        method: "notify",
        message,
        notifyType,
      });
    },
    setStatus: (key, text) => {
      sendToMain({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: key,
        statusText: text,
      });
    },
    setTitle: (title) => {
      sendToMain({
        type: "extension_ui_request",
        method: "setTitle",
        title,
      });
    },
    setEditorText: (text) => {
      if (unifiedTuiState) {
        unifiedTuiState.editor.setText(text);
        unifiedTuiState.tui.requestRender();
      } else {
        sendToMain({
          type: "extension_ui_request",
          method: "set_editor_text",
          text,
        });
      }
    },

    // ── Widgets ──
    setWidget: (key, content, options) => {
      if (typeof content === "function") {
        // Factory: store and add to unified TUI layout
        ensureUnifiedTui();
        const { widgetFactories, widgetAbove, widgetBelow, tui, components } = unifiedTuiState;
        const placement = options?.placement || "belowEditor";
        widgetFactories.set(key, { factory: content, placement });

        // Remove existing component for this key if any
        const existing = components.get(key);
        if (existing) {
          if (existing.placement === "aboveEditor") widgetAbove.removeChild(existing.component);
          else widgetBelow.removeChild(existing.component);
          existing.component.dispose?.();
          components.delete(key);
        }

        // Create and add new component
        const component = content(tui, theme);
        const container = placement === "aboveEditor" ? widgetAbove : widgetBelow;
        container.addChild(component);
        components.set(key, { component, placement });
        tui.requestRender();
      } else if (content === undefined) {
        // Remove widget. Always tell the renderer to drop the static key
        // (the clear-on-undefined contract; widgetLines omitted ⇒ delete),
        // so a static string[] widget turned off via setWidget(key, undefined)
        // actually disappears from the Dock — not just factory widgets.
        sendToMain({
          type: "extension_ui_request",
          method: "setWidget",
          widgetKey: key,
          widgetLines: undefined,
          widgetPlacement: undefined,
        });
        // Additionally tear down any factory component in the unified TUI.
        if (unifiedTuiState) {
          const { widgetFactories, widgetAbove, widgetBelow, tui, components } = unifiedTuiState;
          widgetFactories.delete(key);
          const existing = components.get(key);
          if (existing) {
            if (existing.placement === "aboveEditor") widgetAbove.removeChild(existing.component);
            else widgetBelow.removeChild(existing.component);
            existing.component.dispose?.();
            components.delete(key);
            tui.requestRender();
          }

          // Tear down unified TUI if no factories remain
          if (widgetFactories.size === 0) {
            disposeUnifiedTui();
          }
        }
      } else if (Array.isArray(content)) {
        // Static string[] widget: existing behavior
        sendToMain({
          type: "extension_ui_request",
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      }
    },

    // ── Theme ──
    get theme() {
      return theme;
    },
    getAllThemes: () => [],
    getTheme: (_name) => undefined,
    setTheme: (_theme) => ({ success: false, error: "Theme switching not available in pi-vis" }),

    // ── TUI-only methods (safe no-ops) ──
    setFooter: (_factory) => {},
    setHeader: (_factory) => {},
    onTerminalInput: (handler) => {
      // Full parity with pi's TUI: the handler joins the TUI's pre-editor input
      // chain (it can consume or rewrite keystrokes before the focused Editor).
      // Stored host-side so a /reload TUI recreate re-attaches it. When no
      // unified TUI exists yet, the handler is remembered and attaches on first
      // setWidget factory (mirrors pi, where onTerminalInput is only meaningful
      // with a live TUI). Returns the unsubscribe (pi's contract).
      const entry = { handler, unsubscribe: null };
      terminalInputHandlers.add(entry);
      if (unifiedTuiState) {
        entry.unsubscribe = unifiedTuiState.tui.addInputListener(handler);
      }
      return () => {
        try {
          entry.unsubscribe?.();
        } catch {}
        terminalInputHandlers.delete(entry);
      };
    },
    setWorkingMessage: (_message) => {},
    setWorkingVisible: (_visible) => {},
    setWorkingIndicator: (_options) => {},
    setHiddenThinkingLabel: (_label) => {},
    pasteToEditor: (text) => {
      if (unifiedTuiState) {
        unifiedTuiState.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
        unifiedTuiState.tui.requestRender();
      }
    },
    getEditorText: () => unifiedTuiState?.editor.getExpandedText() ?? "",
    addAutocompleteProvider: (_factory) => {},
    setEditorComponent: (_factory) => {},
    getEditorComponent: () => undefined,
    getToolsExpanded: () => false,
    setToolsExpanded: (_expanded) => {},

    // ── custom() — the panel bridge ──
    //
    // Mirrors InteractiveMode.showExtensionCustom: construct a TUI over our
    // HostTerminal, call factory(tui, theme, keybindings, done), show the
    // returned component as an overlay, and resolve with whatever `done(result)`
    // receives. pi-vis has no inline layout, so the component is ALWAYS shown as
    // an overlay (the only way to make it visible in the xterm.js panel).
    //
    // Critical correctness points (all bugs in the prior version):
    //  - tui.start() MUST be called: it wires terminal.start() → input handler
    //    (so xterm.js keystrokes reach the component) and kicks the render loop.
    //  - KeybindingsManager needs the REAL TUI_KEYBINDINGS, not {} — an empty
    //    set means Enter/Ctrl+C/arrows don't work inside the panel.
    //  - On close, tui.stop() must stop the render timer (else it keeps writing
    //    to a closed panel forever) and terminal.stop() clears the input handler.
    //  - The promise settles exactly once: `closed` guards both done() and the
    //    factory-error path (the old code could resolve via done() then reject).
    custom: async (factory, options) => {
      // ── Reuse path: a unified TUI already owns this session's panel. ──
      // Showing a unified-origin custom component as an overlay on THAT TUI
      // (rather than spawning a second TUI/xterm) is necessary for correct focus
      // save/restore — pi's overlay mechanism (preFocus capture + hideOverlay
      // restore) is per-TUI. But composer-origin custom components must NOT
      // disappear into the hidden/alternate unified surface: when the user
      // submits from the React Composer, the custom view should replace the
      // Composer in its own standalone panel. The AsyncLocalStorage surface is
      // set by bridge.mjs for prompt/steer/follow-up commands.
      if (unifiedTuiState && invocationSurface.getStore() !== "composer") {
        const { tui, panelId } = unifiedTuiState;
        const keybindings = new KeybindingsManager(UNIFIED_KEYBINDINGS);
        return new Promise((resolve, reject) => {
          let component = null;
          let closed = false;
          let overlayShown = false;

          const teardown = () => {
            if (overlayShown) {
              try {
                tui.hideOverlay();
              } catch {
                /* overlay already gone */
              }
              overlayShown = false;
              // Overlay gone → back to content-hugging sizing in the renderer.
              panelBridge.setPanelMode(panelId, "content");
            }
            try {
              component?.dispose?.();
            } catch {
              /* ignore */
            }
          };

          const done = (result) => {
            if (closed) return;
            closed = true;
            teardown();
            resolve(result);
          };

          // Force-close on session replace: hideOverlay only (shared TUI lives on).
          panelBridge.setCanceller(panelId, () => done(undefined));

          Promise.resolve(factory(tui, theme, keybindings, done))
            .then((c) => {
              if (closed) return;
              component = c;
              const overlayOpts =
                typeof options?.overlayOptions === "function"
                  ? options.overlayOptions()
                  : (options?.overlayOptions ?? (c?.width ? { width: c.width } : {}));
              const handle = tui.showOverlay(component, overlayOpts);
              overlayShown = true;
              // A pi-tui overlay is now compositing against terminal `rows`, so
              // its rendered height tracks whatever grid the renderer reports.
              // Tell the renderer to pin a fixed grid (viewport mode) — otherwise
              // its content-tracking sizer and the overlay chase each other (the
              // "wiggle"). Cleared back to "content" in teardown().
              panelBridge.setPanelMode(panelId, "viewport");
              options?.onHandle?.(handle);
            })
            .catch((err) => {
              if (closed) return;
              closed = true;
              teardown();
              reject(err);
            });
        });
      }

      // ── Standalone path: no unified TUI — spawn a dedicated panel/TUI. ──
      const isOverlay = options?.overlay ?? false;
      const panelId = panelBridge.openPanel({ overlay: isOverlay });
      const hostTerminal = createHostTerminal(panelId, panelBridge);
      // TUI / KeybindingsManager / TUI_KEYBINDINGS come from the createUIContext
      // scope destructure above — do NOT redeclare them here: a `const` in this
      // arrow body would shadow the outer binding for the WHOLE body and put it
      // in the temporal dead zone, so the reuse path's `new KeybindingsManager`
      // (which runs before this line textually) would throw ReferenceError.
      const tui = new TUI(hostTerminal);
      const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
      // Start the TUI: wires HostTerminal.start (input handler) + begins the
      // render loop that composites overlays and writes ANSI to hostTerminal.
      tui.start();

      // Keep the TUI's layout in sync with the actual xterm.js panel size.
      // The renderer sends panel_resize whenever the FitAddon recomputes cols/rows.
      // A force resize asks pi-tui to discard diff-render state and repaint a
      // complete frame (used when a renderer xterm remounts).
      panelBridge.setResizeHandler(panelId, (cols, rows, force) => {
        hostTerminal.resize(cols, rows);
        tui.requestRender(force === true);
      });

      return new Promise((resolve, reject) => {
        let component = null;
        let closed = false;

        const teardown = () => {
          try {
            tui.hideOverlay();
          } catch {
            /* no overlay shown yet */
          }
          try {
            tui.stop();
          } catch {
            /* already stopped */
          }
          try {
            component?.dispose?.();
          } catch {
            /* ignore dispose errors */
          }
          panelBridge.closePanel(panelId);
        };

        const done = (result) => {
          if (closed) return;
          closed = true;
          teardown();
          resolve(result);
        };

        // Let the host force-close this panel (resolve undefined + tear down)
        // if the session is replaced while the panel is still open.
        panelBridge.setCanceller(panelId, () => done(undefined));

        Promise.resolve(factory(tui, theme, keybindings, done))
          .then((c) => {
            if (closed) return;
            component = c;
            // overlayOptions may be static or a function (dynamic sizing).
            const overlayOpts =
              typeof options?.overlayOptions === "function"
                ? options.overlayOptions()
                : (options?.overlayOptions ?? (c?.width ? { width: c.width } : {}));
            const handle = tui.showOverlay(component, overlayOpts);
            options?.onHandle?.(handle);
          })
          .catch((err) => {
            if (closed) return;
            closed = true;
            teardown();
            reject(err);
          });
      });
    },
  };

  return {
    context,
    runWithInvocationSurface,
    unified: {
      dispose: disposeUnifiedTui,
      resolveSubmit: resolveUnifiedSubmit,
      resolveClipboardImage,
    },
  };
}

// ─── HostTerminal ─────────────────────────────────────────────────────────────

/**
 * Implements pi-tui's Terminal interface.
 * Writes all output to the panel (via panelBridge) for display in xterm.js.
 */
function createHostTerminal(panelId, panelBridge) {
  // Mutable dimensions — read by the TUI via the getters below and written by
  // resize(). Stored in closure scope (not `this`) so the getters always return
  // current values regardless of how the terminal is referenced.
  let cols = 80;
  let rows = 24;

  return {
    get columns() {
      return cols;
    },
    get rows() {
      return rows;
    },
    kittyProtocolActive: false,

    start(onInput, _onResize) {
      // Store input handler so panelBridge can feed keystrokes to it.
      // (_onResize — the TUI's requestRender-on-resize — is unused: pi-vis
      // drives resizes explicitly via resize(), which calls requestRender.)
      panelBridge.setInputHandler(panelId, onInput);
    },

    stop() {
      panelBridge.clearInputHandler(panelId);
    },

    drainInput(_maxMs, _idleMs) {
      return Promise.resolve();
    },

    write(data) {
      panelBridge.writePanel(panelId, data);
    },

    // Called by panelBridge when the renderer reports a new xterm.js size —
    // keeps the TUI's layout in sync with the actual panel dimensions.
    resize(newCols, newRows) {
      cols = newCols;
      rows = newRows;
    },

    moveBy(_lines) {},
    // pi-tui calls hideCursor() when it shows an overlay (and our panels are
    // always overlays), and showCursor() when a component wants a visible caret
    // (e.g. a text field). The real terminal honors these by writing DECTCEM;
    // ours must too, or xterm renders its own block cursor that the TUI never
    // shows. Emit the escape so xterm matches the TUI.
    hideCursor() {
      panelBridge.writePanel(panelId, "\x1b[?25l");
    },
    showCursor() {
      panelBridge.writePanel(panelId, "\x1b[?25h");
    },
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle(_title) {},
    setProgress(_active) {},
  };
}
