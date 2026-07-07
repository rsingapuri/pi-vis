#!/usr/bin/env node
/**
 * fake-unified-host — a deterministic stand-in for the SessionHost subprocess
 * (resources/pi-session-host/host.mjs) that drives the factory-`setWidget`
 * unified-TUI panel flow, WITHOUT a real pi install or SDK.
 *
 * Installed via the `PIVIS_TEST_HOST_SCRIPT` env override in SessionHost
 * (src/main/pi/session-host.ts). It speaks the SAME wire protocol host.mjs
 * does (process.send / process.on("message")), so the real app exercises the
 * full path: SessionHost → registry → IPC → store reducer → UnifiedTuiHost →
 * xterm.js.
 *
 * What it simulates (the pi-subagents "FleetView" roster flow):
 *   - on `init`: emit `spawned` → `ready {piVersion}`, then shortly after open
 *     a persistent unified panel (`panel_open {unified:true}`) and stream
 *     `panel_data` ANSI frames — exactly what host.mjs's ensureUnifiedTui()
 *     produces when an extension calls `setWidget(key, factory)`.
 *   - answers the renderer's startup commands (get_available_models / get_state
 *     / get_commands / get_session_stats) with the same shapes fake-pi uses.
 *   - forwards `prompt`/`bash` as a response + a few agent events so the
 *     transcript shows life.
 *   - records `panel_input` keystrokes to PIVIS_TEST_HOST_INPUT_FILE so the
 *     Playwright test can assert input routing via a side channel.
 *
 * Wire protocol (host → main), mirrored from host.mjs / fake-host-process.mjs:
 *   { type:"spawned" } / { type:"ready", piVersion } / { type:"response", id, success, data? }
 *   { type:"event", event } / { type:"panel_open", panelId, overlay, unified? }
 *   { type:"panel_data", panelId, data } / { type:"panel_close", panelId }
 */
import * as fs from "node:fs";

const INPUT_FILE = process.env.PIVIS_TEST_HOST_INPUT_FILE;
const PANEL_ID = 1;

const MODELS = [
  { id: "fake-model", name: "Fake Model", api: "fake", provider: "fake", reasoning: false },
  { id: "fake-model-2", name: "Fake Model Two", api: "fake", provider: "fake", reasoning: true },
];

let panelOpen = false;
let panelTimer = null;
let factoryWidgetActive = false;
let deferredClose = false;
let editorDraft = "";
let submitCounter = 0;
const pendingSubmits = new Map();
const AUTO_CLOSE_MS = Number(process.env.PIVIS_TEST_UNIFIED_AUTO_CLOSE_MS || 0);
const AUTO_CLOSE_AFTER_DRAFT = process.env.PIVIS_TEST_UNIFIED_AUTO_CLOSE_AFTER_DRAFT || "";
let autoClosedAfterDraft = false;

// The kitty keyboard protocol handshake the REAL host writes in
// HostTerminal.start() (see keyboard-protocol.mjs): enable bracketed paste, then
// push flags 7 + query current flags + DA sentinel. xterm 6.1 (with
// vtExtensions.kittyKeyboard) ANSWERS this over its onData → panel_input, so the
// test can assert byte-level that xterm (a) granted kitty and (b) encodes
// Shift+Enter as \x1b[13;2u. Re-emitted on a force-resize (the remount path).
const KITTY_HANDSHAKE = "\x1b[?2004h\x1b[>7u\x1b[?u\x1b[c";

function send(msg) {
  if (typeof process.send === "function") process.send(msg);
}

function recordInput(data) {
  if (!INPUT_FILE) return;
  try {
    fs.appendFileSync(INPUT_FILE, data, { flag: "a" });
  } catch {
    /* best effort — input routing is asserted on a best-effort basis */
  }
}

function stripControlSequences(data) {
  // Remove CSI replies/releases/modified-key sequences so the tiny fake editor
  // sees only the intended text-ish keypresses. The real host delegates this to
  // pi-tui + the kitty negotiator; this fixture only needs enough state to
  // model draft-retained close behavior in the E2E suite.
  return data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function maybeCloseDeferredUnifiedPanel() {
  if (factoryWidgetActive) return;
  if (pendingSubmits.size > 0) return;
  if (editorDraft.trim().length > 0) return;
  closeUnifiedPanel();
}

function submitUnifiedDraft() {
  const text = editorDraft;
  if (!text.trim()) {
    maybeCloseDeferredUnifiedPanel();
    return;
  }
  const id = `fake-submit-${++submitCounter}`;
  pendingSubmits.set(id, text);
  editorDraft = "";
  send({ type: "unified_submit_request", id, text });
}

function updateFakeEditorDraft(data) {
  if (!panelOpen) return;
  const plain = stripControlSequences(data);
  for (const ch of plain) {
    if (ch === "\r") {
      submitUnifiedDraft();
    } else if (ch === "\b" || ch === "\x7f") {
      editorDraft = editorDraft.slice(0, -1);
      maybeCloseDeferredUnifiedPanel();
    } else if (ch === "\n" || ch >= " ") {
      editorDraft += ch;
    }
  }
  if (
    AUTO_CLOSE_AFTER_DRAFT &&
    !autoClosedAfterDraft &&
    factoryWidgetActive &&
    editorDraft.includes(AUTO_CLOSE_AFTER_DRAFT)
  ) {
    autoClosedAfterDraft = true;
    requestFactoryWidgetClose();
  }
}

function reply(id, success, data = {}) {
  send({ type: "response", id, success, data });
}

function handleCommand(id, command, uiSurface) {
  const t = command?.type;
  switch (t) {
    case "get_available_models":
      reply(id, true, { models: MODELS, currentModelId: "fake-model" });
      break;
    case "get_state":
      reply(id, true, {
        model: MODELS[0],
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        sessionId: "fake-unified",
        messageCount: 0,
      });
      break;
    case "get_commands":
      reply(id, true, {
        commands: [
          {
            name: "custom-panel",
            description: "Open a fake custom panel",
            source: "extension",
            sourceInfo: "fake-unified-host",
          },
        ],
      });
      break;
    case "get_session_stats":
      reply(id, true, {
        sessionId: "fake-unified",
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
      });
      break;
    case "set_model":
    case "set_thinking_level":
      reply(id, true, {});
      break;
    case "prompt":
    case "steer":
      reply(id, true, {});
      if (command?.message === "/custom-panel") {
        openCustomPanel(uiSurface);
        break;
      }
      // A whisper of agent activity so the transcript isn't empty.
      send({ type: "event", event: { type: "agent_start" } });
      send({
        type: "event",
        event: { type: "message_start", role: "assistant" },
      });
      send({
        type: "event",
        event: { type: "message_update", delta: { text_delta: "Working on it…" } },
      });
      send({ type: "event", event: { type: "message_end" } });
      send({ type: "event", event: { type: "agent_end" } });
      break;
    case "bash":
      reply(id, true, {});
      break;
    default:
      // Be permissive: any other command gets a generic success so a new
      // renderer startup command can't wedge the session.
      reply(id, true, {});
      break;
  }
}

// ─── Unified panel (the factory setWidget flow) ────────────────────────────

function renderRoster() {
  // Clear-screen + home + a recognizable fleet roster. UnifiedTuiHost renders
  // this into xterm.js; the test greps for "Fleet" and an agent name. When the
  // fake extension has self-closed its widget but a draft retains the panel,
  // render an editor-only placeholder so the visible surface remains stable.
  const lines = factoryWidgetActive
    ? [
        "▸ Fleet (2 agents)        ↓/↑ navigate · Enter open",
        "  ● swift-otter    running   3 turns",
        "  ○ brave-falcon   queued    —",
        "",
        "  (unified TUI · type a prompt + Enter)",
      ]
    : ["  (unified editor retained for unsent input)"];
  return `\x1b[2J\x1b[H${lines.join("\n")}\n`;
}

function renderFrame() {
  send({ type: "panel_data", panelId: PANEL_ID, data: renderRoster() });
}

function openUnifiedPanel() {
  if (panelOpen) return;
  panelOpen = true;
  factoryWidgetActive = true;
  deferredClose = false;
  editorDraft = "";
  autoClosedAfterDraft = false;
  pendingSubmits.clear();
  send({ type: "panel_open", panelId: PANEL_ID, overlay: false, unified: true });
  // Mirror the real host: push the kitty handshake so xterm answers it. The
  // reply (+ later keystrokes) is captured to PIVIS_TEST_HOST_INPUT_FILE.
  send({ type: "panel_data", panelId: PANEL_ID, data: KITTY_HANDSHAKE });
  renderFrame();
  // Keep streaming so a remount (e.g. session switch) re-seeds from the buffer.
  panelTimer = setInterval(renderFrame, 1000);
  if (panelTimer?.unref) panelTimer.unref();
  if (AUTO_CLOSE_MS > 0) {
    setTimeout(requestFactoryWidgetClose, AUTO_CLOSE_MS).unref?.();
  }
}

function requestFactoryWidgetClose() {
  if (!panelOpen) return;
  factoryWidgetActive = false;
  if (editorDraft.trim().length > 0 || pendingSubmits.size > 0) {
    deferredClose = true;
    renderFrame();
    return;
  }
  closeUnifiedPanel();
}

function closeUnifiedPanel() {
  if (!panelOpen) return;
  panelOpen = false;
  factoryWidgetActive = false;
  deferredClose = false;
  editorDraft = "";
  pendingSubmits.clear();
  if (panelTimer) {
    clearInterval(panelTimer);
    panelTimer = null;
  }
  send({ type: "panel_close", panelId: PANEL_ID });
}

function openCustomPanel(uiSurface) {
  if (uiSurface === "unified") {
    send({ type: "panel_mode", panelId: PANEL_ID, mode: "viewport" });
    send({
      type: "panel_data",
      panelId: PANEL_ID,
      data: `\x1b[2J\x1b[H${["Unified custom panel", "opened from the unified editor"].join("\n")}\n`,
    });
    return;
  }

  const customPanelId = 2;
  send({ type: "panel_open", panelId: customPanelId, overlay: true, unified: false });
  send({
    type: "panel_data",
    panelId: customPanelId,
    data: `\x1b[2J\x1b[H${["Composer custom panel", "opened from the native composer"].join("\n")}\n`,
  });
}

// ─── Wire protocol handling ────────────────────────────────────────────────

process.on("message", (msg) => {
  try {
    switch (msg?.type) {
      case "init":
        send({ type: "spawned" });
        send({ type: "ready", piVersion: "99.0.0" });
        // Open the unified panel shortly after ready, mirroring an extension
        // registering a factory setWidget during its first tool call.
        setTimeout(openUnifiedPanel, 300);
        break;
      case "command":
        handleCommand(msg.id, msg.command, msg.uiSurface);
        break;
      case "panel_input":
        // Keystrokes from UnifiedTuiHost's xterm → record for the input-routing
        // assertion and update a tiny fake editor draft so this fixture can
        // model the real host's draft-retained self-close invariant.
        if (typeof msg?.data === "string") {
          recordInput(msg.data);
          updateFakeEditorDraft(msg.data);
        }
        break;
      case "panel_resize":
        // A force resize = xterm remounted (clean terminal). The real host
        // re-pushes the handshake here; mirror it so a second kitty reply
        // appears in the input file (the session-switch invariant, I6).
        if (msg?.force === true && panelOpen) {
          send({ type: "panel_data", panelId: PANEL_ID, data: KITTY_HANDSHAKE });
        }
        break;
      case "panel_close_request":
        closeUnifiedPanel();
        break;
      case "unified_submit_response": {
        const snapshot = pendingSubmits.get(msg.id);
        if (snapshot !== undefined) {
          pendingSubmits.delete(msg.id);
          if (msg.ok === false && msg.bailed === true) editorDraft = snapshot;
        }
        if (deferredClose) maybeCloseDeferredUnifiedPanel();
        break;
      }
      case "clipboard_read_image_response":
      case "dialog_response":
        // Renderer replies we don't need to act on for the render/input test.
        break;
      default:
        break;
    }
  } catch (err) {
    process.stderr.write(`fake-unified-host: ${err?.stack ?? err}\n`);
  }
});

process.on("disconnect", () => {
  if (panelTimer) clearInterval(panelTimer);
  process.exit(0);
});
