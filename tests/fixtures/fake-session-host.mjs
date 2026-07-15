#!/usr/bin/env node
/**
 * Deterministic direct SessionHost-protocol fake used by the default Electron
 * E2E suites. It is a child-process IPC peer, not a pi RPC/JSONL process.
 *
 * The fixture deliberately models the protocol facts SessionHost validates:
 * UUID host identity, epoch and transport ordering, direct snapshots, command
 * correlation, submit dispositions, transition batches, UI/panel acks, and
 * revisioned editor state. It also persists enough real session JSONL for
 * history/session-file and diff-comment tests.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hostInstanceId = crypto.randomUUID();
let sessionEpoch = 0;
let snapshotSequence = 0;
let transportSequence = 0;
// Authority-frame cursors are independent from the legacy child IPC sequence.
// Keeping them separate lets transcript/UI traffic never create a semantic gap.
let semanticTransportSequence = 0;
const presentationTransportSequence = { transcript: 0, extensionUi: 0, panel: 0 };
const authorityIntents = new Map();
const authorityOutcomes = [];
const authorityJournal = [];
const authorityRestorations = new Map();
const transitionPermitWaiters = new Map();
let authorityJournalSequence = 0;
let initialized = false;
let cwd = process.cwd();
let sessionId = crypto.randomUUID();
let sessionFile;
let sessionName;
let fileCreated = false;
let lastEntryId;
let currentThinkingLevel = "off";
let currentModelId = "fake-model";
let runtimeStreaming = false;
let runtimeCompacting = false;
let runtimeRetrying = false;
let runtimeNavigation = false;
let runtimeBash = false;
let runtimeEditorPending = false;
let retryAttempt = 0;
let operationSequence = 0;
const activeOperations = new Map();
const steeringQueue = [];
const followUpQueue = [];
let editorRevision = 0;
let closeToken;
let editorText = "";
let editorAttachments = [];
let lastAssistantText = null;
let heartbeat;

const pendingDialogs = new Map();
const openPanels = new Set();
const userMessagesForForking = [];
const catalog = {
  notifications: [],
  statuses: {},
  widgets: {},
  toolsExpanded: false,
  capabilityDiagnostics: [],
};

const fakeModels = [
  {
    id: "fake-model",
    name: "Fake Model",
    api: "fake",
    provider: "fake",
    reasoning: false,
    contextWindow: 200000,
    input: ["text", "image"],
  },
  {
    id: "fake-model-2",
    name: "Fake Model Two",
    api: "fake",
    provider: "fake",
    reasoning: true,
    contextWindow: 200000,
    input: ["text", "image"],
  },
];

function currentModel() {
  return fakeModels.find((model) => model.id === currentModelId) ?? fakeModels[0];
}

function send(message) {
  if (typeof process.send !== "function" || !process.connected) return;
  process.send({
    ...message,
    hostInstanceId,
    sessionEpoch,
    transportSequence: ++transportSequence,
  });
  // Presentation traffic has its own cursor. Legacy wire messages remain for
  // existing E2E seams, while frame consumers only use these publications.
  if (message?.type === "extension_ui_request") {
    publishExtensionUi(message);
  } else if (typeof message?.type === "string" && message.type.startsWith("panel_")) {
    publishPanel(message);
  }
}

function sendControl(payload) {
  send({ type: "control", payload });
}

function snapshot() {
  return {
    hostInstanceId,
    sessionEpoch,
    snapshotSequence: ++snapshotSequence,
    capturedAt: Date.now(),
    isStreaming: runtimeStreaming,
    isIdle:
      !runtimeStreaming &&
      !runtimeCompacting &&
      !runtimeRetrying &&
      !runtimeNavigation &&
      !runtimeBash &&
      !runtimeEditorPending &&
      pendingDialogs.size === 0,
    isCompacting: runtimeCompacting,
    isRetrying: runtimeRetrying,
    retryAttempt,
    isBashRunning: runtimeBash,
    model: currentModel(),
    thinkingLevel: currentThinkingLevel,
    sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    ...(sessionName ? { sessionName } : {}),
    pendingMessageCount: steeringQueue.length + followUpQueue.length,
    steering: steeringQueue.map((item) => item.text),
    followUp: followUpQueue.map((item) => item.text),
    hostFacts: {
      submitting: runtimeEditorPending,
      actualCompaction: runtimeCompacting,
      navigation: runtimeNavigation,
      pendingDialogs: pendingDialogs.size,
      custodyCount: steeringQueue.length + followUpQueue.length,
    },
    catalog: structuredClone(catalog),
    editor: { revision: editorRevision, text: editorText, attachments: editorAttachments },
  };
}

function authorityOwner() {
  return { hostInstanceId, sessionEpoch };
}

function semanticSnapshot() {
  const value = snapshot();
  const owner = authorityOwner();
  const outcomes = authorityOutcomes.filter(
    (outcome) =>
      outcome.owner.hostInstanceId === owner.hostInstanceId &&
      outcome.owner.sessionEpoch === owner.sessionEpoch,
  );
  const activeIntents = [...authorityIntents.values()]
    .filter(
      (entry) =>
        entry.owner.hostInstanceId === owner.hostInstanceId &&
        entry.owner.sessionEpoch === owner.sessionEpoch &&
        !entry.outcome,
    )
    .map((entry) => ({
      intentId: entry.intentId,
      owner,
      kind: entry.intent.kind,
      state: "admitted",
      recordedAt: entry.recordedAt,
    }));
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
      steering: value.steering,
      followUp: value.followUp,
      steeringIntentIds: steeringQueue.map((item) => item.intentId ?? null),
      followUpIntentIds: followUpQueue.map((item) => item.intentId ?? null),
    },
    custody: [],
    editor: value.editor,
    activeIntents,
    recentIntentOutcomes: outcomes,
    recentObservedOperations: [],
    operationJournalLowWatermark: authorityJournal[0]?.sequence ?? authorityJournalSequence,
    operationJournalHighWatermark: authorityJournalSequence,
    operationJournalTruncated: false,
    dispatchedIntentLowWatermark: 0,
    dispatchedIntentHighWatermark: authorityIntents.size,
    dispatchedIntentTruncated: false,
    model: value.model,
    thinkingLevel: value.thinkingLevel,
    sessionName: value.sessionName,
    catalog: value.catalog,
  };
}

function emitAuthorityFrame(records = []) {
  const terminalSnapshot = semanticSnapshot();
  const frameSequence = ++semanticTransportSequence;
  send({
    type: "authority_frame",
    frame: {
      owner: terminalSnapshot.owner,
      transportSequence: frameSequence,
      frameId: `${hostInstanceId}:${sessionEpoch}:${frameSequence}`,
      records,
      terminalSnapshot,
    },
  });
}

function presentationCursor(plane) {
  return {
    ...authorityOwner(),
    transportSequence: ++presentationTransportSequence[plane],
    snapshotSequence: Math.max(1, snapshotSequence),
  };
}

function publishTranscript(event) {
  const cursor = presentationCursor("transcript");
  send({
    type: "authority_publication",
    publication: {
      plane: "transcript",
      owner: authorityOwner(),
      payload: {
        kind: "delta",
        cursor,
        liveTailCursor: String(cursor.transportSequence),
        entries: [structuredClone(event)],
      },
    },
  });
}

function publishExtensionUi(request) {
  const cursor = presentationCursor("extensionUi");
  send({
    type: "authority_publication",
    publication: {
      plane: "extensionUi",
      owner: authorityOwner(),
      payload: {
        kind: "request",
        cursor,
        request: { ...structuredClone(request), hostInstanceId, sessionEpoch },
      },
    },
  });
}

function publishPanel(event) {
  const cursor = presentationCursor("panel");
  const panelKey = `panel:${event.panelId ?? "all"}`;
  const payload =
    event.type === "panel_close"
      ? { kind: "close", cursor, panelKey }
      : event.type === "panel_data"
        ? { kind: "ansi_delta", cursor, panelKey, data: event.data ?? "", renderRevision: 0 }
        : {
            kind: "repaint_required",
            cursor,
            panelKey,
            reason: "fixture_repaint",
            renderRevision: event.revision ?? 0,
          };
  send({
    type: "authority_publication",
    publication: { plane: "panel", owner: authorityOwner(), payload },
  });
}

function publishSnapshot(full = false) {
  const value = snapshot();
  sendControl({ type: "snapshot", snapshot: value, ...(full ? { full: true } : {}) });
  emitAuthorityFrame();
  return value;
}

function reply(id, success, data, error) {
  send({
    type: "response",
    id,
    success,
    ...(data !== undefined ? { data } : {}),
    ...(error ? { error } : {}),
  });
}

function emitEvent(event) {
  send({ type: "event", event });
  publishTranscript(event);
}

function newEntryId() {
  return crypto.randomBytes(4).toString("hex");
}

function sessionsRoot() {
  return (
    process.env.FAKE_PI_SESSIONS_DIR ??
    process.env.PIVIS_SESSIONS_DIR ??
    path.join(os.tmpdir(), "pivis-fake-session-host")
  );
}

function allocateSessionPath(prefix = new Date().toISOString().replace(/[:.]/g, "-")) {
  const encodedCwd = `-${cwd.replaceAll("/", "-")}--`;
  return path.join(sessionsRoot(), encodedCwd, `${prefix}_${sessionId}.jsonl`);
}

function loadSession(file) {
  sessionFile = file;
  fileCreated = fs.existsSync(file);
  if (!fileCreated) return;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  try {
    const header = JSON.parse(lines[0] ?? "");
    if (typeof header.id === "string") sessionId = header.id;
  } catch {
    // Keep the generated identity for a malformed fixture file.
  }
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw);
      if (typeof entry.id === "string") lastEntryId = entry.id;
      if (entry.type === "session_info" && typeof entry.name === "string") {
        sessionName = entry.name;
      }
      const text = entry.message?.content?.find?.((part) => part?.type === "text")?.text;
      if (entry.type === "message" && entry.message?.role === "user" && typeof text === "string") {
        userMessagesForForking.push({ entryId: entry.id, text });
      }
      if (
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        typeof text === "string"
      ) {
        lastAssistantText = text;
      }
    } catch {
      // Ignore malformed historical lines; the E2E fixture stays available.
    }
  }
}

function ensureFile() {
  if (fileCreated) return;
  sessionFile ??= allocateSessionPath();
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
    })}\n`,
  );
  fileCreated = true;
}

function appendEntry(fields) {
  ensureFile();
  const entry = {
    id: newEntryId(),
    ...(lastEntryId ? { parentId: lastEntryId } : {}),
    timestamp: Date.now(),
    ...fields,
  };
  fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  lastEntryId = entry.id;
  return entry;
}

function appendMessage(role, text) {
  return appendEntry({
    type: "message",
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  });
}

function emitUser(text) {
  const message = { role: "user", content: [{ type: "text", text }] };
  emitEvent({ type: "message_start", message });
  emitEvent({ type: "message_end", message });
}

function emitAssistant(text, chunkSize = text.length || 1) {
  const message = { role: "assistant" };
  emitEvent({ type: "message_start", message });
  for (let index = 0; index < text.length; index += chunkSize) {
    emitEvent({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        delta: text.slice(index, index + chunkSize),
      },
    });
  }
  emitEvent({ type: "message_end", message });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logOperation(event, details = {}) {
  const file = process.env.PIVIS_TEST_HOST_OPERATION_LOG;
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify({ event, at: Date.now(), ...details })}\n`);
}

function beginOperation(kind) {
  const token = `${kind}-${++operationSequence}`;
  activeOperations.set(kind, token);
  logOperation("started", { kind, token });
  return token;
}

function operationIsActive(kind, token) {
  return activeOperations.get(kind) === token;
}

function completeOperation(kind, token) {
  if (!operationIsActive(kind, token)) return false;
  activeOperations.delete(kind);
  logOperation("completed", { kind, token });
  return true;
}

function cancelOperation(kind) {
  const token = activeOperations.get(kind);
  if (!token) return false;
  activeOperations.delete(kind);
  logOperation("cancelled", { kind, token });
  return true;
}

function submissionResult(submission, disposition, extra = {}) {
  return {
    intentId: submission.intentId,
    hostInstanceId,
    sessionEpoch,
    editorRevision: submission.editorRevision,
    disposition,
    ...extra,
  };
}

function reportCompleted(submission) {
  send({
    type: "submission_disposition",
    result: submissionResult(submission, "completed"),
  });
}

async function runHello(submission) {
  const operationToken = beginOperation("streaming");
  emitEvent({ type: "agent_start" });
  emitEvent({ type: "turn_start" });
  runtimeStreaming = true;
  publishSnapshot();
  const text = "Hello! I'm your pi coding agent.";
  const message = { role: "assistant" };
  emitEvent({ type: "message_start", message });
  for (const delta of ["Hello! ", "I'm ", "your pi ", "coding agent."]) {
    emitEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta },
    });
    await sleep(300);
    if (!operationIsActive("streaming", operationToken)) return;
  }
  emitEvent({ type: "message_end", message });
  emitEvent({ type: "turn_end" });
  emitEvent({ type: "agent_end" });
  emitEvent({ type: "agent_settled" });
  appendMessage("assistant", text);
  logOperation("persisted", { kind: "streaming", token: operationToken, text });
  lastAssistantText = text;
  runtimeStreaming = false;
  completeOperation("streaming", operationToken);
  reportCompleted(submission);
  publishSnapshot();
}

async function runLongTool(submission) {
  const operationToken = beginOperation("streaming");
  runtimeStreaming = true;
  emitEvent({ type: "agent_start" });
  emitEvent({ type: "turn_start" });
  publishSnapshot();
  const output = Array.from({ length: 240 }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return `long-tool-line-${number}  ${"abcdef0123456789 ".repeat((index % 8) + 1)}complete`;
  }).join("\n");
  const command = `node scripts/generate-long-report.mjs --workspace ${cwd} --include-transcript --format=json --long-option=${"value-".repeat(22)}tail`;
  emitEvent({
    type: "tool_execution_start",
    toolCallId: "tool-long-output",
    toolName: "bash",
    args: { command },
  });
  await sleep(80);
  if (!operationIsActive("streaming", operationToken)) return;
  emitEvent({
    type: "tool_execution_update",
    toolCallId: "tool-long-output",
    toolName: "bash",
    args: { command },
    partialResult: {
      content: [{ type: "text", text: output.split("\n").slice(0, 80).join("\n") }],
      details: { truncation: { truncated: false } },
    },
  });
  await sleep(80);
  if (!operationIsActive("streaming", operationToken)) return;
  emitEvent({
    type: "tool_execution_end",
    toolCallId: "tool-long-output",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: output }],
      details: {
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          outputLines: 240,
          totalLines: 6400,
        },
        fullOutputPath: path.join(os.tmpdir(), "fake-pi-long-output.log"),
      },
    },
    isError: false,
  });
  const text = "Long tool output captured.";
  emitAssistant(text);
  emitEvent({ type: "turn_end" });
  emitEvent({ type: "agent_end" });
  emitEvent({ type: "agent_settled" });
  appendMessage("assistant", text);
  logOperation("persisted", { kind: "streaming", token: operationToken, text });
  lastAssistantText = text;
  runtimeStreaming = false;
  completeOperation("streaming", operationToken);
  reportCompleted(submission);
  publishSnapshot();
}

function openSelect(submission, request, onAnswer) {
  pendingDialogs.set(request.id, { submission, request, onAnswer });
  send(request);
  publishSnapshot();
}

async function finishExtensionText(submission, text) {
  const operationToken = beginOperation("streaming");
  runtimeStreaming = true;
  emitEvent({ type: "agent_start" });
  publishSnapshot();
  if (!operationIsActive("streaming", operationToken)) return;
  emitAssistant(text, 12);
  emitEvent({ type: "agent_end" });
  emitEvent({ type: "agent_settled" });
  appendMessage("assistant", text);
  lastAssistantText = text;
  runtimeStreaming = false;
  completeOperation("streaming", operationToken);
  reportCompleted(submission);
  publishSnapshot();
}

async function runDelayedState(submission, kind) {
  const operationToken = beginOperation(kind);
  if (kind === "navigation") runtimeNavigation = true;
  if (kind === "retry") {
    runtimeRetrying = true;
    retryAttempt = 1;
  }
  if (kind === "editor") runtimeEditorPending = true;
  publishSnapshot();
  await sleep(800);
  if (!operationIsActive(kind, operationToken)) return;
  if (kind === "navigation") runtimeNavigation = false;
  if (kind === "retry") {
    runtimeRetrying = false;
    retryAttempt = 0;
  }
  if (kind === "editor") runtimeEditorPending = false;
  completeOperation(kind, operationToken);
  reportCompleted(submission);
  publishSnapshot();
}

async function runOverlappingOperations(submission) {
  const kinds = ["navigation", "compaction", "retry", "streaming", "bash"];
  const tokens = new Map(kinds.map((kind) => [kind, beginOperation(kind)]));
  runtimeNavigation = true;
  runtimeCompacting = true;
  runtimeRetrying = true;
  retryAttempt = 1;
  runtimeStreaming = true;
  runtimeBash = true;
  publishSnapshot();
  await sleep(2_000);
  let anyCompleted = false;
  for (const [kind, token] of tokens) {
    if (operationIsActive(kind, token)) {
      anyCompleted = completeOperation(kind, token) || anyCompleted;
    }
  }
  runtimeNavigation = false;
  runtimeCompacting = false;
  runtimeRetrying = false;
  retryAttempt = 0;
  runtimeStreaming = false;
  runtimeBash = false;
  if (anyCompleted) reportCompleted(submission);
  publishSnapshot();
}

async function runSubmission(submission) {
  const text = String(submission.text ?? "");
  const lowered = text.toLowerCase();
  const userEntry = appendMessage("user", text);
  userMessagesForForking.push({ entryId: userEntry.id, text });
  emitUser(text);

  if (lowered === "/ask-user-question" || lowered.startsWith("/ask-user-question ")) {
    const id = crypto.randomUUID();
    openSelect(
      submission,
      {
        type: "extension_ui_request",
        id,
        method: "select",
        title: "Pick a choice",
        options: ["Allow", "Deny", "Ask me later"],
        timeout: 120000,
      },
      (response) =>
        finishExtensionText(
          submission,
          `ask-user-question chose: ${response?.value ?? "no-answer"}`,
        ),
    );
    return;
  }

  if (lowered === "/set-editor" || lowered.startsWith("/set-editor ")) {
    // Let the consumed disposition clear the submitted slash text before the
    // extension injects its replacement, matching the real prompt preflight
    // ordering and preventing the clear from winning the renderer race.
    const operationToken = beginOperation("editor");
    runtimeEditorPending = true;
    publishSnapshot();
    await sleep(200);
    if (!operationIsActive("editor", operationToken)) return;
    editorText = "injected by extension";
    editorRevision += 1;
    send({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "set_editor_text",
      text: editorText,
    });
    runtimeEditorPending = false;
    completeOperation("editor", operationToken);
    await finishExtensionText(submission, "set-editor requested");
    return;
  }

  if (lowered === "/timeout-select" || lowered.startsWith("/timeout-select ")) {
    const id = crypto.randomUUID();
    openSelect(
      submission,
      {
        type: "extension_ui_request",
        id,
        method: "select",
        title: "Auto-dismiss me",
        options: ["yes", "no"],
        timeout: 1500,
      },
      () => {},
    );
    setTimeout(() => {
      if (!pendingDialogs.delete(id)) return;
      // Host-enforced timeout: acknowledge the dialog operation so main and
      // the renderer retire the pending surface.
      send({ type: "ui_ack", operationId: id });
      reportCompleted(submission);
      publishSnapshot();
    }, 1550).unref?.();
    return;
  }

  if (lowered === "/widget-on" || lowered.startsWith("/widget-on ")) {
    catalog.widgets.plan = [
      "Plan mode: planning",
      "Tools: read_file",
      "Produce a <proposed_plan> block.",
    ];
    catalog.statuses.plan = "plan active";
    send({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: catalog.widgets.plan,
    });
    send({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "setStatus",
      statusKey: "plan",
      statusText: catalog.statuses.plan,
    });
    reportCompleted(submission);
    publishSnapshot();
    return;
  }

  if (lowered === "/widget-off" || lowered.startsWith("/widget-off ")) {
    delete catalog.widgets.plan;
    delete catalog.statuses.plan;
    send({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "setWidget",
      widgetKey: "plan",
    });
    send({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "setStatus",
      statusKey: "plan",
    });
    reportCompleted(submission);
    publishSnapshot();
    return;
  }

  if (lowered.startsWith("/test-navigation")) {
    await runDelayedState(submission, "navigation");
  } else if (lowered.startsWith("/test-retry")) {
    await runDelayedState(submission, "retry");
  } else if (lowered.startsWith("/test-editor-wait")) {
    await runDelayedState(submission, "editor");
  } else if (lowered.startsWith("/test-overlap")) {
    await runOverlappingOperations(submission);
  } else if (lowered.includes("hello")) {
    await runHello(submission);
  } else if (lowered.includes("long-tool")) {
    await runLongTool(submission);
  } else {
    runtimeStreaming = true;
    emitEvent({ type: "agent_start" });
    publishSnapshot();
    const assistant = `Echo: ${text}`;
    emitAssistant(assistant);
    emitEvent({ type: "agent_end" });
    emitEvent({ type: "agent_settled" });
    appendMessage("assistant", assistant);
    lastAssistantText = assistant;
    runtimeStreaming = false;
    reportCompleted(submission);
    publishSnapshot();
  }
}

function lifecyclePermit(kind) {
  const activeIntent = [...authorityIntents.values()].some((entry) => !entry.outcome);
  const childWork =
    runtimeStreaming ||
    runtimeCompacting ||
    runtimeRetrying ||
    runtimeNavigation ||
    runtimeBash ||
    runtimeEditorPending ||
    activeOperations.size > 0;
  if (childWork || activeIntent || steeringQueue.length > 0 || followUpQueue.length > 0) {
    return { allowed: false, reason: "active" };
  }
  const presentationActive =
    editorText.length > 0 ||
    editorAttachments.length > 0 ||
    pendingDialogs.size > 0 ||
    openPanels.size > 0 ||
    catalog.notifications.length > 0 ||
    Object.keys(catalog.statuses).length > 0 ||
    Object.keys(catalog.widgets).length > 0;
  if (kind === "activation_visit_release" && presentationActive) {
    return { allowed: false, reason: "presentation_active" };
  }
  return { allowed: true, reason: "allowed" };
}

function stateData() {
  return {
    model: currentModel(),
    thinkingLevel: currentThinkingLevel,
    isStreaming: runtimeStreaming,
    isCompacting: runtimeCompacting,
    sessionFile,
    sessionId,
    ...(sessionName ? { sessionName } : {}),
    messageCount: userMessagesForForking.length,
  };
}

function statsData() {
  return {
    sessionFile,
    sessionId,
    userMessages: userMessagesForForking.length,
    assistantMessages: lastAssistantText ? 1 : 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: userMessagesForForking.length + (lastAssistantText ? 1 : 0),
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    cost: 0.001,
    contextUsage: { tokens: 150, contextWindow: 200000, percent: 0.075 },
  };
}

function commandCatalog() {
  return [
    ...[
      ["ask-user-question", "Ask the user a question (test extension)"],
      ["set-editor", "Inject text into the editor (test extension)"],
      ["timeout-select", "Open a select dialog with a 1.5s timeout (test extension)"],
      ["widget-on", "Show extension widget and status"],
      ["widget-off", "Clear extension widget and status"],
      ["test-navigation", "Hold deterministic navigation for ESC tests"],
      ["test-retry", "Hold deterministic retry for ESC tests"],
      ["test-editor-wait", "Hold deterministic editor preflight for ESC tests"],
      ["test-overlap", "Hold overlapping runtime operations for ESC priority tests"],
    ].map(([name, description]) => ({
      name,
      description,
      source: "extension",
      sourceInfo: { path: `/fake/extensions/${name}.js`, scope: "user" },
    })),
  ];
}

function requestTransitionPermit(request) {
  return new Promise((resolve) => {
    transitionPermitWaiters.set(request.transitionId, resolve);
    send({ type: "transition_prepare", ...request });
  });
}

async function transition(reason, records = []) {
  const transitionId = `${reason}-${crypto.randomUUID()}`;
  const provisionalEpoch = sessionEpoch + 1;
  sendControl({ type: "transition_started", transitionId, provisionalEpoch });
  const permit = await requestTransitionPermit({
    transitionId,
    phase: "successor",
    kind: reason,
    targetFile: sessionFile,
  });
  if (!permit.allowed) {
    sendControl({ type: "transition_cancelled", transitionId });
    throw new Error(permit.reason ?? "Transition permit denied");
  }
  sessionEpoch = provisionalEpoch;
  snapshotSequence = 0;
  const terminalSnapshot = snapshot();
  sendControl({
    type: "transition_batch",
    batch: {
      transitionId,
      provisionalEpoch,
      records,
      terminalSnapshot,
    },
  });
  // This first successor frame is deliberately empty of predecessor records.
  emitAuthorityFrame();
}

async function startFreshSession() {
  sessionId = crypto.randomUUID();
  sessionName = undefined;
  sessionFile = allocateSessionPath(`new-${Date.now()}`);
  fileCreated = false;
  lastEntryId = undefined;
  lastAssistantText = null;
  userMessagesForForking.length = 0;
  editorText = "";
  editorRevision += 1;
  ensureFile();
  await transition("new-session", [{ type: "event", event: { type: "session_info_changed" } }]);
}

async function handleCommand(id, command) {
  switch (command?.type) {
    case "get_commands":
      reply(id, true, { commands: commandCatalog() });
      break;
    case "get_state":
      reply(id, true, stateData());
      break;
    case "get_session_stats":
      reply(id, true, statsData());
      break;
    case "get_available_models":
      reply(id, true, { models: fakeModels, currentModelId });
      break;
    case "set_model":
      if (!fakeModels.some((model) => model.id === command.modelId)) {
        reply(id, false, undefined, `Model not found: ${command.modelId}`);
        break;
      }
      currentModelId = command.modelId;
      reply(id, true, { modelId: currentModelId });
      publishSnapshot();
      break;
    case "set_thinking_level":
      currentThinkingLevel = command.level;
      reply(id, true, {});
      emitEvent({ type: "thinking_level_changed", level: currentThinkingLevel });
      publishSnapshot();
      break;
    case "set_session_name":
      sessionName = command.name;
      appendEntry({ type: "session_info", name: sessionName });
      reply(id, true, {});
      emitEvent({ type: "session_info_changed", name: sessionName });
      publishSnapshot();
      break;
    case "new_session":
      await startFreshSession();
      reply(id, true, { cancelled: false });
      break;
    case "get_fork_messages":
      reply(id, true, { messages: userMessagesForForking });
      break;
    case "get_last_assistant_text":
      reply(id, true, { text: lastAssistantText });
      break;
    case "get_messages":
      reply(id, true, { messages: [] });
      break;
    case "bash": {
      const operationToken = beginOperation("bash");
      runtimeBash = true;
      publishSnapshot();
      if (String(command.command).includes("test-long-bash")) {
        await sleep(800);
        if (!operationIsActive("bash", operationToken)) {
          reply(id, true, { output: "", exitCode: 130, cancelled: true });
          break;
        }
      }
      runtimeBash = false;
      completeOperation("bash", operationToken);
      reply(id, true, { output: `$ ${command.command}\nbash output here\n`, exitCode: 0 });
      publishSnapshot();
      break;
    }
    case "compact": {
      const operationToken = beginOperation("compaction");
      runtimeCompacting = true;
      emitEvent({ type: "compaction_start", reason: "manual" });
      publishSnapshot();
      await sleep(500);
      if (!operationIsActive("compaction", operationToken)) {
        emitEvent({ type: "compaction_end", reason: "manual", aborted: true });
        reply(id, false, undefined, "Compaction aborted");
        break;
      }
      runtimeCompacting = false;
      completeOperation("compaction", operationToken);
      const summary = `Compacted ${userMessagesForForking.length} messages`;
      appendEntry({ type: "compaction", summary, reason: "manual", tokensBefore: 1000 });
      logOperation("persisted", { kind: "compaction", token: operationToken, summary });
      emitEvent({
        type: "compaction_end",
        reason: "manual",
        result: { summary, tokensBefore: 1000 },
      });
      reply(id, true, { summary, cancelled: false, tokensBefore: 1000, tokensAfter: 200 });
      publishSnapshot();
      break;
    }
    case "export_html": {
      const outputPath =
        command.outputPath ?? path.join(sessionsRoot(), `export-${Date.now()}.html`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "<html><body>exported</body></html>");
      reply(id, true, { path: outputPath });
      break;
    }
    case "get_tree":
      reply(id, true, { nodes: [], leafId: null });
      break;
    case "get_cache_miss_notices":
      reply(id, true, { notices: [] });
      break;
    default:
      reply(id, false, undefined, `Unsupported fake-host command: ${String(command?.type)}`);
      break;
  }
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
  authorityJournal.push({ type: "intent_outcome", sequence: ++authorityJournalSequence, outcome });
  emitAuthorityFrame([{ type: "intent_outcome", outcome }]);
}

async function executeAuthorityIntent(entry) {
  const { intent } = entry;
  switch (intent.kind) {
    case "submit": {
      if (intent.editorRevision !== editorRevision) {
        finishAuthorityIntent(entry, "rejected", {
          disposition: "not_submitted",
          editorRevision,
          message: "Editor revision changed",
        });
        return;
      }
      const submission = {
        intentId: entry.intentId,
        expectedHostId: hostInstanceId,
        expectedEpoch: sessionEpoch,
        editorRevision: intent.editorRevision,
        text: intent.text,
        images: intent.images,
        requestedMode: intent.requestedMode,
        surface: intent.surface,
      };
      editorRevision++;
      editorText = "";
      editorAttachments = [];
      if (runtimeStreaming) {
        const queue = intent.requestedMode === "steer" ? steeringQueue : followUpQueue;
        queue.push({
          intentId: entry.intentId,
          text: intent.text,
          images: structuredClone(intent.images),
        });
        logOperation("queued", {
          kind: intent.requestedMode,
          intentId: entry.intentId,
          text: intent.text,
        });
        finishAuthorityIntent(entry, "completed", {
          disposition: "completed",
          editorRevision: submission.editorRevision,
          queued: true,
        });
        publishSnapshot();
        return;
      }
      await runSubmission(submission);
      finishAuthorityIntent(entry, "completed", {
        disposition: "completed",
        editorRevision: submission.editorRevision,
        queued: false,
      });
      return;
    }
    case "invokeCommand": {
      // Extension slash commands are exercised through the fixture's existing
      // extension submission seam. Built-ins below never go through prompt.
      const command = intent.text.trim().replace(/^\//, "").split(/\s+/, 1)[0];
      if (command === "compact") {
        await handleCommand(`authority-${entry.intentId}`, { type: "compact" });
        finishAuthorityIntent(entry, "completed", { commandType: command, response: {} });
      } else if (command === "new") {
        // Settle against the predecessor before the fixture advances its epoch.
        finishAuthorityIntent(entry, "completed", { commandType: command, response: {} });
        await handleCommand(`authority-${entry.intentId}`, { type: "new_session" });
      } else if (command === "reload") {
        finishAuthorityIntent(entry, "completed", { commandType: command, response: {} });
        await transition("authority-reload");
      } else if (intent.editorRevision !== editorRevision) {
        finishAuthorityIntent(entry, "rejected", {
          ...(command ? { commandType: command } : {}),
          disposition: "not_submitted",
          editorRevision,
          message: "Editor revision changed",
        });
      } else {
        const submission = {
          intentId: entry.intentId,
          expectedHostId: hostInstanceId,
          expectedEpoch: sessionEpoch,
          editorRevision: intent.editorRevision,
          text: intent.text,
          images: [],
          requestedMode: "followUp",
          surface: "composer",
        };
        editorRevision++;
        editorText = "";
        editorAttachments = [];
        await runSubmission(submission);
        finishAuthorityIntent(entry, "completed", {
          ...(command ? { commandType: command } : {}),
          disposition: "completed",
          editorRevision: intent.editorRevision,
        });
      }
      return;
    }
    case "compact":
      await handleCommand(`authority-${entry.intentId}`, {
        type: "compact",
        instructions: intent.instructions,
      });
      finishAuthorityIntent(entry, "completed", {});
      return;
    case "runBash":
      await handleCommand(`authority-${entry.intentId}`, { type: "bash", command: intent.command });
      finishAuthorityIntent(entry, "completed", {
        started: true,
        output: `$ ${intent.command}\nbash output here\n`,
        exitCode: 0,
      });
      return;
    case "setModel":
      if (!fakeModels.some((model) => model.id === intent.modelId)) {
        finishAuthorityIntent(entry, "failed", undefined, `Model not found: ${intent.modelId}`);
        return;
      }
      currentModelId = intent.modelId;
      publishSnapshot();
      finishAuthorityIntent(entry, "completed", {
        provider: intent.provider,
        modelId: intent.modelId,
      });
      return;
    case "setThinking":
      currentThinkingLevel = intent.level;
      emitEvent({ type: "thinking_level_changed", level: currentThinkingLevel });
      publishSnapshot();
      finishAuthorityIntent(entry, "completed", { level: intent.level });
      return;
    case "rename":
      sessionName = intent.name;
      appendEntry({ type: "session_info", name: sessionName });
      emitEvent({ type: "session_info_changed", name: sessionName });
      publishSnapshot();
      finishAuthorityIntent(entry, "completed", { name: intent.name });
      return;
    case "export": {
      const outputPath =
        intent.outputPath ?? path.join(sessionsRoot(), `export-${Date.now()}.html`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "<html><body>exported</body></html>");
      finishAuthorityIntent(entry, "completed", { path: outputPath });
      return;
    }
    case "navigate":
      runtimeNavigation = true;
      publishSnapshot();
      runtimeNavigation = false;
      publishSnapshot();
      finishAuthorityIntent(entry, "completed", {
        targetId: intent.targetId,
        ...(intent.summarize !== undefined ? { summarized: intent.summarize } : {}),
      });
      return;
    case "interrupt": {
      const target = runtimeNavigation
        ? "navigation"
        : runtimeCompacting
          ? "compaction"
          : runtimeRetrying
            ? "retry"
            : runtimeStreaming
              ? "streaming"
              : runtimeBash
                ? "bash"
                : runtimeEditorPending
                  ? "editor"
                  : "idle";
      const interrupted = target !== "editor" && target !== "idle";
      if (interrupted) {
        cancelOperation(target);
        if (target === "navigation") runtimeNavigation = false;
        if (target === "compaction") runtimeCompacting = false;
        if (target === "retry") {
          runtimeRetrying = false;
          retryAttempt = 0;
        }
        if (target === "bash") runtimeBash = false;
        if (target === "streaming") {
          runtimeStreaming = false;
          const queued = [...steeringQueue, ...followUpQueue];
          if (queued.length > 0) {
            const restoration = {
              type: "queue_restoration",
              restorationId: `fake-queue-${crypto.randomUUID()}`,
              steering: steeringQueue.map((item) => item.text),
              followUp: followUpQueue.map((item) => item.text),
              originalAttachments: queued.map((item) => ({
                intentId: item.intentId,
                images: structuredClone(item.images),
              })),
              requiresReview: true,
            };
            authorityRestorations.set(restoration.restorationId, restoration);
            emitAuthorityFrame([restoration]);
          }
          steeringQueue.length = 0;
          followUpQueue.length = 0;
        }
      }
      logOperation("escape", { target, requestId: entry.intentId });
      finishAuthorityIntent(entry, "completed", {
        target: target === "idle" ? "editor" : target,
        interrupted,
      });
      publishSnapshot();
      return;
    }
    case "reload":
      // The terminal predecessor outcome commits before transition() advances
      // the owner and installs its successor baseline.
      finishAuthorityIntent(entry, "completed", {});
      await transition("authority-reload");
      return;
    default:
      finishAuthorityIntent(entry, "failed", undefined, "Unsupported fake authority intent");
  }
}

function dispatchAuthorityIntent(envelope) {
  const intentId = envelope?.intentId;
  const owner = envelope?.expectedOwner;
  const intent = envelope?.intent;
  if (!intentId || !owner || !intent || typeof intent.kind !== "string") {
    return {
      status: "not_admitted",
      intentId: intentId ?? "",
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
  queueMicrotask(() => {
    void executeAuthorityIntent(entry).catch((error) =>
      finishAuthorityIntent(
        entry,
        "failed",
        undefined,
        error instanceof Error ? error.message : String(error),
      ),
    );
  });
  return { status: "admitted", intentId, owner: structuredClone(owner) };
}

function authorityAttach(rendererGeneration) {
  const semantic = semanticSnapshot();
  if (semanticTransportSequence === 0) semanticTransportSequence = 1;
  if (presentationTransportSequence.transcript === 0) presentationTransportSequence.transcript = 1;
  if (presentationTransportSequence.extensionUi === 0)
    presentationTransportSequence.extensionUi = 1;
  if (presentationTransportSequence.panel === 0) presentationTransportSequence.panel = 1;
  const owner = semantic.owner;
  const cursor = {
    ...owner,
    transportSequence: semanticTransportSequence,
    snapshotSequence: semantic.snapshotSequence,
  };
  const transcriptCursor = {
    ...owner,
    transportSequence: presentationTransportSequence.transcript,
    snapshotSequence: semantic.snapshotSequence,
  };
  const extensionUiCursor = {
    ...owner,
    transportSequence: presentationTransportSequence.extensionUi,
    snapshotSequence: semantic.snapshotSequence,
  };
  return {
    sessionId,
    rendererGeneration,
    owner,
    semantic: { sync: { state: "following", cursor }, snapshot: semantic },
    operationJournal: authorityJournal.filter(
      (entry) => entry.outcome.owner.sessionEpoch === sessionEpoch,
    ),
    restorations: [...authorityRestorations.values()],
    transcript: {
      sync: { state: "following", cursor: transcriptCursor },
      persistedHistoryCursor: sessionFile ?? null,
      liveTailCursor: null,
      overlapBoundary: sessionFile ? `persisted:${sessionFile}` : null,
    },
    extensionUi: {
      sync: { state: "following", cursor: extensionUiCursor },
      notifications: structuredClone(catalog.notifications),
      statuses: structuredClone(catalog.statuses),
      widgets: structuredClone(catalog.widgets),
      dialogs: [...pendingDialogs.values()].map(({ request }) => ({
        request: structuredClone(request),
        rendererGeneration,
        inputPending: false,
        acknowledged: false,
      })),
    },
    panels: [],
    publicationHighWatermark: 0,
  };
}

async function handleMessage(message) {
  if (process.env.PIVIS_TEST_HOST_MESSAGE_LOG) {
    fs.appendFileSync(
      process.env.PIVIS_TEST_HOST_MESSAGE_LOG,
      `${JSON.stringify({
        type: message?.type,
        command: message?.command?.type,
        text: message?.submission?.text,
        intent: message?.envelope?.intent,
      })}\n`,
    );
  }
  switch (message?.type) {
    case "init": {
      if (initialized) return;
      initialized = true;
      cwd = message.cwd || cwd;
      sessionId = crypto.randomUUID();
      if (message.sessionFile) loadSession(message.sessionFile);
      else sessionFile = allocateSessionPath();
      if (process.env.PIVIS_TEST_HOST_SPAWN_LOG) {
        fs.appendFileSync(
          process.env.PIVIS_TEST_HOST_SPAWN_LOG,
          `${JSON.stringify({ argv: process.argv.slice(2), cwd, sessionFile: message.sessionFile })}\n`,
        );
      }
      sendControl({ type: "spawned" });
      if (process.env.PIVIS_TEST_HOST_FAIL_SESSION_ID === sessionId) {
        setTimeout(() => process.exit(23), 5).unref?.();
        return;
      }
      const readyDelayMs = Number.parseInt(process.env.PIVIS_TEST_HOST_READY_DELAY_MS ?? "", 10);
      const publishReady = () => {
        sendControl({ type: "ready", piVersion: "99.0.0", snapshot: snapshot() });
        heartbeat = setInterval(() => publishSnapshot(false), 1000);
        heartbeat.unref?.();
      };
      if (Number.isFinite(readyDelayMs) && readyDelayMs > 0) {
        setTimeout(publishReady, readyDelayMs).unref?.();
      } else {
        publishReady();
      }
      break;
    }
    case "command":
      if (!initialized) reply(message.id, false, undefined, "Not initialized");
      else await handleCommand(message.id, message.command);
      break;
    case "submit": {
      const submission = message.submission;
      if (
        !submission ||
        submission.expectedHostId !== hostInstanceId ||
        submission.expectedEpoch !== sessionEpoch ||
        submission.editorRevision !== editorRevision
      ) {
        reply(
          message.id,
          true,
          submissionResult(submission ?? { intentId: "unknown", editorRevision }, "not_submitted", {
            message: "Runtime identity or editor revision changed",
          }),
        );
        break;
      }
      // Mirror the real host's editor custody boundary: only the exact
      // submitted revision clears, and accepting it advances the canonical
      // revision before the renderer can issue a clearing patch.
      editorRevision++;
      editorText = "";
      editorAttachments = [];
      const queue = submission.requestedMode === "steer" ? steeringQueue : followUpQueue;
      if (runtimeStreaming) {
        queue.push({
          intentId: submission.intentId,
          text: submission.text,
          images: structuredClone(submission.images ?? []),
        });
        reply(message.id, true, submissionResult(submission, "consumed", { queued: true }));
        logOperation("queued", {
          kind: submission.requestedMode,
          intentId: submission.intentId,
          text: submission.text,
        });
        publishSnapshot();
        break;
      }
      const executeSubmission = () =>
        runSubmission(submission).catch((error) => {
          send({
            type: "submission_disposition",
            result: submissionResult(submission, "extension_error", {
              message: error instanceof Error ? error.message : String(error),
            }),
          });
          runtimeStreaming = false;
          publishSnapshot();
        });
      if (String(submission.text).includes("[test:echo-before-custody]")) {
        // Real Pi can publish message_start while session.prompt() is still
        // running, before the submit response returns through child IPC.
        // Keep a deterministic seam for that legal ordering.
        const execution = executeSubmission();
        reply(message.id, true, submissionResult(submission, "consumed", { queued: false }));
        void execution;
      } else {
        reply(message.id, true, submissionResult(submission, "consumed", { queued: false }));
        void executeSubmission();
      }
      break;
    }
    case "state_request": {
      // Compatibility resync stays a direct legacy snapshot, never a frame.
      const value = publishSnapshot(true);
      reply(message.id, true, value);
      break;
    }
    case "authority_attach":
      reply(message.id, true, authorityAttach(message.rendererGeneration));
      break;
    case "lifecycle_permit":
      reply(message.id, true, lifecyclePermit(message.operation));
      break;
    case "dispatch_intent":
      reply(message.id, true, dispatchAuthorityIntent(message.envelope));
      break;
    case "transition_permit": {
      const resolve = transitionPermitWaiters.get(message.transitionId);
      if (resolve) {
        transitionPermitWaiters.delete(message.transitionId);
        resolve({ allowed: message.allowed === true, reason: message.reason });
      }
      break;
    }
    case "query": {
      const envelope = message.envelope;
      if (
        envelope?.expectedOwner?.hostInstanceId !== hostInstanceId ||
        envelope?.expectedOwner?.sessionEpoch !== sessionEpoch
      ) {
        reply(message.id, false, undefined, "Stale authority owner");
        break;
      }
      const query = envelope?.query;
      const read =
        query?.type === "get_state"
          ? stateData()
          : query?.type === "get_session_stats"
            ? statsData()
            : query?.type === "get_commands"
              ? { commands: commandCatalog() }
              : query?.type === "get_available_models"
                ? { models: fakeModels, currentModelId }
                : query?.type === "get_fork_messages"
                  ? { messages: userMessagesForForking }
                  : query?.type === "get_last_assistant_text"
                    ? { text: lastAssistantText }
                    : query?.type === "get_messages"
                      ? { messages: [] }
                      : query?.type === "get_tree"
                        ? { nodes: [], leafId: null }
                        : query?.type === "get_cache_miss_notices"
                          ? { notices: [] }
                          : undefined;
      reply(message.id, true, {
        queryId: envelope?.queryId,
        owner: authorityOwner(),
        queryType: query?.type,
        response: {
          type: "response",
          command: query?.type ?? "unknown",
          success: read !== undefined,
          ...(read === undefined ? { error: "Unsupported fake-host query" } : { data: read }),
        },
      });
      break;
    }
    case "prepare_close":
      closeToken = crypto.randomUUID();
      reply(message.id, true, {
        token: closeToken,
        mutationSequence: snapshotSequence,
        snapshot: snapshot(),
        custody: [],
        activeIntents: [],
        restorations: [],
        ui: {
          editor: { revision: editorRevision, text: editorText, attachments: editorAttachments },
          panels: [...openPanels].map((panelId) => ({ panelId })),
        },
      });
      break;
    case "confirm_close":
      reply(message.id, true, { valid: message.token === closeToken });
      break;
    case "cancel_close": {
      const cancelled = message.token === closeToken;
      if (cancelled) closeToken = undefined;
      reply(message.id, true, { cancelled });
      break;
    }
    case "escape": {
      const target = runtimeNavigation
        ? "navigation"
        : runtimeCompacting
          ? "compaction"
          : runtimeRetrying
            ? "retry"
            : runtimeStreaming
              ? "streaming"
              : runtimeBash
                ? "bash"
                : runtimeEditorPending
                  ? "editor"
                  : undefined;
      let restorationId;
      if (target && target !== "editor") {
        cancelOperation(target);
        if (target === "navigation") runtimeNavigation = false;
        if (target === "compaction") runtimeCompacting = false;
        if (target === "retry") {
          runtimeRetrying = false;
          retryAttempt = 0;
        }
        if (target === "streaming") {
          runtimeStreaming = false;
          restorationId = `fake-queue-${crypto.randomUUID()}`;
          send({
            type: "queue_restoration",
            restorationId,
            steering: steeringQueue.map((item) => item.text),
            followUp: followUpQueue.map((item) => item.text),
            originalAttachments: [...steeringQueue, ...followUpQueue].map((item) => ({
              intentId: item.intentId,
              images: structuredClone(item.images),
            })),
            requiresReview: true,
          });
          const restoration = {
            type: "queue_restoration",
            restorationId,
            steering: steeringQueue.map((item) => item.text),
            followUp: followUpQueue.map((item) => item.text),
            originalAttachments: [...steeringQueue, ...followUpQueue].map((item) => ({
              intentId: item.intentId,
              images: structuredClone(item.images),
            })),
            requiresReview: true,
          };
          authorityRestorations.set(restorationId, restoration);
          emitAuthorityFrame([restoration]);
          logOperation("restored", {
            kind: "queue",
            restorationId,
            steering: steeringQueue.map((item) => item.text),
            followUp: followUpQueue.map((item) => item.text),
          });
          steeringQueue.length = 0;
          followUpQueue.length = 0;
        }
        if (target === "bash") runtimeBash = false;
      }
      logOperation("escape", { target: target ?? "idle", requestId: message.requestId });
      reply(message.id, true, {
        requestId: message.requestId,
        hostInstanceId,
        sessionEpoch,
        disposition:
          target === "editor" ? "outcome_unknown" : target ? "abort_requested" : "already_inactive",
        target: target ?? "editor",
        ...(restorationId ? { restorationId } : {}),
        ...(target === "editor"
          ? { message: "Submission preflight cannot be cancelled; outcome remains recoverable" }
          : {}),
      });
      publishSnapshot();
      break;
    }
    case "reload":
      await transition("reload");
      reply(message.id, true);
      break;
    case "editor_patch": {
      const patch = message.patch ?? {};
      if (
        Number.isInteger(patch.baseRevision) &&
        Number.isInteger(patch.revision) &&
        patch.baseRevision === editorRevision &&
        patch.revision > editorRevision
      ) {
        editorRevision = patch.revision;
        editorText = String(patch.text ?? "");
        editorAttachments = structuredClone(patch.attachments ?? []);
        reply(message.id, true, {
          accepted: true,
          revision: editorRevision,
          text: editorText,
          attachments: editorAttachments,
        });
      } else {
        reply(message.id, true, {
          accepted: false,
          revision: editorRevision,
          text: editorText,
          attachments: editorAttachments,
          conflictText: String(patch.text ?? ""),
          conflictAttachments: structuredClone(patch.attachments ?? []),
          ...(patch.alternateConflictText !== undefined
            ? {
                alternateConflictText: patch.alternateConflictText,
                alternateConflictAttachments: structuredClone(
                  patch.alternateConflictAttachments ?? [],
                ),
              }
            : {}),
          ...(Array.isArray(patch.additionalConflictCandidates) &&
          patch.additionalConflictCandidates.length > 0
            ? {
                additionalConflictCandidates: structuredClone(patch.additionalConflictCandidates),
              }
            : {}),
        });
      }
      break;
    }
    case "dialog_response": {
      const response = message.response;
      const pending = response?.id ? pendingDialogs.get(response.id) : undefined;
      if (pending) {
        pendingDialogs.delete(response.id);
        send({ type: "ui_ack", operationId: response.id });
        await pending.onAnswer(response);
        publishSnapshot();
      }
      break;
    }
    case "renderer_detached":
      pendingDialogs.clear();
      if (openPanels.size) {
        openPanels.clear();
        send({ type: "panel_clear_all" });
      }
      send({ type: "renderer_cancelled", rendererGeneration: message.rendererGeneration });
      publishSnapshot();
      break;
    case "panel_close_request":
      if (openPanels.delete(message.panelId))
        send({ type: "panel_close", panelId: message.panelId });
      send({ type: "ui_ack", operationId: message.operationId });
      break;
    case "panel_input":
      reply(message.id, true, { acknowledgedThrough: message.sequence });
      break;
    case "panel_resize":
    case "restoration_ack":
    case "unified_submit_response":
    case "clipboard_read_image_response":
    case "interrupt":
      break;
    default:
      if (message?.id) reply(message.id, false, undefined, `Unknown message: ${message.type}`);
      break;
  }
}

process.on("message", (message) => {
  void handleMessage(message).catch((error) => {
    if (message?.id)
      reply(message.id, false, undefined, error instanceof Error ? error.message : String(error));
  });
});

process.on("disconnect", () => {
  if (heartbeat) clearInterval(heartbeat);
  process.exit(0);
});
