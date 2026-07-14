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
import crypto from "node:crypto";
import * as fs from "node:fs";

const INPUT_FILE = process.env.PIVIS_TEST_HOST_INPUT_FILE;
const PANEL_ID = 1;

const MODELS = [
  { id: "fake-model", name: "Fake Model", api: "fake", provider: "fake", reasoning: false },
  { id: "fake-model-2", name: "Fake Model Two", api: "fake", provider: "fake", reasoning: true },
];

const hostInstanceId = crypto.randomUUID();
const sessionEpoch = 0;
let transportSequence = 0;
let snapshotSequence = 0;
// Authority-frame cursors are per plane, never aliases of legacy child IPC.
let semanticTransportSequence = 0;
let transcriptTransportSequence = 0;
let extensionUiTransportSequence = 0;
let panelTransportSequence = 0;
let lastSemanticSnapshotSequence = 0;
let panelRenderRevision = 0;
let panelInputAcknowledgedThrough = 0;
let panelRepaintAcknowledgedRevision = 0;
let panelFramebuffer = "";
let editorRevision = 0;
let editorText = "";
let editorAttachments = [];
let closeToken;
let panelOpen = false;
let panelTimer = null;
let factoryWidgetActive = false;
let deferredClose = false;
let editorDraft = "";
let submitCounter = 0;
const pendingSubmits = new Map();
// The authority dispatch journal is intentionally independent from the legacy
// submit compatibility seam. Receipts only admit; terminal results travel in
// semantic frames.
const authorityIntents = new Map();
const authorityOutcomes = [];
let customPanelOpen = false;
const CUSTOM_PANEL_ID = 2;
const CUSTOM_PANEL_KEY = `panel:${CUSTOM_PANEL_ID}`;
let customPanelRenderRevision = 0;
let customPanelFramebuffer = "";
const AUTO_CLOSE_MS = Number(process.env.PIVIS_TEST_UNIFIED_AUTO_CLOSE_MS || 0);
const AUTO_CLOSE_AFTER_DRAFT = process.env.PIVIS_TEST_UNIFIED_AUTO_CLOSE_AFTER_DRAFT || "";
const HANG_UNIFIED_SUBMIT = process.env.PIVIS_TEST_HANG_UNIFIED_SUBMIT === "1";
let autoClosedAfterDraft = false;

// The kitty keyboard protocol handshake the REAL host writes in
// HostTerminal.start() (see keyboard-protocol.mjs): enable bracketed paste, then
// push flags 7 + query current flags + DA sentinel. xterm 6.1 (with
// vtExtensions.kittyKeyboard) ANSWERS this over its onData → panel_input, so the
// test can assert byte-level that xterm (a) granted kitty and (b) encodes
// Shift+Enter as \x1b[13;2u. Re-emitted on a force-resize (the remount path).
const KITTY_HANDSHAKE = "\x1b[?2004h\x1b[>7u\x1b[?u\x1b[c";

function send(msg) {
  if (typeof process.send === "function") {
    process.send({
      ...msg,
      hostInstanceId,
      sessionEpoch,
      transportSequence: ++transportSequence,
    });
  }
}

function sendControl(payload) {
  send({ type: "control", payload });
}

function authorityOwner() {
  return { hostInstanceId, sessionEpoch };
}

function snapshot() {
  return {
    hostInstanceId,
    sessionEpoch,
    snapshotSequence: ++snapshotSequence,
    capturedAt: Date.now(),
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    retryAttempt: 0,
    isBashRunning: false,
    model: MODELS[0],
    thinkingLevel: "medium",
    sessionId: "fake-unified",
    pendingMessageCount: 0,
    steering: [],
    followUp: [],
    hostFacts: {
      submitting: false,
      actualCompaction: false,
      navigation: false,
      pendingDialogs: 0,
      custodyCount: 0,
    },
    catalog: {
      notifications: [],
      statuses: {},
      widgets: {},
      toolsExpanded: false,
      capabilityDiagnostics: [],
    },
    editor: { revision: editorRevision, text: editorText, attachments: editorAttachments },
  };
}

function semanticSnapshot() {
  const value = snapshot();
  lastSemanticSnapshotSequence = value.snapshotSequence;
  const owner = authorityOwner();
  return {
    owner,
    snapshotSequence: value.snapshotSequence,
    capturedAt: value.capturedAt,
    sdk: {
      isStreaming: value.isStreaming,
      isIdle: value.isIdle,
      isCompacting: value.isCompacting,
      isRetrying: value.isRetrying,
      retryAttempt: value.retryAttempt,
      isBashRunning: value.isBashRunning,
    },
    activity: {},
    queues: {
      steering: [],
      followUp: [],
      steeringIntentIds: [],
      followUpIntentIds: [],
    },
    custody: [],
    editor: value.editor,
    activeIntents: [...authorityIntents.values()]
      .filter((entry) => !entry.outcome)
      .map((entry) => ({
        intentId: entry.intentId,
        owner: entry.owner,
        kind: entry.intent.kind,
        state: "admitted",
        recordedAt: entry.recordedAt,
      })),
    recentIntentOutcomes: authorityOutcomes.slice(-20),
    recentObservedOperations: [],
    operationJournalLowWatermark: 0,
    operationJournalHighWatermark: 0,
    operationJournalTruncated: false,
    dispatchedIntentLowWatermark: 0,
    dispatchedIntentHighWatermark: 0,
    dispatchedIntentTruncated: false,
    model: value.model,
    thinkingLevel: value.thinkingLevel,
    catalog: value.catalog,
  };
}

function emitAuthorityFrame(records = []) {
  const terminalSnapshot = semanticSnapshot();
  const transportSequence = ++semanticTransportSequence;
  send({
    type: "authority_frame",
    frame: {
      owner: terminalSnapshot.owner,
      transportSequence,
      frameId: `${hostInstanceId}:${sessionEpoch}:${transportSequence}`,
      records,
      terminalSnapshot,
    },
  });
  return terminalSnapshot;
}

function presentationCursor(plane, snapshotSequence = lastSemanticSnapshotSequence || 1) {
  const transportSequence =
    plane === "transcript"
      ? ++transcriptTransportSequence
      : plane === "extensionUi"
        ? ++extensionUiTransportSequence
        : ++panelTransportSequence;
  return { ...authorityOwner(), transportSequence, snapshotSequence };
}

function publishPanel(payload) {
  send({
    type: "authority_publication",
    publication: { plane: "panel", owner: authorityOwner(), payload },
  });
}

function panelBaseline(cursor, ansi = `${KITTY_HANDSHAKE}${panelFramebuffer}`, following = true) {
  return {
    panelKey: `panel:${PANEL_ID}`,
    panelId: PANEL_ID,
    owner: authorityOwner(),
    sync: following
      ? { state: "following", cursor }
      : { state: "synchronizing", lastCursor: cursor, reason: "repaint_ack_pending" },
    overlay: false,
    unified: true,
    mode: "content",
    inputAcknowledgedThrough: panelInputAcknowledgedThrough,
    keyframe: { kind: "keyframe", ansi, renderRevision: panelRenderRevision },
  };
}

function publishPanelReset() {
  const cursor = presentationCursor("panel");
  publishPanel({
    kind: "reset",
    cursor,
    panelKey: `panel:${PANEL_ID}`,
    renderRevision: panelRenderRevision,
    panelId: PANEL_ID,
    overlay: false,
    unified: true,
    mode: "content",
  });
}

function publishPanelKeyframe(following = true) {
  const cursor = presentationCursor("panel");
  publishPanel({ kind: "keyframe", cursor, panel: panelBaseline(cursor, undefined, following) });
}

function publishPanelData(data) {
  const cursor = presentationCursor("panel");
  publishPanel({
    kind: "ansi_delta",
    cursor,
    panelKey: `panel:${PANEL_ID}`,
    data,
    renderRevision: panelRenderRevision,
  });
}

function publishPanelClose() {
  const cursor = presentationCursor("panel");
  publishPanel({ kind: "close", cursor, panelKey: `panel:${PANEL_ID}` });
}

function publishCustomPanelReset() {
  const cursor = presentationCursor("panel");
  publishPanel({
    kind: "reset",
    cursor,
    panelKey: CUSTOM_PANEL_KEY,
    renderRevision: customPanelRenderRevision,
    panelId: CUSTOM_PANEL_ID,
    overlay: true,
    unified: false,
    mode: "viewport",
  });
}

function publishCustomPanelKeyframe() {
  const cursor = presentationCursor("panel");
  publishPanel({
    kind: "keyframe",
    cursor,
    panel: {
      panelKey: CUSTOM_PANEL_KEY,
      panelId: CUSTOM_PANEL_ID,
      owner: authorityOwner(),
      sync: { state: "following", cursor },
      overlay: true,
      unified: false,
      mode: "viewport",
      inputAcknowledgedThrough: 0,
      keyframe: {
        kind: "keyframe",
        ansi: customPanelFramebuffer,
        renderRevision: customPanelRenderRevision,
      },
    },
  });
}

function publishCustomPanelData(data) {
  const cursor = presentationCursor("panel");
  publishPanel({
    kind: "ansi_delta",
    cursor,
    panelKey: CUSTOM_PANEL_KEY,
    data,
    renderRevision: customPanelRenderRevision,
  });
}

function publishCustomPanelClose() {
  const cursor = presentationCursor("panel");
  publishPanel({ kind: "close", cursor, panelKey: CUSTOM_PANEL_KEY });
}

function authorityAttach(rendererGeneration) {
  const semantic = semanticSnapshot();
  if (semanticTransportSequence === 0) semanticTransportSequence = 1;
  if (transcriptTransportSequence === 0) transcriptTransportSequence = 1;
  if (extensionUiTransportSequence === 0) extensionUiTransportSequence = 1;
  if (panelOpen && panelTransportSequence === 0) panelTransportSequence = 1;
  const owner = authorityOwner();
  const semanticCursor = {
    ...owner,
    transportSequence: semanticTransportSequence,
    snapshotSequence: semantic.snapshotSequence,
  };
  const presentationBaseline = (transportSequence) => ({
    ...owner,
    transportSequence,
    snapshotSequence: semantic.snapshotSequence,
  });
  const panelCursor = presentationBaseline(panelTransportSequence);
  return {
    sessionId: "fake-unified",
    rendererGeneration,
    owner,
    semantic: { sync: { state: "following", cursor: semanticCursor }, snapshot: semantic },
    operationJournal: [],
    restorations: [],
    transcript: {
      sync: { state: "following", cursor: presentationBaseline(transcriptTransportSequence) },
      persistedHistoryCursor: null,
      liveTailCursor: null,
      overlapBoundary: null,
    },
    extensionUi: {
      sync: { state: "following", cursor: presentationBaseline(extensionUiTransportSequence) },
      notifications: [],
      statuses: {},
      widgets: {},
      dialogs: [],
    },
    panels: [
      ...(panelOpen ? [panelBaseline(panelCursor)] : []),
      ...(customPanelOpen
        ? [
            {
              panelKey: CUSTOM_PANEL_KEY,
              panelId: CUSTOM_PANEL_ID,
              owner,
              sync: { state: "following", cursor: panelCursor },
              overlay: true,
              unified: false,
              mode: "viewport",
              inputAcknowledgedThrough: 0,
              keyframe: {
                kind: "keyframe",
                ansi: customPanelFramebuffer,
                renderRevision: customPanelRenderRevision,
              },
            },
          ]
        : []),
    ],
    publicationHighWatermark: 0,
  };
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
  send({ type: "unified_submit_request", id, text, editorRevision });
}

function updateFakeEditorDraft(data) {
  if (!panelOpen) return;
  const plain = stripControlSequences(data);
  for (const ch of plain) {
    if (ch === "\r") {
      submitUnifiedDraft();
    } else if (ch === "\b" || ch === "\x7f") {
      editorDraft = editorDraft.slice(0, -1);
      editorRevision++;
      maybeCloseDeferredUnifiedPanel();
    } else if (ch === "\n" || ch >= " ") {
      editorDraft += ch;
      editorRevision++;
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
  const data = renderRoster();
  panelFramebuffer = data;
  send({ type: "panel_data", panelId: PANEL_ID, data });
  publishPanelData(data);
}

function requestPanelRepaint() {
  if (!panelOpen) return;
  panelRenderRevision++;
  // Input sequence is monotonic for the panel identity across repaint/remount.
  // Only the repaint revision is fenced; resetting the cumulative input ack
  // would turn the first post-remount terminal reply into an unrecoverable gap.
  panelRepaintAcknowledgedRevision = 0;
  publishPanelReset();
  publishPanelKeyframe(false);
  // The mounted xterm acknowledges only after it has applied the reset. Delay
  // one turn so panel_open has committed and UnifiedTuiHost has subscribed.
  setTimeout(() => {
    if (panelOpen)
      send({ type: "panel_repaint", panelId: PANEL_ID, revision: panelRenderRevision });
  }, 0).unref?.();
}

function openUnifiedPanel() {
  if (panelOpen) return;
  panelOpen = true;
  factoryWidgetActive = true;
  deferredClose = false;
  editorDraft = "";
  autoClosedAfterDraft = false;
  pendingSubmits.clear();
  panelRenderRevision++;
  panelInputAcknowledgedThrough = 0;
  panelRepaintAcknowledgedRevision = 0;
  panelFramebuffer = renderRoster();
  send({
    type: "panel_open",
    panelId: PANEL_ID,
    overlay: false,
    unified: true,
    baseline: { revision: panelRenderRevision, repaintRequired: true },
  });
  // A reset plus a full child-owned keyframe gives frame consumers a complete
  // baseline before independent ANSI deltas begin.
  publishPanelReset();
  publishPanelKeyframe();
  // Mirror the real host: push the kitty handshake so xterm answers it. The
  // reply (+ later keystrokes) is captured to PIVIS_TEST_HOST_INPUT_FILE.
  send({ type: "panel_data", panelId: PANEL_ID, data: KITTY_HANDSHAKE });
  renderFrame();
  requestPanelRepaint();
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
  publishPanelClose();
}

function stableAuthorityFingerprint(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableAuthorityFingerprint).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableAuthorityFingerprint(value[key])}`)
    .join(",")}}`;
}

function finishAuthorityIntent(entry, state, result, error) {
  if (entry.outcome) return;
  const outcome = {
    intentId: entry.intentId,
    owner: structuredClone(entry.owner),
    kind: entry.intent.kind,
    state,
    ...(result === undefined ? {} : { result }),
    ...(error ? { error } : {}),
  };
  entry.outcome = outcome;
  authorityOutcomes.push(outcome);
  emitAuthorityFrame([{ type: "intent_outcome", outcome }]);
}

function executeAuthorityIntent(entry) {
  const { intent } = entry;
  if (intent.kind === "submit") {
    // Preserve the claimed-action timeout seam. Admission is durable, but no
    // terminal authority evidence is published for this intentionally hung run.
    if (HANG_UNIFIED_SUBMIT && intent.surface === "unified") return;
    editorRevision = Math.max(editorRevision, intent.editorRevision) + 1;
    editorText = "";
    editorAttachments = [];
    finishAuthorityIntent(entry, "completed", {
      disposition: "consumed",
      editorRevision: intent.editorRevision,
      queued: false,
    });
    return;
  }
  if (intent.kind === "invokeCommand") {
    const command = intent.text.trim().replace(/^\//, "").split(/\s+/, 1)[0];
    if (command === "custom-panel") openCustomPanel("composer");
    finishAuthorityIntent(entry, "completed", {
      ...(command ? { commandType: command } : {}),
      disposition: "consumed",
      editorRevision: intent.editorRevision,
      queued: false,
    });
    return;
  }
  finishAuthorityIntent(entry, "completed", {});
}

function dispatchAuthorityIntent(envelope) {
  const intentId = envelope?.intentId;
  const owner = envelope?.expectedOwner;
  const intent = envelope?.intent;
  if (!intentId || !owner || !intent || typeof intent.kind !== "string") {
    return {
      status: "not_admitted",
      intentId: typeof intentId === "string" && intentId ? intentId : "invalid-intent",
      reason: "invalid",
      invalidReason: "malformed",
    };
  }
  if (owner.hostInstanceId !== hostInstanceId || owner.sessionEpoch !== sessionEpoch) {
    return { status: "not_admitted", intentId, reason: "stale_owner" };
  }
  const key = `${owner.hostInstanceId}:${owner.sessionEpoch}:${intentId}`;
  const fingerprint = stableAuthorityFingerprint({ owner, intent });
  const prior = authorityIntents.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      return {
        status: "not_admitted",
        intentId,
        reason: "invalid",
        invalidReason: "payload_conflict",
      };
    }
    return { status: "duplicate", intentId, owner: structuredClone(owner) };
  }
  const entry = {
    intentId,
    owner: structuredClone(owner),
    intent: structuredClone(intent),
    fingerprint,
    recordedAt: Date.now(),
    outcome: null,
  };
  authorityIntents.set(key, entry);
  emitAuthorityFrame();
  queueMicrotask(() => executeAuthorityIntent(entry));
  return { status: "admitted", intentId, owner: structuredClone(owner) };
}

function closeCustomPanel() {
  if (!customPanelOpen) return;
  customPanelOpen = false;
  publishCustomPanelClose();
}

function openCustomPanel(uiSurface) {
  if (uiSurface === "unified") {
    const modeCursor = presentationCursor("panel");
    publishPanel({
      kind: "mode",
      cursor: modeCursor,
      panelKey: `panel:${PANEL_ID}`,
      mode: "viewport",
    });
    const data = `\x1b[2J\x1b[H${["Unified custom panel", "opened from the unified editor"].join("\n")}\n`;
    publishPanelData(data);
    // Compatibility-only copies for renderers without authority projections.
    send({ type: "panel_mode", panelId: PANEL_ID, mode: "viewport" });
    send({ type: "panel_data", panelId: PANEL_ID, data });
    return;
  }

  customPanelOpen = true;
  customPanelRenderRevision++;
  customPanelFramebuffer = `\x1b[2J\x1b[H${["Composer custom panel", "opened from the native composer"].join("\n")}\n`;
  // The canonical panel projection, rather than legacy panel_open/data, owns
  // replacement of the composer. Keep the unified panel's panelKey alive.
  publishCustomPanelReset();
  publishCustomPanelKeyframe();
  publishCustomPanelData(customPanelFramebuffer);
  // Compatibility copy for renderers that have not installed the authority
  // projection. Delay one turn so their CustomPanelHost can subscribe.
  setTimeout(() => {
    if (customPanelOpen)
      send({ type: "panel_data", panelId: CUSTOM_PANEL_ID, data: customPanelFramebuffer });
  }, 0).unref?.();
}

// ─── Wire protocol handling ────────────────────────────────────────────────

process.on("message", (msg) => {
  if (process.env.PIVIS_TEST_HOST_MESSAGE_LOG) {
    fs.appendFileSync(
      process.env.PIVIS_TEST_HOST_MESSAGE_LOG,
      `${JSON.stringify({
        type: msg?.type,
        command: msg?.command?.type,
        text: msg?.submission?.text,
        intent: msg?.envelope?.intent,
        panelId: msg?.panelId,
        force: msg?.force,
        revision: msg?.revision,
        data: msg?.type === "panel_input" ? msg?.data : undefined,
      })}\n`,
    );
  }
  try {
    switch (msg?.type) {
      case "init":
        sendControl({ type: "spawned" });
        sendControl({ type: "ready", piVersion: "99.0.0", snapshot: snapshot() });
        emitAuthorityFrame();
        // Open the unified panel shortly after ready, mirroring an extension
        // registering a factory setWidget during its first tool call.
        setTimeout(openUnifiedPanel, 300);
        break;
      case "command":
        handleCommand(msg.id, msg.command, msg.uiSurface);
        break;
      case "state_request":
        // Compatibility resync is a direct public-session snapshot, not a
        // semantic frame or a presentation baseline.
        reply(msg.id, true, snapshot());
        break;
      case "authority_attach":
        reply(msg.id, true, authorityAttach(msg.rendererGeneration));
        break;
      case "lifecycle_permit": {
        const active =
          pendingSubmits.size > 0 || [...authorityIntents.values()].some((entry) => !entry.outcome);
        const presentationActive =
          editorText.length > 0 ||
          editorAttachments.length > 0 ||
          panelOpen ||
          customPanelOpen ||
          factoryWidgetActive;
        reply(
          msg.id,
          true,
          active
            ? { allowed: false, reason: "active" }
            : msg.operation === "activation_visit_release" && presentationActive
              ? { allowed: false, reason: "presentation_active" }
              : { allowed: true, reason: "allowed" },
        );
        break;
      }
      case "dispatch_intent":
        reply(msg.id, true, dispatchAuthorityIntent(msg.envelope));
        break;
      case "prepare_close":
        closeToken = crypto.randomUUID();
        reply(msg.id, true, {
          token: closeToken,
          mutationSequence: snapshotSequence,
          snapshot: snapshot(),
          custody: [],
          activeIntents: [],
          restorations: [],
          ui: {
            editor: { revision: editorRevision, text: editorText, attachments: editorAttachments },
            unifiedSubmissions: [...pendingSubmits].map(([id, text]) => ({ id, text })),
            panels: panelOpen ? [{ panelId: PANEL_ID }] : [],
          },
        });
        break;
      case "confirm_close":
        reply(msg.id, true, { valid: msg.token === closeToken });
        break;
      case "cancel_close": {
        const cancelled = msg.token === closeToken;
        if (cancelled) closeToken = undefined;
        reply(msg.id, true, { cancelled });
        break;
      }
      case "submit": {
        const submission = msg.submission;
        if (HANG_UNIFIED_SUBMIT && submission.surface === "unified") break;
        reply(msg.id, true, {
          intentId: submission.intentId,
          hostInstanceId: submission.expectedHostId,
          sessionEpoch: submission.expectedEpoch,
          editorRevision: submission.editorRevision,
          disposition: "consumed",
        });
        if (submission.text === "/custom-panel") openCustomPanel(submission.surface);
        break;
      }
      case "editor_patch":
        editorRevision = msg.patch?.revision ?? editorRevision;
        editorText = msg.patch?.text ?? editorText;
        editorAttachments = structuredClone(msg.patch?.attachments ?? []);
        reply(msg.id, true, {
          accepted: true,
          revision: editorRevision,
          text: editorText,
          attachments: editorAttachments,
        });
        break;
      case "panel_input": {
        const expected = panelInputAcknowledgedThrough + 1;
        const repaintRequired =
          !panelOpen ||
          msg?.panelId !== PANEL_ID ||
          msg?.revision !== panelRenderRevision ||
          panelRepaintAcknowledgedRevision !== panelRenderRevision;
        if (repaintRequired) {
          reply(msg.id, true, {
            acknowledgedThrough: panelInputAcknowledgedThrough,
            repaintRequired: { revision: panelRenderRevision, repaintRequired: true },
          });
        } else if (msg.sequence !== expected) {
          reply(msg.id, true, {
            acknowledgedThrough: panelInputAcknowledgedThrough,
            gap: { expected, received: msg.sequence },
          });
        } else {
          // Keystrokes from UnifiedTuiHost's xterm → record for the input-routing
          // assertion and update a tiny fake editor draft so this fixture can
          // model the real host's draft-retained self-close invariant.
          if (typeof msg?.data === "string") {
            recordInput(msg.data);
            updateFakeEditorDraft(msg.data);
          }
          panelInputAcknowledgedThrough = msg.sequence;
          reply(msg.id, true, { acknowledgedThrough: panelInputAcknowledgedThrough });
        }
        break;
      }
      case "panel_repaint_ack":
        if (panelOpen && msg?.panelId === PANEL_ID && msg?.revision === panelRenderRevision) {
          panelRepaintAcknowledgedRevision = panelRenderRevision;
          reply(msg.id, true, { acknowledged: true });
          publishPanelKeyframe(true);
          // Re-send the control handshake through the accepted authority plane
          // after the following keyframe enables terminal replies.
          setTimeout(() => {
            if (panelOpen && panelRepaintAcknowledgedRevision === panelRenderRevision)
              publishPanelData(KITTY_HANDSHAKE);
          }, 50).unref?.();
        } else {
          reply(msg.id, true, { acknowledged: false });
        }
        break;
      case "panel_resize":
        // A force resize = xterm remounted (clean terminal). The real host
        // re-pushes the handshake here; mirror it so a second kitty reply
        // appears in the input file (the session-switch invariant, I6).
        if (msg?.force === true && panelOpen) {
          send({ type: "panel_data", panelId: PANEL_ID, data: KITTY_HANDSHAKE });
          requestPanelRepaint();
        }
        break;
      case "panel_close_request":
        if (msg?.panelId === CUSTOM_PANEL_ID) closeCustomPanel();
        else closeUnifiedPanel();
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
