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
import { stripVTControlCharacters } from "node:util";
import { createKeyboardProtocolNegotiator, createKittyGlobalGate } from "./keyboard-protocol.mjs";

// ─── Dialog resolver (promise-based, one-at-a-time) ───────────────────────────

export function createDialogResolver(sendToMain, onAcknowledged = () => {}) {
  // P3-b: queue outstanding dialogs by id (not a single-slot) so a second
  // dialog overlapping the first can't silently overwrite its resolver.
  // Trust resolution is serial today (init is a serial await chain), so this
  // is hardening — but the single-slot was a latent hang if pi ever issues
  // concurrent selects. The id comes from createDialog's `${method}_${Date.now()}`
  // and is echoed back inside the ExtensionUiResponse (response.id), so resolve
  // matches the right promise regardless of completion order.
  /** @type {Map<string, { resolve: (r: unknown) => void }>} */
  const pending = new Map();
  const outcomes = new Map();

  const finish = (id, response) => {
    const d = pending.get(id);
    if (!d) return outcomes.get(id);
    pending.delete(id);
    d.cleanup?.();
    outcomes.set(id, response);
    if (outcomes.size > 100) outcomes.delete(outcomes.keys().next().value);
    d.resolve(response);
    onAcknowledged(id);
    return response;
  };

  const resolve = (response) => {
    const id = response?.id;
    if (id && outcomes.has(id)) {
      onAcknowledged(id);
      return outcomes.get(id);
    }
    const resolvedId = id ?? (pending.size ? pending.keys().next().value : undefined);
    if (!resolvedId) return;
    return finish(resolvedId, response);
  };

  let nextDialogId = 0;

  const createDialog = (method, title, { message, options, placeholder, prefill, opts } = {}) => {
    return new Promise((resolveFn) => {
      const id = `${method}_${Date.now()}_${++nextDialogId}`;
      let timer;
      const signal = opts?.signal;
      const onAbort = () => finish(id, { type: "extension_ui_response", id, cancelled: true });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      };
      const request = {
        type: "extension_ui_request",
        id,
        operationId: id,
        method,
        title,
        ...(message !== undefined ? { message } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(prefill !== undefined ? { prefill } : {}),
        ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
      };
      pending.set(id, { resolve: resolveFn, cleanup, method, request });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (typeof opts?.timeout === "number" && opts.timeout >= 0) {
        timer = setTimeout(onAbort, opts.timeout);
        timer.unref?.();
      }
      sendToMain(request);
    });
  };

  const cancelAll = () => {
    for (const id of [...pending.keys()]) {
      finish(id, { type: "extension_ui_response", id, cancelled: true });
    }
  };

  // Public ModelRuntime.login receives this small interaction object. It is
  // deliberately independent from extension dialogs: all updates replace one
  // app-owned providerAuth surface and secrets only return through this promise.
  const createProviderAuthInteraction = (providerName, authType, signal) => {
    const id = `provider-auth_${Date.now()}_${++nextDialogId}`;
    const request = (update) =>
      new Promise((resolveFn) => {
        const onAbort = () => finish(id, { type: "extension_ui_response", id, cancelled: true });
        pending.set(id, {
          resolve: resolveFn,
          cleanup: () => signal?.removeEventListener?.("abort", onAbort),
          request: {
            type: "extension_ui_request",
            id,
            operationId: id,
            method: "providerAuth",
            providerName,
            authType,
            ...update,
          },
        });
        if (signal?.aborted) return onAbort();
        signal?.addEventListener?.("abort", onAbort, { once: true });
        sendToMain({
          type: "extension_ui_request",
          id,
          operationId: id,
          method: "providerAuth",
          providerName,
          authType,
          ...update,
        });
      });
    return {
      // Names intentionally match Pi's public auth interaction callbacks.
      openBrowser: (authUrl) => request({ phase: "oauth", authUrl }),
      showDeviceCode: (deviceCode, message) => request({ phase: "device", deviceCode, message }),
      prompt: (prompt, options) =>
        request({ phase: "prompt", prompt, options, secret: true }).then((r) => r?.value),
      select: (prompt, options) =>
        request({ phase: "prompt", prompt, options }).then((r) => r?.value),
      update: (message) =>
        sendToMain({
          type: "extension_ui_request",
          id,
          operationId: id,
          method: "providerAuth",
          providerName,
          authType,
          phase: "prompt",
          message,
        }),
      signal,
    };
  };

  return {
    resolve,
    createDialog,
    createProviderAuthInteraction,
    cancelAll,
    get pendingCount() {
      return pending.size;
    },
    pendingSnapshot(rendererGeneration = 0) {
      return [...pending.values()].map((entry) => ({
        request: structuredClone(entry.request),
        rendererGeneration,
        inputPending: true,
        acknowledged: false,
      }));
    },
  };
}

// ─── Main uiContext factory ───────────────────────────────────────────────────

/**
 * Create a full ExtensionUIContext for mode:"tui".
 *
 * @param {object} deps
 * @param {object} deps.theme - pi's local Theme instance (from initHostTheme)
 * @param {object} deps.panelBridge - { openPanel, writePanel, closePanel } for custom()
 * @param {function} deps.createDialog - (method, title, opts) => Promise
 * @param {function} deps.sendToMain - sends messages to the Electron main process
 * @param {function} [deps.trackBlockingUi] - correlates a blocking UI promise
 *   with the lifecycle async context that opened it.
 * @param {object} deps.tuiModules - public TUI/component/keybinding/width helpers from pi-tui
 */
export function createUIContext({
  theme,
  editorTheme,
  panelBridge,
  createDialog,
  sendToMain,
  trackBlockingUi = (promise) => promise,
  tuiModules,
}) {
  const {
    TUI,
    KeybindingsManager,
    TUI_KEYBINDINGS,
    Container,
    Editor,
    // Kitty keyboard protocol: pi-tui's module-global setter (toggles legacy
    // reinterpretation like bare `\n`→shift+enter) and the StdinBuffer that
    // splits batched stdin into single sequences. Both are on pi-tui's PUBLIC
    // index. Feature-detected (NOT version-compared): an old pi-tui without
    // these exports yields a null gate, so the host performs NO negotiation at
    // all and keeps today's behavior (no crash). See keyboard-protocol.mjs.
    // isKeyRelease filters the release events kitty flag 2 surfaces to input
    // listeners (the paste-image listener below runs in the input chain, which
    // pi-tui does NOT pre-filter — unlike the focused editor).
    setKittyProtocolActive,
    StdinBuffer,
    isKeyRelease,
    truncateToWidth,
    visibleWidth,
  } = tuiModules;
  const invocationSurface = new AsyncLocalStorage();
  // A teardown callback belongs exclusively to the widget generation being
  // retired. Preserve that identity across promises/timers created by teardown
  // so none of its descendants can publish widgets into a live generation.
  const widgetDisposalContext = new AsyncLocalStorage();
  const catalog = {
    notifications: [],
    statuses: new Map(),
    widgets: new Map(),
    title: undefined,
    workingMessage: undefined,
    workingVisible: undefined,
    hiddenThinkingLabel: undefined,
    toolsExpanded: false,
    capabilityDiagnostics: [],
  };
  let editorRevision = 0;
  let editorText = "";
  let editorAttachments = [];
  let editorConflictText;
  let editorConflictAttachments = [];
  let editorAlternateConflictText;
  let editorAlternateConflictAttachments = [];
  let editorAdditionalConflictCandidates = [];
  let notificationSequence = 0;

  function addCapabilityDiagnostic(message) {
    if (!catalog.capabilityDiagnostics.includes(message)) {
      catalog.capabilityDiagnostics.push(message);
    }
  }

  function catalogSnapshot() {
    return {
      notifications: catalog.notifications.map((item) => ({ ...item })),
      statuses: Object.fromEntries(catalog.statuses),
      widgets: Object.fromEntries([...catalog.widgets].map(([key, lines]) => [key, [...lines]])),
      ...(catalog.title !== undefined ? { title: catalog.title } : {}),
      ...(catalog.workingMessage !== undefined ? { workingMessage: catalog.workingMessage } : {}),
      ...(catalog.workingVisible !== undefined ? { workingVisible: catalog.workingVisible } : {}),
      ...(catalog.hiddenThinkingLabel !== undefined
        ? { hiddenThinkingLabel: catalog.hiddenThinkingLabel }
        : {}),
      toolsExpanded: catalog.toolsExpanded,
      capabilityDiagnostics: [...catalog.capabilityDiagnostics],
    };
  }

  function editorStateSnapshot(revision, text, attachments, leadingCandidates = []) {
    const candidates = [];
    const seen = [{ text, attachments }];
    const add = (candidate) => {
      if (
        !candidate ||
        seen.some(
          (existing) =>
            existing.text === candidate.text &&
            JSON.stringify(existing.attachments) === JSON.stringify(candidate.attachments),
        )
      )
        return;
      seen.push(candidate);
      candidates.push(candidate);
    };
    for (const candidate of leadingCandidates) add(candidate);
    if (editorConflictText !== undefined) {
      add({ text: editorConflictText, attachments: editorConflictAttachments });
    }
    if (editorAlternateConflictText !== undefined) {
      add({
        text: editorAlternateConflictText,
        attachments: editorAlternateConflictAttachments,
      });
    }
    for (const candidate of editorAdditionalConflictCandidates) add(candidate);
    const [conflict, alternate, ...additional] = candidates;
    return {
      revision,
      text,
      attachments: structuredClone(attachments),
      ...(conflict
        ? {
            conflictText: conflict.text,
            conflictAttachments: structuredClone(conflict.attachments),
            ...(alternate
              ? {
                  alternateConflictText: alternate.text,
                  alternateConflictAttachments: structuredClone(alternate.attachments),
                }
              : {}),
            ...(additional.length > 0
              ? { additionalConflictCandidates: structuredClone(additional) }
              : {}),
          }
        : {}),
    };
  }

  function editorSnapshot() {
    const pending = [...pendingSubmits.values()].find((item) => item.accepted !== true);
    if (pending !== undefined) {
      return editorStateSnapshot(pending.revision, pending.text, editorAttachments, [
        ...(editorText !== "" ? [{ text: editorText, attachments: editorAttachments }] : []),
      ]);
    }
    return editorStateSnapshot(editorRevision, editorText, editorAttachments);
  }

  function acceptEditorSubmission(request) {
    if (request.editorRevision !== editorRevision) return false;
    editorRevision++;
    editorText = "";
    // Slash commands consume only their command text. Attachments are staged
    // prompt context and remain authoritative for the next ordinary prompt.
    if (!request.text.startsWith("/")) editorAttachments = [];
    editorConflictText = undefined;
    editorConflictAttachments = [];
    editorAlternateConflictText = undefined;
    editorAlternateConflictAttachments = [];
    editorAdditionalConflictCandidates = [];
    if (unifiedTuiState) {
      unifiedTuiState.editor.setText("");
      unifiedTuiState.tui.requestRender();
      maybeDisposeUnifiedTui();
    }
    for (const pending of pendingSubmits.values()) {
      if (pending.revision === request.editorRevision && pending.text === request.text) {
        pending.accepted = true;
      }
    }
    return true;
  }

  function applyEditorPatch({
    baseRevision,
    revision,
    text,
    attachments = [],
    alternateConflictText,
    alternateConflictAttachments = [],
    additionalConflictCandidates = [],
  }) {
    if (baseRevision !== editorRevision || revision <= editorRevision) {
      editorConflictText = text;
      editorConflictAttachments = structuredClone(attachments);
      editorAlternateConflictText = alternateConflictText;
      editorAlternateConflictAttachments = structuredClone(alternateConflictAttachments);
      editorAdditionalConflictCandidates = structuredClone(additionalConflictCandidates);
      return {
        accepted: false,
        revision: editorRevision,
        text: editorText,
        attachments: structuredClone(editorAttachments),
        conflictText: text,
        conflictAttachments: structuredClone(attachments),
        ...(alternateConflictText !== undefined
          ? {
              alternateConflictText,
              alternateConflictAttachments: structuredClone(alternateConflictAttachments),
            }
          : {}),
        ...(additionalConflictCandidates.length > 0
          ? { additionalConflictCandidates: structuredClone(additionalConflictCandidates) }
          : {}),
      };
    }
    editorRevision = revision;
    editorText = text;
    editorAttachments = structuredClone(attachments);
    editorConflictText = undefined;
    editorConflictAttachments = [];
    editorAlternateConflictText = undefined;
    editorAlternateConflictAttachments = [];
    editorAdditionalConflictCandidates = [];
    if (unifiedTuiState) {
      unifiedTuiState.editor.setText(text);
      unifiedTuiState.tui.requestRender();
      maybeDisposeUnifiedTui();
    }
    return {
      accepted: true,
      revision: editorRevision,
      text: editorText,
      attachments: structuredClone(editorAttachments),
    };
  }

  // One refcounted gate shared by every panel terminal this uiContext owns.
  // Refcounting matters because multiple panels (unified + custom) can be open
  // at once: closing one must NOT disable kitty decode for another. Null when
  // pi-tui predates the kitty exports → no negotiation (status-quo).
  const kittyGate =
    typeof setKittyProtocolActive === "function"
      ? createKittyGlobalGate(setKittyProtocolActive)
      : null;
  // Deps threaded into every createHostTerminal: the gate (or null) + the
  // StdinBuffer constructor (or undefined for the no-splitting fallback).
  const hostTerminalDeps = { kittyGate, StdinBuffer };

  const runWithInvocationSurface = (surface, fn) => {
    if (surface !== "composer" && surface !== "unified") return fn();
    return invocationSurface.run(surface, fn);
  };

  // pi-tui's base `Editor` expects an `EditorTheme` ({ borderColor:(s)=>string,
  // selectList }), NOT pi's full Theme instance. Passing the full Theme makes
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

  // Component factories may return the same object for more than one key. One
  // source object is one lifecycle identity: every installed adapter owns a
  // lease, and source.dispose() runs only after the final lease is released.
  const widgetSourceOwnership = new Map();

  // Pending unified submissions remain authoritative across renderer loss:
  // id → { text, revision }. The new renderer replays the same correlated
  // request; disposal never drops it unless the whole session is replaced.
  const pendingSubmits = new Map();

  // Pending clipboard-image reads capture the editor generation/revision/text.
  // A late reply can then be preserved as a conflict instead of mutating a
  // newer draft or a replacement TUI.
  const pendingClipboardReads = new Map();

  // onTerminalInput handlers live host-side, decoupled from TUI lifetime so a
  // /reload-induced TUI recreate re-attaches them to the fresh TUI. Each entry
  // is { handler, unsubscribe }.
  const terminalInputHandlers = new Set();

  // ─── Unified TUI lifecycle ─────────────────────────────────────────────────────

  function ensureUnifiedTui() {
    if (unifiedTuiState) return;

    const panelId = panelBridge.openPanel({ overlay: false, unified: true });
    const hostTerminal = createHostTerminal(panelId, panelBridge, hostTerminalDeps);
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
    if (editorText) editor.setText(editorText);
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
    // diff against the old, now-disposed xterm. The same remount also drops
    // any terminal modes the previous xterm had negotiated — including the
    // Kitty keyboard enhancement — so a forced resize MUST re-push the
    // handshake once the fresh xterm is alive (otherwise Shift+Enter breaks
    // after switching sessions). See keyboard-protocol.mjs / I6.
    panelBridge.setResizeHandler(panelId, (cols, rows, force) => {
      hostTerminal.resize(cols, rows);
      if (force === true) hostTerminal.renegotiate();
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

    // Retention check: when the last factory widget is gone, unsent editor text
    // becomes the only root keeping the unified TUI alive. Watch user input and
    // close the editor-only panel as soon as that draft is deleted. This runs as
    // a pre-editor listener, so defer the check until after the focused Editor
    // has handled the key in the same input turn.
    tui.addInputListener(() => {
      queueMicrotask(() => {
        const next = editor.getExpandedText?.() ?? editor.getText?.() ?? "";
        if (next !== editorText) {
          editorText = next;
          editorRevision++;
          editorConflictText = undefined;
        }
      });
      scheduleUnifiedRetentionCheck();
    });

    // Editor submit → ask the renderer to run the shared submit pipeline, then
    // report the outcome so a guard bail can restore the text. Pi's
    // Editor.submitValue() clears the editor synchronously BEFORE invoking
    // onSubmit, so the editor is already empty by the time this fires; the text
    // captured here is what gets restored on bail. The pending submit itself is
    // a retention root while the renderer may still ask us to restore on bail.
    editor.onSubmit = (text) => {
      // The base Editor clears its visual buffer before this callback. Keep the
      // submitted text in pendingSubmits as the authoritative editor snapshot
      // until main confirms custody/consumption; do not advance the synchronized
      // revision merely because the local widget cleared.
      const revision = editorRevision;
      editorText = "";
      editorConflictText = undefined;
      const id = crypto.randomUUID();
      pendingSubmits.set(id, { text, revision, accepted: false });
      sendToMain({ type: "unified_submit_request", id, text, editorRevision: revision });
    };

    // Clipboard image paste (Ctrl+V / Alt+V). pi wires this on its PRIVATE
    // CustomEditor (onPasteImage + app.clipboard.pasteImage), which the host
    // cannot import. The public base Editor has no paste-image handling, so we
    // drive it through the input-listener chain: this listener runs BEFORE the
    // focused editor (tui.handleInput iterates inputListeners first) and
    // consumes the key. The clipboard read is an async round-trip to the main
    // process; the temp-file path is inserted when it resolves (fire-and-forget
    // — parity with pi, whose onPasteImage is also unawaited).
    //
    // RELEASE-EVENT GUARD: kitty flag 2 (event types) surfaces key-RELEASE
    // sequences (\x1b[<cp>;<mod>:3u) to input listeners, and pi-tui's input-
    // listener chain is NOT pre-filtered (unlike the focused editor, which
    // drops release events unless it opts in via wantsKeyRelease). matches()
    // matches BOTH press and release (it ignores event type), so without this
    // guard a single Ctrl+V would fire TWO clipboard reads. isKeyRelease()
    // rejects the release half. See keyboard-protocol.mjs risk note.
    tui.addInputListener((data) => {
      if (typeof isKeyRelease === "function" && isKeyRelease(data)) return;
      if (!pasteKeybindings.matches(data, "app.clipboard.pasteImage")) return;
      const id = crypto.randomUUID();
      pendingClipboardReads.set(id, {
        panelId,
        revision: editorRevision,
        text: editor.getExpandedText?.() ?? editor.getText?.() ?? editorText,
      });
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
    const editor = unifiedTuiState?.editor;
    if (ok) {
      // Native and unified submissions share the same custody acknowledgement.
      // The authority normally advances this revision before the renderer
      // response arrives; retain the fallback for non-prompt unified actions.
      if (!snapshot.accepted && editorText === "") editorRevision++;
      editorConflictText = undefined;
    } else if (bailed) {
      // Restore losslessly. If the user typed during the round-trip, preserve
      // that newer local draft and expose the submitted text as the conflict.
      if (!editor && editorText === "") {
        // Renderer-loss teardown disposed the TUI, but the host still owns the
        // correlated submission. Restore into replicated editor state so the
        // native Composer in the new renderer receives it.
        editorText = snapshot.text;
        editorConflictText = undefined;
      } else if (editor && editor.getText() === "") {
        editor.setText(snapshot.text);
        editorText = snapshot.text;
        editorConflictText = undefined;
        editor.requestRender?.();
        unifiedTuiState.tui.requestRender();
      } else {
        editorConflictText = snapshot.text;
      }
    }

    // Re-evaluate roots after the pending-submit root drains. Success with no
    // widgets and an empty editor closes; bail/failure restore keeps the panel;
    // a new widget registered during the round-trip keeps it open.
    maybeDisposeUnifiedTui();
  }

  function resolveClipboardImage(id, result) {
    const request = pendingClipboardReads.get(id);
    if (!request) return;
    pendingClipboardReads.delete(id);

    const { bytes, mimeType } = result;
    if (!bytes) return; // empty clipboard → nothing to insert

    const editor = unifiedTuiState?.editor;
    const sameEditorGeneration = Boolean(editor && unifiedTuiState?.panelId === request.panelId);

    const extMap = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
    const ext = extMap[mimeType] || "png";
    // NOTE: temp files are not actively reaped (parity with pi's own TUI paste,
    // which also leaves them for the OS to reclaim from tmpdir). Bounded by
    // paste frequency and the LLM reading the path before tmpdir rotates.
    const tmpPath = path.join(os.tmpdir(), `pi-vis-clipboard-${id}.${ext}`);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(bytes, "base64"));
      const visualText = editor?.getExpandedText?.() ?? editor?.getText?.() ?? editorText;
      const currentText = editorRevision !== request.revision ? editorText : visualText;
      if (
        !sameEditorGeneration ||
        editorRevision !== request.revision ||
        currentText !== request.text
      ) {
        editorText = currentText;
        editorAttachments = [
          ...editorAttachments,
          { kind: "file", name: path.basename(tmpPath), path: tmpPath },
        ];
        editorConflictText = editorConflictText ? `${editorConflictText}\n${tmpPath}` : tmpPath;
        editorRevision++;
        catalog.notifications.push({
          id: `clipboard-conflict-${id}`,
          message: "Clipboard image was retained separately because the editor changed.",
          type: "warning",
        });
        return;
      }
      editor.insertTextAtCursor(tmpPath);
      const insertedText = editor.getExpandedText?.() ?? editor.getText?.() ?? currentText;
      editorText = insertedText === currentText ? `${currentText}${tmpPath}` : insertedText;
      editorConflictText = undefined;
      editorRevision++;
      unifiedTuiState.tui.requestRender();
    } catch {
      /* best-effort — a failed write/insert must not crash the editor */
    }
  }

  // ─── Unified-TUI retention / teardown ─────────────────────────────────────────

  function unifiedEditorHasDraft() {
    const editor = unifiedTuiState?.editor;
    if (!editor) return false;
    try {
      const text =
        typeof editor.getExpandedText === "function"
          ? editor.getExpandedText()
          : editor.getText?.();
      return typeof text === "string" && text.trim().length > 0;
    } catch {
      // If the public editor getter ever throws, prefer preserving the panel
      // over risking loss of unsent input.
      return true;
    }
  }

  function unifiedHasRetentionRoot() {
    const state = unifiedTuiState;
    if (!state) return false;
    return state.widgetFactories.size > 0 || pendingSubmits.size > 0 || unifiedEditorHasDraft();
  }

  function maybeDisposeUnifiedTui() {
    if (!unifiedTuiState) return;
    if (unifiedHasRetentionRoot()) return;
    disposeUnifiedTui();
  }

  function scheduleUnifiedRetentionCheck() {
    queueMicrotask(maybeDisposeUnifiedTui);
  }

  function disposeUnifiedTui(options = {}) {
    if (!unifiedTuiState) return;
    const state = unifiedTuiState;
    const { tui, editor, panelId, components } = state;

    // Tombstone the generation before invoking any extension- or TUI-owned
    // cleanup. Re-entrant disposal is then a no-op, and no callback can observe
    // this retiring state as the current Unified TUI.
    unifiedTuiState = null;

    runWidgetTeardown(() => {
      // Detach onTerminalInput handlers from this TUI instance. They stay
      // registered (terminalInputHandlers) and re-attach to a fresh TUI if a
      // later, independent setWidget factory recreates one; nilling the
      // unsubscribe avoids a stale detach on a disposed TUI.
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

      // Renderer reload preserves correlated unified submissions for replay.
      // Session replacement uses the default and retires old-session requests.
      if (options.preservePendingSubmits !== true) pendingSubmits.clear();

      panelBridge.closePanel(panelId);
    });
  }

  function normalizedWidgetPlacement(options) {
    // Match pi's public ExtensionUIContext contract: omitted placement means
    // above the editor. Treat unknown runtime values conservatively as the
    // default instead of silently moving extension chrome below the editor.
    return options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor";
  }

  function widgetFailureMessage(key, phase, error) {
    let safeKey = "unknown";
    try {
      safeKey = String(key);
    } catch {
      // Preserve a useful diagnostic even for a hostile runtime key value.
    }
    let detail = "Unknown error";
    try {
      detail = error instanceof Error ? error.message : String(error);
    } catch {
      // Even a hostile thrown value with a throwing toString() cannot escape
      // the render boundary.
    }
    const sanitize = (value) => stripVTControlCharacters(value).replace(/\s+/g, " ").trim();
    safeKey = sanitize(safeKey).slice(0, 120) || "unknown";
    detail = sanitize(detail).slice(0, 240);
    return `Extension widget "${safeKey}" ${phase} failed${detail ? `: ${detail}` : ""}`;
  }

  function reportWidgetFailure(key, phase, error) {
    const message = widgetFailureMessage(key, phase, error);
    addCapabilityDiagnostic(message);
    catalog.notifications.push({
      id: `widget-failure-${++notificationSequence}`,
      message,
      type: "error",
    });
    try {
      sendToMain({
        type: "extension_ui_request",
        method: "notify",
        message,
        notifyType: "error",
      });
    } catch {
      // Render containment must remain containment even if the renderer IPC
      // disappeared at the same moment as the extension failed.
    }
  }

  function observeRejectedThenable(value, onRejected) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      return false;
    }
    let then;
    try {
      then = value.then;
    } catch (error) {
      try {
        onRejected(error);
      } catch {
        // Failure reporting must not become a second component failure.
      }
      return true;
    }
    if (typeof then !== "function") return false;

    // Pi's Component contract is synchronous, but a JavaScript extension can
    // accidentally return a Promise. Observe its rejection immediately so the
    // malformed hook cannot escape through the host's unhandled-rejection path.
    try {
      void Promise.resolve(value).then(undefined, (error) => {
        try {
          onRejected(error);
        } catch {
          // Failure reporting must not create an unhandled rejection either.
        }
      });
    } catch (error) {
      try {
        onRejected(error);
      } catch {
        // Preserve containment even for a hostile thenable implementation.
      }
    }
    return true;
  }

  function runWidgetTeardown(callback) {
    // AsyncLocalStorage propagates this fence through Promise and timer work
    // spawned by cleanup. The fence is intentionally key-agnostic: a disposer
    // writing a different key is still stale work from a retired generation.
    return widgetDisposalContext.run(true, callback);
  }

  function acquireWidgetSource(key, source) {
    let ownership = widgetSourceOwnership.get(source);
    if (!ownership) {
      ownership = { source, leaseCount: 0, activeKeyRefCounts: new Map() };
      widgetSourceOwnership.set(source, ownership);
    }
    ownership.leaseCount++;
    ownership.activeKeyRefCounts.set(key, (ownership.activeKeyRefCounts.get(key) ?? 0) + 1);
    return { ownership, key, released: false };
  }

  function releaseWidgetSource(lease, args, reportOnce) {
    if (lease.released) return;
    lease.released = true;

    const { ownership, key } = lease;
    const keyRefCount = ownership.activeKeyRefCounts.get(key) ?? 0;
    if (keyRefCount <= 1) ownership.activeKeyRefCounts.delete(key);
    else ownership.activeKeyRefCounts.set(key, keyRefCount - 1);
    ownership.leaseCount--;
    if (ownership.leaseCount > 0) return;

    if (widgetSourceOwnership.get(ownership.source) === ownership) {
      widgetSourceOwnership.delete(ownership.source);
    }

    let result;
    try {
      result = runWidgetTeardown(() => ownership.source.dispose?.(...args));
    } catch (error) {
      reportOnce("dispose", error);
      return;
    }
    observeRejectedThenable(result, (error) => reportOnce("dispose", error));
  }

  function disposeInvalidWidgetSource(key, source) {
    if ((typeof source !== "object" && typeof source !== "function") || source === null) return;

    // An invalid refresh may return an object that is still installed under a
    // different lease. It is not ours to dispose until that final active lease
    // retires through releaseWidgetSource().
    if (widgetSourceOwnership.has(source)) return;

    let result;
    try {
      result = runWidgetTeardown(() => source.dispose?.());
    } catch (error) {
      reportWidgetFailure(key, "dispose", error);
      return;
    }
    observeRejectedThenable(result, (error) => reportWidgetFailure(key, "dispose", error));
  }

  function createGuardedWidgetComponent(key, source) {
    if ((typeof source !== "object" && typeof source !== "function") || source === null) {
      throw new TypeError(`Widget factory "${key}" must return a TUI component`);
    }
    if (typeof source.render !== "function") {
      throw new TypeError(`Widget factory "${key}" returned a component without render()`);
    }

    const sourceLease = acquireWidgetSource(key, source);
    const reportedPhases = new Set();
    let disposed = false;
    const reportOnce = (phase, error) => {
      if (reportedPhases.has(phase)) return;
      reportedPhases.add(phase);
      reportWidgetFailure(key, phase, error);
    };
    const safeWidth = (width) => (Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80);
    const conservativelyTruncatePlainText = (value, width) => {
      const maxWidth = safeWidth(width);
      // Terminal code points occupy at most two cells. Keep only printable
      // characters and at most floor(width / 2) of them, so this last-resort
      // path is bounded even when the public width helpers are absent or throw.
      // Losing styling here is preferable to leaking a partial control
      // sequence into pi-tui.
      const printable = Array.from(stripVTControlCharacters(value)).filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
      });
      return printable.slice(0, Math.floor(maxWidth / 2)).join("");
    };
    const truncateSafely = (value, width) => {
      const maxWidth = safeWidth(width);
      if (typeof truncateToWidth === "function") {
        try {
          const truncated = truncateToWidth(value, maxWidth, maxWidth > 1 ? "…" : "");
          if (typeof truncated === "string" && typeof visibleWidth === "function") {
            const truncatedWidth = visibleWidth(truncated);
            if (
              Number.isFinite(truncatedWidth) &&
              truncatedWidth >= 0 &&
              truncatedWidth <= maxWidth
            ) {
              return truncated;
            }
          }
        } catch {
          // Fall through to a conservative plain-text bound. It sacrifices
          // styling but cannot leave a partial terminal control sequence.
        }
      }
      return conservativelyTruncatePlainText(value, maxWidth);
    };
    const fitRenderedLine = (value, width) => {
      const maxWidth = safeWidth(width);
      if (typeof visibleWidth === "function") {
        try {
          const measuredWidth = visibleWidth(value);
          if (Number.isFinite(measuredWidth) && measuredWidth >= 0 && measuredWidth <= maxWidth) {
            return value;
          }
        } catch {
          // A width-helper failure is a host compatibility concern, not an
          // extension render failure. The safe truncation path below contains
          // the row without publishing a false error notification.
        }
      }
      return truncateSafely(value, maxWidth);
    };
    const fallback = (error, width) => {
      const message = widgetFailureMessage(key, "render", error);
      try {
        const styled = theme.fg("error", message);
        return [
          truncateSafely(typeof styled === "string" && styled.length > 0 ? styled : message, width),
        ];
      } catch {
        return [truncateSafely(message, width)];
      }
    };

    return {
      render(...args) {
        try {
          const render = source.render;
          if (typeof render !== "function") {
            throw new TypeError("render is no longer a function");
          }
          const lines = render.apply(source, args);
          if (!Array.isArray(lines)) {
            observeRejectedThenable(lines, (error) => reportOnce("render", error));
            throw new TypeError("render() must return an array of strings");
          }
          if (lines.some((line) => typeof line !== "string")) {
            throw new TypeError("render() must return an array of strings");
          }
          for (let index = 0; index < lines.length; index++) {
            if (lines[index].includes("\r") || lines[index].includes("\n")) {
              throw new TypeError(`rendered line ${index + 1} contains an embedded line break`);
            }
          }
          const width = safeWidth(args[0]);
          if (typeof visibleWidth !== "function") {
            return lines.map((line) => conservativelyTruncatePlainText(line, width));
          }
          // A component can legitimately see a transiently tiny width while
          // the renderer mounts/fits xterm. Width overflow is therefore layout
          // input, not an extension failure: normalize each row with pi-tui's
          // ANSI-aware public helper and let the next wider render restore the
          // complete source output. Malformed rows and thrown render calls
          // remain on the diagnostic path above.
          return lines.map((line) => fitRenderedLine(line, width));
        } catch (error) {
          reportOnce("render", error);
          return fallback(error, args[0]);
        }
      },
      invalidate(...args) {
        try {
          const result = source.invalidate?.(...args);
          observeRejectedThenable(result, (error) => reportOnce("invalidate", error));
        } catch (error) {
          reportOnce("invalidate", error);
        }
      },
      dispose(...args) {
        if (disposed) return;
        disposed = true;
        releaseWidgetSource(sourceLease, args, reportOnce);
      },
    };
  }

  function removeFactoryWidget(state, key) {
    state.widgetFactories.delete(key);
    const existing = state.components.get(key);
    if (!existing) return false;
    const container = existing.placement === "aboveEditor" ? state.widgetAbove : state.widgetBelow;
    container.removeChild(existing.component);
    state.components.delete(key);
    existing.component.dispose?.();
    return true;
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
      const r = await trackBlockingUi(createDialog("select", title, { options, opts }));
      return r?.cancelled ? undefined : r?.value;
    },
    confirm: async (title, message, opts) => {
      const r = await trackBlockingUi(createDialog("confirm", title, { message, opts }));
      return r?.confirmed === true; // cancel / anything else → false
    },
    input: async (title, placeholder, opts) => {
      const r = await trackBlockingUi(createDialog("input", title, { placeholder, opts }));
      return r?.cancelled ? undefined : r?.value;
    },
    editor: async (title, prefill) => {
      const r = await trackBlockingUi(createDialog("editor", title, { prefill }));
      return r?.cancelled ? undefined : r?.value;
    },

    // ── Fire-and-forget notifications ──
    notify: (message, notifyType) => {
      catalog.notifications.push({
        id: `notification-${++notificationSequence}`,
        message,
        ...(notifyType ? { type: notifyType } : {}),
      });
      sendToMain({
        type: "extension_ui_request",
        method: "notify",
        message,
        notifyType,
      });
    },
    setStatus: (key, text) => {
      if (text === undefined) catalog.statuses.delete(key);
      else catalog.statuses.set(key, text);
      sendToMain({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: key,
        statusText: text,
      });
    },
    setTitle: (title) => {
      catalog.title = title;
      sendToMain({
        type: "extension_ui_request",
        method: "setTitle",
        title,
      });
    },
    setEditorText: (text) => {
      editorRevision++;
      editorText = text;
      if (unifiedTuiState) {
        unifiedTuiState.editor.setText(text);
        unifiedTuiState.tui.requestRender();
        maybeDisposeUnifiedTui();
      }
      // This is a mutation notification, not an unversioned renderer
      // injection. Main requests the authoritative editor snapshot and the
      // renderer reconciles it against any local patch already in flight.
      sendToMain({
        type: "extension_ui_request",
        method: "set_editor_text",
        text,
      });
    },

    // ── Widgets ──
    setWidget: (key, content, options) => {
      // A retiring source/TUI may schedule synchronous or asynchronous cleanup.
      // Every descendant write is stale, including a write to a different key.
      if (widgetDisposalContext.getStore() === true) return;

      const isFactory = typeof content === "function";
      const isStatic = Array.isArray(content);
      // Resolve extension-controlled options before opening a panel or mutating
      // either presentation plane. A throwing/revoked getter is therefore a
      // clean failed call rather than a half-committed widget transition.
      const placement = isFactory || isStatic ? normalizedWidgetPlacement(options) : undefined;

      if (isFactory) {
        // Construct first, then replace atomically. A throwing factory must not
        // strand a blank unified panel or destroy the prior component for the
        // same key.
        ensureUnifiedTui();
        const state = unifiedTuiState;
        const { widgetFactories, widgetAbove, widgetBelow, tui, components } = state;
        let source;
        let component;
        try {
          source = content(tui, theme);
          // Observe a mistakenly async factory before synchronous Component
          // validation rejects its Promise/thenable, preventing a later
          // rejection from escaping through the host process.
          observeRejectedThenable(source, (error) => reportWidgetFailure(key, "factory", error));
          component = createGuardedWidgetComponent(key, source);
        } catch (error) {
          disposeInvalidWidgetSource(key, source);
          maybeDisposeUnifiedTui();
          throw error;
        }

        // A factory is allowed to call UI methods synchronously. If that
        // re-entrant work replaced this TUI, the component belongs to the old
        // generation and must never be installed into the new one.
        if (unifiedTuiState !== state) {
          component.dispose?.();
          throw new Error(`Widget factory "${key}" outlived its Unified TUI generation`);
        }

        const existing = components.get(key);
        if (existing?.source === source) {
          // A factory may return the same component instance on refresh. Reuse
          // its guarded adapter so replacing the registration cannot dispose
          // the component that remains installed.
          component.dispose?.();
          if (existing.placement !== placement) {
            const oldContainer = existing.placement === "aboveEditor" ? widgetAbove : widgetBelow;
            const nextContainer = placement === "aboveEditor" ? widgetAbove : widgetBelow;
            nextContainer.addChild(existing.component);
            oldContainer.removeChild(existing.component);
            existing.placement = placement;
          }
          widgetFactories.set(key, { factory: content, placement });
          if (catalog.widgets.delete(key)) {
            sendToMain({
              type: "extension_ui_request",
              method: "setWidget",
              widgetKey: key,
              widgetLines: undefined,
              widgetPlacement: undefined,
            });
          }
          tui.requestRender();
          return;
        }

        const container = placement === "aboveEditor" ? widgetAbove : widgetBelow;
        try {
          // Install the validated replacement before retiring the previous
          // component. A construction/add failure therefore leaves the prior
          // registration intact and renderable.
          container.addChild(component);
        } catch (error) {
          component.dispose?.();
          maybeDisposeUnifiedTui();
          throw error;
        }
        components.set(key, { component, source, placement });
        widgetFactories.set(key, { factory: content, placement });

        if (existing) {
          const oldContainer = existing.placement === "aboveEditor" ? widgetAbove : widgetBelow;
          oldContainer.removeChild(existing.component);
          existing.component.dispose?.();
        }

        // A key has one presentation plane. Switching static → factory clears
        // the Dock copy only after the factory component is known-good.
        if (catalog.widgets.delete(key)) {
          sendToMain({
            type: "extension_ui_request",
            method: "setWidget",
            widgetKey: key,
            widgetLines: undefined,
            widgetPlacement: undefined,
          });
        }
        tui.requestRender();
      } else if (content === undefined) {
        catalog.widgets.delete(key);
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
          const state = unifiedTuiState;
          if (removeFactoryWidget(state, key)) state.tui.requestRender();

          // Tear down only when ALL unified roots are gone. If the user has an
          // unsent editor draft, keep an editor-only unified panel alive instead
          // of shoving them back to the Composer and losing the text. If a
          // submit is in flight, keep the panel too so a guard bail can restore.
          maybeDisposeUnifiedTui();
        }
      } else if (isStatic) {
        if (content.some((line) => typeof line !== "string")) {
          throw new TypeError(`Static widget "${key}" must contain only strings`);
        }
        const lines = [...content];
        catalog.widgets.set(key, lines);

        // A key has one presentation plane. Switching factory → static removes
        // and disposes the TUI component before publishing the Dock value.
        if (unifiedTuiState) {
          const state = unifiedTuiState;
          if (removeFactoryWidget(state, key)) state.tui.requestRender();
          maybeDisposeUnifiedTui();
        }

        sendToMain({
          type: "extension_ui_request",
          method: "setWidget",
          widgetKey: key,
          widgetLines: lines,
          widgetPlacement: placement,
        });
      }
    },

    // ── Theme ──
    get theme() {
      return theme;
    },
    getAllThemes: () => [],
    getTheme: (_name) => undefined,
    setTheme: (_theme) => {
      const error = "Theme switching not available in pi-vis";
      if (!catalog.capabilityDiagnostics.includes(error)) catalog.capabilityDiagnostics.push(error);
      sendToMain({
        type: "extension_ui_request",
        method: "notify",
        message: error,
        notifyType: "warning",
      });
      return { success: false, error };
    },

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
    setWorkingMessage: (message) => {
      catalog.workingMessage = message;
    },
    setWorkingVisible: (visible) => {
      catalog.workingVisible = visible;
    },
    setWorkingIndicator: (_options) => {},
    setHiddenThinkingLabel: (label) => {
      catalog.hiddenThinkingLabel = label;
    },
    pasteToEditor: (text) => {
      if (unifiedTuiState) {
        const before =
          unifiedTuiState.editor.getExpandedText?.() ??
          unifiedTuiState.editor.getText?.() ??
          editorText;
        unifiedTuiState.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
        const after =
          unifiedTuiState.editor.getExpandedText?.() ??
          unifiedTuiState.editor.getText?.() ??
          before;
        editorText = after === before ? `${before}${text}` : after;
        unifiedTuiState.tui.requestRender();
      } else {
        editorText += text;
      }
      editorRevision++;
      sendToMain({
        type: "extension_ui_request",
        method: "set_editor_text",
        text: editorText,
      });
    },
    getEditorText: () => unifiedTuiState?.editor.getExpandedText() ?? editorText,
    addAutocompleteProvider: (_factory) => {},
    setEditorComponent: (_factory) => {},
    getEditorComponent: () => undefined,
    getToolsExpanded: () => catalog.toolsExpanded,
    setToolsExpanded: (expanded) => {
      catalog.toolsExpanded = expanded;
    },

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
        const lifecycleUiPromise = new Promise((resolve, reject) => {
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
        return trackBlockingUi(lifecycleUiPromise);
      }

      // ── Standalone path: no unified TUI — spawn a dedicated panel/TUI. ──
      const isOverlay = options?.overlay ?? false;
      const panelId = panelBridge.openPanel({ overlay: isOverlay });
      const hostTerminal = createHostTerminal(panelId, panelBridge, hostTerminalDeps);
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
      // complete frame (used when a renderer xterm remounts). It ALSO re-pushes
      // the kitty handshake: a remounted xterm starts without the enhancement,
      // so a custom panel that survives a remount (e.g. via the replay buffer)
      // must renegotiate or modified keys arrive as legacy bytes. See I6/I12.
      panelBridge.setResizeHandler(panelId, (cols, rows, force) => {
        hostTerminal.resize(cols, rows);
        if (force === true) hostTerminal.renegotiate();
        tui.requestRender(force === true);
      });

      const standaloneUiPromise = new Promise((resolve, reject) => {
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
      return trackBlockingUi(standaloneUiPromise);
    },
  };

  return {
    context,
    runWithInvocationSurface,
    state: {
      catalogSnapshot,
      addCapabilityDiagnostic,
      editorSnapshot,
      acceptEditorSubmission,
      applyEditorPatch,
      pendingUnifiedSubmissions: () =>
        [...pendingSubmits].map(([id, value]) => ({
          id,
          text: value.text,
          revision: value.revision,
        })),
    },
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
 *
 * Keyboard protocol: when a kitty gate is present, this terminal performs the
 * same handshake pi's ProcessTerminal does (bracketed paste + push + query +
 * DA over the panel wire), filters xterm's replies out of the input stream,
 * and routes real keystrokes through a pi-tui StdinBuffer (so batched chunks
 * split into single sequences for matchesKey/parseKey). A null gate (old pi-tui
 * without the kitty exports) performs NO negotiation — today's behavior. See
 * keyboard-protocol.mjs for the state machine and the byte-level contract.
 */
function createHostTerminal(panelId, panelBridge, { kittyGate, StdinBuffer } = {}) {
  // Mutable dimensions — read by the TUI via the getters below and written by
  // resize(). Stored in closure scope (not `this`) so the getters always return
  // current values regardless of how the terminal is referenced.
  let cols = 80;
  let rows = 24;
  // The TUI's onInput handler, captured in start() so the negotiator/StdinBuffer
  // can forward real keystrokes to it.
  let inputHandler = null;
  let stdinBuffer = null;
  // Gate-ref lifecycle: acquired in start(), released exactly once in stop().
  // The flag (not bare acquire/release pairing) is what makes the release
  // idempotent across double-stop and stop-without-start — an unbalanced
  // release would hit refcount 0 early and kill kitty decode for OTHER panels.
  let gateAcquired = false;

  // pi-tui emits one logical paint as several synchronous Terminal calls: the
  // frame first, then hardware-cursor positioning and visibility. Publishing
  // each call separately lets the renderer size the cursor-at-bottom
  // intermediate state. That is unstable when the frame ends in blank rows:
  // the panel briefly grows, then trims those rows after the cursor moves, and
  // the resulting host resize can immediately reverse it. Preserve byte order
  // but publish all writes from one JavaScript turn as one panel delta.
  let pendingOutput = "";
  let outputFlushQueued = false;
  const flushOutput = () => {
    outputFlushQueued = false;
    if (pendingOutput.length === 0) return;
    const data = pendingOutput;
    pendingOutput = "";
    panelBridge.writePanel(panelId, data);
  };
  const queueOutput = (data) => {
    if (data.length === 0) return;
    pendingOutput += data;
    if (outputFlushQueued) return;
    outputFlushQueued = true;
    queueMicrotask(flushOutput);
  };

  // Per-terminal negotiator. Null when there is no kitty gate (old pi-tui or
  // feature detection failed) → the terminal is a plain pass-through.
  const negotiator = kittyGate
    ? createKeyboardProtocolNegotiator({
        // Writes go to the panel (xterm.js) — the handshake bytes + fallbacks.
        write: (data) => panelBridge.writePanel(panelId, data),
        // Forwarded sequences are REAL keystrokes → the TUI's editor chain.
        forward: (seq) => {
          if (inputHandler) inputHandler(seq);
        },
        onKittyActive: () => kittyGate.markActive(),
      })
    : null;

  return {
    get columns() {
      return cols;
    },
    get rows() {
      return rows;
    },
    // Truthful: reflects whether THIS terminal negotiated nonzero kitty flags.
    get kittyProtocolActive() {
      return negotiator?.isActive ?? false;
    },

    start(onInput, _onResize) {
      // (_onResize — the TUI's requestRender-on-resize — is unused: pi-vis
      // drives resizes explicitly via resize(), which calls requestRender.)
      inputHandler = onInput;

      // Route panel input through the negotiation filter. When a StdinBuffer is
      // available (pi-tui public export), split batched chunks into single
      // sequences first — exactly like ProcessTerminal.setupStdinBuffer() — so
      // matchesKey/parseKey see one event at a time (release events, modified
      // keys). The `data` handler runs the negotiator first; anything it does
      // NOT consume (a real key) is forwarded to the TUI. The `paste` handler
      // re-wraps bracketed-paste content for the editor's existing handling.
      let dataHandler;
      if (StdinBuffer && typeof StdinBuffer === "function") {
        stdinBuffer = new StdinBuffer({ timeout: 10 });
        stdinBuffer.on("data", (sequence) => {
          if (negotiator?.filterInput(sequence)) return; // consumed
          inputHandler?.(sequence);
        });
        stdinBuffer.on("paste", (content) => {
          inputHandler?.(`\x1b[200~${content}\x1b[201~`);
        });
        dataHandler = (data) => stdinBuffer.process(data);
      } else {
        // Fallback (no StdinBuffer): filter the raw chunk, then forward. Less
        // correct for batched multi-sequence chunks, but never blocks input —
        // and a pi-tui old enough to lack StdinBuffer almost certainly lacks
        // the kitty exports too (null negotiator ⇒ pure pass-through).
        dataHandler = (data) => {
          if (negotiator?.filterInput(data)) return;
          inputHandler?.(data);
        };
      }
      panelBridge.setInputHandler(panelId, dataHandler);

      // Join the kitty pool + push the handshake. The renderer's xterm answers
      // asynchronously; the guaranteed force-resize after mount renegotiates if
      // this fires before the xterm is alive (start-time race, tolerated).
      if (negotiator) {
        if (!gateAcquired) {
          kittyGate.acquire();
          gateAcquired = true;
        }
        try {
          negotiator.push();
        } catch (err) {
          // A failed push must never wedge the panel — log and carry on as a
          // plain pass-through. The gate ref is deliberately KEPT: a later
          // renegotiate() may still succeed and mark the global active, and the
          // ref is what balances stop()'s release (releasing here would double-
          // release on stop, or leave a later activation with no ref at all).
          console.error("[pi-session-host] kitty push failed; degrading:", err?.message ?? err);
        }
      }
    },

    // Re-push the handshake after an xterm remount (force-resize). Idempotent;
    // safe even if start()'s push raced before the xterm was alive.
    renegotiate() {
      try {
        negotiator?.push();
      } catch (err) {
        console.error("[pi-session-host] kitty renegotiate failed:", err?.message ?? err);
      }
    },

    stop() {
      // Do not leave a final render turn queued behind panel teardown or the
      // negotiator's mode-reset bytes.
      flushOutput();
      if (negotiator) {
        try {
          negotiator.stop();
        } catch {
          /* best-effort cleanup */
        }
        if (gateAcquired) {
          kittyGate.release();
          gateAcquired = false;
        }
      }
      if (stdinBuffer) {
        try {
          stdinBuffer.destroy();
        } catch {
          /* already destroyed */
        }
        stdinBuffer = null;
      }
      panelBridge.clearInputHandler(panelId);
      inputHandler = null;
    },

    drainInput(_maxMs, _idleMs) {
      return Promise.resolve();
    },

    write(data) {
      queueOutput(data);
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
      queueOutput("\x1b[?25l");
    },
    showCursor() {
      queueOutput("\x1b[?25h");
    },
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle(_title) {},
    setProgress(_active) {},
  };
}
